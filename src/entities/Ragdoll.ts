import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Game } from '../core/Game';
import type { HumanRig } from './HumanRig';

// Ragdoll parts collide with the world but not with other ragdoll parts
// (membership bit 1, filter excludes bit 1). Everything else uses Rapier's
// default all-bits groups, so cars still plow through bodies.
const RAGDOLL_GROUPS = ((0x0002 << 16) | (0xffff & ~0x0002)) >>> 0;
const DENSITY = 900; // roughly flesh; sums to a ~60 kg body

interface RagdollPiece {
  body: RAPIER.RigidBody;
  /** Collider center in body frame is the origin; meshes hang off it. */
  meshes: { node: THREE.Object3D; offset: THREE.Vector3; rot: THREE.Quaternion }[];
}

const V = new THREE.Vector3();
const Q = new THREE.Quaternion();

/**
 * Physics ragdoll built from a HumanRig's current pose. Takes ownership of
 * the rig's meshes: each body part becomes a dynamic Rapier body (spherical
 * hips/shoulders/neck/waist, limit-clamped hinges for knees/elbows/ankles)
 * and the visuals follow the simulation until dispose().
 */
export class Ragdoll {
  private pieces: RagdollPiece[] = [];
  private group = new THREE.Group();

  constructor(
    private game: Game,
    rig: HumanRig,
    impact: THREE.Vector3,
    initialVelocity = false
  ) {
    game.scene.add(this.group);
    // Held weapons are not part of the ragdoll parts; drop them first so the
    // stolen forearm meshes don't leave an orphaned gun floating in the scene.
    rig.setHeldItem(null);
    rig.root.updateWorldMatrix(true, true);
    const s = rig.scale;
    const specs = rig.parts();
    const bodies: RAPIER.RigidBody[] = [];

    for (const spec of specs) {
      const pivotPos = spec.pivot.getWorldPosition(new THREE.Vector3());
      const quat = spec.pivot.getWorldQuaternion(new THREE.Quaternion());
      const pos = V.copy(spec.center).multiplyScalar(s).applyQuaternion(quat).add(pivotPos);

      const body = game.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(pos.x, pos.y, pos.z)
          .setRotation(quat)
          .setLinvel(
            impact.x + (Math.random() - 0.5),
            impact.y + (
              initialVelocity ? (Math.random() - 0.5) * 0.4 : 2 + Math.random() * 1.5
            ),
            impact.z + (Math.random() - 0.5)
          )
          .setAngvel({
            x: (Math.random() - 0.5) * 6,
            y: (Math.random() - 0.5) * 4,
            z: (Math.random() - 0.5) * 6,
          })
          .setLinearDamping(0.2)
          .setAngularDamping(1.2)
          .setCcdEnabled(true)
      );
      const shape =
        spec.shape.kind === 'capsule'
          ? RAPIER.ColliderDesc.capsule(spec.shape.halfHeight * s, spec.shape.radius * s)
          : RAPIER.ColliderDesc.cuboid(spec.shape.hx * s, spec.shape.hy * s, spec.shape.hz * s);
      game.world.createCollider(
        shape
          .setDensity(DENSITY)
          .setFriction(0.85)
          .setRestitution(0.05)
          .setCollisionGroups(RAGDOLL_GROUPS),
        body
      );
      bodies.push(body);

      // Steal the rig's visual nodes; from now on the body drives them.
      const meshes = spec.meshes.map((node) => {
        const offset = node.position.clone().sub(spec.center).multiplyScalar(s);
        const rot = node.quaternion.clone();
        node.removeFromParent();
        node.scale.multiplyScalar(s);
        this.group.add(node);
        return { node, offset, rot };
      });
      this.pieces.push({ body, meshes });
    }

    // Joints. Anchors are the child pivot's origin, expressed in each
    // body's local frame (frames coincide with pivot frames, so anchors
    // are just offsets from the collider centers).
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      if (!spec.joint || spec.parent < 0) continue;
      const parentSpec = specs[spec.parent];
      const a1 = spec.pivot.position.clone().sub(parentSpec.center).multiplyScalar(s);
      const a2 = spec.center.clone().multiplyScalar(-s);
      let data: RAPIER.JointData;
      if (spec.joint.kind === 'spherical') {
        data = RAPIER.JointData.spherical(a1, a2);
      } else {
        data = RAPIER.JointData.revolute(a1, a2, spec.joint.axis);
        data.limitsEnabled = true;
        data.limits = [spec.joint.min, spec.joint.max];
      }
      this.game.world.createImpulseJoint(data, bodies[spec.parent], bodies[i], true);
    }

    this.update();
  }

  /** Copy body transforms onto the stolen meshes. Call once per step. */
  update(): void {
    for (const piece of this.pieces) {
      const t = piece.body.translation();
      const r = piece.body.rotation();
      Q.set(r.x, r.y, r.z, r.w);
      for (const m of piece.meshes) {
        m.node.quaternion.copy(Q).multiply(m.rot);
        m.node.position.copy(m.offset).applyQuaternion(Q).add(V.set(t.x, t.y, t.z));
      }
    }
  }

  /** Rough center of the body, for despawn distance checks. */
  position(): THREE.Vector3 {
    const t = this.pieces[0].body.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }

  /** Vertical velocity of the pelvis, used to classify airborne landings. */
  verticalSpeed(): number {
    return this.pieces[0]?.body.linvel().y ?? 0;
  }

  dispose(): void {
    // Removing bodies also removes their joints and colliders.
    for (const piece of this.pieces) this.game.world.removeRigidBody(piece.body);
    this.pieces = [];
    this.game.scene.remove(this.group);
  }
}
