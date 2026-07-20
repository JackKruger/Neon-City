import * as THREE from 'three';
import type { Entity, Game } from '../core/Game';
import type { CopPed } from './CopPed';
import type { Player } from './Player';
import { Vehicle } from './Vehicle';

/** Pursuit AI: chases its target player and rams them. */
export class PoliceCar implements Entity {
  readonly vehicle: Vehicle;
  leaving = false;
  /** The officer this car has dropped off (one per car until they fall). */
  deployedCop: CopPed | null = null;
  private leaveTimer = 0;
  private reverseTime = 0;
  private stuckTime = 0;
  private beaconTime = 0;
  private roadblockTime = 0;
  private beaconRed: THREE.Mesh;
  private beaconBlue: THREE.Mesh;

  constructor(
    private game: Game,
    private target: Player,
    x: number,
    z: number,
    heading: number,
    private roadblock = false
  ) {
    this.vehicle = new Vehicle(game, 'cars/police', x, z, heading);
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

    if (this.leaving) {
      this.leaveTimer += dt;
      v.command = { steer: 0, throttle: 0.5, brake: 0, handbrake: false };
      return;
    }

    const t = v.body.translation();
    const targetPos = this.target.wanted.pursuitTarget();
    const local = new THREE.Vector3(targetPos.x - t.x, 0, targetPos.z - t.z);
    const dist = local.length();
    local.applyQuaternion(v.quaternion().invert());
    const angle = Math.atan2(local.x, Math.max(local.z, 0.01));
    const behind = local.z < 0;

    if (this.roadblock) {
      this.roadblockTime += dt;
      if (dist > 18 && this.roadblockTime < 16) {
        v.command = { steer: 0, throttle: 0, brake: 0, handbrake: true };
        return;
      }
      this.roadblock = false;
    }

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

    const speed = v.forwardSpeed();
    if (Math.abs(speed) < 0.5 && dist > 4) {
      this.stuckTime += dt;
      if (this.stuckTime > 1.6) {
        this.stuckTime = 0;
        this.reverseTime = 1.0;
      }
    } else {
      this.stuckTime = 0;
    }

    let steer = -THREE.MathUtils.clamp(angle / 0.5, -1, 1);
    let throttle = 1;
    let brake = 0;
    if (behind && dist > 6) {
      // Target behind: keep turning hard, moderate speed.
      throttle = speed > 6 ? 0 : 0.6;
      steer = angle > 0 ? -1 : 1;
    } else if (dist < 5 && this.target.driving === false) {
      // Don't grind over on-foot players endlessly; stalk them.
      throttle = speed > 4 ? 0 : 0.4;
      brake = speed > 5 ? 0.5 : 0;
      if (Math.abs(speed) < 1.5) this.target.wanted.maybeDeployCop(this);
    }
    v.command = { steer, throttle, brake, handbrake: false };
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
