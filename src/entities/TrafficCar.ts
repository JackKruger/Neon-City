import * as THREE from 'three';
import type { Entity, Game } from '../core/Game';
import { Vehicle } from './Vehicle';
import {
  CellRef,
  lanePoint,
  nearestRoadPoint,
  nextVehicleRoadCell,
  pointWorld,
  roadNeighbors,
} from '../world/RoadGraph';
import { speedLimitAt, worldToCell } from '../world/CityMap';
import type { Outfit } from './HumanRig';
import type { Drivable } from './Drivable';
import {
  NpcLaneFollower,
  npcVehicleNavigationStats,
} from './NpcLaneFollower';

const TURN_SPEED = 4;
const MAX_SAFE_CROSS_TRACK = 2.2;
const MAX_RECOVERABLE_CROSS_TRACK = 4;

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
  private follower: NpcLaneFollower;
  private prevVel = new THREE.Vector3();
  private hasPrevVel = false;
  private stuckTime = 0;
  private reverseTime = 0;
  private exitRequested = false;
  private outsideLane = false;
  private terminalStopped = false;
  private nearbyVehicles: Drivable[] = [];

  constructor(
    private game: Game,
    model: string,
    from: CellRef,
    to: CellRef,
    readonly driverProfile: { outfit: Outfit; heightScale: number },
    existingVehicle?: Vehicle
  ) {
    this.follower = new NpcLaneFollower(from, to);
    this.fillRoute();
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
    this.fillRoute();
    for (let advances = 0; advances < 4 && this.follower.advanceIfNeeded(t.x, t.z); advances++) {
      this.fillRoute();
    }
    const speed = v.forwardSpeed();
    const sample = this.follower.sample(
      t.x,
      t.z,
      THREE.MathUtils.clamp(3.5 + Math.abs(speed) * 0.45, 3.5, 9)
    );
    const edgeEnd = pointWorld(this.follower.to);
    const dist = Math.hypot(edgeEnd.x - t.x, edgeEnd.z - t.z);

    // Pure-pursuit steering follows the route ahead instead of cutting directly
    // from one sparse waypoint to the next.
    const local = new THREE.Vector3(sample.target.x - t.x, 0, sample.target.z - t.z)
      .applyQuaternion(v.quaternion().invert());
    const angle = Math.atan2(local.x, Math.max(local.z, 0.01));
    let steer = -THREE.MathUtils.clamp(angle / 0.45, -1, 1);

    const turning = Math.abs(angle) > 0.25 || sample.turnCosine < 0.86;
    // Preserve the existing 8 m/s feel for a 50 km/h street while allowing
    // authored limits to slow shopping strips and speed up arterials.
    const roadLimit = Math.min(
      12,
      (this.follower.to.speed ?? speedLimitAt(this.follower.to.cx, this.follower.to.cz)) * 0.16
    );
    let target = turning ? Math.min(TURN_SPEED, roadLimit) : roadLimit;
    if (this.obstacleAhead()) target = 0;
    if (
      dist < 10 &&
      !this.game.npcs.trafficSignalAllows(this.follower.from, this.follower.to, t.y + 0.75)
    ) target = 0;
    const terminalStop = this.follower.futureLength() === 0 && sample.distanceToRouteEnd < 4.5;
    if (terminalStop) target = 0;
    if (terminalStop && !this.terminalStopped) npcVehicleNavigationStats.terminalStops++;
    this.terminalStopped = terminalStop;
    if (sample.crossTrack > MAX_SAFE_CROSS_TRACK) target = Math.min(target, 2.2);
    if (sample.crossTrack > MAX_RECOVERABLE_CROSS_TRACK) target = 0;
    const outsideLane = sample.crossTrack > MAX_SAFE_CROSS_TRACK;
    if (outsideLane && !this.outsideLane) npcVehicleNavigationStats.laneDepartures++;
    this.outsideLane = outsideLane;

    let throttle = 0;
    let brake = 0;
    if (this.reverseTime > 0) {
      this.reverseTime -= dt;
      v.command = { steer: -steer, throttle: 0, brake: 1, handbrake: false };
      return;
    }
    if (speed < target - 0.5) throttle = 0.5;
    else if (speed > target + 1) brake = target === 0 ? 0.8 : 0.3;

    // Un-stick only while still close to the lane. Reversing a car that has
    // already left the route tends to send it farther across the kerb.
    if (target > 0 && sample.crossTrack <= MAX_SAFE_CROSS_TRACK && Math.abs(speed) < 0.4) {
      this.stuckTime += dt;
      if (this.stuckTime > 2.5) {
        this.stuckTime = 0;
        this.reverseTime = 1.2;
        npcVehicleNavigationStats.recoveryAttempts++;
      }
    } else {
      this.stuckTime = 0;
    }

    v.command = { steer, throttle, brake, handbrake: false };
  }

  private fillRoute(): void {
    while (this.follower.futureLength() < 4) {
      const edge = this.follower.lastEdge();
      const next = nextVehicleRoadCell(edge.from, edge.to, Math.random());
      if (!next) break;
      this.follower.append(next);
    }
  }

  private obstacleAhead(): boolean {
    const t = this.vehicle.body.translation();
    const f = this.vehicle.forward();
    if (this.game.transitBlocksRoad(t.x + f.x * 5, t.z + f.z * 5)) return true;
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
        // Queue in-lane. Lateral passing is unsafe until the graph has explicit
        // lane-change connectors.
        return true;
      }
    }
    for (const p of this.game.players) {
      if (p.driving) continue;
      const pos = p.character.position();
      const dx = pos.x - t.x;
      const dz = pos.z - t.z;
      if (dx * dx + dz * dz > 64) continue;
      const along = dx * f.x + dz * f.z;
      if (along > 1 && Math.abs(dx * -f.z + dz * f.x) < 2) return true;
    }
    for (const pedestrian of this.game.npcs.peds) {
      if (!pedestrian.alive()) continue;
      const pos = pedestrian.position();
      const dx = pos.x - t.x;
      const dz = pos.z - t.z;
      const along = dx * f.x + dz * f.z;
      if (along > 0.8 && along < 8 && Math.abs(dx * -f.z + dz * f.x) < 1.8) {
        return true;
      }
    }
    return false;
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
