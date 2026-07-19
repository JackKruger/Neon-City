import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CIVILIAN_CARS, PALETTE, TILE } from '../core/const';
import { Vehicle } from '../entities/Vehicle';
import type { Game } from '../core/Game';
import type { CityStreamer } from './CityStreamer';
import { setRoadNetwork } from './RoadGraph';
import {
  AuthoredObject,
  CoverageFlag,
  TransportFlag,
  authoredObjectsForChunk,
  cellAt,
  cellHash,
  cellToWorld,
  cornerHeight,
  getAuthoredMap,
  hasCoverage,
  heightAt,
  isRoad,
  padHeight,
  roadMask,
  transportAt,
  worldToCell,
} from './CityMap';

const COMMERCIAL = 'abcdefghijklmn'.split('').map((c) => `commercial/building-${c}`);
const SKYSCRAPERS = 'abcde'.split('').map((c) => `commercial/building-skyscraper-${c}`);
const SUBURBAN = 'abcdefghijklmnopqrstu'.split('').map((c) => `suburban/building-type-${c}`);
const INDUSTRIAL = 'abcdefghijklmnopqrst'.split('').map((c) => `industrial/building-${c}`);
const SMOKESTACK = 'industrial/chimney-medium';
const TANK = 'industrial/detail-tank';
const ROADS = [
  'road-straight',
  'road-crossing',
  'road-bend',
  'road-intersection-line',
  'road-crossroad-line',
  'road-end',
  'road-square',
  'road-bridge',
].map((n) => `roads/${n}`);
const TREES = ['suburban/tree-large', 'suburban/tree-small'];
const STREETLIGHT = 'roads/light-curved';
const FENCE = 'suburban/fence-3x3';
const DRIVEWAY = 'suburban/driveway-long';
const PATHS = ['suburban/path-long', 'suburban/path-stones-long', 'suburban/path-stones-messy'];
const PLANTER = 'suburban/planter';
/** Keep authored building boxes clear of car lanes and pedestrian waypoints. */
const ROAD_SPAWN_CLEARANCE = TILE * 0.46;
const PARKED_CAR_CLEARANCE = 4.5;

export const CITY_ASSETS = [
  ...COMMERCIAL,
  ...SKYSCRAPERS,
  ...SUBURBAN,
  ...INDUSTRIAL,
  SMOKESTACK,
  TANK,
  ...ROADS,
  ...TREES,
  STREETLIGHT,
  FENCE,
  DRIVEWAY,
  ...PATHS,
  PLANTER,
];

/**
 * Commercial cells inside these coarse districts build warehouses and
 * factories instead of shops and towers. Purely a function of cell coords,
 * so it works identically for authored and procedural maps.
 */
const DISTRICT_CELLS = 12; // 144m
function isIndustrialDistrict(cx: number, cz: number): boolean {
  return cellHash(Math.floor(cx / DISTRICT_CELLS), Math.floor(cz / DISTRICT_CELLS), 60) < 0.24;
}

/**
 * True when a road cell is part of a wide-road area (OSM dual carriageways
 * and big junctions rasterize to 2+ cells wide) rather than a 1-wide street
 * the tile set can represent. Diagonal staircases of bends stay tiled: each
 * of their cells has only 2 orthogonal road neighbors.
 */
function roadBlob(cx: number, cz: number): boolean {
  const road = (dx: number, dz: number) => (cellAt(cx + dx, cz + dz) === '#' ? 1 : 0);
  const n4 = road(0, -1) + road(1, 0) + road(0, 1) + road(-1, 0);
  if (n4 < 3) return false;
  const nd = road(-1, -1) + road(1, -1) + road(-1, 1) + road(1, 1);
  return n4 + nd >= 5;
}

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
    ['roads/road-intersection-line', 7], // T: connects N+E+S
    ['roads/road-crossroad-line', 15],
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
export class City implements CityStreamer {
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
    asphalt: new THREE.MeshStandardMaterial({ color: PALETTE.asphalt }),
    water: new THREE.MeshStandardMaterial({
      color: PALETTE.water,
      roughness: 0.15,
      metalness: 0.1,
    }),
  };
  private propMats = {
    metal: new THREE.MeshStandardMaterial({ color: 0x56616a, roughness: 0.65, metalness: 0.35 }),
    timber: new THREE.MeshStandardMaterial({ color: 0x8b6245, roughness: 0.85 }),
    civic: new THREE.MeshStandardMaterial({ color: 0x489fb5, roughness: 0.55 }),
    art: new THREE.MeshStandardMaterial({ color: 0xe85d75, roughness: 0.35, metalness: 0.2 }),
  };
  private authoredBuildingMats = {
    commercial: new THREE.MeshStandardMaterial({ color: 0xb985cf, roughness: 0.78 }),
    skyscraper: new THREE.MeshStandardMaterial({ color: 0x718caf, roughness: 0.5, metalness: 0.18 }),
    suburban: new THREE.MeshStandardMaterial({ color: 0xd9b38c, roughness: 0.88 }),
    industrial: new THREE.MeshStandardMaterial({ color: 0x899096, roughness: 0.82, metalness: 0.12 }),
  };
  private safetyBody: RAPIER.RigidBody;

  constructor(private game: Game) {
    setRoadNetwork(null);
    // Deep tunnelling net. Streamed heightfields are the actual terrain.
    this.safetyBody = game.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    game.world.createCollider(
      RAPIER.ColliderDesc.cuboid(1e5, 0.5, 1e5).setTranslation(0, -30.5, 0),
      this.safetyBody
    );
  }

  loadedChunkCount(): number {
    return this.chunks.size;
  }

  /** Build the 3x3 chunks around a spawn point synchronously (boot only). */
  async prewarm(x: number, z: number): Promise<void> {
    const { kx, kz } = chunkOfWorld(x, z);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) this.buildChunk(kx + dx, kz + dz);
    }
  }

  dispose(): void {
    for (const chunk of [...this.chunks.values()]) this.unloadChunk(chunk);
    this.game.world.removeRigidBody(this.safetyBody);
    setRoadNetwork(null);
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
    const polygonRoads = getAuthoredMap()?.roadSurfaces === true;
    const authoredObjects = authoredObjectsForChunk(kx, kz);
    // Keep the local object check as a safe fallback if an older map omits the
    // source mask or the coverage layer fails to load.
    const authoredBuildingArea = authoredObjects.some((object) => object.kind === 'building');

    const c0x = kx * CHUNK_TILES;
    const c0z = kz * CHUNK_TILES;
    const heights = new Float32Array((CHUNK_TILES + 1) * (CHUNK_TILES + 1));
    for (let iz = 0; iz <= CHUNK_TILES; iz++) {
      for (let ix = 0; ix <= CHUNK_TILES; ix++) {
        // Rapier expects its height matrix in column-major order: X selects
        // the column and Z the row.
        heights[iz + ix * (CHUNK_TILES + 1)] = cornerHeight(c0x + ix, c0z + iz);
      }
    }
    const mid = (CHUNK_TILES - 1) / 2;
    this.game.world.createCollider(
      RAPIER.ColliderDesc.heightfield(
        CHUNK_TILES,
        CHUNK_TILES,
        heights,
        { x: CHUNK_SIZE, y: 1, z: CHUNK_SIZE },
        RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES
      ).setTranslation((c0x + mid) * TILE, 0, (c0z + mid) * TILE),
      body
    );
    for (let cz = c0z; cz < c0z + CHUNK_TILES; cz++) {
      for (let cx = c0x; cx < c0x + CHUNK_TILES; cx++) {
        const cell = cellAt(cx, cz);
        const { x, z } = cellToWorld(cx, cz);
        switch (cell) {
          case '#': {
            // Building coverage wins over the coarse OSM road raster. The
            // road may be a pedestrian/service way inside the footprint.
            if (!isRoad(cx, cz)) {
              this.groundPlane(x, z, 'pavement', buckets);
              break;
            }
            const mask = roadMask(cx, cz);
            if (!polygonRoads) {
              // Legacy authored/procedural maps still use the tile road kit.
              this.groundPlane(x, z, 'asphalt', buckets);
              if (!roadBlob(cx, cz)) {
                let { model, rot } = ROAD_TABLE.get(mask) ?? { model: 'roads/road-square', rot: 0 };
                if ((transportAt(cx, cz) & TransportFlag.Bridge) && (mask === 5 || mask === 10)) {
                  model = 'roads/road-bridge';
                  rot = mask === 10 ? Math.PI / 2 : 0;
                }
                if (model === 'roads/road-straight' && this.nextToIntersection(cx, cz)) {
                  model = 'roads/road-crossing';
                }
                const { object } = this.game.assets.getFitted(model, { width: TILE });
                object.position.set(x, -TILE * 0.02 + 0.002, z);
                object.rotation.y = rot;
                this.bake(object, model, buckets, true);
              }
            }
            this.streetlight(cx, cz, x, z, mask, buckets);
            if (!hasCoverage(cx, cz, CoverageFlag.Parking)) this.maybeParkCar(cx, cz, x, z, mask, vehicles);
            break;
          }
          case 'C':
            this.groundPlane(x, z, 'pavement', buckets);
            if (!authoredBuildingArea && !hasCoverage(cx, cz, CoverageFlag.BuildingSource) && !hasCoverage(cx, cz, CoverageFlag.Building) && (roadMask(cx, cz) !== 0 || this.roadNear(cx, cz, 2))) {
              this.building(body, cx, cz, x, z, buckets);
            } else if (!hasCoverage(cx, cz, CoverageFlag.Tree) && !hasCoverage(cx, cz, CoverageFlag.Building) && cellHash(cx, cz, 7) < 0.25) {
              // Deep inside a roadless block: an open plaza, not a building
              // nobody could ever reach.
              this.tree(body, x + TILE * 0.2, z - TILE * 0.15, cx, cz, buckets);
            }
            break;
          case 'S':
            this.groundPlane(x, z, 'grass', buckets);
            if (!authoredBuildingArea && !hasCoverage(cx, cz, CoverageFlag.BuildingSource) && !hasCoverage(cx, cz, CoverageFlag.Building) && roadMask(cx, cz) !== 0) {
              this.building(body, cx, cz, x, z, buckets);
              if (!hasCoverage(cx, cz, CoverageFlag.Tree) && cellHash(cx, cz, 7) < 0.45) this.tree(body, x + TILE * 0.38, z + TILE * 0.38, cx, cz, buckets);
            } else if (!hasCoverage(cx, cz, CoverageFlag.Tree) && !hasCoverage(cx, cz, CoverageFlag.Building)) {
              // Lots with no street frontage are the block's backyards.
              for (let i = 0, n = 1 + (cellHash(cx, cz, 9) < 0.4 ? 1 : 0); i < n; i++) {
                const ox = (cellHash(cx, cz, 10 + i) - 0.5) * TILE * 0.7;
                const oz = (cellHash(cx, cz, 20 + i) - 0.5) * TILE * 0.7;
                this.tree(body, x + ox, z + oz, cx, cz + i, buckets);
              }
            }
            break;
          case 'P':
            this.groundPlane(x, z, 'grass', buckets);
            for (let i = 0; i < (hasCoverage(cx, cz, CoverageFlag.Tree) ? 0 : 3); i++) {
              const ox = (cellHash(cx, cz, 10 + i) - 0.5) * TILE * 0.8;
              const oz = (cellHash(cx, cz, 20 + i) - 0.5) * TILE * 0.8;
              this.tree(body, x + ox, z + oz, cx, cz + i, buckets);
            }
            break;
          case '.':
            this.groundPlane(x, z, 'pavement', buckets);
            break;
          case '~':
            this.water(body, cx, cz, x, z, buckets);
            break;
        }
      }
    }

    for (const object of authoredObjects) {
      this.authoredObject(object, body, buckets, vehicles);
    }

    // Sand base under the whole chunk (shows through at road seams).
    const base = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, CHUNK_TILES, CHUNK_TILES);
    base.applyMatrix4(
      new THREE.Matrix4()
        .makeRotationX(-Math.PI / 2)
        .setPosition((c0x + mid) * TILE, -0.02, (c0z + mid) * TILE)
    );
    this.displaceTerrain(base);
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

  /** True when a 4-neighbor road cell is a genuine (non-blob) T or crossroad. */
  private nextToIntersection(cx: number, cz: number): boolean {
    for (const [dx, dz] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (cellAt(nx, nz) !== '#' || roadBlob(nx, nz)) continue;
      const m = roadMask(nx, nz);
      const branches = (m & 1 ? 1 : 0) + (m & 2 ? 1 : 0) + (m & 4 ? 1 : 0) + (m & 8 ? 1 : 0);
      if (branches >= 3) return true;
    }
    return false;
  }

  /** True when any road cell lies within chebyshev distance r. */
  private roadNear(cx: number, cz: number, r: number): boolean {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (cellAt(cx + dx, cz + dz) === '#') return true;
      }
    }
    return false;
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

  private authoredObject(
    feature: AuthoredObject,
    body: RAPIER.RigidBody,
    buckets: Buckets,
    vehicles: Vehicle[]
  ): void {
    if (feature.kind === 'road-surface') {
      this.authoredRoadSurface(feature, buckets);
    } else if (feature.kind === 'building') {
      this.authoredBuilding(feature, body, buckets);
    } else if (feature.kind === 'tree') {
      this.authoredTree(feature, body, buckets);
    } else if (feature.kind === 'parking') {
      this.authoredParkedCar(feature, vehicles);
    } else {
      this.authoredProp(feature, body, buckets);
    }
  }

  private authoredRoadSurface(
    feature: Extract<AuthoredObject, { kind: 'road-surface' }>,
    buckets: Buckets
  ): void {
    if (feature.outline.length < 3) return;
    const shape = new THREE.Shape();
    for (let i = 0; i < feature.outline.length; i++) {
      const [x, z] = feature.outline[i];
      if (i === 0) shape.moveTo(x, -z);
      else shape.lineTo(x, -z);
    }
    shape.closePath();
    const coarse = new THREE.ShapeGeometry(shape);
    coarse.rotateX(-Math.PI / 2);
    coarse.translate(feature.x, 0.018, feature.z);
    const geometry = this.subdivideForTerrain(coarse);
    coarse.dispose();
    this.displaceTerrain(geometry);
    this.bucket(this.groundMats[feature.surface], geometry, buckets);
  }

  private authoredBuilding(
    feature: Extract<AuthoredObject, { kind: 'building' }>,
    body: RAPIER.RigidBody,
    buckets: Buckets
  ): void {
    if (feature.outline && feature.outline.length >= 3) {
      this.authoredFootprintBuilding(feature, body, buckets);
      return;
    }
    // Source footprints are represented by one oriented box. Very large or
    // concave footprints can therefore cover roads that the original polygon
    // did not. Never let that approximation seal a gameplay spawn corridor.
    if (this.authoredBuildingBlocksRoad(feature)) return;

    const { cx, cz } = worldToCell(feature.x, feature.z);
    const models = feature.style === 'industrial'
      ? INDUSTRIAL
      : feature.style === 'suburban'
        ? SUBURBAN
        : feature.style === 'skyscraper'
          ? SKYSCRAPERS
          : COMMERCIAL;
    const model = models[Math.floor(cellHash(cx, cz, 91) * models.length)];
    const size = this.game.assets.size(model);
    const baseY = this.authoredBuildingBase(feature);
    const object = this.game.assets.get(model);
    object.scale.set(
      Math.max(0.1, feature.width / size.x),
      Math.max(0.1, feature.height / size.y),
      Math.max(0.1, feature.depth / size.z)
    );
    object.position.set(feature.x, baseY, feature.z);
    object.rotation.y = feature.rotation;
    this.bake(object, model, buckets);
    this.game.world.createCollider(
      RAPIER.ColliderDesc.cuboid(feature.width / 2, feature.height / 2 + 0.25, feature.depth / 2)
        .setTranslation(feature.x, baseY + feature.height / 2 - 0.25, feature.z)
        .setRotation({ x: 0, y: Math.sin(feature.rotation / 2), z: 0, w: Math.cos(feature.rotation / 2) }),
      body
    );
  }

  /** Extrude the real simplified footprint and reuse that mesh for collision. */
  private authoredFootprintBuilding(
    feature: Extract<AuthoredObject, { kind: 'building' }>,
    body: RAPIER.RigidBody,
    buckets: Buckets
  ): void {
    const outline = feature.outline!;
    const baseY = this.authoredBuildingBase(feature);
    const shape = new THREE.Shape();
    for (let i = 0; i < outline.length; i++) {
      const [x, z] = outline[i];
      if (i === 0) shape.moveTo(x, -z);
      else shape.lineTo(x, -z);
    }
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: feature.height,
      bevelEnabled: false,
      steps: 1,
      curveSegments: 1,
    });
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(feature.x, baseY, feature.z);
    geometry.computeVertexNormals();

    const position = geometry.getAttribute('position');
    const vertices = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      vertices[i * 3] = position.getX(i);
      vertices[i * 3 + 1] = position.getY(i);
      vertices[i * 3 + 2] = position.getZ(i);
    }
    const indices = geometry.index
      ? Uint32Array.from(geometry.index.array)
      : Uint32Array.from({ length: position.count }, (_, i) => i);
    this.game.world.createCollider(RAPIER.ColliderDesc.trimesh(vertices, indices), body);
    this.bucket(this.authoredBuildingMats[feature.style], geometry, buckets);
  }

  private authoredTree(
    feature: Extract<AuthoredObject, { kind: 'tree' }>,
    body: RAPIER.RigidBody,
    buckets: Buckets
  ): void {
    const model = feature.variant === 'small' ? TREES[1] : TREES[0];
    const baseY = heightAt(feature.x, feature.z);
    const { object, scale } = this.game.assets.getFitted(model, { height: feature.height });
    object.position.set(feature.x, baseY, feature.z);
    object.rotation.y = cellHash(Math.round(feature.x), Math.round(feature.z), 92) * Math.PI * 2;
    this.bake(object, model, buckets);
    const height = this.game.assets.size(model).y * scale;
    this.game.world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.22, height / 2, 0.22).setTranslation(feature.x, baseY + height / 2, feature.z),
      body
    );
  }

  private authoredParkedCar(
    feature: Extract<AuthoredObject, { kind: 'parking' }>,
    vehicles: Vehicle[]
  ): void {
    const { cx, cz } = worldToCell(feature.x, feature.z);
    const side = cellHash(cx, cz, 93) < 0.5 ? -1 : 1;
    const offset = TILE * 0.3 * side;
    const x = feature.x + Math.cos(feature.rotation) * offset;
    const z = feature.z - Math.sin(feature.rotation) * offset;
    // The open parking dataset may contain multiple bays that thin down to the
    // same road-cell representative. Spawning all of them stacks rigid bodies.
    for (const existing of this.game.vehicles) {
      const t = existing.body.translation();
      if (Math.hypot(t.x - x, t.z - z) < PARKED_CAR_CLEARANCE) return;
    }
    const model = CIVILIAN_CARS[Math.floor(cellHash(cx, cz, 94) * CIVILIAN_CARS.length)];
    const vehicle = new Vehicle(this.game, model, x, z, feature.rotation + (side < 0 ? Math.PI : 0));
    this.game.addVehicle(vehicle);
    vehicles.push(vehicle);
  }

  /** Lowest terrain sample under an authored footprint, used as its level pad. */
  private authoredBuildingBase(
    feature: Extract<AuthoredObject, { kind: 'building' }>
  ): number {
    if (Number.isFinite(feature.baseY)) return feature.baseY as number;
    if (feature.outline && feature.outline.length >= 3) {
      return Math.min(
        heightAt(feature.x, feature.z),
        ...feature.outline.map(([x, z]) => heightAt(feature.x + x, feature.z + z))
      );
    }
    const c = Math.cos(feature.rotation);
    const s = Math.sin(feature.rotation);
    let base = heightAt(feature.x, feature.z);
    for (const lx of [-feature.width / 2, feature.width / 2]) {
      for (const lz of [-feature.depth / 2, feature.depth / 2]) {
        base = Math.min(
          base,
          heightAt(feature.x + lx * c + lz * s, feature.z - lx * s + lz * c)
        );
      }
    }
    return base;
  }

  /** True when an authored building's box intrudes into a road spawn lane. */
  private authoredBuildingBlocksRoad(
    feature: Extract<AuthoredObject, { kind: 'building' }>
  ): boolean {
    const radius =
      Math.hypot(feature.width / 2, feature.depth / 2) + ROAD_SPAWN_CLEARANCE;
    const min = worldToCell(feature.x - radius, feature.z - radius);
    const max = worldToCell(feature.x + radius, feature.z + radius);
    const c = Math.cos(-feature.rotation);
    const s = Math.sin(-feature.rotation);
    for (let cz = min.cz; cz <= max.cz; cz++) {
      for (let cx = min.cx; cx <= max.cx; cx++) {
        if (!isRoad(cx, cz)) continue;
        const point = cellToWorld(cx, cz);
        const dx = point.x - feature.x;
        const dz = point.z - feature.z;
        const lx = dx * c - dz * s;
        const lz = dx * s + dz * c;
        if (
          Math.abs(lx) <= feature.width / 2 + ROAD_SPAWN_CLEARANCE &&
          Math.abs(lz) <= feature.depth / 2 + ROAD_SPAWN_CLEARANCE
        ) {
          return true;
        }
      }
    }
    return false;
  }

  private authoredProp(
    feature: Exclude<AuthoredObject, { kind: 'road-surface' | 'building' | 'tree' | 'parking' }>,
    body: RAPIER.RigidBody,
    buckets: Buckets
  ): void {
    const baseY = heightAt(feature.x, feature.z);
    let geometry: THREE.BufferGeometry;
    let material: THREE.Material = this.propMats.metal;
    let collider: { hx: number; hy: number; hz: number } | null = null;
    switch (feature.kind) {
      case 'bollard':
        geometry = new THREE.CylinderGeometry(0.14, 0.18, 1.05, 8);
        geometry.translate(0, 0.525, 0);
        break;
      case 'bicycle-rail':
        geometry = new THREE.BoxGeometry(1.1, 0.75, 0.08);
        geometry.translate(0, 0.45, 0);
        break;
      case 'bin':
        geometry = new THREE.BoxGeometry(0.55, 0.9, 0.55);
        geometry.translate(0, 0.45, 0);
        break;
      case 'seat':
        geometry = new THREE.BoxGeometry(1.7, 0.25, 0.55);
        geometry.translate(0, 0.55, 0);
        material = this.propMats.timber;
        break;
      case 'planter':
        geometry = new THREE.CylinderGeometry(0.55, 0.48, 0.7, 10);
        geometry.translate(0, 0.35, 0);
        material = this.propMats.civic;
        break;
      case 'fountain':
        geometry = new THREE.CylinderGeometry(1.4, 1.6, 0.8, 16);
        geometry.translate(0, 0.4, 0);
        material = this.propMats.civic;
        collider = { hx: 1.5, hy: 0.4, hz: 1.5 };
        break;
      case 'barbecue':
        geometry = new THREE.BoxGeometry(1.1, 1.1, 0.8);
        geometry.translate(0, 0.55, 0);
        collider = { hx: 0.55, hy: 0.55, hz: 0.4 };
        break;
      case 'art':
        geometry = new THREE.IcosahedronGeometry(1.2, 0);
        geometry.translate(0, 1.25, 0);
        material = this.propMats.art;
        collider = { hx: 1.1, hy: 1.2, hz: 1.1 };
        break;
    }
    geometry.applyMatrix4(
      new THREE.Matrix4().makeRotationY(feature.rotation).setPosition(feature.x, baseY, feature.z)
    );
    this.bucket(material, geometry, buckets);
    if (collider) {
      this.game.world.createCollider(
        RAPIER.ColliderDesc.cuboid(collider.hx, collider.hy, collider.hz)
          .setTranslation(feature.x, baseY + collider.hy, feature.z),
        body
      );
    }
  }

  private building(body: RAPIER.RigidBody, cx: number, cz: number, x: number, z: number, buckets: Buckets): void {
    const cell = cellAt(cx, cz);
    const industrial = cell === 'C' && isIndustrialDistrict(cx, cz);
    // Suburban yard variant: front path, driveway, fenced garden, or bare lot.
    const yard = cell === 'S' ? cellHash(cx, cz, 50) : 1;
    const fenced = yard >= 0.55 && yard < 0.75;

    let model: string;
    let lotFrac: number;
    if (industrial) {
      model = INDUSTRIAL[Math.floor(cellHash(cx, cz, 61) * INDUSTRIAL.length)];
      lotFrac = 0.92;
    } else if (cell === 'C') {
      const skyscraper = cellHash(cx, cz, 1) < 0.3;
      model = skyscraper
        ? SKYSCRAPERS[Math.floor(cellHash(cx, cz, 2) * SKYSCRAPERS.length)]
        : COMMERCIAL[Math.floor(cellHash(cx, cz, 3) * COMMERCIAL.length)];
      lotFrac = 0.95;
    } else {
      model = SUBURBAN[Math.floor(cellHash(cx, cz, 4) * SUBURBAN.length)];
      // Fenced lots get a smaller house so the garden reads as a garden.
      lotFrac = fenced ? 0.58 : 0.72;
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
    const fdx = Math.sin(rot); // unit vector from the lot center toward the road
    const fdz = Math.cos(rot);

    // Houses sit back from the street so the yard props have a front strip;
    // commercial and industrial fill their lot to the sidewalk.
    const frontHalf = (size.z * scale) / 2;
    const sideHalf = (size.x * scale) / 2;
    const setback = cell === 'S' ? Math.max(0, Math.min(TILE * 0.08, TILE * 0.46 - frontHalf)) : 0;
    const bx = x - fdx * setback;
    const bz = z - fdz * setback;
    const baseY = padHeight(cx, cz);
    object.position.set(bx, baseY, bz);
    object.rotation.y = rot;
    this.bake(object, model, buckets);

    const quarterTurns = Math.round(rot / (Math.PI / 2)) & 1;
    const hx = ((quarterTurns ? size.z : size.x) * scale) / 2;
    const hz = ((quarterTurns ? size.x : size.z) * scale) / 2;
    const hy = (size.y * scale) / 2;
    this.game.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy + 0.25, hz).setTranslation(bx, baseY + hy - 0.25, bz),
      body
    );

    if (cell === 'S') this.yardProps(cx, cz, x, z, rot, mask, yard, scale, frontHalf, sideHalf, setback, buckets);
    if (industrial) this.industrialProps(body, cx, cz, x, z, rot, frontHalf, sideHalf, buckets);
  }

  /**
   * Dress a suburban lot according to its yard variant: a stone path with a
   * planter by the door, a driveway, or a fenced-in garden. Props are visual
   * only (no colliders) — cars can cut across a lawn without snagging.
   */
  private yardProps(
    cx: number,
    cz: number,
    x: number,
    z: number,
    rot: number,
    mask: number,
    yard: number,
    houseScale: number,
    frontHalf: number,
    sideHalf: number,
    setback: number,
    buckets: Buckets
  ): void {
    const fdx = Math.sin(rot);
    const fdz = Math.cos(rot);
    const sdx = fdz; // lateral unit vector across the lot front
    const sdz = -fdx;
    // Free strip between the house front and the lot's street edge.
    const gap = TILE / 2 - frontHalf + setback;

    if (yard < 0.55 && mask !== 0 && gap > 1.5) {
      const walk = yard < 0.3;
      const model = walk ? PATHS[Math.floor(cellHash(cx, cz, 51) * PATHS.length)] : DRIVEWAY;
      const len = gap * (walk ? 0.9 : 0.98);
      const side = cellHash(cx, cz, 53) < 0.5 ? 1 : -1;
      // Paths run up the middle to the door; driveways offset toward a garage.
      const off = walk ? 0 : side * sideHalf * 0.45;
      const d = TILE / 2 - len / 2; // anchored at the sidewalk edge
      const px = x + fdx * d + sdx * off;
      const pz = z + fdz * d + sdz * off;
      const { object } = this.game.assets.getFitted(model, { length: len });
      object.position.set(px, 0.012, pz);
      object.rotation.y = rot;
      this.bake(object, model, buckets, true);
      if (walk) {
        const planter = this.game.assets.get(PLANTER);
        planter.scale.setScalar(houseScale);
        const planterX = x + fdx * (TILE / 2 - gap + 0.4) + sdx * side * sideHalf * 0.6;
        const planterZ = z + fdz * (TILE / 2 - gap + 0.4) + sdz * side * sideHalf * 0.6;
        planter.position.set(
          planterX,
          heightAt(planterX, planterZ),
          planterZ
        );
        planter.rotation.y = rot;
        this.bake(planter, PLANTER, buckets);
      }
    } else if (yard >= 0.55 && yard < 0.75) {
      const { object } = this.game.assets.getFitted(FENCE, { width: TILE * 0.88 });
      object.position.set(x, heightAt(x, z), z);
      object.rotation.y = rot;
      this.bake(object, FENCE, buckets);
    }
  }

  /** A smokestack or storage tank behind shallow factories, when it fits. */
  private industrialProps(
    body: RAPIER.RigidBody,
    cx: number,
    cz: number,
    x: number,
    z: number,
    rot: number,
    frontHalf: number,
    sideHalf: number,
    buckets: Buckets
  ): void {
    const r = cellHash(cx, cz, 62);
    if (r >= 0.4) return;
    const d = frontHalf + 1.6; // rear clearance for the prop's own footprint
    if (d > TILE * 0.42) return;
    const fdx = Math.sin(rot);
    const fdz = Math.cos(rot);
    const side = cellHash(cx, cz, 63) < 0.5 ? 1 : -1;
    const off = side * Math.min(sideHalf * 0.55, TILE * 0.3);
    const px = x - fdx * d + fdz * off;
    const pz = z - fdz * d - fdx * off;
    const baseY = heightAt(px, pz);
    if (r < 0.2) {
      const height = 8 + cellHash(cx, cz, 64) * 4;
      const { object } = this.game.assets.getFitted(SMOKESTACK, { height });
      object.position.set(px, baseY, pz);
      this.bake(object, SMOKESTACK, buckets);
      this.game.world.createCollider(
        RAPIER.ColliderDesc.cuboid(1.1, height / 2, 1.1).setTranslation(px, baseY + height / 2, pz),
        body
      );
    } else {
      const { object } = this.game.assets.getFitted(TANK, { height: 2.6 });
      object.position.set(px, baseY, pz);
      object.rotation.y = rot;
      this.bake(object, TANK, buckets);
    }
  }

  /**
   * Curved streetlights, every third cell: on alternating sides of 1-wide
   * straight segments, and on every sidewalk edge of wide-road cells (which
   * have no straight mask, so the old rule left arterials unlit).
   */
  private streetlight(cx: number, cz: number, x: number, z: number, mask: number, buckets: Buckets): void {
    if (((cx + cz) % 3 + 3) % 3 !== 0) return;
    const edges: [number, number][] = [];
    if (roadBlob(cx, cz)) {
      for (const [dx, dz] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
        if (cellAt(cx + dx, cz + dz) !== '#') edges.push([dx, dz]);
      }
    } else if (mask === 5 || mask === 10) {
      const side = ((cx + cz) / 3) % 2 === 0 ? 1 : -1;
      edges.push(mask === 5 ? [side, 0] : [0, side]);
    }
    for (const [dx, dz] of edges) {
      const { object } = this.game.assets.getFitted(STREETLIGHT, { height: 6 });
      // Stand on the sidewalk edge, arm pointing over the road.
      const px = x + dx * TILE * 0.46;
      const pz = z + dz * TILE * 0.46;
      object.position.set(px, heightAt(px, pz), pz);
      object.rotation.y = dx !== 0 ? (dx > 0 ? Math.PI / 2 : -Math.PI / 2) : dz > 0 ? 0 : Math.PI;
      this.bake(object, STREETLIGHT, buckets);
    }
  }

  private tree(body: RAPIER.RigidBody, x: number, z: number, hx: number, hz: number, buckets: Buckets): void {
    const model = TREES[cellHash(hx, hz, 30) < 0.6 ? 0 : 1];
    const { object, scale } = this.game.assets.getFitted(model, {
      height: 5.5 + cellHash(hx, hz, 31) * 3,
    });
    const baseY = heightAt(x, z);
    object.position.set(x, baseY, z);
    object.rotation.y = cellHash(hx, hz, 32) * Math.PI * 2;
    this.bake(object, model, buckets);
    const height = this.game.assets.size(model).y * scale;
    this.game.world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.25, height / 2, 0.25).setTranslation(x, baseY + height / 2, z),
      body
    );
  }

  /**
   * Water cell: a glossy plane, plus an invisible wall on any edge shared
   * with land so cars stay out of the bay. Each boundary edge is owned by
   * exactly one water cell, so walls are never duplicated across chunks.
   */
  private water(body: RAPIER.RigidBody, cx: number, cz: number, x: number, z: number, buckets: Buckets): void {
    const geo = new THREE.PlaneGeometry(TILE, TILE);
    geo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2).setPosition(x, 0.015, z));
    this.bucket(this.groundMats.water, geo, buckets);

    const edges: [number, number][] = [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ];
    for (const [dx, dz] of edges) {
      if (cellAt(cx + dx, cz + dz) === '~') continue;
      const hx = dx === 0 ? TILE / 2 : 0.25;
      const hz = dz === 0 ? TILE / 2 : 0.25;
      this.game.world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, 2.5, hz).setTranslation(
          x + (dx * TILE) / 2,
          2.5,
          z + (dz * TILE) / 2
        ),
        body
      );
    }
  }

  private groundPlane(x: number, z: number, kind: 'pavement' | 'grass' | 'asphalt', buckets: Buckets): void {
    const geo = new THREE.PlaneGeometry(TILE, TILE);
    geo.applyMatrix4(
      new THREE.Matrix4()
        .makeRotationX(-Math.PI / 2)
        .setPosition(x, kind === 'grass' ? -0.008 : -0.005, z)
    );
    this.displaceTerrain(geo);
    this.bucket(this.groundMats[kind], geo, buckets);
  }

  /** Bake an object's meshes (with world transforms) into merge buckets. */
  private bake(object: THREE.Object3D, modelName: string, buckets: Buckets, drape = false): void {
    const pack = modelName.split('/')[0];
    object.updateMatrixWorld(true);
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const geo = child.geometry.clone() as THREE.BufferGeometry;
      geo.applyMatrix4(child.matrixWorld);
      if (drape) this.displaceTerrain(geo);
      for (const attr of Object.keys(geo.attributes)) {
        if (!['position', 'normal', 'uv'].includes(attr)) geo.deleteAttribute(attr);
      }
      const raw = (Array.isArray(child.material) ? child.material[0] : child.material) as THREE.MeshStandardMaterial;
      this.bucket(this.canonical(pack, raw), geo, buckets);
    });
  }

  /** Add the shared terrain lattice height to world-space geometry vertices. */
  private displaceTerrain(geometry: THREE.BufferGeometry): void {
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      position.setY(i, position.getY(i) + heightAt(position.getX(i), position.getZ(i)));
    }
    position.needsUpdate = true;
  }

  /** Split long authored polygon triangles until terrain curvature is sampled per tile. */
  private subdivideForTerrain(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
    type Vertex = { p: THREE.Vector3; n: THREE.Vector3; uv: THREE.Vector2 };
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');
    const uvs = geometry.getAttribute('uv');
    const indices = geometry.index?.array;
    const outP: number[] = [];
    const outN: number[] = [];
    const outUv: number[] = [];
    const vertex = (i: number): Vertex => ({
      p: new THREE.Vector3(positions.getX(i), positions.getY(i), positions.getZ(i)),
      n: new THREE.Vector3(normals.getX(i), normals.getY(i), normals.getZ(i)),
      uv: new THREE.Vector2(uvs.getX(i), uvs.getY(i)),
    });
    const midpoint = (a: Vertex, b: Vertex): Vertex => ({
      p: a.p.clone().add(b.p).multiplyScalar(0.5),
      n: a.n.clone().add(b.n).normalize(),
      uv: a.uv.clone().add(b.uv).multiplyScalar(0.5),
    });
    const emit = (a: Vertex, b: Vertex, c: Vertex, depth = 0): void => {
      const longest = Math.max(
        a.p.distanceToSquared(b.p),
        b.p.distanceToSquared(c.p),
        c.p.distanceToSquared(a.p)
      );
      if (longest > TILE * TILE && depth < 8) {
        const ab = midpoint(a, b);
        const bc = midpoint(b, c);
        const ca = midpoint(c, a);
        emit(a, ab, ca, depth + 1);
        emit(ab, b, bc, depth + 1);
        emit(ca, bc, c, depth + 1);
        emit(ab, bc, ca, depth + 1);
        return;
      }
      for (const v of [a, b, c]) {
        outP.push(v.p.x, v.p.y, v.p.z);
        outN.push(v.n.x, v.n.y, v.n.z);
        outUv.push(v.uv.x, v.uv.y);
      }
    };
    const triangleCount = indices ? indices.length / 3 : positions.count / 3;
    for (let i = 0; i < triangleCount; i++) {
      const a = indices ? Number(indices[i * 3]) : i * 3;
      const b = indices ? Number(indices[i * 3 + 1]) : i * 3 + 1;
      const c = indices ? Number(indices[i * 3 + 2]) : i * 3 + 2;
      emit(vertex(a), vertex(b), vertex(c));
    }
    const result = new THREE.BufferGeometry();
    result.setAttribute('position', new THREE.Float32BufferAttribute(outP, 3));
    result.setAttribute('normal', new THREE.Float32BufferAttribute(outN, 3));
    result.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2));
    // Ground planes in the same material buckets are indexed; keep the
    // representation compatible so BufferGeometryUtils can batch them.
    result.setIndex(Array.from({ length: outP.length / 3 }, (_, i) => i));
    return result;
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
