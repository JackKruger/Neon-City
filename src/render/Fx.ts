import * as THREE from 'three';

/**
 * Pooled short-lived combat visuals: bullet tracers, muzzle flashes, blood
 * puffs and impact sparks. Unlit materials, no dynamic lights (split-screen
 * budget). Meshes are recycled per kind instead of being disposed.
 */

type FxKind = 'tracer' | 'flash' | 'blood' | 'spark';

interface FxItem {
  kind: FxKind;
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  velocity: THREE.Vector3 | null;
}

const GEO: Record<FxKind, THREE.BufferGeometry> = {
  tracer: new THREE.BoxGeometry(0.03, 0.03, 1), // scaled to span shots
  flash: new THREE.SphereGeometry(0.09, 6, 5),
  blood: new THREE.BoxGeometry(0.06, 0.06, 0.06),
  spark: new THREE.BoxGeometry(0.04, 0.04, 0.04),
};

const MAT: Record<FxKind, THREE.MeshBasicMaterial> = {
  tracer: new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true }),
  flash: new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true }),
  blood: new THREE.MeshBasicMaterial({ color: 0x8a1020 }),
  spark: new THREE.MeshBasicMaterial({ color: 0xffe36b }),
};

const MID = new THREE.Vector3();

export class Fx {
  private active: FxItem[] = [];
  private free: Record<FxKind, FxItem[]> = { tracer: [], flash: [], blood: [], spark: [] };

  constructor(private scene: THREE.Scene) {}

  private spawn(kind: FxKind, maxLife: number, withVelocity: boolean): FxItem {
    let item = this.free[kind].pop();
    if (!item) {
      // Materials are shared per kind; opacity fades would conflict, so
      // tracers/flashes just vanish at end of life instead of fading.
      item = {
        kind,
        mesh: new THREE.Mesh(GEO[kind], MAT[kind]),
        life: 0,
        maxLife,
        velocity: null,
      };
    }
    item.life = 0;
    item.maxLife = maxLife;
    item.velocity = withVelocity ? item.velocity ?? new THREE.Vector3() : null;
    item.mesh.scale.setScalar(1);
    this.scene.add(item.mesh);
    this.active.push(item);
    return item;
  }

  /** Thin bright streak from muzzle to impact point. */
  tracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const item = this.spawn('tracer', 0.07, false);
    const length = from.distanceTo(to);
    MID.copy(from).add(to).multiplyScalar(0.5);
    item.mesh.position.copy(MID);
    item.mesh.scale.set(1, 1, Math.max(0.1, length));
    item.mesh.lookAt(to);
  }

  /** Brief glow at the barrel. */
  muzzle(pos: THREE.Vector3): void {
    const item = this.spawn('flash', 0.05, false);
    item.mesh.position.copy(pos);
  }

  /** A few dark red chunks with gravity, for hits on people. */
  blood(pos: THREE.Vector3): void {
    for (let i = 0; i < 4; i++) {
      const item = this.spawn('blood', 0.45, true);
      item.mesh.position.copy(pos);
      item.velocity!.set(
        (Math.random() - 0.5) * 3,
        1.5 + Math.random() * 2,
        (Math.random() - 0.5) * 3
      );
    }
  }

  /** Impact sparks for shots that hit the world instead of a person. */
  spark(pos: THREE.Vector3): void {
    for (let i = 0; i < 3; i++) {
      const item = this.spawn('spark', 0.3, true);
      item.mesh.position.copy(pos);
      item.velocity!.set(
        (Math.random() - 0.5) * 4,
        1 + Math.random() * 2.5,
        (Math.random() - 0.5) * 4
      );
    }
  }

  update(dt: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const item = this.active[i];
      item.life += dt;
      if (item.velocity) {
        item.velocity.y -= 9 * dt;
        item.mesh.position.addScaledVector(item.velocity, dt);
      }
      if (item.life >= item.maxLife) {
        this.scene.remove(item.mesh);
        this.active.splice(i, 1);
        this.free[item.kind].push(item);
      }
    }
  }
}
