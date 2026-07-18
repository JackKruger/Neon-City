import * as THREE from 'three';
import type { Game } from '../core/Game';
import { CIVILIAN_CARS } from '../core/const';
import { Pedestrian } from '../entities/Pedestrian';
import type { Outfit } from '../entities/HumanRig';
import { TrafficCar } from '../entities/TrafficCar';
import { CellRef, randomRoadCellNear, roadNeighbors } from './RoadGraph';
import { cellToWorld } from './CityMap';

const MAX_PEDS = 26;
const MAX_TRAFFIC = 12;
const SPAWN_MIN = 45;
const SPAWN_MAX = 100;
const DESPAWN = 140;

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

    this.checkRunOvers();

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 0.4;
      this.recycle();
      if (this.peds.length < MAX_PEDS) this.spawnPed();
      if (this.traffic.length < MAX_TRAFFIC) this.spawnTraffic();
    }
  }

  private distToPlayers(x: number, z: number): number {
    let best = Infinity;
    for (const p of this.game.playerPositions()) {
      best = Math.min(best, Math.hypot(p.x - x, p.z - z));
    }
    return best;
  }

  private randomSpawnEdge(): { from: CellRef; to: CellRef } | null {
    const players = this.game.playerPositions();
    for (let tries = 0; tries < 12; tries++) {
      const p = players[Math.floor(Math.random() * players.length)];
      const cell = randomRoadCellNear(p.x, p.z, SPAWN_MIN, SPAWN_MAX);
      if (!cell) continue;
      // The ring is relative to one player; keep clear of the other too.
      const { x, z } = cellToWorld(cell.cx, cell.cz);
      if (this.distToPlayers(x, z) < SPAWN_MIN) continue;
      const neighbors = roadNeighbors(cell);
      if (neighbors.length === 0) continue;
      const to = neighbors[Math.floor(Math.random() * neighbors.length)];
      return { from: cell, to };
    }
    return null;
  }

  private spawnPed(): void {
    const edge = this.randomSpawnEdge();
    if (!edge) return;
    const heightScale = 0.92 + Math.random() * 0.13;
    this.peds.push(new Pedestrian(this.game, randomOutfit(), heightScale, edge.from, edge.to));
  }

  private spawnTraffic(): void {
    const edge = this.randomSpawnEdge();
    if (!edge) return;
    const model = CIVILIAN_CARS[Math.floor(Math.random() * CIVILIAN_CARS.length)];
    this.traffic.push(new TrafficCar(this.game, model, edge.from, edge.to));
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

  private checkRunOvers(): void {
    for (const v of this.game.vehicles) {
      const speed = v.getSpeed();
      if (speed < 5) continue;
      const t = v.body.translation();
      for (const p of this.peds) {
        if (p.dead) continue;
        const pos = p.position();
        const dx = pos.x - t.x;
        const dz = pos.z - t.z;
        if (dx * dx + dz * dz < 2.6) {
          const vel = v.body.linvel();
          p.die(new THREE.Vector3(vel.x, vel.y, vel.z));
          this.game.onPedestrianKilled(v);
        }
      }
    }
  }
}
