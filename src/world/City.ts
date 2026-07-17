import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CIVILIAN_CARS, PALETTE, TILE } from '../core/const';
import { Vehicle } from '../entities/Vehicle';
import type { Game } from '../core/Game';
import { cellAt, cellHash, cellToWorld, roadMask, worldToCell } from './CityMap';

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

const ROAD_TABLE = buildRoadTable();

/** Chunk streaming parameters. */
export const CHUNK_TILES = 10;
export const CHUNK_SIZE = CHUNK_TILES * TILE; // 120m
/** Chunks kept loaded around each player (chebyshev, in chunks). */
const LOAD_RADIUS = 2;
/** Chunks beyond this from every player are freed (hysteresis vs LOAD_RADIUS). */
const UNLOAD_RADIUS = 3;

type Buckets = Map<THREE.Material, THREE.BufferGeometry[]>;

interface Chunk {
  kx: number;
  kz: number;
  meshes: THREE.Mesh[];
  body: RAPIER.RigidBody;
  /** Parked cars owned by this chunk (orphaned instead of despawned if stolen). */
  vehicles: Vehicle[];
}

const chunkKey = (kx: number, kz: number) => `${kx},${kz}`;

export function chunkOfWorld(x: number, z: number): { kx: number; kz: number } {
  const { cx, cz } = worldToCell(x, z);
  return { kx: Math.floor(cx / CHUNK_TILES), kz: Math.floor(cz / CHUNK_TILES) };
}

/**
 * Streams city chunks in around the players and frees them behind. Each chunk
 * is self-contained: merged render meshes plus one fixed rigid body carrying
 * all of its colliders, so unloading is one removeRigidBody call.
 */
export class City {
  private chunks = new Map<string, Chunk>();
  private queue: { kx: number; kz: number }[] = [];
  private queued = new Set<string>();
  /**
   * One shared material per (pack, name, color) signature so meshes batch
   * across chunks and models. Kenney kits reuse the same few materials in
   * every file; without this each GLB's private instances would each cost
   * a draw call per chunk.
   */
  private canonicalMats = new Map<string, THREE.Material>();
  private groundMats = {
    pavement: new THREE.MeshStandardMaterial({ color: PALETTE.pavement }),
    grass: new THREE.MeshStandardMaterial({ color: PALETTE.grass }),
    sand: new THREE.MeshStandardMaterial({ color: PALETTE.sand }),
  };

  constructor(private game: Game) {
    // One flat ground slab covers the whole (unbounded) city; chunks only
    // add building and tree colliders on top.
    const ground = game.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    game.world.createCollider(
      RAPIER.ColliderDesc.cuboid(1e5, 0.5, 1e5).setTranslation(0, -0.5, 0),
      ground
    );
  }

  loadedChunkCount(): number {
    return this.chunks.size;
  }

  /** Build the 3x3 chunks around a spawn point synchronously (boot only). */
  prewarm(x: number, z: number): void {
    const { kx, kz } = chunkOfWorld(x, z);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) this.buildChunk(kx + dx, kz + dz);
    }
  }

  /**
   * Stream toward the given player positions. Builds at most one chunk per
   * call so the cost amortizes across frames instead of hitching.
   */
  update(positions: { x: number; z: number }[]): void {
    const centers = positions.map((p) => chunkOfWorld(p.x, p.z));
    const distTo = (kx: number, kz: number) =>
      Math.min(...centers.map((c) => Math.max(Math.abs(kx - c.kx), Math.abs(kz - c.kz))));

    const wanted = new Set<string>();
    for (const c of centers) {
      for (let dz = -LOAD_RADIUS; dz <= LOAD_RADIUS; dz++) {
        for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
          wanted.add(chunkKey(c.kx + dx, c.kz + dz));
        }
      }
    }

    for (const chunk of [...this.chunks.values()]) {
      if (distTo(chunk.kx, chunk.kz) > UNLOAD_RADIUS) this.unloadChunk(chunk);
    }

    for (const k of wanted) {
      if (!this.chunks.has(k) && !this.queued.has(k)) {
        const [kx, kz] = k.split(',').map(Number);
        this.queue.push({ kx, kz });
        this.queued.add(k);
      }
    }
    this.queue = this.queue.filter((q) => {
      const keep = wanted.has(chunkKey(q.kx, q.kz));
      if (!keep) this.queued.delete(chunkKey(q.kx, q.kz));
      return keep;
    });
    if (this.queue.length === 0) return;

    let best = 0;
    for (let i = 1; i < this.queue.length; i++) {
      if (distTo(this.queue[i].kx, this.queue[i].kz) < distTo(this.queue[best].kx, this.queue[best].kz)) best = i;
    }
    const job = this.queue.splice(best, 1)[0];
    this.queued.delete(chunkKey(job.kx, job.kz));
    this.buildChunk(job.kx, job.kz);
  }

  private buildChunk(kx: number, kz: number): void {
    if (this.chunks.has(chunkKey(kx, kz))) return;
    const body = this.game.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const buckets: Buckets = new Map();
    const vehicles: Vehicle[] = [];

    const c0x = kx * CHUNK_TILES;
    const c0z = kz * CHUNK_TILES;
    for (let cz = c0z; cz < c0z + CHUNK_TILES; cz++) {
      for (let cx = c0x; cx < c0x + CHUNK_TILES; cx++) {
        const cell = cellAt(cx, cz);
        const { x, z } = cellToWorld(cx, cz);
        switch (cell) {
          case '#': {
            const mask = roadMask(cx, cz);
            const { model, rot } = ROAD_TABLE.get(mask) ?? { model: 'roads/road-square', rot: 0 };
            const { object } = this.game.assets.getFitted(model, { width: TILE });
            object.position.set(x, -TILE * 0.02 + 0.002, z);
            object.rotation.y = rot;
            this.bake(object, model, buckets);
            this.streetlight(cx, cz, x, z, mask, buckets);
            this.maybeParkCar(cx, cz, x, z, mask, vehicles);
            break;
          }
          case 'C':
            this.groundPlane(x, z, 'pavement', buckets);
            this.building(body, cx, cz, x, z, buckets);
            break;
          case 'S':
            this.groundPlane(x, z, 'grass', buckets);
            this.building(body, cx, cz, x, z, buckets);
            if (cellHash(cx, cz, 7) < 0.45) this.tree(body, x + TILE * 0.38, z + TILE * 0.38, cx, cz, buckets);
            break;
          case 'P':
            this.groundPlane(x, z, 'grass', buckets);
            for (let i = 0; i < 3; i++) {
              const ox = (cellHash(cx, cz, 10 + i) - 0.5) * TILE * 0.8;
              const oz = (cellHash(cx, cz, 20 + i) - 0.5) * TILE * 0.8;
              this.tree(body, x + ox, z + oz, cx, cz + i, buckets);
            }
            break;
          case '.':
            this.groundPlane(x, z, 'pavement', buckets);
            break;
        }
      }
    }

    // Sand base under the whole chunk (shows through at road seams).
    const mid = (CHUNK_TILES - 1) / 2;
    const base = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE);
    base.applyMatrix4(
      new THREE.Matrix4()
        .makeRotationX(-Math.PI / 2)
        .setPosition((c0x + mid) * TILE, -0.02, (c0z + mid) * TILE)
    );
    this.bucket(this.groundMats.sand, base, buckets);

    const meshes: THREE.Mesh[] = [];
    for (const [mat, geos] of buckets) {
      const merged = mergeGeometries(geos, false);
      if (merged) {
        const mesh = new THREE.Mesh(merged, mat);
        this.game.scene.add(mesh);
        meshes.push(mesh);
        for (const g of geos) g.dispose();
      } else {
        for (const g of geos) {
          const mesh = new THREE.Mesh(g, mat);
          this.game.scene.add(mesh);
          meshes.push(mesh);
        }
      }
    }

    this.chunks.set(chunkKey(kx, kz), { kx, kz, meshes, body, vehicles });
  }

  private unloadChunk(chunk: Chunk): void {
    for (const m of chunk.meshes) {
      this.game.scene.remove(m);
      m.geometry.dispose();
    }
    this.game.world.removeRigidBody(chunk.body);
    for (const v of chunk.vehicles) {
      const t = v.body.translation();
      const c = chunkOfWorld(t.x, t.z);
      // Only reclaim cars still parked in this chunk; stolen or driven-off
      // ones are orphaned so they don't vanish next to a player.
      if (v.driver === null && c.kx === chunk.kx && c.kz === chunk.kz) {
        this.game.removeVehicle(v);
      }
    }
    this.chunks.delete(chunkKey(chunk.kx, chunk.kz));
  }

  private maybeParkCar(cx: number, cz: number, x: number, z: number, mask: number, vehicles: Vehicle[]): void {
    if (mask !== 5 && mask !== 10) return; // straight segments only
    if (cellHash(cx, cz, 40) > 0.04) return;
    const along = mask === 5 ? 0 : Math.PI / 2; // heading along the road
    const side = cellHash(cx, cz, 41) < 0.5 ? 1 : -1;
    const off = TILE * 0.3 * side;
    const model = CIVILIAN_CARS[Math.floor(cellHash(cx, cz, 42) * CIVILIAN_CARS.length)];
    const v = new Vehicle(
      this.game,
      model,
      x + (mask === 5 ? off : 0),
      z + (mask === 10 ? off : 0),
      along + (side < 0 ? Math.PI : 0)
    );
    this.game.addVehicle(v);
    vehicles.push(v);
  }

  private building(body: RAPIER.RigidBody, cx: number, cz: number, x: number, z: number, buckets: Buckets): void {
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

    const size = this.game.assets.size(model);
    const footprint = Math.max(size.x, size.z);
    const scale = ((TILE * lotFrac) / footprint) * (0.88 + cellHash(cx, cz, 5) * 0.24);
    const object = this.game.assets.get(model);
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
    this.bake(object, model, buckets);

    const quarterTurns = Math.round(rot / (Math.PI / 2)) & 1;
    const hx = ((quarterTurns ? size.z : size.x) * scale) / 2;
    const hz = ((quarterTurns ? size.x : size.z) * scale) / 2;
    const hy = (size.y * scale) / 2;
    this.game.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, hy, z),
      body
    );
  }

  /** A curved streetlight on alternating sides of straight road segments. */
  private streetlight(cx: number, cz: number, x: number, z: number, mask: number, buckets: Buckets): void {
    if (mask !== 5 && mask !== 10) return;
    if (((cx + cz) % 3 + 3) % 3 !== 0) return;
    const side = ((cx + cz) / 3) % 2 === 0 ? 1 : -1;
    const off = TILE * 0.46 * side;
    const { object } = this.game.assets.getFitted(STREETLIGHT, { height: 6 });
    if (mask === 5) {
      // N-S road: light on east/west sidewalk, arm pointing at the road.
      object.position.set(x + off, 0, z);
      object.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
    } else {
      object.position.set(x, 0, z + off);
      object.rotation.y = side > 0 ? 0 : Math.PI;
    }
    this.bake(object, STREETLIGHT, buckets);
  }

  private tree(body: RAPIER.RigidBody, x: number, z: number, hx: number, hz: number, buckets: Buckets): void {
    const model = TREES[cellHash(hx, hz, 30) < 0.6 ? 0 : 1];
    const { object, scale } = this.game.assets.getFitted(model, {
      height: 5.5 + cellHash(hx, hz, 31) * 3,
    });
    object.position.set(x, 0, z);
    object.rotation.y = cellHash(hx, hz, 32) * Math.PI * 2;
    this.bake(object, model, buckets);
    const height = this.game.assets.size(model).y * scale;
    this.game.world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.25, height / 2, 0.25).setTranslation(x, height / 2, z),
      body
    );
  }

  private groundPlane(x: number, z: number, kind: 'pavement' | 'grass', buckets: Buckets): void {
    const geo = new THREE.PlaneGeometry(TILE, TILE);
    geo.applyMatrix4(
      new THREE.Matrix4()
        .makeRotationX(-Math.PI / 2)
        .setPosition(x, kind === 'grass' ? -0.008 : -0.005, z)
    );
    this.bucket(this.groundMats[kind], geo, buckets);
  }

  /** Bake an object's meshes (with world transforms) into merge buckets. */
  private bake(object: THREE.Object3D, modelName: string, buckets: Buckets): void {
    const pack = modelName.split('/')[0];
    object.updateMatrixWorld(true);
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const geo = child.geometry.clone() as THREE.BufferGeometry;
      geo.applyMatrix4(child.matrixWorld);
      for (const attr of Object.keys(geo.attributes)) {
        if (!['position', 'normal', 'uv'].includes(attr)) geo.deleteAttribute(attr);
      }
      const raw = (Array.isArray(child.material) ? child.material[0] : child.material) as THREE.MeshStandardMaterial;
      this.bucket(this.canonical(pack, raw), geo, buckets);
    });
  }

  private canonical(pack: string, mat: THREE.MeshStandardMaterial): THREE.Material {
    // Keyed per asset pack: kits reuse material names ("colormap") but each
    // kit's texture atlas is different, so never collapse across packs.
    const k = `${pack}|${mat.name}|${mat.color ? mat.color.getHex() : ''}|${mat.map ? 'tex' : ''}`;
    let m = this.canonicalMats.get(k);
    if (!m) {
      m = mat;
      this.canonicalMats.set(k, m);
    }
    return m;
  }

  private bucket(mat: THREE.Material, geo: THREE.BufferGeometry, buckets: Buckets): void {
    if (!buckets.has(mat)) buckets.set(mat, []);
    buckets.get(mat)!.push(geo);
  }
}
