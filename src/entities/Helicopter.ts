import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Game } from '../core/Game';
import { GRAVITY, VEHICLE_COLLISION_GROUPS } from '../core/const';
import { heightAt } from '../world/CityMap';
import type { Drivable, DriveCommand } from './Drivable';

const HOVER_GRAVITY = -GRAVITY;
const HORIZONTAL_ACCEL = 9;
const ASCEND_SPEED = 6;
const DESCEND_SPEED = -4.5;
const MAX_HORIZONTAL_SPEED = 30;

const BODY_MAT = new THREE.MeshStandardMaterial({
  color: 0xff3f8e,
  roughness: 0.58,
  metalness: 0.18,
});
const DARK_MAT = new THREE.MeshStandardMaterial({
  color: 0x17243d,
  roughness: 0.3,
  metalness: 0.35,
});
const GLASS_MAT = new THREE.MeshStandardMaterial({
  color: 0x55dffc,
  roughness: 0.12,
  metalness: 0.1,
  transparent: true,
  opacity: 0.72,
});

/** Arcade helicopter with automatic hover and procedural low-poly visuals. */
export class Helicopter implements Drivable {
  readonly kind = 'helicopter' as const;
  readonly root = new THREE.Group();
  readonly body: RAPIER.RigidBody;
  command: DriveCommand = {
    steer: 0,
    throttle: 0,
    brake: 0,
    handbrake: false,
    descend: false,
  };
  driver: object | null = null;
  destroyed = false;

  private model = new THREE.Group();
  private mainRotor = new THREE.Group();
  private tailRotor = new THREE.Group();
  private parkedAnchor: { x: number; y: number; z: number; rotation: RAPIER.Rotation } | null = null;
  private rotorSpeed = 0;
  private flying = false;

  constructor(private game: Game, x: number, z: number, heading = 0) {
    this.buildModel();
    this.root.add(this.model);
    this.body = game.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, heightAt(x, z) + 0.98, z)
        .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading))
        .setLinearDamping(0.45)
        .setAngularDamping(2.5)
        .setGravityScale(0)
        .enabledRotations(false, true, false)
        .setCcdEnabled(true)
    );
    game.world.createCollider(
      RAPIER.ColliderDesc.cuboid(1.02, 0.58, 1.75)
        .setTranslation(0, 0.08, 0.15)
        .setDensity(250)
        .setFriction(0.1)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setRestitution(0.18)
        .setCollisionGroups(VEHICLE_COLLISION_GROUPS),
      this.body
    );
    game.scene.add(this.root);
    this.syncVisuals();
  }

  update(dt: number): void {
    const occupied = this.driver !== null;
    const targetRotor = occupied ? 22 : 2.5;
    this.rotorSpeed += (targetRotor - this.rotorSpeed) * (1 - Math.exp(-3.5 * dt));
    this.mainRotor.rotation.y += this.rotorSpeed * dt;
    this.tailRotor.rotation.x += this.rotorSpeed * 1.8 * dt;

    if (!occupied) {
      this.park();
      this.model.rotation.x *= Math.exp(-6 * dt);
      this.model.rotation.z *= Math.exp(-6 * dt);
      return;
    }
    if (!this.flying) {
      this.flying = true;
      this.parkedAnchor = null;
      this.body.setGravityScale(1, true);
    }

    const mass = this.body.mass();
    const velocity = this.body.linvel();
    const verticalTarget = this.command.handbrake
      ? ASCEND_SPEED
      : this.command.descend
        ? DESCEND_SPEED
        : 0;
    const verticalCorrection = THREE.MathUtils.clamp(
      (verticalTarget - velocity.y) * 3.2,
      -12,
      12
    );
    this.body.applyImpulse(
      new RAPIER.Vector3(0, mass * (HOVER_GRAVITY + verticalCorrection) * dt, 0),
      true
    );

    const forward = this.forward().setY(0).normalize();
    const drive = this.command.throttle - this.command.brake;
    this.body.applyImpulse(
      new RAPIER.Vector3(
        forward.x * drive * mass * HORIZONTAL_ACCEL * dt,
        0,
        forward.z * drive * mass * HORIZONTAL_ACCEL * dt
      ),
      true
    );
    const horizontalSpeed = Math.hypot(velocity.x, velocity.z);
    if (horizontalSpeed > MAX_HORIZONTAL_SPEED) {
      const scale = MAX_HORIZONTAL_SPEED / horizontalSpeed;
      this.body.setLinvel(
        new RAPIER.Vector3(velocity.x * scale, velocity.y, velocity.z * scale),
        true
      );
    }

    const angular = this.body.angvel();
    const yawRate = THREE.MathUtils.lerp(
      angular.y,
      this.command.steer * 1.35,
      1 - Math.exp(-7 * dt)
    );
    this.body.setAngvel(new RAPIER.Vector3(0, yawRate, 0), true);
    this.model.rotation.x = THREE.MathUtils.lerp(
      this.model.rotation.x,
      drive * 0.16,
      1 - Math.exp(-5 * dt)
    );
    this.model.rotation.z = THREE.MathUtils.lerp(
      this.model.rotation.z,
      -this.command.steer * 0.13,
      1 - Math.exp(-5 * dt)
    );
  }

  afterPhysics(): void {
    if (this.parkedAnchor) this.restoreParkedAnchor();
    this.syncVisuals();
  }

  private park(): void {
    this.flying = false;
    this.body.setGravityScale(0, true);
    const t = this.body.translation();
    if (!this.parkedAnchor) {
      const r = this.body.rotation();
      this.parkedAnchor = {
        x: t.x,
        y: t.y,
        z: t.z,
        rotation: { x: r.x, y: r.y, z: r.z, w: r.w },
      };
    }
    this.restoreParkedAnchor();
  }

  private restoreParkedAnchor(): void {
    if (!this.parkedAnchor) return;
    const a = this.parkedAnchor;
    this.body.setTranslation(new RAPIER.Vector3(a.x, a.y, a.z), false);
    this.body.setRotation(a.rotation, false);
    this.body.setLinvel(new RAPIER.Vector3(0, 0, 0), false);
    this.body.setAngvel(new RAPIER.Vector3(0, 0, 0), false);
  }

  forwardSpeed(): number {
    const v = this.body.linvel();
    const f = this.forward();
    return v.x * f.x + v.z * f.z;
  }

  forward(): THREE.Vector3 {
    return new THREE.Vector3(0, 0, 1).applyQuaternion(this.quaternion());
  }

  quaternion(): THREE.Quaternion {
    const r = this.body.rotation();
    return new THREE.Quaternion(r.x, r.y, r.z, r.w);
  }

  speedKmh(): number {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.y, v.z) * 3.6;
  }

  getSpeed(): number {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.z);
  }

  getHeading(): number {
    const f = this.forward();
    return Math.atan2(f.x, f.z);
  }

  getFocus(out: THREE.Vector3): void {
    const t = this.body.translation();
    out.set(t.x, t.y, t.z);
  }

  getFollowDistance(): number {
    return 10;
  }

  overlapsPedestrian(position: THREE.Vector3, radius = 0.38, height = 1.8): boolean {
    const t = this.body.translation();
    const local = new THREE.Vector3(
      position.x - t.x,
      position.y + height / 2 - t.y,
      position.z - t.z
    ).applyQuaternion(this.quaternion().invert());
    return (
      Math.abs(local.x) <= 1.02 + radius &&
      Math.abs(local.y - 0.08) <= 0.58 + height / 2 &&
      Math.abs(local.z - 0.15) <= 1.75 + radius
    );
  }

  doorPosition(side: 1 | -1, clearance: number, out = new THREE.Vector3()): THREE.Vector3 {
    const t = this.body.translation();
    const offset = new THREE.Vector3(side * (1.02 + clearance), -0.82, 0.35)
      .applyQuaternion(this.quaternion());
    return out.set(t.x + offset.x, t.y + offset.y, t.z + offset.z);
  }

  seatPosition(side: 1 | -1, out = new THREE.Vector3()): THREE.Vector3 {
    const t = this.body.translation();
    const offset = new THREE.Vector3(side * 0.22, -0.55, 0.45).applyQuaternion(this.quaternion());
    return out.set(t.x + offset.x, t.y + offset.y, t.z + offset.z);
  }

  setDoorOpen(_side: 1 | -1, _open: boolean): void {}

  canExit(): boolean {
    const t = this.body.translation();
    return (
      t.y - heightAt(t.x, t.z) < 1.8 &&
      this.getSpeed() < 3 &&
      Math.abs(this.body.linvel().y) < 2
    );
  }

  private syncVisuals(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.root.position.set(t.x, t.y, t.z);
    this.root.quaternion.set(r.x, r.y, r.z, r.w);
  }

  private buildModel(): void {
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, position: THREE.Vector3) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(position);
      this.model.add(mesh);
      return mesh;
    };

    const cabin = add(new THREE.SphereGeometry(1, 16, 12), BODY_MAT, new THREE.Vector3(0, 0.15, 0.35));
    cabin.scale.set(1.05, 0.78, 1.45);
    const glass = add(new THREE.SphereGeometry(0.82, 14, 10), GLASS_MAT, new THREE.Vector3(0, 0.32, 1.0));
    glass.scale.set(0.94, 0.66, 0.9);

    const boom = add(new THREE.CylinderGeometry(0.12, 0.28, 3.5, 8), BODY_MAT, new THREE.Vector3(0, 0.35, -1.9));
    boom.rotation.x = Math.PI / 2;
    const fin = add(new THREE.BoxGeometry(0.1, 1.25, 0.65), BODY_MAT, new THREE.Vector3(0, 0.82, -3.55));
    fin.rotation.x = -0.18;

    for (const side of [-1, 1]) {
      const skid = add(new THREE.CylinderGeometry(0.055, 0.055, 3.1, 8), DARK_MAT, new THREE.Vector3(side * 0.82, -0.88, 0));
      skid.rotation.x = Math.PI / 2;
      for (const z of [-0.75, 0.75]) {
        const strut = add(new THREE.CylinderGeometry(0.04, 0.04, 0.75, 8), DARK_MAT, new THREE.Vector3(side * 0.62, -0.55, z));
        strut.rotation.z = side * 0.35;
      }
    }

    this.mainRotor.position.set(0, 1.15, 0.05);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.48, 8), DARK_MAT);
    mast.position.y = -0.2;
    this.mainRotor.add(mast);
    for (const angle of [0, Math.PI / 2]) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.035, 0.16), DARK_MAT);
      blade.rotation.y = angle;
      this.mainRotor.add(blade);
    }
    this.model.add(this.mainRotor);

    this.tailRotor.position.set(0.12, 0.65, -3.55);
    for (const angle of [0, Math.PI / 2]) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.25, 0.11), DARK_MAT);
      blade.rotation.x = angle;
      this.tailRotor.add(blade);
    }
    this.model.add(this.tailRotor);
  }

  dispose(): void {
    this.game.scene.remove(this.root);
    this.game.world.removeRigidBody(this.body);
  }
}
