import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Assets } from './Assets';
import { Input } from './Input';
import { Viewports, type CameraTarget } from '../render/Viewports';
import { Hud } from '../ui/Hud';
import { buildMapCanvas } from '../ui/Minimap';
import { MapOverlay } from '../ui/MapOverlay';
import { AudioSys } from './AudioSys';
import { CIVILIAN_CARS, GRAVITY, PALETTE, STEP } from './const';
import { CITY_ASSETS, City } from '../world/City';
import { CompiledCity } from '../world/CompiledCity';
import type { CityStreamer } from '../world/CityStreamer';
import {
  cellAt,
  bridgeSurfaceHeightAt,
  cellToWorld,
  getAuthoredMap,
  heightAt,
  nearestRoadCell,
  roadInfoAt,
  setAuthoredMap,
  speedLimitAt,
  suburbNameAt,
  TransportFlag,
  transportAt,
  worldToCell,
} from '../world/CityMap';
import { loadAuthoredMap } from '../world/MapLoad';
import { Vehicle } from '../entities/Vehicle';
import { Helicopter } from '../entities/Helicopter';
import type { Drivable } from '../entities/Drivable';
import { Player } from '../entities/Player';
import { Npcs } from '../world/Npcs';
import { TrafficCar } from '../entities/TrafficCar';
import { Combat } from '../gameplay/Combat';
import { Fx } from '../render/Fx';
import { Pickup } from '../entities/Pickup';
import { WEAPONS, WEAPON_ORDER, type WeaponId } from '../gameplay/Weapons';
import { randomRoadCellNear } from '../world/RoadGraph';
import { Settings } from './Settings';
import { WorldLighting } from '../world/WorldLighting';

export interface Entity {
  update(dt: number): void;
}

const ACTOR_ASSETS = [...CIVILIAN_CARS, 'cars/police', 'cars/debris-door-window'];
const LEGACY_ASSETS = [...ACTOR_ASSETS, ...CITY_ASSETS];
type MapMode = 'procedural' | 'legacy' | 'compiled';

export class Game {
  readonly scene = new THREE.Scene();
  readonly renderer: THREE.WebGLRenderer;
  readonly world: RAPIER.World;
  readonly eventQueue = new RAPIER.EventQueue(true);
  readonly assets: Assets;
  readonly input = new Input();
  readonly settings = new Settings();
  readonly viewports: Viewports;
  readonly hud: Hud;
  readonly lighting: WorldLighting;
  readonly mapOverlay: MapOverlay | null;
  readonly entities: Entity[] = [];

  private clock = new THREE.Clock();
  private accumulator = 0;
  private debugCam = false;
  private suburbCache: { cx: number; cz: number; name: string | null }[] = [];

  readonly vehicles: Drivable[] = [];
  readonly players: Player[] = [];
  readonly audio = new AudioSys();
  readonly combat = new Combat(this);
  readonly fx = new Fx(this.scene);
  readonly pickups: Pickup[] = [];
  /** Chance a spawned pedestrian fights back when attacked (debug: ?brawlers). */
  pedBraveChance = 0.25;
  readonly city: CityStreamer;
  npcs!: Npcs;
  paused = false;

  static async create(container: HTMLElement): Promise<Game> {
    const requestedMode = new URLSearchParams(location.search).get('map');
    const mode: MapMode = requestedMode === 'procedural' || requestedMode === 'compiled' || requestedMode === 'legacy'
      ? requestedMode
      : 'legacy';
    if (mode === 'procedural') setAuthoredMap(null);
    const [assets] = await Promise.all([
      (async () => {
        const a = new Assets();
        await a.preload(mode === 'compiled' ? ACTOR_ASSETS : LEGACY_ASSETS);
        return a;
      })(),
      RAPIER.init(),
      mode === 'procedural' ? Promise.resolve(null) : loadAuthoredMap('melbourne', { loadObjects: mode === 'legacy' }),
    ]);
    const game = new Game(container, assets, mode);
    await game.initialize();
    return game;
  }

  private constructor(container: HTMLElement, assets: Assets, mode: MapMode) {
    this.assets = assets;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
    this.input.attachPointerLock(this.renderer.domElement);

    window.addEventListener('resize', () => {
      this.renderer.setSize(container.clientWidth, container.clientHeight);
      this.viewports.updateAspects();
    });

    this.world = new RAPIER.World(new RAPIER.Vector3(0, GRAVITY, 0));
    this.world.timestep = STEP;

    this.viewports = new Viewports(this.renderer, (target, focus, desired, out) => {
      this.resolveCameraCollision(target, focus, desired, out);
    });
    this.viewports.setPlayerCount(1);
    this.hud = new Hud(container, this.settings);
    this.audio.onCaption = (text) => this.hud.showCaption(text);
    const map = getAuthoredMap();
    const mapCanvas = map ? buildMapCanvas(map) : null;
    if (map && mapCanvas) this.hud.setMapCanvas(mapCanvas, map);
    this.hud.setPlayerCount(1);
    this.mapOverlay = map && mapCanvas ? new MapOverlay(container, map, mapCanvas) : null;

    this.lighting = this.setupEnvironment();
    // The Kenney asphalt is nearly sand-colored; darken it well below the
    // pavement gray so streets read as streets against the sidewalks.
    for (const name of CITY_ASSETS) {
      if (name.startsWith('roads/road-')) this.assets.tint(name, 0x666c7c);
    }
    this.city = mode === 'compiled' ? new CompiledCity(this) : new City(this);
  }

  private async initialize(): Promise<void> {
    const map = getAuthoredMap();
    const requestedSpawn = map?.spawn ?? { x: 0, z: 0 };
    const requestedCell = worldToCell(requestedSpawn.x, requestedSpawn.z);
    const safeSpawnCell = nearestRoadCell(requestedCell.cx, requestedCell.cz);
    const spawn = safeSpawnCell
      ? cellToWorld(safeSpawnCell.cx, safeSpawnCell.cz)
      : requestedSpawn;
    await this.city.prewarm(spawn.x, spawn.z);
    // Register freshly-created fixed colliders with Rapier's scene queries so
    // the first character can raycast its exact spawn surface immediately.
    this.world.step(this.eventQueue);

    const p1 = new Player(this, 0, spawn.x, spawn.z);
    this.players.push(p1);
    this.entities.push(p1);

    this.npcs = new Npcs(this);

    this.spawnStarterPickups(spawn.x, spawn.z);
    this.spawnHelicopter(spawn.x, spawn.z);
    this.applyDebugParams();
  }

  /** Player XZ positions, for chunk streaming and spawn-ring sampling. */
  playerPositions(): { x: number; z: number }[] {
    return this.players.map((p) => {
      if (p.driving) {
        const t = p.vehicle!.body.translation();
        return { x: t.x, z: t.z };
      }
      const c = p.position();
      return { x: c.x, z: c.z };
    });
  }

  /** Terrain query exposed on window.__game for verification tooling. */
  heightAt(x: number, z: number): number {
    return heightAt(x, z);
  }

  /** Highest fixed world surface below a nearby actor. Unlike `heightAt`, this
   * can resolve a bridge deck without turning the terrain beneath it solid. */
  surfaceHeightBelow(x: number, z: number, ceilingY: number, maxDistance = 16): number {
    const ray = new RAPIER.Ray(
      new RAPIER.Vector3(x, ceilingY, z),
      new RAPIER.Vector3(0, -1, 0)
    );
    const hit = this.world.castRay(
      ray,
      maxDistance,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC
    );
    return hit ? ceilingY - hit.timeOfImpact : heightAt(x, z);
  }

  /** Drivable surface for a fresh road-bound actor. Legacy maps can resolve
   * the authored deck directly; compiled maps recover it from fixed collision
   * when the transport layer marks this cell as a bridge. */
  roadSurfaceHeightAt(x: number, z: number): number {
    const terrain = heightAt(x, z);
    const authoredDeck = bridgeSurfaceHeightAt(x, z);
    if (authoredDeck > terrain + 0.02) return authoredDeck;
    const { cx, cz } = worldToCell(x, z);
    if ((transportAt(cx, cz) & TransportFlag.Bridge) !== 0) {
      return this.surfaceHeightBelow(x, z, terrain + 24, 40);
    }
    return terrain;
  }

  addVehicle(v: Drivable): void {
    this.vehicles.push(v);
    this.entities.push(v);
  }

  removeVehicle(v: Drivable): void {
    const vi = this.vehicles.indexOf(v);
    if (vi >= 0) this.vehicles.splice(vi, 1);
    const ei = this.entities.indexOf(v);
    if (ei >= 0) this.entities.splice(ei, 1);
    v.dispose();
  }

  /** Attribute a witnessed crime; active police always count as witnesses. */
  reportCrime(
    player: Player | null,
    heat: number,
    origin?: THREE.Vector3,
    requiresWitness = true
  ): void {
    if (!player) return;
    const point = origin ?? player.position();
    const witnessed = !requiresWitness || player.wanted.policeAware || this.npcs?.witnessCrime(point);
    if (witnessed) player.wanted.addHeat(heat, point);
  }

  /** Crime hooks from the NPC simulation. */
  onPedestrianKilled(vehicle: Drivable): void {
    const t = vehicle.body.translation();
    this.reportCrime(
      vehicle.driver instanceof Player ? vehicle.driver : null,
      45,
      new THREE.Vector3(t.x, t.y, t.z)
    );
  }

  onTrafficRammed(car: TrafficCar): void {
    // Attribute the hit to a player-driven vehicle close to the impact.
    const t = car.vehicle.body.translation();
    for (const p of this.players) {
      if (!p.driving) continue;
      const v = p.vehicle!.body.translation();
      if (Math.hypot(v.x - t.x, v.z - t.z) < 8) {
        this.reportCrime(p, 16, new THREE.Vector3(t.x, t.y, t.z));
        return;
      }
    }
  }

  /** Eject occupants, resolve radial damage, and attribute a destroyed car. */
  onVehicleExploded(vehicle: Vehicle, origin: THREE.Vector3, attacker: Player | null): void {
    for (const player of this.players) player.ejectFromDestroyedVehicle(vehicle, origin);
    const trafficDriver = vehicle.driver instanceof TrafficCar ? vehicle.driver : null;
    if (trafficDriver) this.npcs.ejectTrafficDriver(vehicle, 1, trafficDriver.driverProfile);
    vehicle.driver = null;
    this.combat.blast(origin, 10, 105, attacker, vehicle);
    this.reportCrime(attacker, 24, origin);
  }

  /** Transfer a portion of severe chassis deceleration to occupants. */
  onVehicleCrashDamage(vehicle: Vehicle, chassisDamage: number, deltaV: number): void {
    if (deltaV < 7) return;
    const t = vehicle.body.translation();
    const origin = new THREE.Vector3(t.x, t.y, t.z);
    const injury = Math.min(48, Math.max(2, chassisDamage * 0.32 + (deltaV - 7) * 0.8));
    for (const player of this.players) {
      if (player.vehicle === vehicle) player.takeOccupantCrashDamage(injury, origin);
    }
    if (deltaV > 9) this.npcs.reactToDanger(origin, Math.min(32, 16 + deltaV));
  }

  /** Split the screen and drop player 2 next to player 1. */
  joinPlayer2(): void {
    if (this.players.length >= 2) return;
    const p1 = this.players[0];
    const pos = p1.driving
      ? new THREE.Vector3().copy(p1.vehicle!.root.position)
      : p1.position();
    const p2 = new Player(this, 1, pos.x + 2.5, pos.z + 2.5);
    this.players.push(p2);
    this.entities.push(p2);
    this.viewports.setPlayerCount(2);
    this.hud.setPlayerCount(2);
  }

  /** Every usable weapon, arranged in a deterministic ring around spawn. */
  private spawnStarterPickups(x: number, z: number): void {
    const wanted = WEAPON_ORDER.filter(
      (weapon): weapon is Exclude<WeaponId, 'fists'> => weapon !== 'fists'
    );
    for (let i = 0; i < wanted.length; i++) {
      const weapon = wanted[i];
      const def = WEAPONS[weapon];
      const angle = -Math.PI * 0.8 + (i / Math.max(1, wanted.length - 1)) * Math.PI * 1.6;
      const px = x + Math.sin(angle) * 5;
      const pz = z + Math.cos(angle) * 5;
      const ammo = def.kind === 'gun' ? def.magSize * 5 : 0;
      this.pickups.push(new Pickup(this, weapon, ammo, px, heightAt(px, pz), pz));
    }
  }

  /** Put a flyable helicopter on a nearby road-sized clear patch. */
  private spawnHelicopter(x: number, z: number): void {
    let cell = randomRoadCellNear(x, z, 10, 24);
    for (let attempt = 1; !cell && attempt < 10; attempt++) {
      cell = randomRoadCellNear(x, z, 10, 24);
    }
    const spot = cell ? cellToWorld(cell.cx, cell.cz) : { x: x + 12, z };
    this.addVehicle(new Helicopter(this, spot.x, spot.z, 0));
  }

  private applyDebugParams(): void {
    const params = new URLSearchParams(location.search);
    if (params.has('nofog')) this.scene.fog = null;
    if (params.has('testcar')) {
      const s = getAuthoredMap()?.spawn ?? { x: 3, z: 24 };
      this.addVehicle(new Vehicle(this, 'cars/taxi', s.x, s.z + 12, 0));
    }
    if (params.has('p2')) this.joinPlayer2();
    if (params.has('arsenal')) {
      for (const p of this.players) p.inventory.giveAll();
    }
    if (params.has('brawlers')) this.pedBraveChance = 1;
    if (params.has('pos')) {
      this.debugCam = true;
      const cam = this.viewports.cameras[0].camera;
      const pos = params.get('pos')!.split(',').map(Number);
      const look = (params.get('look') ?? '0,0,0').split(',').map(Number);
      cam.position.set(pos[0], pos[1], pos[2]);
      cam.lookAt(look[0], look[1], look[2]);
    }
  }

  private setupEnvironment(): WorldLighting {
    this.scene.background = new THREE.Color(PALETTE.sky);
    // Fog far sits just inside the guaranteed chunk-loaded distance so new
    // chunks always materialize fully fogged (no visible pop-in).
    this.scene.fog = new THREE.Fog(PALETTE.fogColor, 60, 230);

    const hemi = new THREE.HemisphereLight(0xffe4c8, 0x6b5b8a, 1.15);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffcf90, 1.7);
    sun.position.set(-80, 100, 40);
    this.scene.add(sun);
    return new WorldLighting(this.scene, hemi, sun, () => this.audio.thunder());
  }

  start(): void {
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private frame(): void {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.input.poll();
    this.mapOverlay?.setPlayers(
      this.playerPositions().map((pos, i) => ({ ...pos, heading: this.players[i].getHeading() }))
    );
    if (this.input.p2JoinRequested) {
      this.input.p2JoinRequested = false;
      this.joinPlayer2();
    }
    const pausePressed = this.input.consumePause();
    const mapPressed = this.input.consumeMapToggle();
    if (pausePressed) {
      if (this.mapOverlay?.isOpen) {
        this.mapOverlay.close();
      } else {
        this.paused = !this.paused;
        this.hud.setPaused(this.paused);
        if (this.paused) document.exitPointerLock?.();
        if (!this.paused) this.input.clearGameplayEdges();
      }
    }
    if (mapPressed && !pausePressed && !this.paused && this.mapOverlay) {
      if (this.mapOverlay.isOpen) this.mapOverlay.close();
      else {
        document.exitPointerLock?.();
        this.mapOverlay.open();
      }
    }
    // Clicks and presses made while browsing the map shouldn't fire weapons.
    if (this.mapOverlay?.isOpen) this.input.clearGameplayEdges();
    if (!this.paused) {
      this.accumulator += dt;
      while (this.accumulator >= STEP) {
        this.fixedUpdate();
        this.accumulator -= STEP;
      }
    }
    const positions = this.playerPositions();
    this.city.update(positions);
    this.lighting.update(this.paused ? 0 : dt, positions);
    if (!this.paused) this.fx.update(dt);
    if (this.paused) this.audio.duck();
    else this.updateAudio(dt);
    this.mapOverlay?.setPlayers(
      positions.map((pos, i) => ({ ...pos, heading: this.players[i].getHeading() }))
    );
    const pan = this.input.mapPanAxes();
    this.mapOverlay?.update(dt, pan.x, pan.y);
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      const pos = positions[i];
      const look = this.input.cameraInput(
        p.index,
        dt,
        this.settings.values.cameraSensitivity,
        this.settings.values.invertCameraY,
        !this.paused && !this.mapOverlay?.isOpen
      );
      if (!this.debugCam) {
        this.viewports.cameras[i]?.update(p, dt, look, this.settings.values.reducedMotion);
      }
      const def = p.inventory.def();
      const heading = p.getHeading();
      const drivingCar = p.driving && p.vehicle!.kind === 'car';
      const currentRoad = drivingCar ? roadInfoAt(pos.x, pos.z, heading) : null;
      const roadCell = worldToCell(pos.x, pos.z);
      const fallbackLimit = drivingCar && cellAt(roadCell.cx, roadCell.cz) === '#'
        ? speedLimitAt(roadCell.cx, roadCell.cz)
        : undefined;
      this.hud.update(i, {
        speedKmh: p.driving ? p.vehicle!.speedKmh() : undefined,
        prompt: p.prompt ?? undefined,
        stars: p.wanted.stars,
        wantedSearching: p.wanted.searching,
        money: p.money,
        weapon: p.driving ? undefined : def.name,
        ammoMag: !p.driving && def.kind === 'gun' ? p.inventory.magCount() : undefined,
        ammoReserve: !p.driving && def.kind === 'gun' ? p.inventory.reserveCount() : undefined,
        vehicleHealth: p.vehicle instanceof Vehicle ? p.vehicle.healthFraction : undefined,
        health: p.health / 100,
        armour: p.armour / 100,
        message: p.hudMessage ?? undefined,
        pos,
        heading,
        suburb: this.suburbAt(i, pos.x, pos.z),
        roadName: currentRoad ? currentRoad.name ?? 'Unnamed road' : undefined,
        speedLimitKmh: currentRoad?.speedLimitKmh ?? fallbackLimit,
        cops: p.wanted.police.map((cop) => {
          const t = cop.vehicle.body.translation();
          return { x: t.x, z: t.z };
        }),
      });
    }
    this.hud.setInputMethods(this.players.map((player) => this.input.inputMethod(player.index)));
    this.viewports.render(this.scene);
  }

  /** Pull the chase camera in front of the first wall/terrain obstruction. */
  private resolveCameraCollision(
    target: CameraTarget,
    focus: THREE.Vector3,
    desired: THREE.Vector3,
    out: THREE.Vector3
  ): void {
    const direction = desired.clone().sub(focus);
    const distance = direction.length();
    if (distance < 0.01) {
      out.copy(desired);
      return;
    }
    direction.multiplyScalar(1 / distance);
    const player = target as Player;
    const excludedBody = player.vehicle?.body ?? player.character.body;
    const hit = this.world.castRay(
      new RAPIER.Ray(focus, direction),
      distance,
      true,
      undefined,
      undefined,
      undefined,
      excludedBody
    );
    const safeDistance = hit ? Math.max(0.8, hit.timeOfImpact - 0.35) : distance;
    out.copy(focus).addScaledVector(direction, safeDistance);
  }

  private suburbAt(playerIndex: number, x: number, z: number): string | null {
    const { cx, cz } = worldToCell(x, z);
    let cached = this.suburbCache[playerIndex];
    if (!cached) {
      cached = { cx: Number.NaN, cz: Number.NaN, name: null };
      this.suburbCache[playerIndex] = cached;
    }
    if (cached.cx === cx && cached.cz === cz) return cached.name;
    cached.cx = cx;
    cached.cz = cz;
    const suburb = suburbNameAt(x, z);
    if (suburb) cached.name = suburb;
    else if (cellAt(cx, cz) === '~') cached.name = 'Port Phillip Bay';
    return cached.name;
  }

  private updateAudio(dt: number): void {
    let speed = 0;
    let throttle = 0;
    let skidding = false;
    let sirenDist = Infinity;
    let walking = false;
    let running = false;
    for (const p of this.players) {
      if (p.vehicle) {
        speed = Math.max(speed, p.vehicle.getSpeed());
        throttle = Math.max(throttle, p.vehicle.command.throttle);
        skidding ||=
          p.vehicle.kind === 'car' &&
          p.vehicle.command.handbrake &&
          p.vehicle.getSpeed() > 6;
      }
      if (!p.vehicle && !p.dead && !p.knockedDown && p.input) {
        const move = Math.hypot(p.input.moveX, p.input.moveY);
        walking ||= move > 0.15;
        running ||= move > 0.15 && p.input.sprint;
      }
      for (const cop of p.wanted.police) {
        sirenDist = Math.min(sirenDist, cop.distanceToTarget());
      }
    }
    this.audio.update(
      dt,
      speed,
      throttle,
      skidding,
      sirenDist,
      walking,
      running,
      this.lighting.darknessAmount,
      this.lighting.rainAmount
    );
  }

  private fixedUpdate(): void {
    for (const p of this.players) {
      p.input = this.input.read(p.index);
      p.cameraYaw = this.viewports.cameras[p.index]?.yaw() ?? 0;
    }
    this.npcs.update(STEP);
    for (const e of this.entities) e.update(STEP);
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      this.pickups[i].update(STEP);
      if (this.pickups[i].collected) this.pickups.splice(i, 1);
    }
    this.world.step(this.eventQueue);
    for (const vehicle of this.vehicles) vehicle.afterPhysics();
    this.npcs.afterPhysics();
  }
}
