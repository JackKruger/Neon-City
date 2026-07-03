import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Entity, Game } from '../core/Game';

const HEIGHT = 1.8;
const RADIUS = 0.35;
const WALK_SPEED = 3.2;
const RUN_SPEED = 6.5;

/** Kinematic capsule character with a Kenney blocky model. */
export class Character implements Entity {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly root = new THREE.Group();
  private controller: RAPIER.KinematicCharacterController;
  private vy = 0;
  private facing = 0;
  private moveDir = new THREE.Vector3();
  private moveSpeed = 0;
  private walkPhase = 0;
  private model: THREE.Group;
  enabled = true;

  constructor(
    private game: Game,
    modelName: string,
    x: number,
    z: number
  ) {
    const { object: model } = game.assets.getFitted(modelName, { height: HEIGHT });
    this.model = model;
    this.root.add(model);
    model.position.y = -HEIGHT / 2; // root sits at capsule center
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
      this.walkPhase += dt * this.moveSpeed * 2.2;
    }
    this.syncVisuals();
  }

  private syncVisuals(): void {
    const t = this.body.translation();
    this.root.position.set(t.x, t.y, t.z);
    this.root.rotation.y = this.facing;
    // Cheap walk bob in lieu of skeletal animation.
    const bob = this.moveSpeed > 0 ? Math.abs(Math.sin(this.walkPhase)) * 0.06 : 0;
    this.model.position.y = -HEIGHT / 2 + bob;
    this.model.rotation.x = this.moveSpeed > 0 ? Math.sin(this.walkPhase) * 0.045 : 0;
  }

  dispose(): void {
    this.game.scene.remove(this.root);
    this.game.world.removeCharacterController(this.controller);
    this.game.world.removeRigidBody(this.body);
  }
}
