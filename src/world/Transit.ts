import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Game } from '../core/Game';
import { TRANSIT_COLLISION_GROUPS } from '../core/const';
import type { CompiledTransitStop } from './CompiledFormat';
import {
  nextRoadCell,
  pointWorld,
  roadNeighbors,
  roadPoints,
  type CellRef,
  type NavigationMode,
} from './RoadGraph';

const TRAM_HEADWAY = 90;
const TRAIN_HEADWAY = 180;
const TRAM_DWELL = 12;
const TRAIN_DWELL = 20;
const MAX_TRAMS = 4;
const MAX_TRAINS = 2;

export interface TransitStop extends CompiledTransitStop {
  sourceId: string;
}

function material(color: number, metalness = 0.05): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.58, metalness });
}

function addBox(
  root: THREE.Group,
  size: [number, number, number],
  position: [number, number, number],
  color: number
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material(color));
  mesh.position.set(...position);
  root.add(mesh);
  return mesh;
}

/** Solid, non-derailable rail vehicle driven by the compiled transit graph. */
export class TransitVehicle {
  readonly root = new THREE.Group();
  readonly body: RAPIER.RigidBody;
  readonly mode: 'tram' | 'train';
  private from: CellRef;
  private to: CellRef;
  private waypoint: { x: number; y: number; z: number };
  private speed = 0;
  private dwell = 0;
  private stopCooldown = 0;
  private doors: THREE.Mesh[] = [];
  private disposed = false;

  constructor(private game: Game, mode: 'tram' | 'train', from: CellRef, to: CellRef) {
    this.mode = mode;
    this.from = from;
    this.to = to;
    this.waypoint = this.point(to);
    const start = this.point(from);
    const heading = Math.atan2(this.waypoint.x - start.x, this.waypoint.z - start.z);
    this.buildModel();
    this.root.position.set(start.x, start.y + (mode === 'tram' ? 1.25 : 1.55), start.z);
    this.root.rotation.y = heading;
    game.scene.add(this.root);

    const length = mode === 'tram' ? 24 : 138;
    const body = game.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(this.root.position.x, this.root.position.y, this.root.position.z)
        .setRotation({ x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) })
    );
    game.world.createCollider(
      RAPIER.ColliderDesc.cuboid(mode === 'tram' ? 1.3 : 1.45, mode === 'tram' ? 1.55 : 1.8, length / 2)
        .setFriction(0.7)
        .setCollisionGroups(TRANSIT_COLLISION_GROUPS),
      body
    );
    this.body = body;
  }

  update(dt: number, stops: TransitStop[]): void {
    if (this.disposed) return;
    this.stopCooldown = Math.max(0, this.stopCooldown - dt);
    if (this.dwell > 0) {
      this.dwell = Math.max(0, this.dwell - dt);
      this.speed = Math.max(0, this.speed - dt * 4);
      this.setDoors(this.dwell > 0.6);
      return;
    }
    this.setDoors(false);
    const position = this.body.translation();
    const dx = this.waypoint.x - position.x;
    const dz = this.waypoint.z - position.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 2.2) this.advance();

    const targetSpeed = Math.min(this.mode === 'tram' ? 12 : 22, Math.max(4, (this.to.speed ?? 50) / 3.6));
    const blocked = this.obstacleAhead(position.x, position.z, dx, dz);
    const upcomingStop = this.stopCooldown <= 0 ? this.nearestStopAhead(stops, position.x, position.z, dx, dz) : null;
    const braking = blocked || (upcomingStop !== null && upcomingStop.distance < Math.max(8, this.speed * this.speed / 2.8));
    this.speed = THREE.MathUtils.clamp(this.speed + (braking ? -3.2 : 1.15) * dt, 0, targetSpeed);
    if (upcomingStop && upcomingStop.distance < 2.5 && this.speed < 0.7) {
      this.speed = 0;
      this.dwell = this.mode === 'tram' ? TRAM_DWELL : TRAIN_DWELL;
      this.stopCooldown = this.dwell + 8;
    }

    const length = Math.hypot(dx, dz) || 1;
    const step = Math.min(distance, this.speed * dt);
    const next = {
      x: position.x + dx / length * step,
      y: THREE.MathUtils.lerp(position.y, this.waypoint.y + (this.mode === 'tram' ? 1.25 : 1.55), Math.min(1, dt * 5)),
      z: position.z + dz / length * step,
    };
    const heading = Math.atan2(dx, dz);
    this.body.setNextKinematicTranslation(next);
    this.body.setNextKinematicRotation({ x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) });
    this.root.position.set(next.x, next.y, next.z);
    this.root.rotation.y = heading;
  }

  afterPhysics(): void {
    const velocity = this.forward().multiplyScalar(this.speed);
    const position = this.body.translation();
    for (const pedestrian of this.game.npcs.peds) {
      if (!pedestrian.canReceiveVehicleImpact()) continue;
      const point = pedestrian.position();
      if (!this.overlaps(point.x, point.z, 0.8)) continue;
      pedestrian.die(new THREE.Vector3(velocity.x * 0.7, 0.8, velocity.z * 0.7));
      this.game.fx.blood(new THREE.Vector3(point.x, point.y + 0.9, point.z), velocity, 1.8);
    }
    for (const player of this.game.players) {
      if (player.driving) continue;
      const point = player.character.position();
      if (!this.overlaps(point.x, point.z, 0.7)) continue;
      player.takeVehicleHit(Math.min(75, 12 + this.speed * 3), velocity, this.speed > 4);
    }
    if (this.speed > 2 && this.mode === 'tram') this.game.npcs.reactToDanger(new THREE.Vector3(position.x, position.y, position.z), 15);
  }

  blocksRoad(x: number, z: number, radius = 6): boolean {
    return this.overlaps(x, z, radius);
  }

  distanceToPlayers(): number {
    const p = this.body.translation();
    return Math.min(...this.game.playerPositions().map((player) => Math.hypot(player.x - p.x, player.z - p.z)));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.game.scene.remove(this.root);
    this.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const entry of materials) entry.dispose();
    });
    this.game.world.removeRigidBody(this.body);
  }

  private point(point: CellRef): { x: number; y: number; z: number } {
    const world = pointWorld(point);
    return { x: world.x, y: point.y ?? this.game.roadSurfaceHeightAt(world.x, world.z), z: world.z };
  }

  private advance(): void {
    const next = nextRoadCell(this.from, this.to, 0.25, this.mode);
    this.from = this.to;
    this.to = next;
    this.waypoint = this.point(next);
  }

  private forward(): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.root.rotation.y), 0, Math.cos(this.root.rotation.y));
  }

  private overlaps(x: number, z: number, padding: number): boolean {
    const p = this.body.translation();
    const f = this.forward();
    const dx = x - p.x;
    const dz = z - p.z;
    const along = dx * f.x + dz * f.z;
    const side = dx * f.z - dz * f.x;
    return Math.abs(along) <= (this.mode === 'tram' ? 12 : 69) + padding && Math.abs(side) <= 1.5 + padding;
  }

  private obstacleAhead(x: number, z: number, dx: number, dz: number): boolean {
    const length = Math.hypot(dx, dz) || 1;
    const fx = dx / length; const fz = dz / length;
    const halfLength = this.mode === 'tram' ? 12 : 69;
    for (const vehicle of this.game.vehicles) {
      const p = vehicle.body.translation();
      const ox = p.x - x; const oz = p.z - z;
      const beyondNose = ox * fx + oz * fz - halfLength;
      if (beyondNose > 1 && beyondNose < Math.max(12, this.speed * 2.2) && Math.abs(ox * -fz + oz * fx) < 2) return true;
    }
    return false;
  }

  private nearestStopAhead(stops: TransitStop[], x: number, z: number, dx: number, dz: number): { distance: number } | null {
    const length = Math.hypot(dx, dz) || 1;
    const fx = dx / length; const fz = dz / length;
    let best = Infinity;
    for (const stop of stops) {
      if (stop.mode !== this.mode) continue;
      const ox = stop.x - x; const oz = stop.z - z;
      const along = ox * fx + oz * fz;
      const side = Math.abs(ox * -fz + oz * fx);
      if (along >= 0 && along < best && side < 7) best = along;
    }
    return Number.isFinite(best) ? { distance: best } : null;
  }

  private setDoors(open: boolean): void {
    for (const door of this.doors) door.position.x = (door.userData.baseX as number) + (open ? 0.42 * Math.sign(door.userData.baseX as number) : 0);
  }

  private buildModel(): void {
    if (this.mode === 'tram') {
      for (const z of [-7.7, 0, 7.7]) {
        addBox(this.root, [2.55, 2.65, 7.2], [0, 0, z], 0xe8e8dc);
        addBox(this.root, [2.59, 0.75, 5.8], [0, 0.55, z], 0x263d56);
        for (const side of [-1, 1]) {
          const door = addBox(this.root, [0.06, 1.85, 1.25], [side * 1.31, -0.15, z], 0xffca35);
          door.userData.baseX = door.position.x;
          this.doors.push(door);
        }
      }
      addBox(this.root, [0.06, 0.06, 8], [0, 2.15, 0], 0x22242a);
    } else {
      const carLength = 22.5;
      for (let i = 0; i < 6; i++) {
        const z = (i - 2.5) * carLength;
        addBox(this.root, [2.9, 3.1, carLength - 0.5], [0, 0, z], 0xd7dbe0);
        addBox(this.root, [2.94, 0.8, carLength - 2], [0, 0.5, z], 0x21364f);
        addBox(this.root, [2.96, 0.22, carLength - 0.8], [0, -1.25, z], 0x135aa3);
        for (const side of [-1, 1]) {
          const door = addBox(this.root, [0.06, 2.1, 1.7], [side * 1.49, -0.08, z], 0xffcf32);
          door.userData.baseX = door.position.x;
          this.doors.push(door);
        }
      }
    }
  }
}

/** Owns deterministic services while compiled transit chunks are streamed. */
export class TransitManager {
  readonly vehicles: TransitVehicle[] = [];
  private chunks = new Map<string, TransitStop[]>();
  private clock = 0;
  private lastSpawn = new Map<NavigationMode, number>([['tram', -TRAM_HEADWAY], ['train', -TRAIN_HEADWAY]]);

  constructor(private game: Game) {}

  registerChunk(key: string, stops: CompiledTransitStop[], sources: string[]): void {
    this.chunks.set(key, stops.map((stop) => ({ ...stop, sourceId: sources[stop.sourceIndex] })));
  }

  unregisterChunk(key: string): void {
    this.chunks.delete(key);
  }

  update(dt: number): void {
    this.clock += dt;
    this.trySpawn('tram', TRAM_HEADWAY, MAX_TRAMS);
    this.trySpawn('train', TRAIN_HEADWAY, MAX_TRAINS);
    const stops = [...this.chunks.values()].flat();
    for (const vehicle of this.vehicles) vehicle.update(dt, stops);
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      if (this.vehicles[i].distanceToPlayers() <= 240) continue;
      this.vehicles[i].dispose();
      this.vehicles.splice(i, 1);
    }
  }

  afterPhysics(): void {
    for (const vehicle of this.vehicles) vehicle.afterPhysics();
  }

  blocksRoad(x: number, z: number): boolean {
    return this.vehicles.some((vehicle) => vehicle.mode === 'tram' && vehicle.blocksRoad(x, z));
  }

  positions(): { x: number; z: number; mode: 'tram' | 'train' }[] {
    return this.vehicles.map((vehicle) => {
      const position = vehicle.body.translation();
      return { x: position.x, z: position.z, mode: vehicle.mode };
    });
  }

  dispose(): void {
    for (const vehicle of this.vehicles) vehicle.dispose();
    this.vehicles.length = 0;
    this.chunks.clear();
  }

  private trySpawn(mode: 'tram' | 'train', headway: number, cap: number): void {
    if (this.vehicles.filter((vehicle) => vehicle.mode === mode).length >= cap) return;
    if (this.clock - (this.lastSpawn.get(mode) ?? -headway) < headway) return;
    const players = this.game.playerPositions();
    const candidates = roadPoints(mode)
      .filter((point) => {
        const p = pointWorld(point);
        const distance = Math.min(...players.map((player) => Math.hypot(player.x - p.x, player.z - p.z)));
        const minimum = mode === 'train' ? 110 : 45;
        const maximum = mode === 'train' ? 220 : 180;
        return distance >= minimum && distance <= maximum && roadNeighbors(point, mode).length > 0;
      })
      .sort((a, b) => a.z! - b.z! || a.x! - b.x!);
    if (candidates.length === 0) return;
    const index = Math.abs(Math.floor(this.clock / headway) * 2654435761) % candidates.length;
    const from = candidates[index];
    const neighbors = roadNeighbors(from, mode);
    if (neighbors.length === 0) return;
    this.vehicles.push(new TransitVehicle(this.game, mode, from, neighbors[0]));
    this.lastSpawn.set(mode, this.clock);
  }
}
