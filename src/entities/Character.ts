import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Entity, Game } from '../core/Game';
import { HumanRig, Outfit } from './HumanRig';

const HEIGHT = 1.8;
const RADIUS = 0.35;
const WALK_SPEED = 3.2;
const RUN_SPEED = 6.5;

/** Kinematic capsule character driving a procedural articulated human. */
export class Character implements Entity {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly root = new THREE.Group();
  readonly rig: HumanRig;
  private controller: RAPIER.KinematicCharacterController;
  private vy = 0;
  private facing = 0;
  private moveDir = new THREE.Vector3();
  private moveSpeed = 0;
  private walkPhase = 0;
  private stride = 0; // smoothed 0..1 idle->stride blend
  private runBlend = 0; // smoothed 0..1 walk->run gait
  private time = Math.random() * 10; // desync idle breathing between people
  enabled = true;

  constructor(
    private game: Game,
    outfit: Outfit,
    x: number,
    z: number,
    heightScale = 1
  ) {
    this.rig = new HumanRig(outfit, heightScale);
    this.root.add(this.rig.root);
    this.rig.root.position.y = -HEIGHT / 2; // root sits at capsule center
    game.scene.add(this.root);

    this.body = game.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, HEIGHT / 2 + 0.1, z)
    );
    this.collider = game.world.createCollider(
      RAPIER.ColliderDesc.capsule(HEIGHT / 2 - RADIUS, RADIUS),
      this.body
    );
    this.controller = game.world.createCharacterController(0.05);
    this.controller.setUp(new RAPIER.Vector3(0, 1, 0));
    this.controller.enableAutostep(0.45, 0.2, true);
    this.controller.enableSnapToGround(0.45);
    this.controller.setApplyImpulsesToDynamicBodies(true);

    this.syncVisuals();
  }

  /** Set the desired planar move direction (normalized) and sprint flag. */
  setMove(dir: THREE.Vector3, sprint: boolean): void {
    this.moveDir.copy(dir);
    this.moveSpeed = dir.lengthSq() > 0.01 ? (sprint ? RUN_SPEED : WALK_SPEED) : 0;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.root.visible = on;
    this.body.setEnabled(on);
  }

  teleport(x: number, y: number, z: number): void {
    this.body.setTranslation(new RAPIER.Vector3(x, y + HEIGHT / 2 + 0.05, z), true);
    this.vy = 0;
    this.syncVisuals();
  }

  position(): THREE.Vector3 {
    const t = this.body.translation();
    return new THREE.Vector3(t.x, t.y - HEIGHT / 2, t.z);
  }

  getFacing(): number {
    return this.facing;
  }

  update(dt: number): void {
    if (!this.enabled) return;
    this.time += dt;

    this.vy = Math.max(this.vy - 20 * dt, -30);
    const desired = new RAPIER.Vector3(
      this.moveDir.x * this.moveSpeed * dt,
      this.vy * dt,
      this.moveDir.z * this.moveSpeed * dt
    );
    this.controller.computeColliderMovement(this.collider, desired);
    const move = this.controller.computedMovement();
    const t = this.body.translation();
    this.body.setNextKinematicTranslation(
      new RAPIER.Vector3(t.x + move.x, t.y + move.y, t.z + move.z)
    );
    if (this.controller.computedGrounded()) this.vy = 0;

    if (this.moveSpeed > 0) {
      const target = Math.atan2(this.moveDir.x, this.moveDir.z);
      let delta = target - this.facing;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      this.facing += delta * Math.min(1, 12 * dt);
      // Cadence rises with speed; a full cycle is two steps.
      this.walkPhase += dt * (3.2 + this.moveSpeed * 1.5);
    }
    // Ease gait blends so stops/starts and sprint changes don't pop.
    const strideTarget = this.moveSpeed > 0 ? 1 : 0;
    this.stride += (strideTarget - this.stride) * Math.min(1, 10 * dt);
    const runTarget = Math.min(
      1,
      Math.max(0, (this.moveSpeed - WALK_SPEED) / (RUN_SPEED - WALK_SPEED))
    );
    this.runBlend += (runTarget - this.runBlend) * Math.min(1, 6 * dt);
    this.syncVisuals();
  }

  private syncVisuals(): void {
    const t = this.body.translation();
    this.root.position.set(t.x, t.y, t.z);
    this.root.rotation.y = this.facing;
    this.rig.setLocomotion(this.walkPhase, this.stride, this.runBlend, this.time);
  }

  dispose(): void {
    this.game.scene.remove(this.root);
    this.game.world.removeCharacterController(this.controller);
    this.game.world.removeRigidBody(this.body);
  }
}
