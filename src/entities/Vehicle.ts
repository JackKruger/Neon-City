import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Entity, Game } from '../core/Game';
import { VEHICLE_COLLISION_GROUPS } from '../core/const';
import type { CameraTarget } from '../render/Viewports';
import { heightAt } from '../world/CityMap';

/** Uniform scale for all Kenney car models (sedan 2.55u -> ~4.4m). */
const CAR_SCALE = 1.73;

export interface DriveCommand {
  steer: number; // -1..1
  throttle: number; // 0..1
  brake: number; // 0..1, acts as reverse when nearly stopped
  handbrake: boolean;
}

interface WheelVisual {
  node: THREE.Object3D;
  connection: THREE.Vector3;
  rest: number;
  front: boolean;
}

const SUSPENSION_REST = 0.3;
/** Normalized spring constant (Rapier multiplies by chassis mass). */
const SUSPENSION_STIFFNESS = 60;
/** Static deflection under gravity: g / (4 * stiffness). The connection
 * sits at wheel + (rest - sag) so the body settles at the model's designed
 * ride height once the springs compress. */
const STATIC_SAG = 20 / (4 * SUSPENSION_STIFFNESS);
const MAX_FORWARD_SPEED = 36; // m/s (~130 km/h)
const MAX_REVERSE_SPEED = 10;
/** Tire grip (Rapier frictionSlip). Higher up front fights understeer. */
const GRIP_FRONT = 4.8;
const GRIP_REAR = 4.2;
/** Front lateral stiffness > 1 keeps turn-in strong under full throttle,
 * when weight transfer unloads the front axle. */
const SIDE_STIFFNESS_FRONT = 1.3;
/** Extra downward acceleration at top speed (m/s^2); keeps fast cars planted. */
const DOWNFORCE_ACCEL = 6;
/**
 * Average densities for the hollow chassis and its low ballast. Together they
 * put a sedan around a tonne, so a ~60 kg ragdoll cannot absorb most of the
 * car's momentum. Drive forces and suspension limits already scale with mass.
 */
const CHASSIS_DENSITY = 60;
const BALLAST_DENSITY = 500;

export class Vehicle implements Entity, CameraTarget {
  readonly root = new THREE.Group();
  readonly body: RAPIER.RigidBody;
  private controller: RAPIER.DynamicRayCastVehicleController;
  private wheels: WheelVisual[] = [];
  private steerAngle = 0;
  private sideFriction = 1.0;
  private flippedTime = 0;
  private chassisCenter = new THREE.Vector3();
  private chassisHalfSize = new THREE.Vector3();
  private parkingAnchor: { x: number; z: number; rotation: RAPIER.Rotation } | null = null;

  // Vehicles are parked until a player or AI driver supplies a command.
  command: DriveCommand = { steer: 0, throttle: 0, brake: 0, handbrake: true };
  /** Current driver (Player or an AI), if any. */
  driver: object | null = null;
  /** Set false to leave the physics parked (traffic converts on impact). */
  destroyed = false;

  constructor(
    private game: Game,
    readonly modelName: string,
    x: number,
    z: number,
    heading: number
  ) {
    const model = game.assets.get(modelName);
    model.scale.setScalar(CAR_SCALE);
    this.root.add(model);
    model.updateMatrixWorld(true);

    // Locate wheel nodes; flip the model if its front is -Z so that the
    // vehicle's local forward is always +Z.
    const wheelNodes: THREE.Object3D[] = [];
    model.traverse((o) => {
      if (o.name.startsWith('wheel-')) wheelNodes.push(o);
    });
    const frontZ = wheelNodes
      .filter((w) => w.name.includes('front'))
      .reduce((acc, w) => acc + w.getWorldPosition(new THREE.Vector3()).z, 0);
    if (frontZ < 0) {
      model.rotation.y = Math.PI;
      model.updateMatrixWorld(true);
    }

    const wheelRadius =
      new THREE.Box3().setFromObject(wheelNodes[0]).getSize(new THREE.Vector3()).y / 2 || 0.3;

    // Chassis collider from the model bbox minus wheels.
    for (const w of wheelNodes) this.root.attach(w);
    const bbox = new THREE.Box3().setFromObject(model);
    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());
    this.chassisCenter.copy(center);
    this.chassisHalfSize.copy(size).multiplyScalar(0.5);

    const world = game.world;
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, heightAt(x, z) + wheelRadius + SUSPENSION_REST + 0.05, z)
        .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading))
        .setLinearDamping(0.08)
        .setAngularDamping(1.2)
        .setCcdEnabled(true)
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
        .setTranslation(center.x, center.y, center.z)
        .setFriction(0.4)
        .setRestitution(0.3)
        .setDensity(CHASSIS_DENSITY)
        .setCollisionGroups(VEHICLE_COLLISION_GROUPS),
      this.body
    );
    // Dense low slab drops the center of mass for flatter cornering.
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(size.x / 2, 0.08, size.z / 2)
        .setTranslation(center.x, center.y - size.y / 4, center.z)
        .setDensity(BALLAST_DENSITY)
        .setCollisionGroups(VEHICLE_COLLISION_GROUPS),
      this.body
    );

    this.controller = world.createVehicleController(this.body);
    const mass = this.body.mass();
    for (const node of wheelNodes) {
      const pos = node.getWorldPosition(new THREE.Vector3()); // root is at origin
      const connection = new THREE.Vector3(
        pos.x,
        pos.y + SUSPENSION_REST - STATIC_SAG,
        pos.z
      );
      const i = this.controller.numWheels();
      this.controller.addWheel(
        connection,
        new RAPIER.Vector3(0, -1, 0),
        new RAPIER.Vector3(-1, 0, 0),
        SUSPENSION_REST,
        wheelRadius
      );
      this.controller.setWheelSuspensionStiffness(i, SUSPENSION_STIFFNESS);
      this.controller.setWheelSuspensionCompression(i, 3.8);
      this.controller.setWheelSuspensionRelaxation(i, 7.0);
      this.controller.setWheelMaxSuspensionForce(i, mass * 60);
      this.controller.setWheelMaxSuspensionTravel(i, 0.3);
      const front = node.name.includes('front');
      this.controller.setWheelFrictionSlip(i, front ? GRIP_FRONT : GRIP_REAR);
      this.controller.setWheelSideFrictionStiffness(i, front ? SIDE_STIFFNESS_FRONT : 1.0);
      this.wheels.push({
        node,
        connection,
        rest: SUSPENSION_REST,
        front,
      });
    }

    game.scene.add(this.root);
    this.syncVisuals();
  }

  /** Signed speed along the chassis forward axis (m/s). */
  forwardSpeed(): number {
    const v = this.body.linvel();
    const f = this.forward();
    return v.x * f.x + v.y * f.y + v.z * f.z;
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

  /** True when a standing pedestrian capsule overlaps the chassis bounds. */
  overlapsPedestrian(position: THREE.Vector3, radius = 0.38, height = 1.8): boolean {
    const t = this.body.translation();
    const local = new THREE.Vector3(
      position.x - t.x,
      position.y + height / 2 - t.y,
      position.z - t.z
    ).applyQuaternion(this.quaternion().invert());
    return (
      Math.abs(local.x - this.chassisCenter.x) <= this.chassisHalfSize.x + radius &&
      Math.abs(local.y - this.chassisCenter.y) <= this.chassisHalfSize.y + height / 2 &&
      Math.abs(local.z - this.chassisCenter.z) <= this.chassisHalfSize.z + radius
    );
  }

  update(dt: number): void {
    const { steer, throttle, brake, handbrake } = this.command;
    this.pinWhileParked(
      this.driver === null && handbrake && steer === 0 && throttle === 0 && brake === 0
    );
    const mass = this.body.mass();
    const speed = this.forwardSpeed();
    const sliding = handbrake && Math.abs(speed) > 2;

    // Steering: tighter at low speed, wider under a handbrake slide so the
    // drift angle stays steerable. Returning to center is faster than
    // steering in — keyboard taps stop wandering the moment they're released.
    // Quadratic falloff keeps full-lock yaw rate roughly constant (~1 rad/s)
    // across the speed range instead of getting dartier the faster you go.
    const a = Math.abs(speed);
    const maxSteer = (sliding ? 0.8 : 0.6) / (1 + 0.05 * a + 0.006 * a * a);
    const target = -steer * maxSteer;
    const returning = Math.abs(target) < Math.abs(this.steerAngle);
    const rate = (returning ? 7.0 : 4.0) * dt;
    this.steerAngle += THREE.MathUtils.clamp(target - this.steerAngle, -rate, rate);

    // Rear side friction eases off while the handbrake is held at speed
    // (slides); a stopped handbraked car keeps full grip so it stays parked.
    const targetFriction = sliding ? 0.32 : 1.0;
    this.sideFriction = THREE.MathUtils.lerp(this.sideFriction, targetFriction, 0.2);

    // Quadratic taper keeps midrange pull strong and still reaches top speed.
    const speedRatio = THREE.MathUtils.clamp(speed / MAX_FORWARD_SPEED, 0, 1);
    const forwardTaper = 1 - speedRatio * speedRatio;
    let engine = throttle * mass * 8 * forwardTaper;
    let brakeForce = 0;
    if (brake > 0) {
      if (speed < 1.0) {
        const reverseTaper = THREE.MathUtils.clamp(1 + speed / MAX_REVERSE_SPEED, 0, 1);
        engine = -brake * mass * 5 * reverseTaper;
      } else {
        // The controller's wheel brake is savagely non-linear (it locks the
        // wheel at small values); this lands around 15 m/s^2 of decel.
        brakeForce = brake * mass * 0.08;
      }
    } else if (throttle === 0 && !handbrake && speed > 1) {
      // Engine braking: lifting off bleeds speed instead of coasting forever.
      engine = -mass * 1.5 * speedRatio;
    }

    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      if (w.front) {
        this.controller.setWheelSteering(i, this.steerAngle);
        this.controller.setWheelBrake(i, brakeForce);
      } else {
        this.controller.setWheelEngineForce(i, engine);
        this.controller.setWheelBrake(
          i,
          brakeForce * 0.6 + (handbrake ? mass * 3 : 0)
        );
        this.controller.setWheelSideFrictionStiffness(i, this.sideFriction);
      }
    }

    // Speed-scaled downforce while grounded: plants the car over crests and
    // intersection bumps, and scales grip up with speed.
    let grounded = 0;
    for (let i = 0; i < this.wheels.length; i++) {
      if (this.controller.wheelIsInContact(i)) grounded++;
    }
    if (grounded >= 2) {
      const df = mass * DOWNFORCE_ACCEL * speedRatio * dt;
      this.body.applyImpulse(new RAPIER.Vector3(0, -df, 0), true);
    }

    this.updateFlipRecovery(dt);
    this.controller.updateVehicle(dt);
  }

  /** Apply post-step parking constraints, then render the final physics pose. */
  afterPhysics(): void {
    if (this.parkingAnchor) this.restoreParkingAnchor();
    this.syncVisuals();
  }

  /**
   * Keep an unoccupied car fixed on a slope without suspending its vertical
   * settling. Player and AI drivers restore all degrees of freedom at once.
   */
  private pinWhileParked(locked: boolean): void {
    if (!locked) {
      if (this.parkingAnchor) this.body.wakeUp();
      this.parkingAnchor = null;
      return;
    }
    const translation = this.body.translation();
    if (!this.parkingAnchor) {
      const rotation = this.body.rotation();
      this.parkingAnchor = {
        x: translation.x,
        z: translation.z,
        rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
      };
    } else this.restoreParkingAnchor();
  }

  private restoreParkingAnchor(): void {
    if (!this.parkingAnchor) return;
    const translation = this.body.translation();
    this.body.setTranslation(
      new RAPIER.Vector3(this.parkingAnchor.x, translation.y, this.parkingAnchor.z),
      false
    );
    this.body.setRotation(this.parkingAnchor.rotation, false);
    const velocity = this.body.linvel();
    this.body.setLinvel(new RAPIER.Vector3(0, velocity.y, 0), false);
    this.body.setAngvel(new RAPIER.Vector3(0, 0, 0), false);
  }

  /** Rights the car after it has been stuck on its side/roof for a moment. */
  private updateFlipRecovery(dt: number): void {
    const q = this.quaternion();
    const upY = new THREE.Vector3(0, 1, 0).applyQuaternion(q).y;
    if (upY < 0.25 && this.getSpeed() < 2) {
      this.flippedTime += dt;
    } else {
      this.flippedTime = 0;
      return;
    }
    if (this.flippedTime < 1.5) return;
    this.flippedTime = 0;
    const t = this.body.translation();
    const yaw = this.getHeading();
    this.body.setTranslation(new RAPIER.Vector3(t.x, t.y + 1.2, t.z), true);
    this.body.setRotation(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
      true
    );
    this.body.setLinvel(new RAPIER.Vector3(0, 0, 0), true);
    this.body.setAngvel(new RAPIER.Vector3(0, 0, 0), true);
  }

  private syncVisuals(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.root.position.set(t.x, t.y, t.z);
    this.root.quaternion.set(r.x, r.y, r.z, r.w);

    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      const len = this.controller.wheelSuspensionLength(i) ?? w.rest;
      w.node.position.set(w.connection.x, w.connection.y - len, w.connection.z);
      w.node.rotation.order = 'YXZ';
      w.node.rotation.y = w.front ? this.steerAngle : 0;
      w.node.rotation.x = this.controller.wheelRotation(i) ?? 0;
      w.node.rotation.z = 0;
    }
  }

  // CameraTarget
  getFocus(out: THREE.Vector3): void {
    const t = this.body.translation();
    out.set(t.x, t.y, t.z);
  }
  getHeading(): number {
    const f = this.forward();
    return Math.atan2(f.x, f.z);
  }
  getSpeed(): number {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.z);
  }
  getFollowDistance(): number {
    return 7;
  }

  dispose(): void {
    this.game.scene.remove(this.root);
    this.controller.free();
    this.game.world.removeRigidBody(this.body);
  }
}
