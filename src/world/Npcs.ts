import * as THREE from 'three';
import type { Game } from '../core/Game';
import { CIVILIAN_CARS } from '../core/Game';
import { Pedestrian } from '../entities/Pedestrian';
import { TrafficCar } from '../entities/TrafficCar';
import { CellRef, allRoadCells, roadNeighbors } from './RoadGraph';
import { cellToWorld } from './CityMap';

const MAX_PEDS = 26;
const MAX_TRAFFIC = 12;
const SPAWN_MIN = 45;
const SPAWN_MAX = 100;
const DESPAWN = 140;

export const PED_MODELS = 'cdefghijklmnopqr'
  .split('')
  .map((c) => `characters/character-${c}`);

/** Keeps a budget of pedestrians and traffic alive in a ring around players. */
export class Npcs {
  readonly peds: Pedestrian[] = [];
  readonly traffic: TrafficCar[] = [];
  private roadCells: CellRef[] = allRoadCells();
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

  private playerPositions(): THREE.Vector3[] {
    return this.game.players.map((p) =>
      p.driving
        ? new THREE.Vector3().copy(p.vehicle!.root.position)
        : p.character.position()
    );
  }

  private distToPlayers(x: number, z: number): number {
    let best = Infinity;
    for (const p of this.playerPositions()) {
      best = Math.min(best, Math.hypot(p.x - x, p.z - z));
    }
    return best;
  }

  private randomSpawnEdge(): { from: CellRef; to: CellRef } | null {
    for (let tries = 0; tries < 12; tries++) {
      const cell = this.roadCells[Math.floor(Math.random() * this.roadCells.length)];
      const { x, z } = cellToWorld(cell.cx, cell.cz);
      const d = this.distToPlayers(x, z);
      if (d < SPAWN_MIN || d > SPAWN_MAX) continue;
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
    const model = PED_MODELS[Math.floor(Math.random() * PED_MODELS.length)];
    this.peds.push(new Pedestrian(this.game, model, edge.from, edge.to));
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
          p.die();
          this.game.onPedestrianKilled(v);
        }
      }
    }
  }
}
