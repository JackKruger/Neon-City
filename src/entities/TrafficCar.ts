import * as THREE from 'three';
import type { Entity, Game } from '../core/Game';
import { Vehicle } from './Vehicle';
import { CellRef, lanePoint, nextRoadCell } from '../world/RoadGraph';
import { speedLimitAt, worldToCell } from '../world/CityMap';

const TURN_SPEED = 4;

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

  constructor(
    private game: Game,
    model: string,
    from: CellRef,
    to: CellRef
  ) {
    this.from = from;
    this.to = to;
    this.waypoint = lanePoint(from, to, 0.18);
    const start = lanePoint(from, to, 0.18);
    const startPos = { x: start.x + (from.cx - to.cx) * 6, z: start.z + (from.cz - to.cz) * 6 };
    const heading = Math.atan2(to.cx - from.cx, to.cz - from.cz);
    this.vehicle = new Vehicle(game, model, startPos.x, startPos.z, heading);
    this.vehicle.driver = this;
    game.addVehicle(this.vehicle);
  }

  update(dt: number): void {
    const v = this.vehicle;
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
    const steer = -THREE.MathUtils.clamp(angle / 0.45, -1, 1);

    const turning = Math.abs(angle) > 0.25;
    // Preserve the existing 8 m/s feel for a 50 km/h street while allowing
    // authored limits to slow shopping strips and speed up arterials.
    const roadLimit = Math.min(12, speedLimitAt(this.to.cx, this.to.cz) * 0.16);
    let target = turning ? Math.min(TURN_SPEED, roadLimit) : roadLimit;
    if (this.blockedAhead()) target = 0;

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
    const next = nextRoadCell(this.from, this.to, Math.random());
    this.from = this.to;
    this.to = next;
    this.waypoint = lanePoint(this.from, this.to, 0.18);
  }

  private blockedAhead(): boolean {
    const t = this.vehicle.body.translation();
    const f = this.vehicle.forward();
    for (const other of this.game.vehicles) {
      if (other === this.vehicle) continue;
      const o = other.body.translation();
      const dx = o.x - t.x;
      const dz = o.z - t.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > 81) continue;
      const along = dx * f.x + dz * f.z;
      if (along < 1.5) continue;
      const side = Math.abs(dx * -f.z + dz * f.x);
      if (side < 2.2) return true;
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
    return false;
  }

  crash(): void {
    this.crashed = true;
    // The shaken NPC driver abandons the car; players can steal it.
    this.vehicle.driver = null;
  }

  /** Stop AI control before a player claims the occupied vehicle. */
  prepareForCarjacking(): void {
    this.crashed = true;
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
