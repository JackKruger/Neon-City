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
/** Model centres above the compiled track datum. Rail render surfaces sit
 * 0.14/0.16 m above that datum, so include that lift as well as half-height. */
const TRAM_RIDE_HEIGHT = 1.47;
const TRAIN_RIDE_HEIGHT = 1.71;
/** Spacing between recorded trail crumbs; the cars sample this path so they
 * pivot at their joins and lie along both the curve and the grade of the track. */
const TRAIL_STEP = 1.0;
const MAX_SEGMENTS_PER_STEP = 16;

const UP = new THREE.Vector3(0, 1, 0);
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _basis = new THREE.Matrix4();

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
  /** Track height (no ride offset) of the segment currently being traversed. */
  private fromWorld: { x: number; y: number; z: number };
  private waypoint: { x: number; y: number; z: number };
  /** Rail datum at the leading nose. The rest of the consist samples its trail. */
  private trackPosition: { x: number; y: number; z: number };
  private speed = 0;
  private dwell = 0;
  private stopCooldown = 0;
  private heading: number;
  private doors: THREE.Mesh[] = [];
  private disposed = false;
  /** Individual cars, each pivoting on its own along the recorded trail. */
  private cars: { group: THREE.Group; arc: number; halfWheelbase: number }[] = [];
  /** Height the car centre rides above the rail head. */
  private readonly rideHeight: number;
  /** Distance from the vehicle centre to its nose. */
  private readonly halfLength: number;
  /** Breadcrumbs the rail-following nose has passed, newest first. */
  private trail: { x: number; y: number; z: number }[] = [];
  private readonly maxTrailPoints: number;

  constructor(private game: Game, mode: 'tram' | 'train', from: CellRef, to: CellRef) {
    this.mode = mode;
    this.from = from;
    this.to = to;
    this.rideHeight = mode === 'tram' ? TRAM_RIDE_HEIGHT : TRAIN_RIDE_HEIGHT;
    const length = mode === 'tram' ? 24 : 138;
    this.halfLength = length / 2;
    this.maxTrailPoints = Math.ceil((length + 8) / TRAIL_STEP) + 4;
    this.fromWorld = this.point(from);
    this.waypoint = this.point(to);
    const start = this.fromWorld;
    this.trackPosition = { ...start };
    this.heading = Math.atan2(this.waypoint.x - start.x, this.waypoint.z - start.z);
    const grade = this.segmentGrade();
    this.buildModel();
    // The root stays at the world origin with identity orientation; each car
    // carries an absolute world transform sampled from the trail.
    game.scene.add(this.root);

    const nose = { x: start.x, y: start.y + this.rideHeight, z: start.z };
    this.seedTrail(nose, this.heading, grade);
    this.layoutCars();
    const centre = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 0 };
    this.sampleTrail(this.halfLength, centre);
    const orientation = this.orientationFromForward(
      _forward.set(centre.fx, centre.fy, centre.fz),
      new THREE.Quaternion()
    );
    const body = game.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(centre.x, centre.y, centre.z)
        .setRotation({ x: orientation.x, y: orientation.y, z: orientation.z, w: orientation.w })
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
    const bodyPosition = this.body.translation();
    const dx = this.waypoint.x - this.trackPosition.x;
    const dz = this.waypoint.z - this.trackPosition.z;

    const targetSpeed = Math.min(this.mode === 'tram' ? 12 : 22, Math.max(4, (this.to.speed ?? 50) / 3.6));
    const blocked = this.obstacleAhead(bodyPosition.x, bodyPosition.z, dx, dz);
    const upcomingStop = this.stopCooldown <= 0
      ? this.nearestStopAhead(stops, bodyPosition.x, bodyPosition.z, dx, dz)
      : null;
    const braking = blocked || (upcomingStop !== null && upcomingStop.distance < Math.max(8, this.speed * this.speed / 2.8));
    this.speed = THREE.MathUtils.clamp(this.speed + (braking ? -3.2 : 1.15) * dt, 0, targetSpeed);
    if (upcomingStop && upcomingStop.distance < 2.5 && this.speed < 0.7) {
      this.speed = 0;
      this.dwell = this.mode === 'tram' ? TRAM_DWELL : TRAIN_DWELL;
      this.stopCooldown = this.dwell + 8;
    }

    this.moveAlongTrack(this.speed * dt);
    const nextDx = this.waypoint.x - this.trackPosition.x;
    const nextDz = this.waypoint.z - this.trackPosition.z;
    if (Math.hypot(nextDx, nextDz) > 1e-4) this.heading = Math.atan2(nextDx, nextDz);
    this.recordTrail({
      x: this.trackPosition.x,
      y: this.trackPosition.y + this.rideHeight,
      z: this.trackPosition.z,
    });
    this.layoutCars();

    const centre = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 0 };
    this.sampleTrail(this.halfLength, centre);
    const orientation = this.orientationFromForward(
      _forward.set(centre.fx, centre.fy, centre.fz),
      new THREE.Quaternion()
    );
    this.body.setNextKinematicTranslation({ x: centre.x, y: centre.y, z: centre.z });
    this.body.setNextKinematicRotation({ x: orientation.x, y: orientation.y, z: orientation.z, w: orientation.w });
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
    this.fromWorld = this.waypoint;
    this.waypoint = this.point(next);
  }

  /** Consume horizontal travel exactly along the compiled polyline, carrying
   * any remainder across a node instead of switching segments early. */
  private moveAlongTrack(distance: number): void {
    let remaining = Math.max(0, distance);
    for (let segment = 0; segment < MAX_SEGMENTS_PER_STEP; segment++) {
      const dx = this.waypoint.x - this.trackPosition.x;
      const dz = this.waypoint.z - this.trackPosition.z;
      const horizontal = Math.hypot(dx, dz);
      if (horizontal < 1e-5) {
        this.trackPosition = { ...this.waypoint };
        this.advance();
        if (remaining <= 1e-5) return;
        continue;
      }
      const step = Math.min(horizontal, remaining);
      const t = step / horizontal;
      this.trackPosition.x += dx * t;
      this.trackPosition.y += (this.waypoint.y - this.trackPosition.y) * t;
      this.trackPosition.z += dz * t;
      remaining -= step;
      if (step >= horizontal - 1e-5) {
        this.trackPosition = { ...this.waypoint };
        this.advance();
      }
      if (remaining <= 1e-5) return;
    }
  }

  private forward(): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  /** Pitch (radians) of the current track segment; positive climbs. */
  private segmentGrade(): number {
    const horiz = Math.hypot(this.waypoint.x - this.fromWorld.x, this.waypoint.z - this.fromWorld.z) || 1;
    return Math.atan2(this.waypoint.y - this.fromWorld.y, horiz);
  }

  /** Build an orientation whose local +Z (car length) follows `forward`, keeping
   * the roof pointed at world up so the car banks with the grade, not the roll. */
  private orientationFromForward(forward: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
    _forward.copy(forward);
    if (_forward.lengthSq() < 1e-8) _forward.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    _forward.normalize();
    _right.crossVectors(UP, _forward);
    if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
    else _right.normalize();
    _up.crossVectors(_forward, _right);
    _basis.makeBasis(_right, _up, _forward);
    return out.setFromRotationMatrix(_basis);
  }

  private seedTrail(nose: { x: number; y: number; z: number }, heading: number, grade: number): void {
    _forward.set(Math.sin(heading) * Math.cos(grade), Math.sin(grade), Math.cos(heading) * Math.cos(grade));
    this.trail = [];
    for (let i = 0; i < this.maxTrailPoints; i++) {
      this.trail.push({
        x: nose.x - _forward.x * TRAIL_STEP * i,
        y: nose.y - _forward.y * TRAIL_STEP * i,
        z: nose.z - _forward.z * TRAIL_STEP * i,
      });
    }
  }

  private recordTrail(nose: { x: number; y: number; z: number }): void {
    const head = this.trail[0];
    if (!head) {
      this.trail.push({ ...nose });
      return;
    }
    // trail[0] tracks the live nose so the lead car never lags the body; a new
    // crumb is committed once the nose is a full step from the last committed
    // one (trail[1]) — that preserved chain is what makes the cars articulate.
    head.x = nose.x;
    head.y = nose.y;
    head.z = nose.z;
    const committed = this.trail[1];
    if (!committed || Math.hypot(nose.x - committed.x, nose.z - committed.z) >= TRAIL_STEP) {
      this.trail.unshift({ ...nose });
      if (this.trail.length > this.maxTrailPoints) this.trail.length = this.maxTrailPoints;
    }
  }

  /** Position and forward direction `arc` metres behind the nose along the trail. */
  private sampleTrail(
    arc: number,
    out: { x: number; y: number; z: number; fx: number; fy: number; fz: number }
  ): void {
    const trail = this.trail;
    if (trail.length < 2) {
      const p = trail[0] ?? { x: 0, y: 0, z: 0 };
      out.x = p.x; out.y = p.y; out.z = p.z;
      out.fx = Math.sin(this.heading); out.fy = 0; out.fz = Math.cos(this.heading);
      return;
    }
    let acc = 0;
    for (let i = 0; i < trail.length - 1; i++) {
      const near = trail[i];
      const far = trail[i + 1];
      const sx = far.x - near.x;
      const sy = far.y - near.y;
      const sz = far.z - near.z;
      const segLen = Math.hypot(sx, sy, sz);
      if (segLen < 1e-4) continue;
      const last = i === trail.length - 2;
      if (acc + segLen >= arc || last) {
        const t = last ? (arc - acc) / segLen : THREE.MathUtils.clamp((arc - acc) / segLen, 0, 1);
        out.x = near.x + sx * t;
        out.y = near.y + sy * t;
        out.z = near.z + sz * t;
        // Forward points from the rear crumb toward the nose crumb.
        const inv = 1 / segLen;
        out.fx = -sx * inv; out.fy = -sy * inv; out.fz = -sz * inv;
        return;
      }
      acc += segLen;
    }
    const tail = trail[trail.length - 1];
    out.x = tail.x; out.y = tail.y; out.z = tail.z;
    out.fx = Math.sin(this.heading); out.fy = 0; out.fz = Math.cos(this.heading);
  }

  private layoutCars(): void {
    const front = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 0 };
    const rear = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 0 };
    for (const car of this.cars) {
      this.sampleTrail(car.arc - car.halfWheelbase, front);
      this.sampleTrail(car.arc + car.halfWheelbase, rear);
      _forward.set(front.x - rear.x, front.y - rear.y, front.z - rear.z);
      if (_forward.lengthSq() < 1e-8) _forward.set(front.fx, front.fy, front.fz);
      this.orientationFromForward(_forward, car.group.quaternion);
      car.group.position.set(
        (front.x + rear.x) / 2,
        (front.y + rear.y) / 2,
        (front.z + rear.z) / 2
      );
    }
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

  /** Start a car body centred on its own origin so it can pivot at the joins. */
  private addCar(arc: number, halfWheelbase: number): THREE.Group {
    const car = new THREE.Group();
    this.root.add(car);
    this.cars.push({ group: car, arc, halfWheelbase });
    return car;
  }

  private buildModel(): void {
    if (this.mode === 'tram') {
      const tramCars = [
        { arc: 19, middle: false },
        { arc: 11.3, middle: true },
        { arc: 3.6, middle: false },
      ];
      for (const { arc, middle } of tramCars) {
        const car = this.addCar(arc, 2.55);
        addBox(car, [2.55, 2.65, 7.2], [0, 0, 0], 0xe8e8dc);
        addBox(car, [2.59, 0.75, 5.8], [0, 0.55, 0], 0x263d56);
        for (const side of [-1, 1]) {
          const door = addBox(car, [0.06, 1.85, 1.25], [side * 1.31, -0.15, 0], 0xffca35);
          door.userData.baseX = door.position.x;
          this.doors.push(door);
        }
        // The pantograph pole rides the centre section only.
        if (middle) addBox(car, [0.06, 0.06, 8], [0, 2.15, 0], 0x22242a);
      }
    } else {
      const carLength = 22.5;
      for (let i = 0; i < 6; i++) {
        const arc = 11 + (5 - i) * carLength;
        const car = this.addCar(arc, 8.2);
        addBox(car, [2.9, 3.1, carLength - 0.5], [0, 0, 0], 0xd7dbe0);
        addBox(car, [2.94, 0.8, carLength - 2], [0, 0.5, 0], 0x21364f);
        addBox(car, [2.96, 0.22, carLength - 0.8], [0, -1.25, 0], 0x135aa3);
        for (const side of [-1, 1]) {
          const door = addBox(car, [0.06, 2.1, 1.7], [side * 1.49, -0.08, 0], 0xffcf32);
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
