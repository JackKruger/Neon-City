import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Entity, Game } from '../core/Game';
import type { CopPed } from './CopPed';
import type { Player } from './Player';
import { Vehicle } from './Vehicle';
import type { CellRef } from '../world/RoadGraph';
import {
  findRoadRoute,
  nearestRoadPoint,
  pointWorld,
} from '../world/RoadGraph';
import {
  NpcLaneFollower,
  npcVehicleNavigationStats,
} from './NpcLaneFollower';

const DIRECT_PURSUIT_DISTANCE = 12;
const MAX_SAFE_CROSS_TRACK = 2.2;
const MAX_RECOVERABLE_CROSS_TRACK = 4;

export interface PoliceSpawnPose {
  x: number;
  z: number;
  heading: number;
}

/** Lane-aligned pursuit spawn, or a perpendicular pose for an authored roadblock. */
export function policeSpawnPose(from: CellRef, to: CellRef, roadblock = false): PoliceSpawnPose {
  const a = pointWorld(from);
  const b = pointWorld(to);
  return {
    x: a.x,
    z: a.z,
    heading: Math.atan2(b.x - a.x, b.z - a.z) + (roadblock ? Math.PI / 2 : 0),
  };
}

/** Pursuit AI: chases its target player and rams them. */
export class PoliceCar implements Entity {
  readonly vehicle: Vehicle;
  leaving = false;
  /** The officer this car has dropped off (one per car until they fall). */
  deployedCop: CopPed | null = null;
  private leaveTimer = 0;
  private reverseTime = 0;
  private stuckTime = 0;
  private routeTimer = 0;
  private beaconTime = 0;
  private roadblockTime = 0;
  private outsideLane = false;
  private terminalStopped = false;
  private beaconRed: THREE.Mesh;
  private beaconBlue: THREE.Mesh;
  private follower: NpcLaneFollower;

  constructor(
    private game: Game,
    private target: Player,
    from: CellRef,
    to: CellRef,
    private roadblock = false
  ) {
    this.follower = new NpcLaneFollower(from, to);
    const pose = policeSpawnPose(from, to, roadblock);
    this.vehicle = new Vehicle(game, 'cars/police', pose.x, pose.z, pose.heading);
    this.vehicle.driver = this;
    game.addVehicle(this.vehicle);

    const mkBeacon = (color: number, dx: number) => {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(0.28, 0.14, 0.3),
        new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0,
        })
      );
      m.position.set(dx, 2.05, -0.1);
      this.vehicle.root.add(m);
      return m;
    };
    this.beaconRed = mkBeacon(0xff2244, -0.28);
    this.beaconBlue = mkBeacon(0x2266ff, 0.28);
  }

  update(dt: number): void {
    this.updateBeacons(dt);
    const v = this.vehicle;

    if (v.destroyed) {
      this.leaving = true;
      this.leaveTimer += dt;
      return;
    }

    if (this.leaving) this.leaveTimer += dt;

    const t = v.body.translation();
    const targetPos = this.target.wanted.pursuitTarget();
    const dist = Math.hypot(targetPos.x - t.x, targetPos.z - t.z);

    if (this.roadblock) {
      this.roadblockTime += dt;
      if (dist > 18 && this.roadblockTime < 16) {
        v.command = { steer: 0, throttle: 0, brake: 0, handbrake: true };
        return;
      }
      this.roadblock = false;
    }

    this.routeTimer -= dt;
    if (!this.leaving && this.routeTimer <= 0) {
      this.routeTimer = 0.65;
      this.replan(targetPos.x, targetPos.z);
    }
    for (
      let advances = 0;
      advances < 5 && this.follower.advanceIfNeeded(t.x, t.z);
      advances++
    ) {
      // The follower mutates its own route cursor.
    }

    const speed = v.forwardSpeed();
    const directPursuit = !this.leaving &&
      dist <= DIRECT_PURSUIT_DISTANCE &&
      this.directPursuitIsClear(t, targetPos);
    const sample = this.follower.sample(
      t.x,
      t.z,
      THREE.MathUtils.clamp(4 + Math.abs(speed) * 0.5, 4, 10)
    );
    const steeringTarget = directPursuit ? targetPos : sample.target;
    const local = new THREE.Vector3(steeringTarget.x - t.x, 0, steeringTarget.z - t.z)
      .applyQuaternion(v.quaternion().invert());
    const angle = Math.atan2(local.x, Math.max(local.z, 0.01));
    const behind = local.z < 0;

    if (this.reverseTime > 0) {
      this.reverseTime -= dt;
      v.command = {
        steer: THREE.MathUtils.clamp(angle, -1, 1),
        throttle: 0,
        brake: 1,
        handbrake: false,
      };
      return;
    }

    if (
      Math.abs(speed) < 0.5 &&
      dist > 4 &&
      (directPursuit || sample.crossTrack <= MAX_SAFE_CROSS_TRACK)
    ) {
      this.stuckTime += dt;
      if (this.stuckTime > 1.6) {
        this.stuckTime = 0;
        this.reverseTime = 1.0;
        npcVehicleNavigationStats.recoveryAttempts++;
      }
    } else {
      this.stuckTime = 0;
    }

    let steer = -THREE.MathUtils.clamp(angle / 0.5, -1, 1);
    const authoredLimit = Math.min(16, (this.follower.to.speed ?? 60) * 0.22);
    const turning = Math.abs(angle) > 0.28 || sample.turnCosine < 0.82;
    let targetSpeed = turning ? Math.min(6.5, authoredLimit) : authoredLimit;
    if (this.leaving) targetSpeed = Math.min(targetSpeed, 8);
    const terminalStop = !directPursuit &&
      this.follower.futureLength() === 0 &&
      sample.distanceToRouteEnd < 4;
    if (terminalStop) {
      targetSpeed = 0;
    }
    if (terminalStop && !this.terminalStopped) npcVehicleNavigationStats.terminalStops++;
    this.terminalStopped = terminalStop;
    if (!directPursuit && sample.crossTrack > MAX_SAFE_CROSS_TRACK) {
      targetSpeed = Math.min(targetSpeed, 2.5);
    }
    if (!directPursuit && sample.crossTrack > MAX_RECOVERABLE_CROSS_TRACK) targetSpeed = 0;
    const outsideLane = !directPursuit && sample.crossTrack > MAX_SAFE_CROSS_TRACK;
    if (outsideLane && !this.outsideLane) npcVehicleNavigationStats.laneDepartures++;
    this.outsideLane = outsideLane;
    let throttle = speed < targetSpeed - 0.5 ? 1 : 0;
    let brake = 0;
    if (speed > targetSpeed + 1) brake = targetSpeed === 0 ? 0.8 : 0.35;
    if (directPursuit && behind && dist > 6) {
      // Target behind: keep turning hard, moderate speed.
      throttle = speed > 6 ? 0 : 0.6;
      steer = angle > 0 ? -1 : 1;
    } else if (directPursuit && dist < 5 && this.target.driving === false) {
      // Don't grind over on-foot players endlessly; stalk them.
      throttle = speed > 4 ? 0 : 0.4;
      brake = speed > 5 ? 0.5 : 0;
      if (Math.abs(speed) < 1.5) this.target.wanted.maybeDeployCop(this);
    }
    v.command = { steer, throttle, brake, handbrake: false };
  }

  private replan(targetX: number, targetZ: number): void {
    const goal = nearestRoadPoint(targetX, targetZ, 'vehicle');
    if (!goal) {
      npcVehicleNavigationStats.routeFailures++;
      return;
    }
    const route = findRoadRoute(this.follower.to, goal, 'vehicle', { maxVisited: 2500 });
    if (!route) {
      npcVehicleNavigationStats.routeFailures++;
      return;
    }
    this.follower.replaceRoute(
      route.length === 1 ? [this.follower.from, this.follower.to] : [this.follower.from, ...route]
    );
    npcVehicleNavigationStats.routeReplans++;
  }

  /** Do not abandon the lane for a nearby target on the far side of a wall. */
  private directPursuitIsClear(
    from: { x: number; y: number; z: number },
    target: THREE.Vector3
  ): boolean {
    const targetY = target.y + (this.target.driving ? 0 : 0.9);
    const dx = target.x - from.x;
    const dy = targetY - from.y;
    const dz = target.z - from.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance < 0.1) return true;
    const hit = this.game.world.castRay(
      new RAPIER.Ray(
        new RAPIER.Vector3(from.x, from.y, from.z),
        new RAPIER.Vector3(dx / distance, dy / distance, dz / distance)
      ),
      distance,
      true,
      RAPIER.QueryFilterFlags.ONLY_FIXED,
      undefined,
      undefined,
      this.vehicle.body
    );
    return hit === null;
  }

  private updateBeacons(dt: number): void {
    this.beaconTime += dt;
    const phase = Math.floor(this.beaconTime * 5) % 2 === 0;
    (this.beaconRed.material as THREE.MeshStandardMaterial).emissiveIntensity = phase ? 2.5 : 0;
    (this.beaconBlue.material as THREE.MeshStandardMaterial).emissiveIntensity = phase ? 0 : 2.5;
  }

  /** Distance to the pursued player. */
  distanceToTarget(): number {
    const t = this.vehicle.body.translation();
    const p = this.target.driving
      ? this.target.vehicle!.root.position
      : this.target.character.position();
    return Math.hypot(p.x - t.x, p.z - t.z);
  }

  shouldDespawn(): boolean {
    return this.vehicle.destroyed || (this.leaving && (this.leaveTimer > 6 || this.distanceToTarget() > 110));
  }

  dispose(): void {
    this.game.removeVehicle(this.vehicle);
  }
}
