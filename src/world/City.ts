import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Assets } from '../core/Assets';
import { PALETTE, TILE } from '../core/const';
import { MAP_H, MAP_W, cellAt, cellHash, cellToWorld, roadMask } from './CityMap';

const COMMERCIAL = 'abcdefghijklmn'.split('').map((c) => `commercial/building-${c}`);
const SKYSCRAPERS = 'abcde'.split('').map((c) => `commercial/building-skyscraper-${c}`);
const SUBURBAN = 'abcdefghijklmnopqrstu'.split('').map((c) => `suburban/building-type-${c}`);
const ROADS = ['road-straight', 'road-bend', 'road-intersection', 'road-crossroad', 'road-end', 'road-square'].map(
  (n) => `roads/${n}`
);
const TREES = ['suburban/tree-large', 'suburban/tree-small'];
const STREETLIGHT = 'roads/light-curved';

export const CITY_ASSETS = [...COMMERCIAL, ...SKYSCRAPERS, ...SUBURBAN, ...ROADS, ...TREES, STREETLIGHT];

/**
 * Road tile orientation. Base connection masks (at rotY=0) were verified
 * against the Kenney models; a quarter turn rotY=+PI/2 maps direction
 * S->E, E->N, N->W, W->S.
 */
function rotateMask(mask: number): number {
  // N=1, E=2, S=4, W=8. One quarter turn (+PI/2): N->W, E->N, S->E, W->S.
  return ((mask & 1) ? 8 : 0) | ((mask & 2) ? 1 : 0) | ((mask & 4) ? 2 : 0) | ((mask & 8) ? 4 : 0);
}

function buildRoadTable(): Map<number, { model: string; rot: number }> {
  const bases: [string, number][] = [
    ['roads/road-straight', 5], // runs N-S
    ['roads/road-bend', 6], // connects E+S
    ['roads/road-intersection', 7], // T: connects N+E+S
    ['roads/road-crossroad', 15],
    ['roads/road-end', 4], // connects S
    ['roads/road-square', 0],
  ];
  const table = new Map<number, { model: string; rot: number }>();
  for (const [model, baseMask] of bases) {
    let mask = baseMask;
    for (let k = 0; k < 4; k++) {
      if (!table.has(mask)) table.set(mask, { model, rot: (k * Math.PI) / 2 });
      mask = rotateMask(mask);
    }
  }
  return table;
}

export class City {
  /** Geometry buckets keyed by material, merged into single meshes at the end. */
  private buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private groundMats = {
    pavement: new THREE.MeshStandardMaterial({ color: PALETTE.pavement }),
    grass: new THREE.MeshStandardMaterial({ color: PALETTE.grass }),
  };

  constructor(
    private scene: THREE.Scene,
    private world: RAPIER.World,
    private assets: Assets
  ) {}

  build(): void {
    const fixed = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const roadTable = buildRoadTable();

    for (let cz = 0; cz < MAP_H; cz++) {
      for (let cx = 0; cx < MAP_W; cx++) {
        const cell = cellAt(cx, cz)!;
        const { x, z } = cellToWorld(cx, cz);
        switch (cell) {
          case '#': {
            const mask = roadMask(cx, cz);
            const { model, rot } = roadTable.get(mask) ?? {
              model: 'roads/road-square',
              rot: 0,
            };
            const { object } = this.assets.getFitted(model, { width: TILE });
            object.position.set(x, -TILE * 0.02 + 0.002, z);
            object.rotation.y = rot;
            this.bakeStatic(object);
            this.streetlight(cx, cz, x, z, mask);
            break;
          }
          case 'C':
            this.groundPlane(x, z, 'pavement');
            this.building(fixed, cx, cz, x, z);
            break;
          case 'S':
            this.groundPlane(x, z, 'grass');
            this.building(fixed, cx, cz, x, z);
            if (cellHash(cx, cz, 7) < 0.45) this.tree(fixed, x + TILE * 0.38, z + TILE * 0.38, cx, cz);
            break;
          case 'P':
            this.groundPlane(x, z, 'grass');
            for (let i = 0; i < 3; i++) {
              const ox = (cellHash(cx, cz, 10 + i) - 0.5) * TILE * 0.8;
              const oz = (cellHash(cx, cz, 20 + i) - 0.5) * TILE * 0.8;
              this.tree(fixed, x + ox, z + oz, cx, cz + i);
            }
            break;
          case '.':
            this.groundPlane(x, z, 'pavement');
            break;
          case 'A':
            break; // sand slab covers it
        }
      }
    }

    this.buildGroundAndWater(fixed);
    this.flushBuckets();
  }

  private building(fixed: RAPIER.RigidBody, cx: number, cz: number, x: number, z: number): void {
    const cell = cellAt(cx, cz);
    let model: string;
    let lotFrac: number;
    if (cell === 'C') {
      const skyscraper = cellHash(cx, cz, 1) < 0.3;
      model = skyscraper
        ? SKYSCRAPERS[Math.floor(cellHash(cx, cz, 2) * SKYSCRAPERS.length)]
        : COMMERCIAL[Math.floor(cellHash(cx, cz, 3) * COMMERCIAL.length)];
      lotFrac = 0.95;
    } else {
      model = SUBURBAN[Math.floor(cellHash(cx, cz, 4) * SUBURBAN.length)];
      lotFrac = 0.72;
    }

    const size = this.assets.size(model);
    const footprint = Math.max(size.x, size.z);
    const scale = ((TILE * lotFrac) / footprint) * (0.88 + cellHash(cx, cz, 5) * 0.24);
    const object = this.assets.get(model);
    object.scale.setScalar(scale);

    // Face the nearest road: model fronts point +Z at rotY=0.
    const mask = roadMask(cx, cz);
    let rot = 0;
    if (mask & 4) rot = 0;
    else if (mask & 2) rot = Math.PI / 2;
    else if (mask & 1) rot = Math.PI;
    else if (mask & 8) rot = -Math.PI / 2;
    object.position.set(x, 0, z);
    object.rotation.y = rot;
    this.bakeStatic(object);

    const quarterTurns = Math.round(rot / (Math.PI / 2)) & 1;
    const hx = ((quarterTurns ? size.z : size.x) * scale) / 2;
    const hz = ((quarterTurns ? size.x : size.z) * scale) / 2;
    const hy = (size.y * scale) / 2;
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, hy, z),
      fixed
    );
  }

  /** A curved streetlight on alternating sides of straight road segments. */
  private streetlight(cx: number, cz: number, x: number, z: number, mask: number): void {
    if (mask !== 5 && mask !== 10) return;
    if ((cx + cz) % 3 !== 0) return;
    const side = ((cx + cz) / 3) % 2 === 0 ? 1 : -1;
    const off = TILE * 0.46 * side;
    const { object } = this.assets.getFitted(STREETLIGHT, { height: 6 });
    if (mask === 5) {
      // N-S road: light on east/west sidewalk, arm pointing at the road.
      object.position.set(x + off, 0, z);
      object.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
    } else {
      object.position.set(x, 0, z + off);
      object.rotation.y = side > 0 ? 0 : Math.PI;
    }
    this.bakeStatic(object);
  }

  private tree(fixed: RAPIER.RigidBody, x: number, z: number, hx: number, hz: number): void {
    const model = TREES[cellHash(hx, hz, 30) < 0.6 ? 0 : 1];
    const { object, scale } = this.assets.getFitted(model, {
      height: 5.5 + cellHash(hx, hz, 31) * 3,
    });
    object.position.set(x, 0, z);
    object.rotation.y = cellHash(hx, hz, 32) * Math.PI * 2;
    this.bakeStatic(object);
    const height = this.assets.size(model).y * scale;
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.25, height / 2, 0.25).setTranslation(x, height / 2, z),
      fixed
    );
  }

  private groundPlane(x: number, z: number, kind: 'pavement' | 'grass'): void {
    const geo = new THREE.PlaneGeometry(TILE, TILE);
    geo.applyMatrix4(
      new THREE.Matrix4()
        .makeRotationX(-Math.PI / 2)
        .setPosition(x, kind === 'grass' ? -0.008 : -0.005, z)
    );
    const mat = this.groundMats[kind];
    if (!this.buckets.has(mat)) this.buckets.set(mat, []);
    this.buckets.get(mat)!.push(geo);
  }

  private buildGroundAndWater(fixed: RAPIER.RigidBody): void {
    const islandW = MAP_W * TILE;
    const islandH = MAP_H * TILE;

    const sand = new THREE.Mesh(
      new THREE.BoxGeometry(islandW, 1, islandH),
      new THREE.MeshStandardMaterial({ color: PALETTE.sand })
    );
    sand.position.y = -0.52;
    this.scene.add(sand);

    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(2400, 2400),
      new THREE.MeshStandardMaterial({ color: PALETTE.water })
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = -0.65;
    this.scene.add(water);

    // Flat physics ground under the whole island; top face at y=0.
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(islandW / 2, 0.5, islandH / 2).setTranslation(0, -0.5, 0),
      fixed
    );
    // Invisible walls at the shoreline.
    const wallSpecs: [number, number, number, number][] = [
      [0, -islandH / 2, islandW / 2, 1],
      [0, islandH / 2, islandW / 2, 1],
      [-islandW / 2, 0, 1, islandH / 2],
      [islandW / 2, 0, 1, islandH / 2],
    ];
    for (const [x, z, hx, hz] of wallSpecs) {
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, 3, hz).setTranslation(x, 3, z),
        fixed
      );
    }
  }

  /** Bake an object's meshes (with world transforms) into merge buckets. */
  private bakeStatic(object: THREE.Object3D): void {
    object.updateMatrixWorld(true);
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const geo = child.geometry.clone() as THREE.BufferGeometry;
      geo.applyMatrix4(child.matrixWorld);
      for (const attr of Object.keys(geo.attributes)) {
        if (!['position', 'normal', 'uv'].includes(attr)) geo.deleteAttribute(attr);
      }
      const mat = (Array.isArray(child.material) ? child.material[0] : child.material) as THREE.Material;
      if (!this.buckets.has(mat)) this.buckets.set(mat, []);
      this.buckets.get(mat)!.push(geo);
    });
  }

  private flushBuckets(): void {
    for (const [mat, geos] of this.buckets) {
      const merged = mergeGeometries(geos, false);
      if (merged) {
        this.scene.add(new THREE.Mesh(merged, mat));
      } else {
        for (const g of geos) this.scene.add(new THREE.Mesh(g, mat));
      }
      for (const g of geos) g.dispose();
    }
    this.buckets.clear();
  }
}
