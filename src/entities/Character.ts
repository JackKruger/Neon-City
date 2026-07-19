import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Entity, Game } from '../core/Game';
import { HumanRig, Outfit } from './HumanRig';
import { heightAt } from '../world/CityMap';

const HEIGHT = 1.8;
const RADIUS = 0.35;
const HALF_HEIGHT = HEIGHT / 2;
const GROUND_CLEARANCE = 0.05;
const GROUND_CHECK_INTERVAL = 0.2;
const MAX_GROUND_PENETRATION = 0.04;
const WALK_SPEED = 3.2;
const RUN_SPEED = 6.5;
const JUMP_SPEED = 8;

/** Kinematic capsule character driving a procedural articulated human. */
export class Character implements Entity {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly root = new THREE.Group();
  readonly rig: HumanRig;
  private controller: RAPIER.KinematicCharacterController;
  private vy = 0;
  private grounded = false;
  private facing = 0;
  private moveDir = new THREE.Vector3();
  private moveSpeed = 0;
  private walkPhase = 0;
  private stride = 0; // smoothed 0..1 idle->stride blend
  private runBlend = 0; // smoothed 0..1 walk->run gait
  private airBlend = 0; // smoothed grounded->jump pose blend
  private groundCheckTimer = Math.random() * GROUND_CHECK_INTERVAL;
  private lastSafeGround = new THREE.Vector3();
  private time = Math.random() * 10; // desync idle breathing between people
  enabled = true;

  constructor(
    private game: Game,
    outfit: Outfit,
    x: number,
    z: number,
    heightScale = 1,
    collisionGroups?: number
  ) {
    this.rig = new HumanRig(outfit, heightScale);
    this.root.add(this.rig.root);
    this.rig.root.position.y = -HALF_HEIGHT; // feet align with the capsule bottom
    game.scene.add(this.root);

    this.body = game.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
        x,
        heightAt(x, z) + HEIGHT / 2 + 0.1,
        z
      )
    );
    this.collider = game.world.createCollider(
      RAPIER.ColliderDesc.capsule(HALF_HEIGHT - RADIUS, RADIUS),
      this.body
    );
    if (collisionGroups !== undefined) this.collider.setCollisionGroups(collisionGroups);
    this.controller = game.world.createCharacterController(0.05);
    this.controller.setUp(new RAPIER.Vector3(0, 1, 0));
    this.controller.enableAutostep(0.45, 0.2, true);
    this.controller.enableSnapToGround(0.45);
    this.controller.setApplyImpulsesToDynamicBodies(true);

    this.lastSafeGround.set(x, heightAt(x, z), z);
    this.snapToGround(1.25, 8);

    this.syncVisuals();
  }

  /** Set the desired planar move direction (normalized) and sprint flag. */
  setMove(dir: THREE.Vector3, sprint: boolean): void {
    this.moveDir.copy(dir);
    this.moveSpeed = dir.lengthSq() > 0.01 ? (sprint ? RUN_SPEED : WALK_SPEED) : 0;
  }

  /** Start a jump if the character was grounded on the previous physics step. */
  jump(): boolean {
    if (!this.enabled || !this.grounded) return false;
    this.vy = JUMP_SPEED;
    this.grounded = false;
    return true;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.grounded = false;
    this.root.visible = on;
    this.body.setEnabled(on);
  }

  teleport(x: number, y: number, z: number): void {
    this.body.setTranslation(new RAPIER.Vector3(x, y + HALF_HEIGHT + GROUND_CLEARANCE, z), true);
    this.vy = 0;
    this.grounded = false;
    if (!this.snapToGround(1.5, 8)) this.lastSafeGround.set(x, y, z);
    this.syncVisuals();
  }

  /** Restore the character to its most recent valid grounded position. */
  recoverToSafeGround(): void {
    const p = this.lastSafeGround;
    this.body.setTranslation(
      new RAPIER.Vector3(p.x, p.y + HALF_HEIGHT + GROUND_CLEARANCE, p.z),
      true
    );
    this.vy = 0;
    this.grounded = false;
    this.snapToGround(1.5, 8);
    this.syncVisuals();
  }

  position(): THREE.Vector3 {
    const t = this.body.translation();
    return new THREE.Vector3(t.x, t.y - HALF_HEIGHT, t.z);
  }

  getFacing(): number {
    return this.facing;
  }

  update(dt: number): void {
    if (!this.enabled) return;
    this.time += dt;
    this.groundCheckTimer += dt;
    if (this.groundCheckTimer >= GROUND_CHECK_INTERVAL) {
      this.groundCheckTimer %= GROUND_CHECK_INTERVAL;
      this.recoverInvalidPlacement();
    }

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
    this.grounded = this.controller.computedGrounded();
    if (this.grounded) {
      if (this.vy < 0) this.vy = 0;
      this.lastSafeGround.set(
        t.x + move.x,
        t.y + move.y - HALF_HEIGHT,
        t.z + move.z
      );
    }
    const airTarget = this.grounded ? 0 : 1;
    this.airBlend += (airTarget - this.airBlend) * (1 - Math.exp(-14 * dt));

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
    this.rig.setLocomotion(
      this.walkPhase,
      this.stride,
      this.runBlend,
      this.time,
      this.airBlend,
      this.vy
    );
  }

  /** Find the highest walkable fixed surface close to the capsule's feet. */
  private groundHeight(maxRise: number, maxDrop: number): number | null {
    const t = this.body.translation();
    const footY = t.y - HALF_HEIGHT;
    const originY = footY + maxRise;
    const ray = new RAPIER.Ray(
      new RAPIER.Vector3(t.x, originY, t.z),
      new RAPIER.Vector3(0, -1, 0)
    );
    let best = -Infinity;
    this.game.world.intersectionsWithRay(
      ray,
      maxRise + maxDrop,
      false,
      (hit) => {
        if (hit.normal.y > 0.55) {
          const y = originY - hit.timeOfImpact;
          if (y > best) best = y;
        }
        return true;
      },
      RAPIER.QueryFilterFlags.ONLY_FIXED,
      undefined,
      this.collider,
      this.body
    );
    return Number.isFinite(best) ? best : null;
  }

  /** Place the capsule exactly above a nearby walkable surface. */
  private snapToGround(maxRise: number, maxDrop: number): boolean {
    const groundY = this.groundHeight(maxRise, maxDrop);
    if (groundY === null) return false;
    const t = this.body.translation();
    this.body.setTranslation(
      new RAPIER.Vector3(t.x, groundY + HALF_HEIGHT + GROUND_CLEARANCE, t.z),
      true
    );
    this.lastSafeGround.set(t.x, groundY, t.z);
    this.vy = 0;
    return true;
  }

  /** Correct only clearly invalid placement so normal slope motion never jitters. */
  private recoverInvalidPlacement(): void {
    const t = this.body.translation();
    if (![t.x, t.y, t.z].every(Number.isFinite) || t.y < -12) {
      this.recoverToSafeGround();
      return;
    }
    const groundY = this.groundHeight(1.5, 4);
    if (groundY === null) return;
    const footY = t.y - HALF_HEIGHT;
    if (footY < groundY - MAX_GROUND_PENETRATION) {
      this.body.setTranslation(
        new RAPIER.Vector3(t.x, groundY + HALF_HEIGHT + GROUND_CLEARANCE, t.z),
        true
      );
      this.lastSafeGround.set(t.x, groundY, t.z);
      this.vy = 0;
      this.grounded = false;
    }
  }

  dispose(): void {
    this.game.scene.remove(this.root);
    this.game.world.removeCharacterController(this.controller);
    this.game.world.removeRigidBody(this.body);
  }
}
