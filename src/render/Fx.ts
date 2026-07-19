import * as THREE from 'three';
import { heightAt } from '../world/CityMap';

/**
 * Pooled combat visuals: bullet tracers, muzzle flashes, directional blood
 * spray, persistent ground splatters and impact sparks. Unlit materials, no
 * dynamic lights (split-screen budget). Meshes are recycled per kind instead
 * of being disposed.
 */

type FxKind = 'tracer' | 'flash' | 'blood' | 'stain' | 'spark';

interface FxItem {
  kind: FxKind;
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  velocity: THREE.Vector3 | null;
}

function makeSplatGeometry(): THREE.BufferGeometry {
  const vertices: number[] = [];
  const segments = 16;
  const radii = Array.from({ length: segments }, (_, i) =>
    0.72 + ((i * 37) % 11) * 0.035 + (i % 3 === 0 ? 0.16 : 0)
  );
  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments;
    const a = (i / segments) * Math.PI * 2;
    const b = (next / segments) * Math.PI * 2;
    vertices.push(
      0, 0, 0,
      Math.cos(a) * radii[i], Math.sin(a) * radii[i], 0,
      Math.cos(b) * radii[next], Math.sin(b) * radii[next], 0
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return geometry;
}

const GEO: Record<FxKind, THREE.BufferGeometry> = {
  tracer: new THREE.BoxGeometry(0.03, 0.03, 1), // scaled to span shots
  flash: new THREE.SphereGeometry(0.09, 6, 5),
  blood: new THREE.BoxGeometry(0.06, 0.06, 0.06),
  stain: makeSplatGeometry(),
  spark: new THREE.BoxGeometry(0.04, 0.04, 0.04),
};

const MAT: Record<FxKind, THREE.MeshBasicMaterial> = {
  tracer: new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true }),
  flash: new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true }),
  blood: new THREE.MeshBasicMaterial({ color: 0x8a1020 }),
  stain: new THREE.MeshBasicMaterial({
    color: 0x5c0712,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  }),
  spark: new THREE.MeshBasicMaterial({ color: 0xffe36b }),
};

const MID = new THREE.Vector3();
const SPRAY = new THREE.Vector3();
const MAX_STAINS = 72;
const STAIN_LIFE = 24;

export class Fx {
  private active: FxItem[] = [];
  private free: Record<FxKind, FxItem[]> = {
    tracer: [],
    flash: [],
    blood: [],
    stain: [],
    spark: [],
  };

  constructor(private scene: THREE.Scene) {}

  private spawn(kind: FxKind, maxLife: number, withVelocity: boolean): FxItem {
    if (kind === 'stain') {
      const stains = this.active.filter((active) => active.kind === 'stain');
      if (stains.length >= MAX_STAINS) this.release(this.active.indexOf(stains[0]));
    }
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
    item.mesh.rotation.set(0, 0, 0);
    this.scene.add(item.mesh);
    this.active.push(item);
    return item;
  }

  private release(index: number): void {
    const [item] = this.active.splice(index, 1);
    if (!item) return;
    this.scene.remove(item.mesh);
    this.free[item.kind].push(item);
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

  /** Directional spray plus irregular, persistent stains for hits on people. */
  blood(pos: THREE.Vector3, direction?: THREE.Vector3, intensity = 1): void {
    if (direction) SPRAY.copy(direction);
    else SPRAY.set(0, 0, 0);
    if (SPRAY.lengthSq() > 0.001) SPRAY.normalize();
    const particleCount = Math.max(4, Math.round(6 * intensity));
    for (let i = 0; i < particleCount; i++) {
      const item = this.spawn('blood', 0.45, true);
      item.mesh.position.copy(pos);
      item.velocity!.set(
        (Math.random() - 0.5) * 3.2,
        1.2 + Math.random() * 2.4,
        (Math.random() - 0.5) * 3.2
      );
      item.velocity!.addScaledVector(SPRAY, 1 + Math.random() * 2.4);
    }

    const lead = 0.18 + Math.random() * 0.3;
    this.stain(
      pos.x + SPRAY.x * lead + (Math.random() - 0.5) * 0.35,
      pos.z + SPRAY.z * lead + (Math.random() - 0.5) * 0.35,
      (0.22 + Math.random() * 0.18) * intensity,
      0.55 + Math.random() * 0.65
    );
    const droplets = Math.max(2, Math.round(2 * intensity));
    for (let i = 0; i < droplets; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = 0.25 + Math.random() * (0.45 + intensity * 0.2);
      this.stain(
        pos.x + Math.cos(angle) * distance + SPRAY.x * lead,
        pos.z + Math.sin(angle) * distance + SPRAY.z * lead,
        0.035 + Math.random() * 0.07 * intensity,
        0.7 + Math.random() * 0.6
      );
    }
  }

  private stain(x: number, z: number, radius: number, stretch: number): void {
    const item = this.spawn('stain', STAIN_LIFE, false);
    item.mesh.position.set(x, heightAt(x, z) + 0.018, z);
    item.mesh.rotation.set(-Math.PI / 2, 0, Math.random() * Math.PI * 2);
    item.mesh.scale.set(radius * stretch, radius, 1);
    item.mesh.renderOrder = 1;
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
        this.release(i);
      }
    }
  }
}
