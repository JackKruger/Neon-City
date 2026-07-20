import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Game } from '../core/Game';
import { CIVILIAN_CARS } from '../core/const';
import { Pedestrian } from '../entities/Pedestrian';
import type { Outfit } from '../entities/HumanRig';
import { TrafficCar } from '../entities/TrafficCar';
import type { Drivable } from '../entities/Drivable';
import { Vehicle } from '../entities/Vehicle';
import {
  CellRef,
  NavigationMode,
  nearestRoadPoint,
  pointWorld,
  randomRoadCellNear,
  roadNeighbors,
} from './RoadGraph';

const MAX_PEDS = 26;
const MAX_TRAFFIC = 12;
const MAX_TRAFFIC_BODIES = MAX_TRAFFIC + 8;
const SPAWN_MIN = 45;
const SPAWN_MAX = 100;
const DESPAWN = 140;
const MIN_CONTACT_SPEED = 0.65;
const RAGDOLL_IMPACT_SPEED = 4.5;
const MAX_PLAYER_VEHICLE_DAMAGE = 45;
const SIGNAL_GREEN = new THREE.Color(0x3cff88);
const SIGNAL_RED = new THREE.Color(0xff365f);

interface TrafficSignalVisual {
  root: THREE.Group;
  northSouth: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  eastWest: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  lastSeen: number;
}

const SKINS = [0xffdbc4, 0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0x5c3a21];
const HAIRS = [0x241b17, 0x4a2f23, 0x8c5a3c, 0xb5651d, 0xd8c6a0, 0x707580, 0x1a1a2e];
const SHIRTS = [
  0x29c5f6, 0xff5f9e, 0xffd166, 0x9b5de5, 0x00f5d4, 0xf15bb5, 0xf5f5f5, 0x2b2d42, 0xef476f,
  0x06d6a0, 0xff9f1c,
];
const PANTS = [0x2b2d42, 0x3a5068, 0x555b6e, 0x1d3557, 0x6d597a, 0x8a5a44, 0x14213d, 0x444444];
const SHOES = [0xf5f5f5, 0x22223b, 0x9a8c98, 0xe07a5f, 0x333333];

function pick(colors: number[]): number {
  return colors[Math.floor(Math.random() * colors.length)];
}

function randomOutfit(): Outfit {
  return {
    skin: pick(SKINS),
    hair: pick(HAIRS),
    shirt: pick(SHIRTS),
    pants: pick(PANTS),
    shoes: pick(SHOES),
  };
}

/** Keeps a budget of pedestrians and traffic alive in a ring around players. */
export class Npcs {
  readonly peds: Pedestrian[] = [];
  readonly traffic: TrafficCar[] = [];
  private spawnTimer = 0;
  private vehicleChoiceTimer = 2;
  private signalClock = 0;
  private pendingEntries: { pedestrian: Pedestrian; vehicle: Vehicle }[] = [];
  private exitingDrivers = new Map<Drivable, Pedestrian>();
  private trafficSignals = new Map<string, TrafficSignalVisual>();
  private nearbyVehicles: Drivable[] = [];

  constructor(private game: Game) {}

  update(dt: number): void {
    this.signalClock += dt;
    for (const p of this.peds) p.update(dt);
    for (const t of this.traffic) t.update(dt);
    this.finishPendingEntries();

    this.vehicleChoiceTimer -= dt;
    if (this.vehicleChoiceTimer <= 0) {
      this.vehicleChoiceTimer = 2.5 + Math.random() * 2;
      this.assignAbandonedVehicle();
    }

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 0.4;
      this.recycle();
      if (this.peds.length < MAX_PEDS) this.spawnPed();
      const activeTraffic = this.traffic.filter(
        (traffic) => !traffic.crashed && !traffic.vehicle.destroyed && traffic.vehicle.driver === traffic
      ).length;
      if (activeTraffic < MAX_TRAFFIC && this.traffic.length < MAX_TRAFFIC_BODIES) this.spawnTraffic();
    }
  }

  /** Resolve pedestrian impacts from the positions produced by the physics step. */
  afterPhysics(): void {
    this.checkVehicleImpacts();
  }

  private distToPlayers(x: number, z: number): number {
    let best = Infinity;
    for (const p of this.game.playerPositions()) {
      best = Math.min(best, Math.hypot(p.x - x, p.z - z));
    }
    return best;
  }

  private randomSpawnEdge(mode: NavigationMode): { from: CellRef; to: CellRef } | null {
    const players = this.game.playerPositions();
    for (let tries = 0; tries < 12; tries++) {
      const p = players[Math.floor(Math.random() * players.length)];
      const cell = randomRoadCellNear(p.x, p.z, SPAWN_MIN, SPAWN_MAX, mode);
      if (!cell) continue;
      // The ring is relative to one player; keep clear of the other too.
      const { x, z } = pointWorld(cell);
      if (this.distToPlayers(x, z) < SPAWN_MIN) continue;
      const neighbors = roadNeighbors(cell, mode);
      if (neighbors.length === 0) continue;
      const to = neighbors[Math.floor(Math.random() * neighbors.length)];
      return { from: cell, to };
    }
    return null;
  }

  private spawnPed(): void {
    const edge = this.randomSpawnEdge('pedestrian');
    if (!edge) return;
    const heightScale = 0.92 + Math.random() * 0.13;
    this.peds.push(new Pedestrian(this.game, randomOutfit(), heightScale, edge.from, edge.to));
  }

  private spawnTraffic(): void {
    const edge = this.randomSpawnEdge('vehicle');
    if (!edge) return;
    const model = CIVILIAN_CARS[Math.floor(Math.random() * CIVILIAN_CARS.length)];
    const profile = { outfit: randomOutfit(), heightScale: 0.94 + Math.random() * 0.1 };
    this.traffic.push(new TrafficCar(this.game, model, edge.from, edge.to, profile));
  }

  /** Alternating virtual signals at junctions; roads without a junction stay green. */
  trafficSignalAllows(from: CellRef, to: CellRef, surfaceCeiling: number): boolean {
    const exits = roadNeighbors(to, 'vehicle');
    const junction = exits.length >= (to.x === undefined ? 3 : 2);
    if (!junction) return true;
    const a = pointWorld(from);
    const b = pointWorld(to);
    const northSouth = Math.abs(b.z - a.z) >= Math.abs(b.x - a.x);
    const offset = Math.abs((to.cx * 17 + to.cz * 31) % 5);
    const phase = (this.signalClock + offset) % 16;
    // A short all-red interval gives pedestrians and crossing traffic time to clear.
    const northSouthGreen = phase < 7;
    const eastWestGreen = phase >= 8 && phase < 15;
    this.updateTrafficSignalVisual(to, northSouthGreen, eastWestGreen, surfaceCeiling);
    return northSouth ? northSouthGreen : eastWestGreen;
  }

  private updateTrafficSignalVisual(
    to: CellRef,
    northSouthGreen: boolean,
    eastWestGreen: boolean,
    surfaceCeiling: number
  ): void {
    const world = pointWorld(to);
    const surfaceY = this.game.surfaceHeightBelow(world.x, world.z, surfaceCeiling);
    const key = `${to.cx},${to.cz},${Math.round(surfaceY * 2)}`;
    let signal = this.trafficSignals.get(key);
    if (!signal) {
      const root = new THREE.Group();
      root.position.set(world.x, surfaceY, world.z);
      const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x252a35, roughness: 0.75, metalness: 0.3 });
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.12, 3.2, 0.12), poleMaterial);
      pole.position.set(2.8, 1.6, 2.8);
      root.add(pole);
      const makeHead = (x: number, z: number, rotation: number) => {
        const material = new THREE.MeshStandardMaterial({
          color: SIGNAL_RED,
          emissive: SIGNAL_RED,
          emissiveIntensity: 1.8,
          roughness: 0.35,
        });
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.58, 0.22), material);
        head.position.set(x, 3, z);
        head.rotation.y = rotation;
        root.add(head);
        return head;
      };
      signal = {
        root,
        northSouth: makeHead(2.8, 2.45, 0),
        eastWest: makeHead(2.45, 2.8, Math.PI / 2),
        lastSeen: this.signalClock,
      };
      this.game.scene.add(root);
      this.trafficSignals.set(key, signal);
    }
    signal.lastSeen = this.signalClock;
    this.setSignalColor(signal.northSouth.material, northSouthGreen ? SIGNAL_GREEN : SIGNAL_RED);
    this.setSignalColor(signal.eastWest.material, eastWestGreen ? SIGNAL_GREEN : SIGNAL_RED);
  }

  private setSignalColor(material: THREE.MeshStandardMaterial, color: THREE.Color): void {
    material.color.copy(color);
    material.emissive.copy(color);
  }

  /** Start a normal door animation when a shaken traffic driver abandons a car. */
  beginTrafficDriverExit(driver: TrafficCar): void {
    const vehicle = driver.vehicle;
    if (vehicle.driver !== driver || vehicle.destroyed) return;
    const side: 1 | -1 = 1; // right-hand-drive driver's door
    const doorway = vehicle.doorPosition(side, 0.9);
    const from = nearestRoadPoint(doorway.x, doorway.z, 'pedestrian');
    if (!from) {
      vehicle.driver = null;
      return;
    }
    const neighbors = roadNeighbors(from, 'pedestrian');
    if (neighbors.length === 0) {
      vehicle.driver = null;
      return;
    }
    const pedestrian = new Pedestrian(
      this.game,
      driver.driverProfile.outfit,
      driver.driverProfile.heightScale,
      from,
      neighbors[Math.floor(Math.random() * neighbors.length)],
      { x: doorway.x, z: doorway.z }
    );
    pedestrian.beginVehicleExit(vehicle, driver, side);
    this.peds.push(pedestrian);
    this.exitingDrivers.set(vehicle, pedestrian);
  }

  completeTrafficDriverExit(vehicle: Drivable, pedestrian: Pedestrian): void {
    if (this.exitingDrivers.get(vehicle) === pedestrian) this.exitingDrivers.delete(vehicle);
  }

  /** Remove manager-side references before a pedestrian is recycled mid-transition. */
  forgetPedestrian(pedestrian: Pedestrian): void {
    this.pendingEntries = this.pendingEntries.filter((entry) => entry.pedestrian !== pedestrian);
    for (const [vehicle, exiting] of this.exitingDrivers) {
      if (exiting === pedestrian) this.exitingDrivers.delete(vehicle);
    }
  }

  /** Clear every NPC reference before a vehicle's Rapier body is disposed. */
  prepareVehicleRemoval(vehicle: Drivable): void {
    if (vehicle instanceof Vehicle) {
      for (let i = this.pendingEntries.length - 1; i >= 0; i--) {
        const entry = this.pendingEntries[i];
        if (entry.vehicle !== vehicle) continue;
        entry.pedestrian.restoreAfterFailedVehicleEntry(vehicle);
        this.pendingEntries.splice(i, 1);
      }
      for (const pedestrian of this.peds) {
        pedestrian.cancelVehicleTransitionForRemoval(vehicle);
      }
    }
    this.exitingDrivers.delete(vehicle);
    for (let i = this.traffic.length - 1; i >= 0; i--) {
      if (this.traffic[i].vehicle === vehicle) this.traffic.splice(i, 1);
    }
  }

  /** Called at the end of the pedestrian's doorway animation. */
  completePedestrianVehicleEntry(pedestrian: Pedestrian, vehicle: Vehicle): void {
    if (!this.pendingEntries.some((entry) => entry.pedestrian === pedestrian)) {
      this.pendingEntries.push({ pedestrian, vehicle });
    }
  }

  private finishPendingEntries(): void {
    for (const { pedestrian, vehicle } of this.pendingEntries.splice(0)) {
      const driver = TrafficCar.occupy(this.game, vehicle, pedestrian.profile);
      if (!driver) {
        vehicle.driver = null;
        pedestrian.restoreAfterFailedVehicleEntry(vehicle);
        continue;
      }
      const pedIndex = this.peds.indexOf(pedestrian);
      if (pedIndex >= 0) this.peds.splice(pedIndex, 1);
      pedestrian.dispose();
      // Replace any abandoned TrafficCar wrapper that still owns this body.
      const oldIndex = this.traffic.findIndex((traffic) => traffic !== driver && traffic.vehicle === vehicle);
      if (oldIndex >= 0) this.traffic.splice(oldIndex, 1);
      this.traffic.push(driver);
    }
  }

  private assignAbandonedVehicle(): void {
    const pedestrians = this.peds.filter((pedestrian) => pedestrian.availableForVehicle());
    let best: { pedestrian: Pedestrian; vehicle: Vehicle; distance: number } | null = null;
    for (const pedestrian of pedestrians) {
      const pos = pedestrian.position();
      for (const candidate of this.game.vehiclesNear(pos.x, pos.z, 18, this.nearbyVehicles)) {
        if (!(candidate instanceof Vehicle)) continue;
        const vehicle = candidate;
        if (vehicle.driver !== null || vehicle.destroyed || vehicle.burning || vehicle.getSpeed() >= 0.8) continue;
        const t = vehicle.body.translation();
        const distance = Math.hypot(t.x - pos.x, t.z - pos.z);
        if (best && distance >= best.distance) continue;
        best = { pedestrian, vehicle, distance };
      }
    }
    if (best) best.pedestrian.tryEnterVehicle(best.vehicle);
  }

  /** Nearby civilians witness a crime, flee, and make it eligible for police dispatch. */
  witnessCrime(origin: THREE.Vector3, radius = 28): boolean {
    let witnessed = false;
    for (const pedestrian of this.peds) {
      if (!pedestrian.alive()) continue;
      const pos = pedestrian.position();
      if (Math.hypot(pos.x - origin.x, pos.z - origin.z) > radius) continue;
      witnessed = true;
      pedestrian.reactToCrime(origin);
    }
    return witnessed;
  }

  reactToDanger(origin: THREE.Vector3, radius = 22): void {
    for (const pedestrian of this.peds) {
      if (!pedestrian.alive()) continue;
      const pos = pedestrian.position();
      if (Math.hypot(pos.x - origin.x, pos.z - origin.z) <= radius) pedestrian.reactToCrime(origin);
    }
  }

  /** Materialize an abstract traffic driver as a recoverable ejected NPC. */
  ejectTrafficDriver(
    vehicle: Drivable,
    side: 1 | -1,
    profile?: { outfit: Outfit; heightScale: number }
  ): void {
    const doorway = vehicle.doorPosition(side, 0.52);
    const from = nearestRoadPoint(doorway.x, doorway.z, 'pedestrian');
    if (!from) return;
    const neighbors = roadNeighbors(from, 'pedestrian');
    if (neighbors.length === 0) return;
    const to = neighbors[Math.floor(Math.random() * neighbors.length)];
    let pedestrian = this.exitingDrivers.get(vehicle);
    if (!pedestrian) {
      pedestrian = new Pedestrian(
        this.game,
        profile?.outfit ?? randomOutfit(),
        profile?.heightScale ?? 0.94 + Math.random() * 0.1,
        from,
        to,
        { x: doorway.x, z: doorway.z }
      );
      this.peds.push(pedestrian);
    } else {
      this.exitingDrivers.delete(vehicle);
    }

    const t = vehicle.body.translation();
    const outward = new THREE.Vector3(doorway.x - t.x, 0, doorway.z - t.z).normalize();
    const velocity = vehicle.body.linvel();
    const impact = new THREE.Vector3(
      outward.x * 4.2 + velocity.x * 0.35,
      0.45,
      outward.z * 4.2 + velocity.z * 0.35
    );
    const inwardYaw = Math.atan2(t.x - doorway.x, t.z - doorway.z);
    pedestrian.pullFromVehicle(doorway, inwardYaw, side, impact);
  }

  private recycle(): void {
    for (const [key, signal] of this.trafficSignals) {
      if (this.signalClock - signal.lastSeen < 8) continue;
      this.game.scene.remove(signal.root);
      signal.root.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        if (Array.isArray(mesh.material)) mesh.material.forEach((material) => material.dispose());
        else mesh.material.dispose();
      });
      this.trafficSignals.delete(key);
    }
    for (let i = this.peds.length - 1; i >= 0; i--) {
      const p = this.peds[i];
      const pos = p.position();
      if (p.deadFor > 8 || this.distToPlayers(pos.x, pos.z) > DESPAWN) {
        p.dispose();
        this.peds.splice(i, 1);
      }
    }
    for (let i = this.traffic.length - 1; i >= 0; i--) {
      const t = this.traffic[i];
      const pos = t.vehicle.body.translation();
      // Player-stolen traffic cars leave the manager's ownership.
      if (t.vehicle.driver !== t && t.vehicle.driver !== null) {
        this.traffic.splice(i, 1);
        continue;
      }
      if (this.distToPlayers(pos.x, pos.z) > DESPAWN) {
        t.dispose();
        const remaining = this.traffic.indexOf(t);
        if (remaining >= 0) this.traffic.splice(remaining, 1);
      }
    }
  }

  private checkVehicleImpacts(): void {
    for (const v of this.game.vehicles) {
      const velocity = v.body.linvel();
      const speed = Math.hypot(velocity.x, velocity.z);
      if (speed < MIN_CONTACT_SPEED) continue;
      const t = v.body.translation();
      for (const p of this.peds) {
        if (!p.canReceiveVehicleImpact()) continue;
        const pos = p.position();
        if (!v.overlapsPedestrian(pos)) continue;

        const away = new THREE.Vector3(pos.x - t.x, 0, pos.z - t.z);
        if (away.lengthSq() < 0.01) away.set(velocity.x, 0, velocity.z);
        away.normalize();
        const approachSpeed = Math.max(0, velocity.x * away.x + velocity.z * away.z);
        const angle = THREE.MathUtils.clamp(approachSpeed / speed, 0, 1);
        // A direct hit transfers most of the speed; a side-swipe still counts,
        // but needs substantially more speed to cause a knockdown.
        const impactSpeed = approachSpeed + (speed - approachSpeed) * 0.28;
        if (impactSpeed < MIN_CONTACT_SPEED) continue;

        if (impactSpeed < RAGDOLL_IMPACT_SPEED) {
          p.shove(away, impactSpeed);
          continue;
        }

        const carry = 0.42 + angle * 0.26;
        const impact = new THREE.Vector3(
          velocity.x * carry + away.x * impactSpeed * 0.2,
          Math.max(0, velocity.y) * 0.3 + Math.min(1.2, impactSpeed * 0.06),
          velocity.z * carry + away.z * impactSpeed * 0.2
        );
        const horizontal = Math.hypot(impact.x, impact.z);
        if (horizontal > 20) impact.multiplyScalar(20 / horizontal);
        p.die(impact);
        this.game.fx.blood(
          new THREE.Vector3(pos.x, pos.y + 0.9, pos.z),
          impact,
          1.6
        );

        // A human impact scrubs a little speed and can impart a small yaw,
        // without the abrupt stop caused by an immovable kinematic capsule.
        const impulseMagnitude =
          v.body.mass() * Math.min(0.75, impactSpeed * (0.025 + angle * 0.025));
        v.body.applyImpulseAtPoint(
          new RAPIER.Vector3(
            -away.x * impulseMagnitude,
            0,
            -away.z * impulseMagnitude
          ),
          new RAPIER.Vector3(pos.x, t.y, pos.z),
          true
        );
        this.game.onPedestrianKilled(v);
      }

      // On-foot players take scaled contact damage from the same overlap test.
      for (const player of this.game.players) {
        if (!player.canReceiveVehicleImpact() || v.driver === player) continue;
        const pos = player.character.position();
        if (!v.overlapsPedestrian(pos)) continue;
        const away = new THREE.Vector3(pos.x - t.x, 0, pos.z - t.z);
        if (away.lengthSq() < 0.01) away.set(velocity.x, 0, velocity.z);
        away.normalize();
        const approachSpeed = Math.max(0, velocity.x * away.x + velocity.z * away.z);
        const impactSpeed = approachSpeed + (speed - approachSpeed) * 0.28;
        if (impactSpeed < MIN_CONTACT_SPEED) continue;
        const knockDown = impactSpeed >= RAGDOLL_IMPACT_SPEED;
        const damage = knockDown
          ? Math.min(MAX_PLAYER_VEHICLE_DAMAGE, Math.ceil(12 + impactSpeed * 1.8))
          : Math.max(1, Math.ceil(impactSpeed * 4));
        const carry = knockDown ? 0.38 + Math.min(0.24, approachSpeed / Math.max(speed, 0.01) * 0.24) : 0;
        const impact = knockDown
          ? new THREE.Vector3(
              velocity.x * carry + away.x * impactSpeed * 0.18,
              Math.min(1.1, impactSpeed * 0.06),
              velocity.z * carry + away.z * impactSpeed * 0.18
            )
          : away;
        const horizontal = Math.hypot(impact.x, impact.z);
        if (horizontal > 16) impact.multiplyScalar(16 / horizontal);
        player.takeVehicleHit(damage, impact, knockDown);
        this.game.fx.blood(
          new THREE.Vector3(pos.x, pos.y + 0.9, pos.z),
          impact,
          knockDown ? 1.5 : 0.65
        );
      }
    }
  }
}
