import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Game } from '../core/Game';
import { CIVILIAN_CARS } from '../core/const';
import { Pedestrian } from '../entities/Pedestrian';
import type { Outfit } from '../entities/HumanRig';
import { TrafficCar } from '../entities/TrafficCar';
import type { Drivable } from '../entities/Drivable';
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
const SPAWN_MIN = 45;
const SPAWN_MAX = 100;
const DESPAWN = 140;
const MIN_CONTACT_SPEED = 0.65;
const RAGDOLL_IMPACT_SPEED = 4.5;
const MAX_PLAYER_VEHICLE_DAMAGE = 45;

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

  constructor(private game: Game) {}

  update(dt: number): void {
    for (const p of this.peds) p.update(dt);
    for (const t of this.traffic) t.update(dt);

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 0.4;
      this.recycle();
      if (this.peds.length < MAX_PEDS) this.spawnPed();
      if (this.traffic.length < MAX_TRAFFIC) this.spawnTraffic();
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
    this.traffic.push(new TrafficCar(this.game, model, edge.from, edge.to));
  }

  /** Materialize an abstract traffic driver as a recoverable ejected NPC. */
  ejectTrafficDriver(vehicle: Drivable, side: 1 | -1): void {
    const doorway = vehicle.doorPosition(side, 0.52);
    const from = nearestRoadPoint(doorway.x, doorway.z, 'pedestrian');
    if (!from) return;
    const neighbors = roadNeighbors(from, 'pedestrian');
    if (neighbors.length === 0) return;
    const to = neighbors[Math.floor(Math.random() * neighbors.length)];
    const pedestrian = new Pedestrian(
      this.game,
      randomOutfit(),
      0.94 + Math.random() * 0.1,
      from,
      to,
      { x: doorway.x, z: doorway.z }
    );

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
    this.peds.push(pedestrian);
  }

  private recycle(): void {
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
        this.traffic.splice(i, 1);
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
