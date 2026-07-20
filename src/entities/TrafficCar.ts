import * as THREE from 'three';
import type { Entity, Game } from '../core/Game';
import { Vehicle } from './Vehicle';
import { CellRef, lanePoint, nearestRoadPoint, nextRoadCell, pointWorld, roadNeighbors } from '../world/RoadGraph';
import { speedLimitAt, worldToCell } from '../world/CityMap';
import type { Outfit } from './HumanRig';
import type { Drivable } from './Drivable';

const TURN_SPEED = 4;

export interface TrafficSpawnPose {
  x: number;
  z: number;
  heading: number;
}

/** Exact chassis pose used by a new traffic wrapper. */
export function trafficSpawnPose(from: CellRef, to: CellRef): TrafficSpawnPose {
  const waypoint = lanePoint(from, to, 0.18);
  const a = pointWorld(from);
  const b = pointWorld(to);
  const dir = { x: b.x - a.x, z: b.z - a.z };
  const length = Math.hypot(dir.x, dir.z) || 1;
  return {
    x: waypoint.x - (dir.x / length) * 6,
    z: waypoint.z - (dir.z / length) * 6,
    heading: Math.atan2(dir.x, dir.z),
  };
}

/** AI driver that follows the road lane grid using the physics Vehicle. */
export class TrafficCar implements Entity {
  readonly vehicle: Vehicle;
  crashed = false;
  private from: CellRef;
  private to: CellRef;
  private waypoint = { x: 0, z: 0 };
  private prevVel = new THREE.Vector3();
  private hasPrevVel = false;
  private stuckTime = 0;
  private reverseTime = 0;
  private exitRequested = false;
  private nearbyVehicles: Drivable[] = [];
  private sideVehicles: Drivable[] = [];

  constructor(
    private game: Game,
    model: string,
    from: CellRef,
    to: CellRef,
    readonly driverProfile: { outfit: Outfit; heightScale: number },
    existingVehicle?: Vehicle
  ) {
    this.from = from;
    this.to = to;
    this.waypoint = lanePoint(from, to, 0.18);
    // Spawn behind the first waypoint, facing along the real lane segment.
    // Adjacent compiled lane nodes routinely fall in the same tile, so cell
    // indices collapse to (0,0); derive heading and setback from exact world
    // positions so cars enter aligned with the lane instead of facing south.
    const spawn = trafficSpawnPose(from, to);
    this.vehicle = existingVehicle ?? new Vehicle(game, model, spawn.x, spawn.z, spawn.heading);
    this.vehicle.driver = this;
    if (!existingVehicle) game.addVehicle(this.vehicle);
  }

  /** Put an on-foot NPC behind the wheel of an existing abandoned car. */
  static occupy(
    game: Game,
    vehicle: Vehicle,
    profile: { outfit: Outfit; heightScale: number }
  ): TrafficCar | null {
    const t = vehicle.body.translation();
    const from = nearestRoadPoint(t.x, t.z, 'vehicle');
    if (!from) return null;
    const neighbors = roadNeighbors(from, 'vehicle');
    if (neighbors.length === 0) return null;
    const forward = vehicle.forward();
    const options = neighbors
      .map((point) => {
        const world = pointWorld(point);
        const dx = world.x - t.x;
        const dz = world.z - t.z;
        const length = Math.hypot(dx, dz) || 1;
        return { point, alignment: (dx * forward.x + dz * forward.z) / length };
      })
      .sort((a, b) => b.alignment - a.alignment);
    return new TrafficCar(game, vehicle.modelName, from, options[0].point, profile, vehicle);
  }

  update(dt: number): void {
    const v = this.vehicle;
    if ((v.destroyed || v.burning) && !this.crashed) this.crash();
    if (this.crashed) {
      v.command = { steer: 0, throttle: 0, brake: 0.4, handbrake: true };
      return;
    }

    // Detect a hard hit (large velocity change in one step).
    const vel = v.body.linvel();
    const dv = Math.hypot(
      vel.x - this.prevVel.x,
      vel.y - this.prevVel.y,
      vel.z - this.prevVel.z
    );
    if (dv > 5 && this.hasPrevVel) {
      this.crash();
      this.game.onTrafficRammed(this);
    }
    this.prevVel.set(vel.x, vel.y, vel.z);
    this.hasPrevVel = true;

    const t = v.body.translation();
    const dist = Math.hypot(this.waypoint.x - t.x, this.waypoint.z - t.z);
    if (dist < 3.5) this.advance();

    // Steering toward waypoint in local frame (forward = +Z, left = +X).
    const local = new THREE.Vector3(this.waypoint.x - t.x, 0, this.waypoint.z - t.z)
      .applyQuaternion(v.quaternion().invert());
    const angle = Math.atan2(local.x, Math.max(local.z, 0.01));
    let steer = -THREE.MathUtils.clamp(angle / 0.45, -1, 1);

    const turning = Math.abs(angle) > 0.25;
    // Preserve the existing 8 m/s feel for a 50 km/h street while allowing
    // authored limits to slow shopping strips and speed up arterials.
    const roadLimit = Math.min(12, (this.to.speed ?? speedLimitAt(this.to.cx, this.to.cz)) * 0.16);
    let target = turning ? Math.min(TURN_SPEED, roadLimit) : roadLimit;
    const obstacle = this.obstacleAhead();
    if (obstacle.stop) target = 0;
    else if (obstacle.steerBias !== 0) {
      steer = THREE.MathUtils.clamp(steer + obstacle.steerBias, -1, 1);
      target = Math.min(target, 5.5);
    }
    if (dist < 10 && !this.game.npcs.trafficSignalAllows(this.from, this.to, t.y + 0.75)) target = 0;

    const speed = v.forwardSpeed();
    let throttle = 0;
    let brake = 0;
    if (this.reverseTime > 0) {
      this.reverseTime -= dt;
      v.command = { steer: -steer, throttle: 0, brake: 1, handbrake: false };
      return;
    }
    if (speed < target - 0.5) throttle = 0.5;
    else if (speed > target + 1) brake = target === 0 ? 0.8 : 0.3;

    // Un-stick: if wanting to move but not moving, back up briefly.
    if (target > 0 && Math.abs(speed) < 0.4) {
      this.stuckTime += dt;
      if (this.stuckTime > 2.5) {
        this.stuckTime = 0;
        this.reverseTime = 1.2;
      }
    } else {
      this.stuckTime = 0;
    }

    v.command = { steer, throttle, brake, handbrake: false };
  }

  private advance(): void {
    const next = nextRoadCell(this.from, this.to, Math.random(), 'vehicle');
    this.from = this.to;
    this.to = next;
    this.waypoint = lanePoint(this.from, this.to, 0.18);
  }

  private obstacleAhead(): { stop: boolean; steerBias: number } {
    const t = this.vehicle.body.translation();
    const f = this.vehicle.forward();
    if (this.game.transitBlocksRoad(t.x + f.x * 5, t.z + f.z * 5)) return { stop: true, steerBias: 0 };
    for (const other of this.game.vehiclesNear(t.x, t.z, 9, this.nearbyVehicles)) {
      if (other === this.vehicle) continue;
      const o = other.body.translation();
      const dx = o.x - t.x;
      const dz = o.z - t.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > 81) continue;
      const along = dx * f.x + dz * f.z;
      if (along < 1.5) continue;
      const side = Math.abs(dx * -f.z + dz * f.x);
      if (side < 2.2) {
        // Keep a safe queue at close range. Farther back, gently move around a
        // stopped obstacle when the adjacent space is clear.
        if (along < 5.2 || other.getSpeed() > 2.5) return { stop: true, steerBias: 0 };
        const passSide = dx * -f.z + dz * f.x >= 0 ? -1 : 1;
        if (this.sideClear(passSide)) return { stop: false, steerBias: passSide * 0.32 };
        return { stop: true, steerBias: 0 };
      }
    }
    for (const p of this.game.players) {
      if (p.driving) continue;
      const pos = p.character.position();
      const dx = pos.x - t.x;
      const dz = pos.z - t.z;
      if (dx * dx + dz * dz > 64) continue;
      const along = dx * f.x + dz * f.z;
      if (along > 1 && Math.abs(dx * -f.z + dz * f.x) < 2) return { stop: true, steerBias: 0 };
    }
    for (const pedestrian of this.game.npcs.peds) {
      if (!pedestrian.alive()) continue;
      const pos = pedestrian.position();
      const dx = pos.x - t.x;
      const dz = pos.z - t.z;
      const along = dx * f.x + dz * f.z;
      if (along > 0.8 && along < 8 && Math.abs(dx * -f.z + dz * f.x) < 1.8) {
        return { stop: true, steerBias: 0 };
      }
    }
    return { stop: false, steerBias: 0 };
  }

  private sideClear(side: number): boolean {
    const t = this.vehicle.body.translation();
    const f = this.vehicle.forward();
    const right = new THREE.Vector3(f.z, 0, -f.x).multiplyScalar(side);
    const sampleX = t.x + f.x * 5 + right.x * 2.4;
    const sampleZ = t.z + f.z * 5 + right.z * 2.4;
    for (const other of this.game.vehiclesNear(sampleX, sampleZ, 3.2, this.sideVehicles)) {
      if (other === this.vehicle) continue;
      const o = other.body.translation();
      if (Math.hypot(o.x - sampleX, o.z - sampleZ) < 3.2) return false;
    }
    return true;
  }

  crash(): void {
    if (this.crashed) return;
    this.crashed = true;
    this.vehicle.command = { steer: 0, throttle: 0, brake: 0.4, handbrake: true };
    if (!this.exitRequested) {
      this.exitRequested = true;
      this.game.npcs.beginTrafficDriverExit(this);
    }
  }

  /** Stop AI control before a player claims the occupied vehicle. */
  prepareForCarjacking(): void {
    this.crashed = true;
    this.exitRequested = true;
    this.vehicle.command = { steer: 0, throttle: 0, brake: 0, handbrake: true };
  }

  /** Cell the car currently occupies (for recycling). */
  cell(): CellRef {
    const t = this.vehicle.body.translation();
    const { cx, cz } = worldToCell(t.x, t.z);
    return { cx, cz };
  }

  dispose(): void {
    this.game.removeVehicle(this.vehicle);
  }
}
