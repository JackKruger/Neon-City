import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Assets } from './Assets';
import { Input } from './Input';
import { Viewports } from '../render/Viewports';
import { Hud } from '../ui/Hud';
import { buildMapCanvas } from '../ui/Minimap';
import { MapOverlay } from '../ui/MapOverlay';
import { AudioSys } from './AudioSys';
import { CIVILIAN_CARS, GRAVITY, PALETTE, STEP } from './const';
import { CITY_ASSETS, City } from '../world/City';
import {
  cellAt,
  cellToWorld,
  getAuthoredMap,
  nearestRoadCell,
  suburbNameAt,
  worldToCell,
} from '../world/CityMap';
import { loadAuthoredMap } from '../world/MapLoad';
import { Vehicle } from '../entities/Vehicle';
import { Player } from '../entities/Player';
import { Npcs } from '../world/Npcs';
import type { TrafficCar } from '../entities/TrafficCar';
import { Combat } from '../gameplay/Combat';
import { Fx } from '../render/Fx';
import { Pickup } from '../entities/Pickup';
import type { WeaponId } from '../gameplay/Weapons';
import { randomRoadCellNear } from '../world/RoadGraph';

export interface Entity {
  update(dt: number): void;
}

const PRELOAD = [...CIVILIAN_CARS, 'cars/police', ...CITY_ASSETS];

export class Game {
  readonly scene = new THREE.Scene();
  readonly renderer: THREE.WebGLRenderer;
  readonly world: RAPIER.World;
  readonly eventQueue = new RAPIER.EventQueue(true);
  readonly assets: Assets;
  readonly input = new Input();
  readonly viewports: Viewports;
  readonly hud: Hud;
  readonly mapOverlay: MapOverlay;
  readonly entities: Entity[] = [];

  private clock = new THREE.Clock();
  private accumulator = 0;
  private debugCam = false;
  private suburbCache: { cx: number; cz: number; name: string | null }[] = [];

  readonly vehicles: Vehicle[] = [];
  readonly players: Player[] = [];
  readonly audio = new AudioSys();
  readonly combat = new Combat(this);
  readonly fx = new Fx(this.scene);
  readonly pickups: Pickup[] = [];
  /** Chance a spawned pedestrian fights back when attacked (debug: ?brawlers). */
  pedBraveChance = 0.25;
  readonly city: City;
  npcs!: Npcs;
  paused = false;

  static async create(container: HTMLElement): Promise<Game> {
    const [assets] = await Promise.all([
      (async () => {
        const a = new Assets();
        await a.preload(PRELOAD);
        return a;
      })(),
      RAPIER.init(),
      loadAuthoredMap('melbourne'),
    ]);
    return new Game(container, assets);
  }

  private constructor(container: HTMLElement, assets: Assets) {
    this.assets = assets;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    window.addEventListener('resize', () => {
      this.renderer.setSize(container.clientWidth, container.clientHeight);
      this.viewports.updateAspects();
    });

    this.world = new RAPIER.World(new RAPIER.Vector3(0, GRAVITY, 0));
    this.world.timestep = STEP;

    this.viewports = new Viewports(this.renderer);
    this.viewports.setPlayerCount(1);
    this.hud = new Hud(container);
    const map = getAuthoredMap();
    if (!map) throw new Error('authored map was not loaded before game construction');
    const mapCanvas = buildMapCanvas(map);
    this.hud.setMapCanvas(mapCanvas, map);
    this.hud.setPlayerCount(1);
    this.mapOverlay = new MapOverlay(container, map, mapCanvas);

    this.setupEnvironment();
    // The Kenney asphalt is nearly sand-colored; darken it well below the
    // pavement gray so streets read as streets against the sidewalks.
    for (const name of CITY_ASSETS) {
      if (name.startsWith('roads/road-')) this.assets.tint(name, 0x666c7c);
    }
    this.city = new City(this);
    const requestedSpawn = map.spawn ?? { x: 3, z: 24 };
    const requestedCell = worldToCell(requestedSpawn.x, requestedSpawn.z);
    const safeSpawnCell = nearestRoadCell(requestedCell.cx, requestedCell.cz);
    const spawn = safeSpawnCell
      ? cellToWorld(safeSpawnCell.cx, safeSpawnCell.cz)
      : requestedSpawn;
    this.city.prewarm(spawn.x, spawn.z);
    // Register freshly-created fixed colliders with Rapier's scene queries so
    // the first character can raycast its exact spawn surface immediately.
    this.world.step(this.eventQueue);

    const p1 = new Player(this, 0, spawn.x, spawn.z);
    this.players.push(p1);
    this.entities.push(p1);

    this.npcs = new Npcs(this);

    this.spawnStarterPickups(spawn.x, spawn.z);
    this.applyDebugParams();
  }

  /** Player XZ positions, for chunk streaming and spawn-ring sampling. */
  playerPositions(): { x: number; z: number }[] {
    return this.players.map((p) => {
      if (p.driving) {
        const t = p.vehicle!.body.translation();
        return { x: t.x, z: t.z };
      }
      const c = p.character.position();
      return { x: c.x, z: c.z };
    });
  }

  addVehicle(v: Vehicle): void {
    this.vehicles.push(v);
    this.entities.push(v);
  }

  removeVehicle(v: Vehicle): void {
    const vi = this.vehicles.indexOf(v);
    if (vi >= 0) this.vehicles.splice(vi, 1);
    const ei = this.entities.indexOf(v);
    if (ei >= 0) this.entities.splice(ei, 1);
    v.dispose();
  }

  /** Attribute a crime's wanted heat to a player (null: no witness/unknown). */
  reportCrime(player: Player | null, heat: number): void {
    player?.wanted.addHeat(heat);
  }

  /** Crime hooks from the NPC simulation. */
  onPedestrianKilled(vehicle: Vehicle): void {
    this.reportCrime(vehicle.driver instanceof Player ? vehicle.driver : null, 45);
  }

  onTrafficRammed(car: TrafficCar): void {
    // Attribute the hit to a player-driven vehicle close to the impact.
    const t = car.vehicle.body.translation();
    for (const p of this.players) {
      if (!p.driving) continue;
      const v = p.vehicle!.body.translation();
      if (Math.hypot(v.x - t.x, v.z - t.z) < 8) {
        p.wanted.addHeat(16);
        return;
      }
    }
  }

  /** Split the screen and drop player 2 next to player 1. */
  joinPlayer2(): void {
    if (this.players.length >= 2) return;
    const p1 = this.players[0];
    const pos = p1.driving
      ? new THREE.Vector3().copy(p1.vehicle!.root.position)
      : p1.character.position();
    const p2 = new Player(this, 1, pos.x + 2.5, pos.z + 2.5);
    this.players.push(p2);
    this.entities.push(p2);
    this.viewports.setPlayerCount(2);
    this.hud.setPlayerCount(2);
  }

  /** A few weapons scattered on streets near spawn until shops exist. */
  private spawnStarterPickups(x: number, z: number): void {
    const wanted: { weapon: WeaponId; ammo: number }[] = [
      { weapon: 'bat', ammo: 0 },
      { weapon: 'knife', ammo: 0 },
      { weapon: 'pistol', ammo: 24 },
    ];
    for (const item of wanted) {
      const cell = randomRoadCellNear(x, z, 8, 30);
      if (!cell) continue;
      const spot = cellToWorld(cell.cx, cell.cz);
      this.pickups.push(new Pickup(this, item.weapon, item.ammo, spot.x, 0, spot.z));
    }
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

  private setupEnvironment(): void {
    this.scene.background = new THREE.Color(PALETTE.sky);
    // Fog far sits just inside the guaranteed chunk-loaded distance so new
    // chunks always materialize fully fogged (no visible pop-in).
    this.scene.fog = new THREE.Fog(PALETTE.fogColor, 60, 230);

    const hemi = new THREE.HemisphereLight(0xffe4c8, 0x6b5b8a, 1.15);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffcf90, 1.7);
    sun.position.set(-80, 100, 40);
    this.scene.add(sun);
  }

  start(): void {
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private frame(): void {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.input.poll();
    this.mapOverlay.setPlayers(
      this.playerPositions().map((pos, i) => ({ ...pos, heading: this.players[i].getHeading() }))
    );
    if (this.input.p2JoinRequested) {
      this.input.p2JoinRequested = false;
      this.joinPlayer2();
    }
    const pausePressed = this.input.consumePause();
    const mapPressed = this.input.consumeMapToggle();
    if (pausePressed) {
      if (this.mapOverlay.isOpen) {
        this.mapOverlay.close();
      } else {
        this.paused = !this.paused;
        this.hud.setPaused(this.paused);
        if (!this.paused) this.input.clearGameplayEdges();
      }
    }
    if (mapPressed && !pausePressed && !this.paused) {
      if (this.mapOverlay.isOpen) this.mapOverlay.close();
      else this.mapOverlay.open();
    }
    // Clicks and presses made while browsing the map shouldn't fire weapons.
    if (this.mapOverlay.isOpen) this.input.clearGameplayEdges();
    if (!this.paused) {
      this.accumulator += dt;
      while (this.accumulator >= STEP) {
        this.fixedUpdate();
        this.accumulator -= STEP;
      }
    }
    const positions = this.playerPositions();
    this.city.update(positions);
    if (!this.paused) this.fx.update(dt);
    if (this.paused) this.audio.duck();
    else this.updateAudio(dt);
    this.mapOverlay.setPlayers(
      positions.map((pos, i) => ({ ...pos, heading: this.players[i].getHeading() }))
    );
    const pan = this.input.mapPanAxes();
    this.mapOverlay.update(dt, pan.x, pan.y);
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      const pos = positions[i];
      if (!this.debugCam) this.viewports.cameras[i]?.update(p, dt);
      const def = p.inventory.def();
      this.hud.update(i, {
        speedKmh: p.driving ? p.vehicle!.speedKmh() : undefined,
        prompt: p.prompt ?? undefined,
        stars: p.wanted.stars,
        money: p.money,
        weapon: p.driving ? undefined : def.name,
        ammoMag: !p.driving && def.kind === 'gun' ? p.inventory.magCount() : undefined,
        ammoReserve: !p.driving && def.kind === 'gun' ? p.inventory.reserveCount() : undefined,
        health: p.health / 100,
        armour: p.armour / 100,
        message: p.hudMessage ?? undefined,
        pos,
        heading: p.getHeading(),
        suburb: this.suburbAt(i, pos.x, pos.z),
        cops: p.wanted.police.map((cop) => {
          const t = cop.vehicle.body.translation();
          return { x: t.x, z: t.z };
        }),
      });
    }
    this.viewports.render(this.scene);
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
    for (const p of this.players) {
      if (p.vehicle) {
        speed = Math.max(speed, p.vehicle.getSpeed());
        throttle = Math.max(throttle, p.vehicle.command.throttle);
        skidding ||= p.vehicle.command.handbrake && p.vehicle.getSpeed() > 6;
      }
      for (const cop of p.wanted.police) {
        sirenDist = Math.min(sirenDist, cop.distanceToTarget());
      }
    }
    this.audio.update(dt, speed, throttle, skidding, sirenDist);
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
    this.npcs.afterPhysics();
  }
}
