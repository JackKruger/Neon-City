import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Assets } from './Assets';
import { Input } from './Input';
import { Viewports } from '../render/Viewports';
import { Hud } from '../ui/Hud';
import { AudioSys } from './AudioSys';
import { GRAVITY, PALETTE, STEP, TILE } from './const';
import { CITY_ASSETS, City } from '../world/City';
import { MAP_H, MAP_W, cellHash, cellToWorld, isRoad, roadMask } from '../world/CityMap';
import { Vehicle } from '../entities/Vehicle';
import { Player } from '../entities/Player';
import { Npcs, PED_MODELS } from '../world/Npcs';
import type { TrafficCar } from '../entities/TrafficCar';

export interface Entity {
  update(dt: number): void;
}

export const CIVILIAN_CARS = [
  'cars/sedan',
  'cars/sedan-sports',
  'cars/hatchback-sports',
  'cars/suv',
  'cars/suv-luxury',
  'cars/taxi',
  'cars/van',
  'cars/truck',
];
const PRELOAD = [
  ...CIVILIAN_CARS,
  'cars/police',
  'characters/character-a',
  'characters/character-b',
  ...PED_MODELS,
  ...CITY_ASSETS,
];

export class Game {
  readonly scene = new THREE.Scene();
  readonly renderer: THREE.WebGLRenderer;
  readonly world: RAPIER.World;
  readonly eventQueue = new RAPIER.EventQueue(true);
  readonly assets: Assets;
  readonly input = new Input();
  readonly viewports: Viewports;
  readonly hud: Hud;
  readonly entities: Entity[] = [];

  private clock = new THREE.Clock();
  private accumulator = 0;
  private debugCam = false;

  readonly vehicles: Vehicle[] = [];
  readonly players: Player[] = [];
  readonly audio = new AudioSys();
  npcs!: Npcs;
  paused = false;

  static async create(container: HTMLElement): Promise<Game> {
    await RAPIER.init();
    const assets = new Assets();
    await assets.preload(PRELOAD);
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
    this.hud.setPlayerCount(1);

    this.setupEnvironment();
    // The Kenney asphalt is nearly sand-colored; cool it down so streets read.
    for (const name of CITY_ASSETS) {
      if (name.startsWith('roads/road-')) this.assets.tint(name, 0x9fa3b0);
    }
    new City(this.scene, this.world, this.assets).build();
    this.spawnParkedCars();

    const p1 = new Player(this, 0, -6, 33.5);
    this.players.push(p1);
    this.entities.push(p1);

    this.npcs = new Npcs(this);

    this.applyDebugParams();
  }

  /** Parked cars on the right side of straight road tiles, spread over the map. */
  private spawnParkedCars(): void {
    let count = 0;
    for (let cz = 0; cz < MAP_H && count < 14; cz++) {
      for (let cx = 0; cx < MAP_W && count < 14; cx++) {
        if (!isRoad(cx, cz)) continue;
        const mask = roadMask(cx, cz);
        if (mask !== 5 && mask !== 10) continue; // straight segments only
        if (cellHash(cx, cz, 40) > 0.28) continue;
        const { x, z } = cellToWorld(cx, cz);
        const along = mask === 5 ? 0 : Math.PI / 2; // heading along the road
        const side = cellHash(cx, cz, 41) < 0.5 ? 1 : -1;
        const off = TILE * 0.3 * side;
        const model = CIVILIAN_CARS[Math.floor(cellHash(cx, cz, 42) * CIVILIAN_CARS.length)];
        this.addVehicle(
          new Vehicle(
            this,
            model,
            x + (mask === 5 ? off : 0),
            z + (mask === 10 ? off : 0),
            along + (side < 0 ? Math.PI : 0)
          )
        );
        count++;
      }
    }
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

  /** Crime hooks from the NPC simulation. */
  onPedestrianKilled(vehicle: Vehicle): void {
    if (vehicle.driver instanceof Player) vehicle.driver.wanted.addHeat(45);
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

  private applyDebugParams(): void {
    const params = new URLSearchParams(location.search);
    if (params.has('nofog')) this.scene.fog = null;
    if (params.has('testcar')) {
      this.addVehicle(new Vehicle(this, 'cars/taxi', -6, 37, Math.PI / 2));
    }
    if (params.has('p2')) this.joinPlayer2();
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
    this.scene.fog = new THREE.Fog(PALETTE.fogColor, 90, 460);

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
    if (this.input.p2JoinRequested) {
      this.input.p2JoinRequested = false;
      this.joinPlayer2();
    }
    if (this.input.consumePause()) {
      this.paused = !this.paused;
      this.hud.setPaused(this.paused);
    }
    if (!this.paused) {
      this.accumulator += dt;
      while (this.accumulator >= STEP) {
        this.fixedUpdate();
        this.accumulator -= STEP;
      }
    }
    this.updateAudio(dt);
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (!this.debugCam) this.viewports.cameras[i]?.update(p, dt);
      this.hud.update(i, {
        speedKmh: p.driving ? p.vehicle!.speedKmh() : undefined,
        prompt: p.prompt ?? undefined,
        stars: p.wanted.stars,
      });
    }
    this.viewports.render(this.scene);
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
    this.world.step(this.eventQueue);
  }
}
