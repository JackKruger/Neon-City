import { TILE } from '../core/const';

/**
 * City layout, queried one cell at a time so any region can be built, thrown
 * away, and rebuilt identically — there is no per-chunk stored state.
 *
 * Two modes share the same query API:
 *  - procedural (default): every answer is a pure function of the cell coords,
 *    giving an unbounded grid city;
 *  - authored: cells come from a fixed map grid (see scripts/build-map.mjs,
 *    loaded by MapLoad.ts); everything outside the grid is open water.
 *
 * Cell legend:
 *   '#' road   'C' commercial lot   'S' suburban lot
 *   'P' park   '.' plaza pavement   '~' water
 */
export type Cell = '#' | 'C' | 'S' | 'P' | '.' | '~';

/** Byte codes used by authored .bin map files; index = code. */
export const CODE_TO_CELL: readonly Cell[] = ['.', '#', 'C', 'S', 'P', '~'];

export const TransportFlag = {
  Road: 1,
  Bridge: 2,
  Tunnel: 4,
  Rail: 8,
  Tram: 16,
  Footpath: 32,
  Roundabout: 64,
} as const;

export const CoverageFlag = {
  Building: 1,
  Tree: 2,
  Parking: 4,
  Prop: 8,
  Address: 16,
  BuildingSource: 32,
} as const;

export type AuthoredObject =
  | { kind: 'road-surface'; sourceId?: string; role?: string; elevation?: number; x: number; z: number; surface: 'asphalt' | 'pavement' | 'marking' | 'rail' | 'concrete' | 'cycleway'; outline: [number, number][] }
  | { kind: 'nav-path'; sourceId?: string; x: number; z: number; mode: 'vehicle' | 'pedestrian' | 'tram'; speed: number; flags?: number; points: [number, number][] }
  | { kind: 'building'; sourceId?: string; x: number; z: number; rotation: number; width: number; depth: number; height: number; baseY?: number; style: 'commercial' | 'skyscraper' | 'suburban' | 'industrial'; roof?: string; outline?: [number, number][] }
  | { kind: 'tree'; x: number; z: number; height: number; variant: 'small' | 'large' }
  | { kind: 'parking'; x: number; z: number; rotation: number }
  | { kind: 'bollard' | 'bicycle-rail' | 'bin' | 'fountain' | 'seat' | 'planter' | 'barbecue' | 'art'; x: number; z: number; rotation: number };

/** [name index, speed km/h, start x, start z, end x, end z]. */
export type RoadInfoSegment = [number, number, number, number, number, number];

export interface RoadInfoIndex {
  version: 1;
  chunkTiles: number;
  tileSize: number;
  names: string[];
  chunks: Record<string, RoadInfoSegment[]>;
}

export type MapLayerName = 'transport' | 'speed' | 'landuse' | 'height' | 'address' | 'coverage';

export interface AuthoredMap {
  name: string;
  /** Grid dimensions in cells; cell (0,0) sits at the grid center. */
  width: number;
  height: number;
  grid: Uint8Array;
  /** Global (width+1) x (height+1) corner lattice, stored in scaled meters. */
  heights: Int16Array | null;
  heightScale: number;
  /** Named locality anchors and a parallel byte grid (255 = no suburb). */
  suburbs?: { name: string; x: number; z: number }[];
  suburbGrid?: Uint8Array;
  layers?: Partial<Record<MapLayerName, Uint8Array>>;
  objectChunks?: Record<string, AuthoredObject[]>;
  /** Compact OSM street-centreline index used by the driving HUD. */
  roadInfo?: RoadInfoIndex;
  /** Exact buffered OSM road polygons are available for visual rendering. */
  roadSurfaces?: boolean;
  /** Suggested player spawn (world meters, on a road cell). */
  spawn: { x: number; z: number };
  attribution: string;
}

let authored: AuthoredMap | null = null;

export function setAuthoredMap(map: AuthoredMap | null): void {
  authored = map;
}

export function getAuthoredMap(): AuthoredMap | null {
  return authored;
}

/** Roads form a grid every BLOCK cells (procedural mode only). */
export const BLOCK = 5;
export const SEA_LEVEL = 0;
export const SEABED = -1.6;

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

export function isRoad(cx: number, cz: number): boolean {
  if (authored) {
    const index = authoredIndex(cx, cz);
    if (index === null || CODE_TO_CELL[authored.grid[index]] !== '#') return false;
    const coverage = authored.layers?.coverage?.[index] ?? 0;
    const transport = authored.layers?.transport?.[index] ?? 0;
    // The base OSM raster includes pedestrian/service ways through building
    // footprints. Those are not usable by this single-level vehicle graph.
    // Keep explicitly-authored grade-separated roads when that layer exists.
    const gradeSeparated = (transport & (TransportFlag.Bridge | TransportFlag.Tunnel)) !== 0;
    return (coverage & CoverageFlag.Building) === 0 || gradeSeparated;
  }
  return mod(cx, BLOCK) === 0 || mod(cz, BLOCK) === 0;
}

export function cellAt(cx: number, cz: number): Cell {
  if (authored) {
    const gx = cx + authored.width / 2;
    const gz = cz + authored.height / 2;
    if (gx < 0 || gz < 0 || gx >= authored.width || gz >= authored.height) return '~';
    return CODE_TO_CELL[authored.grid[gx + gz * authored.width]] ?? '~';
  }
  if (isRoad(cx, cz)) return '#';
  const bx = Math.floor(cx / BLOCK);
  const bz = Math.floor(cz / BLOCK);
  // Low-frequency "downtown-ness" gives coherent multi-block districts;
  // a per-block hash then picks the lot type within the district's flavor.
  const zone = cellHash(Math.floor(bx / 3), Math.floor(bz / 3), 101);
  const r = cellHash(bx, bz, 102);
  if (zone < 0.4) return r < 0.75 ? 'C' : r < 0.9 ? '.' : 'P'; // downtown
  if (zone < 0.75) return r < 0.7 ? 'S' : r < 0.85 ? 'P' : 'C'; // suburbs
  return r < 0.5 ? 'P' : r < 0.9 ? 'S' : '.'; // green belt
}

function authoredIndex(cx: number, cz: number): number | null {
  if (!authored) return null;
  const gx = cx + authored.width / 2;
  const gz = cz + authored.height / 2;
  if (gx < 0 || gz < 0 || gx >= authored.width || gz >= authored.height) return null;
  return gx + gz * authored.width;
}

function layerAt(name: MapLayerName, cx: number, cz: number): number {
  const index = authoredIndex(cx, cz);
  return index === null ? 0 : authored?.layers?.[name]?.[index] ?? 0;
}

export function transportAt(cx: number, cz: number): number {
  return layerAt('transport', cx, cz);
}

export function speedLimitAt(cx: number, cz: number): number {
  return [50, 30, 40, 50, 60, 70][layerAt('speed', cx, cz)] ?? 50;
}

export function landUseAt(cx: number, cz: number): number {
  return layerAt('landuse', cx, cz);
}

export function buildingHeightAt(cx: number, cz: number): number {
  return layerAt('height', cx, cz);
}

export function addressDensityAt(cx: number, cz: number): number {
  return layerAt('address', cx, cz);
}

export function hasCoverage(cx: number, cz: number, flag: number): boolean {
  return (layerAt('coverage', cx, cz) & flag) !== 0;
}

export function authoredObjectsForChunk(kx: number, kz: number): readonly AuthoredObject[] {
  return authored?.objectChunks?.[`${kx},${kz}`] ?? [];
}

/** Center of a cell in world coordinates (cell centers sit on TILE multiples). */
export function cellToWorld(cx: number, cz: number): { x: number; z: number } {
  return { x: cx * TILE, z: cz * TILE };
}

export function worldToCell(x: number, z: number): { cx: number; cz: number } {
  return { cx: Math.round(x / TILE), cz: Math.round(z / TILE) };
}

/** Named suburb at a world position, or null when locality data is unavailable. */
export function suburbNameAt(x: number, z: number): string | null {
  if (!authored?.suburbs || !authored.suburbGrid) return null;
  const { cx, cz } = worldToCell(x, z);
  const gx = cx + authored.width / 2;
  const gz = cz + authored.height / 2;
  if (gx < 0 || gz < 0 || gx >= authored.width || gz >= authored.height) return null;
  const suburbIndex = authored.suburbGrid[gx + gz * authored.width];
  if (suburbIndex === 255) return null;
  return authored.suburbs[suburbIndex]?.name ?? null;
}

export interface CurrentRoadInfo {
  name: string | null;
  speedLimitKmh: number;
}

/** Nearest drivable OSM centreline, biased toward the vehicle's heading at junctions. */
export function roadInfoAt(x: number, z: number, heading?: number): CurrentRoadInfo | null {
  const info = authored?.roadInfo;
  if (!info) return null;
  const cx = Math.floor(Math.round(x / TILE) / info.chunkTiles);
  const cz = Math.floor(Math.round(z / TILE) / info.chunkTiles);
  const travelX = heading === undefined ? 0 : Math.sin(heading);
  const travelZ = heading === undefined ? 0 : Math.cos(heading);
  let best: RoadInfoSegment | null = null;
  let bestScore = Infinity;

  for (let oz = -1; oz <= 1; oz++) {
    for (let ox = -1; ox <= 1; ox++) {
      for (const segment of info.chunks[`${cx + ox},${cz + oz}`] ?? []) {
        const [, , ax, az, bx, bz] = segment;
        const dx = bx - ax;
        const dz = bz - az;
        const lengthSq = dx * dx + dz * dz;
        if (lengthSq < 0.01) continue;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSq));
        const distance = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
        if (distance > 28) continue;
        const alignment = heading === undefined
          ? 1
          : Math.abs((travelX * dx + travelZ * dz) / Math.sqrt(lengthSq));
        const score = distance + (1 - alignment) * 9;
        if (score < bestScore) {
          best = segment;
          bestScore = score;
        }
      }
    }
  }
  if (!best) return null;
  return { name: info.names[best[0]] ?? null, speedLimitKmh: best[1] };
}

/**
 * Snap a cell to the nearest road cell, or null when none is close (e.g. the
 * sample landed in the bay on an authored map).
 */
export function nearestRoadCell(cx: number, cz: number): { cx: number; cz: number } | null {
  if (!authored) {
    const sx = Math.round(cx / BLOCK) * BLOCK;
    const sz = Math.round(cz / BLOCK) * BLOCK;
    return Math.abs(sx - cx) <= Math.abs(sz - cz) ? { cx: sx, cz } : { cx, cz: sz };
  }
  // Ring search outward; authored road cells can be anywhere.
  const MAX_R = 24;
  if (isRoad(cx, cz)) return { cx, cz };
  for (let r = 1; r <= MAX_R; r++) {
    for (let d = -r; d <= r; d++) {
      if (isRoad(cx + d, cz - r)) return { cx: cx + d, cz: cz - r };
      if (isRoad(cx + d, cz + r)) return { cx: cx + d, cz: cz + r };
      if (isRoad(cx - r, cz + d)) return { cx: cx - r, cz: cz + d };
      if (isRoad(cx + r, cz + d)) return { cx: cx + r, cz: cz + d };
    }
  }
  return null;
}

/** Deterministic pseudo-random in [0,1) from cell coords and a salt. */
export function cellHash(cx: number, cz: number, salt = 0): number {
  let h = (cx * 374761393 + cz * 668265263 + salt * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Smooth deterministic value noise sampled on a coarse corner lattice. */
function valueNoise(ix: number, iz: number, period: number, salt: number): number {
  const x0 = Math.floor(ix / period);
  const z0 = Math.floor(iz / period);
  const tx = smoothstep(mod(ix, period) / period);
  const tz = smoothstep(mod(iz, period) / period);
  const a = lerp(cellHash(x0, z0, salt), cellHash(x0 + 1, z0, salt), tx);
  const b = lerp(cellHash(x0, z0 + 1, salt), cellHash(x0 + 1, z0 + 1, salt), tx);
  return lerp(a, b, tz) * 2 - 1;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Height at one global cell corner. Corner (ix,iz) is ((ix-.5)TILE,(iz-.5)TILE). */
export function cornerHeight(ix: number, iz: number): number {
  if (!authored) {
    // The periods keep the worst sampled grade around 6%, within the same
    // drivable envelope enforced by the authored-map baker.
    return 10 * valueNoise(ix, iz, 80, 200) + 3 * valueNoise(ix, iz, 20, 201);
  }
  const gx = ix + authored.width / 2;
  const gz = iz + authored.height / 2;
  if (gx < 0 || gz < 0 || gx > authored.width || gz > authored.height) return SEABED;
  if (!authored.heights) return 0;
  return authored.heights[gx + gz * (authored.width + 1)] * authored.heightScale;
}

/** Bilinear terrain height at an arbitrary world-space XZ point. */
export function heightAt(x: number, z: number): number {
  const fx = x / TILE + 0.5;
  const fz = z / TILE + 0.5;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const north = lerp(cornerHeight(ix, iz), cornerHeight(ix + 1, iz), tx);
  const south = lerp(cornerHeight(ix, iz + 1), cornerHeight(ix + 1, iz + 1), tx);
  return lerp(north, south, tz);
}

export function cellCornerHeights(cx: number, cz: number): [number, number, number, number] {
  return [
    cornerHeight(cx, cz),
    cornerHeight(cx + 1, cz),
    cornerHeight(cx, cz + 1),
    cornerHeight(cx + 1, cz + 1),
  ];
}

/** Stable building-pad height: terrain may overlap the uphill wall base slightly. */
export function padHeight(cx: number, cz: number): number {
  return Math.min(...cellCornerHeights(cx, cz));
}

/** Bitmask of road neighbors: N=1 (z-1), E=2 (x+1), S=4 (z+1), W=8 (x-1). */
export function roadMask(cx: number, cz: number): number {
  return (
    (isRoad(cx, cz - 1) ? 1 : 0) |
    (isRoad(cx + 1, cz) ? 2 : 0) |
    (isRoad(cx, cz + 1) ? 4 : 0) |
    (isRoad(cx - 1, cz) ? 8 : 0)
  );
}
