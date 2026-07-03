import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Entity, Game } from '../core/Game';
import type { CameraTarget } from '../render/Viewports';

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

export class Vehicle implements Entity, CameraTarget {
  readonly root = new THREE.Group();
  readonly body: RAPIER.RigidBody;
  private controller: RAPIER.DynamicRayCastVehicleController;
  private wheels: WheelVisual[] = [];
  private steerAngle = 0;
  private sideFriction = 1.0;

  command: DriveCommand = { steer: 0, throttle: 0, brake: 0, handbrake: false };
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
      (new THREE.Box3().setFromObject(wheelNodes[0]).getSize(new THREE.Vector3()).y ?? 0.6) / 2;

    // Chassis collider from the model bbox minus wheels.
    for (const w of wheelNodes) this.root.attach(w);
    const bbox = new THREE.Box3().setFromObject(model);
    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());

    const world = game.world;
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, wheelRadius + SUSPENSION_REST + 0.05, z)
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
        .setDensity(0.6),
      this.body
    );
    // Dense low slab drops the center of mass for flatter cornering.
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(size.x / 2, 0.08, size.z / 2)
        .setTranslation(center.x, center.y - size.y / 4, center.z)
        .setDensity(5),
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
      this.controller.setWheelFrictionSlip(i, 3.2);
      this.controller.setWheelSideFrictionStiffness(i, 1.0);
      this.wheels.push({
        node,
        connection,
        rest: SUSPENSION_REST,
        front: node.name.includes('front'),
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

  update(dt: number): void {
    const { steer, throttle, brake, handbrake } = this.command;
    const mass = this.body.mass();
    const speed = this.forwardSpeed();

    // Steering: tighter at low speed, smoothed toward target.
    const maxSteer = 0.55 / (1 + Math.abs(speed) * 0.045);
    const target = -steer * maxSteer;
    const rate = 3.5 * dt;
    this.steerAngle += THREE.MathUtils.clamp(target - this.steerAngle, -rate, rate);

    // Rear side friction eases off while the handbrake is held (slides).
    const targetFriction = handbrake ? 0.35 : 1.0;
    this.sideFriction = THREE.MathUtils.lerp(this.sideFriction, targetFriction, 0.2);

    const forwardTaper = THREE.MathUtils.clamp(1 - speed / MAX_FORWARD_SPEED, 0, 1);
    let engine = throttle * mass * 7 * forwardTaper;
    let brakeForce = 0;
    if (brake > 0) {
      if (speed < 1.0) {
        const reverseTaper = THREE.MathUtils.clamp(1 + speed / MAX_REVERSE_SPEED, 0, 1);
        engine = -brake * mass * 5 * reverseTaper;
      } else {
        brakeForce = brake * mass * 2;
      }
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

    this.controller.updateVehicle(dt);
    this.syncVisuals();
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
