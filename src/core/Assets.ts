import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

/**
 * Loads and caches GLB models from /public/assets.
 * Asset names are "<pack>/<file>" without extension, e.g. "cars/sedan".
 */
export class Assets {
  private loader = new GLTFLoader();
  private cache = new Map<string, THREE.Group>();
  private sizes = new Map<string, THREE.Vector3>();

  async preload(names: string[]): Promise<void> {
    await Promise.all(
      names.map(async (name) => {
        if (this.cache.has(name)) return;
        const gltf = await this.loader.loadAsync(`/assets/${name}.glb`);
        this.cache.set(name, gltf.scene);
        const box = new THREE.Box3().setFromObject(gltf.scene);
        this.sizes.set(name, box.getSize(new THREE.Vector3()));
      })
    );
  }

  /** Returns a deep clone of a preloaded model. */
  get(name: string): THREE.Group {
    const src = this.cache.get(name);
    if (!src) throw new Error(`Asset not preloaded: ${name}`);
    return skeletonClone(src) as THREE.Group;
  }

  /**
   * Multiply the cached model's material colors (affects all clones since
   * materials are shared). Used e.g. to darken the pale Kenney asphalt.
   */
  tint(name: string, hex: number): void {
    const src = this.cache.get(name);
    if (!src) return;
    const seen = new Set<string>();
    src.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const std = m as THREE.MeshStandardMaterial;
        if (std.color && !seen.has(std.uuid)) {
          seen.add(std.uuid);
          std.color.multiply(new THREE.Color(hex));
        }
      }
    });
  }

  /** Bounding-box size of the source model (unscaled). */
  size(name: string): THREE.Vector3 {
    const s = this.sizes.get(name);
    if (!s) throw new Error(`Asset not preloaded: ${name}`);
    return s;
  }

  /**
   * Clone scaled so its bbox matches the given dimension.
   * Exactly one of fitWidth/fitHeight/fitLength should be set
   * (width = x, height = y, length = z).
   */
  getFitted(
    name: string,
    fit: { width?: number; height?: number; length?: number }
  ): { object: THREE.Group; scale: number } {
    const size = this.size(name);
    let scale = 1;
    if (fit.width !== undefined) scale = fit.width / size.x;
    else if (fit.height !== undefined) scale = fit.height / size.y;
    else if (fit.length !== undefined) scale = fit.length / size.z;
    const object = this.get(name);
    object.scale.setScalar(scale);
    return { object, scale };
  }
}
