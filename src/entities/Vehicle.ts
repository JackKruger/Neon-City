import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Entity, Game } from '../core/Game';
import { VEHICLE_COLLISION_GROUPS } from '../core/const';
import type { CombatTarget } from '../gameplay/Combat';
import type { WeaponDef } from '../gameplay/Weapons';
import type { CameraTarget } from '../render/Viewports';
import { heightAt } from '../world/CityMap';
import type { Drivable, DriveCommand } from './Drivable';
import type { Player } from './Player';

/** Uniform scale for all Kenney car models (sedan 2.55u -> ~4.4m). */
const CAR_SCALE = 1.73;

export type { DriveCommand } from './Drivable';

interface WheelVisual {
  node: THREE.Object3D;
  connection: THREE.Vector3;
  rest: number;
  front: boolean;
}

interface VehicleDoor {
  pivot: THREE.Group;
  amount: number;
  target: number;
}

interface DamageMaterial {
  material: THREE.MeshStandardMaterial;
  original: THREE.Color;
  roughness: number;
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
 * Bodywork should glance off obstacles instead of gripping them. Road holding
 * comes from the raycast wheels, so chassis contact friction can stay low.
 */
const BODY_FRICTION = 0.08;
const DOOR_OPEN_ANGLE = 1.18;
/**
 * Average densities for the hollow chassis and its low ballast. Together they
 * put a sedan around a tonne, so a ~60 kg ragdoll cannot absorb most of the
 * car's momentum. Drive forces and suspension limits already scale with mass.
 */
const CHASSIS_DENSITY = 60;
const BALLAST_DENSITY = 500;
const MAX_HEALTH = 200;
const FIRE_HEALTH = 40;
const BURN_DURATION = 6;
const IMPACT_DAMAGE_SPEED = 5.5;
const CHARRED = new THREE.Color(0x17151a);

export class Vehicle implements Entity, CameraTarget, Drivable, CombatTarget {
  readonly kind = 'car' as const;
  readonly hitEffect = 'metal' as const;
  readonly aimAssist = false;
  readonly root = new THREE.Group();
  readonly body: RAPIER.RigidBody;
  private controller: RAPIER.DynamicRayCastVehicleController;
  private wheels: WheelVisual[] = [];
  private steerAngle = 0;
  private sideFriction = 1.0;
  private flippedTime = 0;
  private chassisCenter = new THREE.Vector3();
  private chassisHalfSize = new THREE.Vector3();
  private doors = new Map<1 | -1, VehicleDoor>();
  private colliders: RAPIER.Collider[] = [];
  private damageMaterials: DamageMaterial[] = [];
  private preStepVelocity = new THREE.Vector3();
  private hasPreStepVelocity = false;
  private impactCooldown = 0;
  private fireFxCooldown = 0;
  private burnTime = 0;
  private lastAttacker: Player | null = null;
  private parkingAnchor: { x: number; z: number; rotation: RAPIER.Rotation } | null = null;

  // Vehicles are parked until a player or AI driver supplies a command.
  command: DriveCommand = { steer: 0, throttle: 0, brake: 0, handbrake: true };
  /** Current driver (Player or an AI), if any. */
  driver: object | null = null;
  /** True after the fire stage has converted this car into a wreck. */
  destroyed = false;
  health = MAX_HEALTH;
  burning = false;

  constructor(
    private game: Game,
    readonly modelName: string,
    x: number,
    z: number,
    heading: number
  ) {
    const model = game.assets.get(modelName);
    model.scale.setScalar(CAR_SCALE);
    const materialClones = new Map<THREE.Material, THREE.Material>();
    model.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const cloneMaterial = (source: THREE.Material): THREE.Material => {
        let clone = materialClones.get(source);
        if (!clone) {
          clone = source.clone();
          materialClones.set(source, clone);
          const colored = clone as THREE.MeshStandardMaterial;
          if (colored.color && typeof colored.roughness === 'number') {
            this.damageMaterials.push({
              material: colored,
              original: colored.color.clone(),
              roughness: colored.roughness,
            });
          }
        }
        return clone;
      };
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map(cloneMaterial)
        : cloneMaterial(mesh.material);
    });
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
    this.buildDoors();

    const world = game.world;
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, heightAt(x, z) + wheelRadius + SUSPENSION_REST + 0.05, z)
        .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading))
        .setLinearDamping(0.08)
        .setAngularDamping(1.2)
        .setCcdEnabled(true)
    );
    const chassisCollider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
        .setTranslation(center.x, center.y, center.z)
        .setFriction(BODY_FRICTION)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setRestitution(0.3)
        .setDensity(CHASSIS_DENSITY)
        .setCollisionGroups(VEHICLE_COLLISION_GROUPS),
      this.body
    );
    this.colliders.push(chassisCollider);
    // Dense low slab drops the center of mass for flatter cornering.
    const ballastCollider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(size.x / 2, 0.08, size.z / 2)
        .setTranslation(center.x, center.y - size.y / 4, center.z)
        .setFriction(BODY_FRICTION)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setDensity(BALLAST_DENSITY)
        .setCollisionGroups(VEHICLE_COLLISION_GROUPS),
      this.body
    );
    this.colliders.push(ballastCollider);
    for (const collider of this.colliders) game.combat.register(collider, this);

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

  /** World-space point beside the front door, with its Y on the terrain. */
  doorPosition(side: 1 | -1, clearance: number, out = new THREE.Vector3()): THREE.Vector3 {
    const t = this.body.translation();
    const local = new THREE.Vector3(
      this.chassisCenter.x + side * (this.chassisHalfSize.x + clearance),
      0,
      this.chassisCenter.z + this.chassisHalfSize.z * 0.25
    ).applyQuaternion(this.quaternion());
    const x = t.x + local.x;
    const z = t.z + local.z;
    return out.set(x, heightAt(x, z), z);
  }

  /** Approximate foot point inside the front seat for transition animation. */
  seatPosition(side: 1 | -1, out = new THREE.Vector3()): THREE.Vector3 {
    const t = this.body.translation();
    const local = new THREE.Vector3(
      this.chassisCenter.x + side * this.chassisHalfSize.x * 0.24,
      this.chassisCenter.y - this.chassisHalfSize.y + 0.12,
      this.chassisCenter.z + this.chassisHalfSize.z * 0.25
    ).applyQuaternion(this.quaternion());
    return out.set(t.x + local.x, t.y + local.y, t.z + local.z);
  }

  /** Open or close one front door. Door panels are visual-only. */
  setDoorOpen(side: 1 | -1, open: boolean): void {
    const door = this.doors.get(side);
    if (door) door.target = open ? 1 : 0;
  }

  canExit(): boolean {
    return true;
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
    this.impactCooldown = Math.max(0, this.impactCooldown - dt);
    const before = this.body.linvel();
    this.preStepVelocity.set(before.x, before.y, before.z);
    this.hasPreStepVelocity = true;
    this.updateBurning(dt);
    if (this.destroyed) {
      this.command = { steer: 0, throttle: 0, brake: 0, handbrake: true };
    }
    this.updateDoors(dt);
    const { steer, throttle, brake, handbrake } = this.command;
    this.pinWhileParked(
      !this.destroyed && !this.burning &&
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
    const engineHealth = THREE.MathUtils.clamp(0.38 + 0.62 * (this.health / MAX_HEALTH), 0.38, 1);
    let engine = (this.destroyed ? 0 : throttle * mass * 8 * forwardTaper * engineHealth);
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

  private buildDoors(): void {
    for (const side of [-1, 1] as const) {
      const panel = this.game.assets.get('cars/debris-door-window');
      panel.scale.setScalar(CAR_SCALE);
      panel.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(panel);
      const doorLength = box.max.z - box.min.z;

      // Put the panel origin on its lower-front hinge. The standalone debris
      // mesh has the same proportions and palette as the source car pack.
      panel.position.set(-box.getCenter(new THREE.Vector3()).x, -box.min.y, -box.max.z);
      if (side < 0) panel.scale.x *= -1;

      const pivot = new THREE.Group();
      pivot.position.set(
        this.chassisCenter.x + side * (this.chassisHalfSize.x + 0.035),
        this.chassisCenter.y - this.chassisHalfSize.y + 0.04,
        this.chassisCenter.z + this.chassisHalfSize.z * 0.25 + doorLength / 2
      );
      pivot.visible = false;
      pivot.add(panel);
      this.root.add(pivot);
      this.doors.set(side, { pivot, amount: 0, target: 0 });
    }
  }

  private updateDoors(dt: number): void {
    const blend = 1 - Math.exp(-10 * dt);
    for (const [side, door] of this.doors) {
      door.amount = THREE.MathUtils.lerp(door.amount, door.target, blend);
      if (Math.abs(door.amount - door.target) < 0.002) door.amount = door.target;
      door.pivot.visible = door.amount > 0.01;
      door.pivot.rotation.y = -side * DOOR_OPEN_ANGLE * door.amount;
    }
  }

  // CombatTarget
  alive(): boolean {
    return !this.destroyed;
  }

  position(): THREE.Vector3 {
    const t = this.body.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }

  takeHit(damage: number, direction: THREE.Vector3, weapon: WeaponDef, attacker: Player | null): void {
    if (this.destroyed) return;
    let multiplier = 1;
    if (weapon.kind === 'melee') {
      multiplier = weapon.name === 'Explosion'
        ? 1
        : weapon.id === 'fists'
          ? 0.08
          : weapon.id === 'knife'
            ? 0.18
            : 0.48;
    }
    this.lastAttacker = attacker ?? this.lastAttacker;
    this.applyDamage(damage * multiplier);
    if (weapon.name !== 'Explosion') {
      const impulse = direction.clone().setY(0).multiplyScalar(this.body.mass() * Math.min(0.18, damage * 0.002));
      this.body.applyImpulse(new RAPIER.Vector3(impulse.x, 0, impulse.z), true);
    }
  }

  applyBlast(velocityChange: THREE.Vector3): void {
    if (this.destroyed) return;
    const mass = this.body.mass();
    this.body.applyImpulse(
      new RAPIER.Vector3(
        velocityChange.x * mass,
        Math.max(1.5, velocityChange.y) * mass,
        velocityChange.z * mass
      ),
      true
    );
  }

  private applyDamage(amount: number): void {
    if (this.destroyed || !Number.isFinite(amount) || amount <= 0) return;
    this.health = Math.max(0, this.health - amount);
    this.updateDamageAppearance();
    if (this.health <= FIRE_HEALTH) this.startBurning();
    if (this.health <= 0) this.burnTime = Math.max(this.burnTime, BURN_DURATION - 1.35);
  }

  private startBurning(): void {
    if (this.burning || this.destroyed) return;
    this.burning = true;
    this.fireFxCooldown = 0;
    this.parkingAnchor = null;
    this.body.wakeUp();
  }

  private updateBurning(dt: number): void {
    if (!this.burning || this.destroyed) return;
    this.burnTime += dt;
    this.fireFxCooldown -= dt;
    if (this.fireFxCooldown <= 0) {
      this.fireFxCooldown = 0.065 + Math.random() * 0.055;
      this.game.fx.vehicleFire(this.effectPosition(), 0.8 + this.burnTime / BURN_DURATION);
    }
    if (this.burnTime >= BURN_DURATION) this.explode();
  }

  private effectPosition(out = new THREE.Vector3()): THREE.Vector3 {
    const t = this.body.translation();
    const local = new THREE.Vector3(
      this.chassisCenter.x,
      this.chassisCenter.y + this.chassisHalfSize.y * 0.75,
      this.chassisCenter.z + this.chassisHalfSize.z * 0.55
    ).applyQuaternion(this.quaternion());
    return out.set(t.x + local.x, t.y + local.y, t.z + local.z);
  }

  private explode(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.burning = false;
    this.health = 0;
    this.command = { steer: 0, throttle: 0, brake: 0, handbrake: true };
    this.parkingAnchor = null;
    this.updateDamageAppearance();
    const origin = this.effectPosition();
    this.game.fx.explosion(origin);
    const nearest = Math.min(...this.game.playerPositions().map((position) =>
      Math.hypot(position.x - origin.x, position.z - origin.z)
    ));
    this.game.audio.explosion(nearest);
    const mass = this.body.mass();
    this.body.applyImpulse(new RAPIER.Vector3(0, mass * 3.2, 0), true);
    this.body.applyTorqueImpulse(
      new RAPIER.Vector3(
        (Math.random() - 0.5) * mass * 1.2,
        (Math.random() - 0.5) * mass * 0.45,
        (Math.random() - 0.5) * mass * 1.2
      ),
      true
    );
    this.game.onVehicleExploded(this, origin, this.lastAttacker);
  }

  private updateDamageAppearance(): void {
    const damage = this.destroyed ? 1 : 1 - this.health / MAX_HEALTH;
    for (const entry of this.damageMaterials) {
      entry.material.color.copy(entry.original).lerp(CHARRED, damage * 0.88);
      entry.material.roughness = Math.min(1, entry.roughness + damage * 0.18);
    }
  }

  /** Apply post-step parking constraints, then render the final physics pose. */
  afterPhysics(): void {
    if (this.parkingAnchor) this.restoreParkingAnchor();
    this.recordImpactDamage();
    this.syncVisuals();
  }

  private recordImpactDamage(): void {
    if (!this.hasPreStepVelocity || this.destroyed || this.impactCooldown > 0) return;
    const velocity = this.body.linvel();
    const dx = velocity.x - this.preStepVelocity.x;
    const dy = (velocity.y - this.preStepVelocity.y) * 0.65;
    const dz = velocity.z - this.preStepVelocity.z;
    const deltaV = Math.hypot(dx, dy, dz);
    if (deltaV <= IMPACT_DAMAGE_SPEED) return;
    const damage = Math.min(85, Math.pow(deltaV - IMPACT_DAMAGE_SPEED, 1.35) * 2.1);
    this.impactCooldown = 0.22;
    this.applyDamage(damage);
    const point = this.effectPosition();
    this.game.fx.spark(point);
    const nearest = Math.min(...this.game.playerPositions().map((position) =>
      Math.hypot(position.x - point.x, position.z - point.z)
    ));
    this.game.audio.thwack(nearest);
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
    for (const collider of this.colliders) this.game.combat.unregister(collider);
    for (const entry of this.damageMaterials) entry.material.dispose();
    this.controller.free();
    this.game.world.removeRigidBody(this.body);
  }
}
