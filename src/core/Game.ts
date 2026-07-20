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
import { CompiledCity } from '../world/CompiledCity';
import {
  cellAt,
  bridgeSurfaceHeightAt,
  getAuthoredMap,
  heightAt,
  roadInfoAt,
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
import { nearestRoadPoint, pointWorld, randomRoadCellNear } from '../world/RoadGraph';
import { Settings } from './Settings';
import { WorldLighting, type WeatherKind } from '../world/WorldLighting';
import { DevStats, type DevStatsSnapshot } from './DevStats';
import { restoreAtomically, SaveController } from '../save/SaveController';
import { createGameSave, type GameSaveV1, type SaveResult } from '../save/GameSave';
import { SaveStorage } from '../save/SaveStorage';
import { CheatMenu } from '../ui/CheatMenu';

export interface Entity {
  update(dt: number): void;
}

const ACTOR_ASSETS = [...CIVILIAN_CARS, 'cars/police', 'cars/debris-door-window'];
const MAX_FIXED_STEPS_PER_FRAME = 3;
const VEHICLE_GRID_CELL_SIZE = 24;

interface FixedUpdateTiming {
  npcMs: number;
  actorMs: number;
  physicsMs: number;
  postPhysicsMs: number;
}

interface SimulationTiming extends FixedUpdateTiming {
  simulationMs: number;
  fixedSteps: number;
}

export class Game {
  private events = new AbortController();
  private disposed = false;
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
  readonly devStats: DevStats;
  readonly cheatMenu: CheatMenu | null;
  readonly mapOverlay: MapOverlay | null;
  readonly saveStorage: SaveStorage;
  readonly saveController: SaveController;
  readonly entities: Entity[] = [];

  private clock = new THREE.Clock();
  private accumulator = 0;
  private previousFrameStart = performance.now();
  private debugCam = false;
  private suburbCache: { cx: number; cz: number; name: string | null }[] = [];
  private vehicleGrid = new Map<number, Map<number, Drivable[]>>();
  private maximumVehicleSpeed = 0;
  private pausedBeforeCheats = false;

  readonly vehicles: Drivable[] = [];
  readonly players: Player[] = [];
  readonly audio = new AudioSys();
  readonly combat = new Combat(this);
  readonly fx = new Fx(
    this.scene,
    (x, z, ceilingY) => this.surfaceHeightBelow(x, z, ceilingY, 12)
  );
  readonly pickups: Pickup[] = [];
  /** Chance a spawned pedestrian fights back when attacked (debug: ?brawlers). */
  pedBraveChance = 0.25;
  readonly city: CompiledCity;
  npcs!: Npcs;
  paused = false;

  static async create(
    container: HTMLElement,
    initialSave?: GameSaveV1,
    saveStorage = SaveStorage.browser()
  ): Promise<Game> {
    const [assets] = await Promise.all([
      (async () => {
        const a = new Assets();
        await a.preload(ACTOR_ASSETS);
        return a;
      })(),
      RAPIER.init(),
      loadAuthoredMap('melbourne', { loadObjects: false }),
    ]);
    const game = new Game(container, assets, saveStorage);
    try {
      await game.initialize(initialSave);
      return game;
    } catch (error) {
      game.dispose();
      throw error;
    }
  }

  private constructor(container: HTMLElement, assets: Assets, saveStorage: SaveStorage) {
    this.assets = assets;
    this.saveStorage = saveStorage;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
    this.devStats = new DevStats(container, this.renderer);
    this.input.attachPointerLock(this.renderer.domElement);

    window.addEventListener('resize', () => {
      this.renderer.setSize(container.clientWidth, container.clientHeight);
      this.viewports.updateAspects();
    }, { signal: this.events.signal });

    this.world = new RAPIER.World(new RAPIER.Vector3(0, GRAVITY, 0));
    this.world.timestep = STEP;

    this.viewports = new Viewports(this.renderer, (target, focus, desired, out) => {
      this.resolveCameraCollision(target, focus, desired, out);
    });
    this.hud = new Hud(container, this.settings);
    this.hud.setSaveActions({
      inspect: () => this.saveStorage.read(),
      save: () => this.saveNow(),
      load: () => this.loadSave(),
      delete: () => this.saveStorage.delete(),
    });
    this.audio.onCaption = (text) => this.hud.showCaption(text);
    const map = getAuthoredMap();
    const mapCanvas = map ? buildMapCanvas(map) : null;
    if (map && mapCanvas) this.hud.setMapCanvas(mapCanvas, map);
    this.hud.setPlayerCount(1);
    this.mapOverlay = map && mapCanvas ? new MapOverlay(container, map, mapCanvas) : null;

    this.lighting = this.setupEnvironment();
    const params = new URLSearchParams(location.search);
    const cheatsEnabled = params.get('dev') !== '0' && (import.meta.env.DEV || params.has('dev'));
    this.cheatMenu = cheatsEnabled ? new CheatMenu(container, {
      inspect: () => {
        const player = this.players[0];
        return {
          time: this.lighting.currentTime,
          timeLocked: this.lighting.isTimeLocked,
          weather: this.lighting.weatherKind,
          weatherLock: this.lighting.lockedWeather,
          invincible: player?.invincible ?? false,
          wantedLock: player?.wanted.lockedLevel ?? null,
          hasRepairableVehicle: player?.vehicle instanceof Vehicle,
        };
      },
      setTime: (time) => this.lighting.setTime(time),
      setTimeLocked: (locked) => this.lighting.setTimeLocked(locked),
      setWeatherLock: (weather: WeatherKind | null) => this.lighting.setWeatherLock(weather),
      setInvincible: (enabled) => {
        for (const player of this.players) player.invincible = enabled;
      },
      setWantedLock: (stars) => {
        for (const player of this.players) player.wanted.setLockedLevel(stars);
      },
      restoreVitals: () => {
        for (const player of this.players) player.restoreVitals();
      },
      giveArsenal: () => {
        for (const player of this.players) player.inventory.giveAll();
      },
      repairVehicle: () => {
        const vehicle = this.players[0]?.vehicle;
        if (vehicle instanceof Vehicle) vehicle.repair();
      },
      setOpen: (open) => this.setCheatMenuOpen(open),
    }) : null;
    this.city = new CompiledCity(this);
    this.saveController = new SaveController(
      () => this.players[0]?.canSave === true,
      () => { this.saveNow(); }
    );
    window.addEventListener('pagehide', () => { this.saveController.saveForPageHide(); }, { signal: this.events.signal });
  }

  /** Tear down a partially-created game after startup fails. */
  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.events.abort();
    this.mapOverlay?.dispose();
    this.cheatMenu?.dispose();
    this.city.dispose();
    this.lighting.dispose();
    this.hud.dispose();
    this.devStats.dispose();
    this.input.dispose();
    this.audio.dispose();
    if (document.pointerLockElement === this.renderer.domElement) void document.exitPointerLock?.();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.eventQueue.free();
    this.world.free();
  }

  private async initialize(initialSave?: GameSaveV1): Promise<void> {
    const map = getAuthoredMap();
    const requestedSpawn = initialSave?.player.position ?? map?.spawn ?? { x: 0, z: 0 };
    await this.city.prewarm(requestedSpawn.x, requestedSpawn.z);
    const safeSpawnPoint = initialSave
      ? null
      : nearestRoadPoint(requestedSpawn.x, requestedSpawn.z, 'pedestrian');
    const spawn = safeSpawnPoint ? pointWorld(safeSpawnPoint) : requestedSpawn;
    // Register freshly-created fixed colliders with Rapier's scene queries so
    // the first character can raycast its exact spawn surface immediately.
    this.world.step(this.eventQueue);

    const p1 = new Player(this, 0, spawn.x, spawn.z);
    this.players.push(p1);
    this.entities.push(p1);
    if (initialSave) p1.restoreSaveState(initialSave.player);

    this.npcs = new Npcs(this);

    this.spawnStarterPickups(spawn.x, spawn.z);
    this.spawnHelicopter(spawn.x, spawn.z);
    this.applyDebugParams();
  }

  saveNow(): SaveResult<GameSaveV1> {
    const player = this.players[0];
    if (!player?.canSave) {
      return { ok: false, error: { code: 'unsafe', message: 'Cannot save while dead, downed, or entering/exiting a vehicle.' } };
    }
    try {
      const save = createGameSave(player.captureSaveState(), Math.max(0, Math.floor(this.saveStorage.clock.now())));
      return this.saveStorage.write(save);
    } catch (error) {
      return { ok: false, error: { code: 'unsafe', message: error instanceof Error ? error.message : 'The game is temporarily unsafe to save.' } };
    }
  }

  async loadSave(): Promise<SaveResult<GameSaveV1>> {
    return restoreAtomically(
      () => this.saveStorage.read(),
      (save) => this.city.prewarm(save.player.position.x, save.player.position.z),
      (save) => {
        this.players[0].restoreSaveState(save.player);
        this.accumulator = 0;
        this.city.update(this.playerPositions());
        this.mapOverlay?.close();
        this.paused = true;
        this.hud.setPaused(true);
        document.exitPointerLock?.();
      }
    );
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

  /** Rolling diagnostics exposed for browser tooling and benchmark capture. */
  performanceSnapshot(): DevStatsSnapshot {
    return this.devStats.snapshot();
  }

  /** Highest fixed world surface below a nearby actor. Unlike `heightAt`, this
   * can resolve a bridge deck without turning the terrain beneath it solid. */
  surfaceHeightBelow(
    x: number,
    z: number,
    ceilingY: number,
    maxDistance = 16,
    excludeBody?: RAPIER.RigidBody
  ): number {
    const ray = new RAPIER.Ray(
      new RAPIER.Vector3(x, ceilingY, z),
      new RAPIER.Vector3(0, -1, 0)
    );
    const hit = this.world.castRay(
      ray,
      maxDistance,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC,
      undefined,
      undefined,
      excludeBody
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

  /** Check the actual oriented chassis bounds before materialising a car. */
  vehicleSpawnIsClear(x: number, z: number, heading: number): boolean {
    return this.vehicles.every((vehicle) => {
      if (vehicle instanceof Vehicle) return !vehicle.overlapsSpawnFootprint(x, z, heading);
      const position = vehicle.body.translation();
      return Math.hypot(position.x - x, position.z - z) >= 7;
    });
  }

  /** True when a streamed tram currently occupies this road position. */
  transitBlocksRoad(x: number, z: number): boolean {
    return this.city.transit.blocksRoad(x, z);
  }

  /** Fill `out` with vehicles whose chassis origins lie within `radius`.
   * The fixed-step spatial index keeps local AI queries independent of the
   * total number of parked cars in streamed chunks. */
  vehiclesNear(x: number, z: number, radius: number, out: Drivable[]): Drivable[] {
    out.length = 0;
    const minX = Math.floor((x - radius) / VEHICLE_GRID_CELL_SIZE);
    const maxX = Math.floor((x + radius) / VEHICLE_GRID_CELL_SIZE);
    const minZ = Math.floor((z - radius) / VEHICLE_GRID_CELL_SIZE);
    const maxZ = Math.floor((z + radius) / VEHICLE_GRID_CELL_SIZE);
    const radiusSq = radius * radius;
    for (let gx = minX; gx <= maxX; gx++) {
      const column = this.vehicleGrid.get(gx);
      if (!column) continue;
      for (let gz = minZ; gz <= maxZ; gz++) {
        const bucket = column.get(gz);
        if (!bucket) continue;
        for (const vehicle of bucket) {
          const position = vehicle.body.translation();
          const dx = position.x - x;
          const dz = position.z - z;
          if (dx * dx + dz * dz <= radiusSq) out.push(vehicle);
        }
      }
    }
    return out;
  }

  /** Query every vehicle that could reach a radius within a prediction
   * window, including unusually fast crash/explosion velocities. */
  vehiclesNearPredicted(
    x: number,
    z: number,
    seconds: number,
    radius: number,
    out: Drivable[]
  ): Drivable[] {
    return this.vehiclesNear(x, z, radius + this.maximumVehicleSpeed * seconds, out);
  }

  removeVehicle(v: Drivable): void {
    const vi = this.vehicles.indexOf(v);
    const ei = this.entities.indexOf(v);
    this.removeVehicleFromGrid(v);
    if (vi < 0 && ei < 0) return;
    this.npcs?.prepareVehicleRemoval(v);
    if (vi >= 0) this.vehicles.splice(vi, 1);
    if (ei >= 0) this.entities.splice(ei, 1);
    if (v instanceof Vehicle) this.city?.forgetVehicle(v);
    v.dispose();
  }

  /** Evict a vehicle before its Rapier body is freed. The grid is rebuilt at
   * the start of each fixed step, but NPC recycling can remove vehicles later
   * in that same step before player and pedestrian queries run. */
  private removeVehicleFromGrid(vehicle: Drivable): void {
    for (const column of this.vehicleGrid.values()) {
      for (const bucket of column.values()) {
        const index = bucket.indexOf(vehicle);
        if (index >= 0) bucket.splice(index, 1);
      }
    }
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

  /** Every usable weapon, arranged in a deterministic ring around spawn. */
  private spawnStarterPickups(x: number, z: number): void {
    const wanted = WEAPON_ORDER.filter(
      (weapon): weapon is Exclude<WeaponId, 'fists'> => weapon !== 'fists'
    );
    const placed: { x: number; z: number }[] = [];
    for (let i = 0; i < wanted.length; i++) {
      const weapon = wanted[i];
      const def = WEAPONS[weapon];
      const angle = -Math.PI * 0.8 + (i / Math.max(1, wanted.length - 1)) * Math.PI * 1.6;
      const px = x + Math.sin(angle) * 5;
      const pz = z + Math.cos(angle) * 5;
      const footpath = nearestRoadPoint(px, pz, 'pedestrian');
      const snapped = footpath ? pointWorld(footpath) : null;
      // A sparse graph can return the player's own node for several nearby
      // targets. Keep the original ring point rather than stacking pickups or
      // awarding one immediately at startup.
      const position = snapped && Math.hypot(snapped.x - x, snapped.z - z) >= 2.5 &&
        placed.every((other) => Math.hypot(snapped.x - other.x, snapped.z - other.z) >= 1.5)
        ? snapped
        : { x: px, z: pz };
      placed.push(position);
      const ammo = def.kind === 'gun' ? def.magSize * 5 : 0;
      this.pickups.push(new Pickup(
        this,
        weapon,
        ammo,
        position.x,
        heightAt(position.x, position.z),
        position.z
      ));
    }
  }

  /** Put a flyable helicopter on a nearby road-sized clear patch. */
  private spawnHelicopter(x: number, z: number): void {
    let cell = randomRoadCellNear(x, z, 10, 24);
    for (let attempt = 1; !cell && attempt < 10; attempt++) {
      cell = randomRoadCellNear(x, z, 10, 24);
    }
    const spot = cell ? pointWorld(cell) : { x: x + 12, z };
    this.addVehicle(new Helicopter(this, spot.x, spot.z, 0));
  }

  private applyDebugParams(): void {
    const params = new URLSearchParams(location.search);
    if (params.has('nofog')) this.scene.fog = null;
    if (params.has('testcar')) {
      const s = getAuthoredMap()?.spawn ?? { x: 3, z: 24 };
      this.addVehicle(new Vehicle(this, 'cars/taxi', s.x, s.z + 12, 0));
    }
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
    this.previousFrameStart = performance.now();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private frame(): void {
    const frameStarted = performance.now();
    const frameMs = frameStarted - this.previousFrameStart;
    this.previousFrameStart = frameStarted;
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.input.poll();
    this.handlePauseAndMapInput();
    const simulation = this.advanceFixedSteps(dt);
    const { positions, streamingMs } = this.updateStreamingAndEnvironment(dt);
    this.updateCamerasAndHud(dt, positions);
    this.renderAndRecord(frameStarted, frameMs, streamingMs, simulation);
  }

  private handlePauseAndMapInput(): void {
    const pausePressed = this.input.consumePause();
    const mapPressed = this.input.consumeMapToggle();
    if (this.cheatMenu?.isOpen) {
      if (pausePressed) this.cheatMenu.setOpen(false);
      return;
    }
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
  }

  private setCheatMenuOpen(open: boolean): void {
    this.input.clearQueuedInput();
    if (open) {
      this.pausedBeforeCheats = this.paused;
      this.paused = true;
      this.hud.setPaused(false);
      this.mapOverlay?.close();
      document.exitPointerLock?.();
      return;
    }
    this.paused = this.pausedBeforeCheats;
    this.hud.setPaused(this.paused);
  }

  private advanceFixedSteps(dt: number): SimulationTiming {
    let simulationMs = 0;
    let npcMs = 0;
    let actorMs = 0;
    let physicsMs = 0;
    let postPhysicsMs = 0;
    let fixedSteps = 0;
    if (!this.paused) {
      this.accumulator += dt;
      while (this.accumulator >= STEP && fixedSteps < MAX_FIXED_STEPS_PER_FRAME) {
        const simulationStarted = performance.now();
        const timing = this.fixedUpdate();
        npcMs += timing.npcMs;
        actorMs += timing.actorMs;
        physicsMs += timing.physicsMs;
        postPhysicsMs += timing.postPhysicsMs;
        simulationMs += performance.now() - simulationStarted;
        fixedSteps++;
        this.accumulator -= STEP;
      }
      // A busy frame must not create an ever-growing simulation backlog. All
      // gameplay still advances in fixed STEP increments; excess wall time is
      // deliberately dropped after the bounded catch-up attempt.
      if (this.accumulator >= STEP) this.accumulator %= STEP;
      this.saveController.update(dt);
    }
    return { simulationMs, npcMs, actorMs, physicsMs, postPhysicsMs, fixedSteps };
  }

  private updateStreamingAndEnvironment(dt: number): { positions: { x: number; z: number }[]; streamingMs: number } {
    const positions = this.playerPositions();
    const streamingStarted = performance.now();
    this.city.update(positions);
    const streamingMs = performance.now() - streamingStarted;
    this.lighting.update(this.paused ? 0 : dt, positions);
    if (!this.paused) this.fx.update(dt);
    if (this.paused) this.audio.duck();
    else this.updateAudio(dt);
    this.mapOverlay?.setPlayers(
      positions.map((pos, i) => ({ ...pos, heading: this.players[i].getHeading() }))
    );
    const pan = this.input.mapPanAxes();
    this.mapOverlay?.update(dt, pan.x, pan.y);
    return { positions, streamingMs };
  }

  private updateCamerasAndHud(dt: number, positions: { x: number; z: number }[]): void {
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
        this.viewports.cameras[i]?.update(
          p,
          dt,
          look,
          this.settings.values.reducedMotion,
          p.driving,
          !p.driving
        );
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
        transit: this.city.transit.positions(),
      });
    }
    this.hud.setInputMethods(this.players.map((player) => this.input.inputMethod(player.index)));
  }

  private renderAndRecord(
    frameStarted: number,
    frameMs: number,
    streamingMs: number,
    simulation: SimulationTiming
  ): void {
    const renderStarted = performance.now();
    this.viewports.render(this.scene);
    const renderMs = performance.now() - renderStarted;
    const police = this.players.reduce(
      (sum, player) => sum + player.wanted.police.length + player.wanted.copPeds.length,
      0
    );
    this.devStats.record(
      {
        frameMs,
        cpuMs: performance.now() - frameStarted,
        simulationMs: simulation.simulationMs,
        npcMs: simulation.npcMs,
        actorMs: simulation.actorMs,
        physicsMs: simulation.physicsMs,
        postPhysicsMs: simulation.postPhysicsMs,
        streamingMs,
        renderMs,
        fixedSteps: simulation.fixedSteps,
      },
      {
        stream: this.city.stats(),
        pedestrians: this.npcs.peds.length,
        traffic: this.npcs.traffic.length,
        transit: this.city.transit.vehicles.length,
        vehicles: this.vehicles.length,
        police,
        pickups: this.pickups.length,
        dynamicLights: this.lighting.activeLightCount,
        weather: this.lighting.weatherKind,
        bodies: this.world.bodies.len(),
        colliders: this.world.colliders.len(),
      }
    );
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
    let engineActive = false;
    let skidding = false;
    let sirenDist = Infinity;
    let walking = false;
    let running = false;
    for (const p of this.players) {
      if (p.vehicle) {
        engineActive = true;
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
      this.lighting.rainAmount,
      engineActive
    );
  }

  private fixedUpdate(): FixedUpdateTiming {
    const controlsEnabled = !this.mapOverlay?.isOpen;
    for (const p of this.players) {
      p.input = this.input.read(p.index, controlsEnabled);
      p.cameraYaw = this.viewports.cameras[p.index]?.yaw() ?? 0;
    }
    this.rebuildVehicleGrid();
    this.city.fixedUpdate(STEP);
    const npcStarted = performance.now();
    this.npcs.update(STEP);
    const npcMs = performance.now() - npcStarted;
    const actorStarted = performance.now();
    for (const e of this.entities) e.update(STEP);
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      this.pickups[i].update(STEP);
      if (this.pickups[i].collected) this.pickups.splice(i, 1);
    }
    const actorMs = performance.now() - actorStarted;
    const physicsStarted = performance.now();
    this.world.step(this.eventQueue);
    const physicsMs = performance.now() - physicsStarted;
    const postPhysicsStarted = performance.now();
    for (const vehicle of this.vehicles) vehicle.afterPhysics();
    this.city.afterPhysics();
    this.npcs.afterPhysics();
    const postPhysicsMs = performance.now() - postPhysicsStarted;
    return { npcMs, actorMs, physicsMs, postPhysicsMs };
  }

  private rebuildVehicleGrid(): void {
    this.maximumVehicleSpeed = 0;
    for (const column of this.vehicleGrid.values()) {
      for (const bucket of column.values()) bucket.length = 0;
    }
    for (const vehicle of this.vehicles) {
      const position = vehicle.body.translation();
      const velocity = vehicle.body.linvel();
      this.maximumVehicleSpeed = Math.max(
        this.maximumVehicleSpeed,
        Math.hypot(velocity.x, velocity.z)
      );
      const gx = Math.floor(position.x / VEHICLE_GRID_CELL_SIZE);
      const gz = Math.floor(position.z / VEHICLE_GRID_CELL_SIZE);
      let column = this.vehicleGrid.get(gx);
      if (!column) {
        column = new Map();
        this.vehicleGrid.set(gx, column);
      }
      let bucket = column.get(gz);
      if (!bucket) {
        bucket = [];
        column.set(gz, bucket);
      }
      bucket.push(vehicle);
    }
  }
}
