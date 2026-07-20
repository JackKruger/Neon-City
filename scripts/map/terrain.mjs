import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { MAP_CENTER, MAP_SIZE, TILE, clipPolygonToBounds } from './geo.mjs';

export const HEIGHT_SCALE = 0.1;
export const SEABED = -1.6;
export const MAX_GRADE = 0.08;
const HGT_SAMPLES = 3601;
const HGT_INTERVALS = HGT_SAMPLES - 1;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((MAP_CENTER.lat * Math.PI) / 180);

export function tileName(lat, lon) {
  const south = Math.floor(lat);
  const west = Math.floor(lon);
  return `${south < 0 ? 'S' : 'N'}${String(Math.abs(south)).padStart(2, '0')}` +
    `${west < 0 ? 'W' : 'E'}${String(Math.abs(west)).padStart(3, '0')}`;
}

/** Return every one-degree HGT tile intersected by geographic bounds. */
export function hgtTileNamesForBounds({ south, north, west, east }) {
  const names = [];
  const northTile = Math.floor(north - 1e-10);
  const eastTile = Math.floor(east - 1e-10);
  for (let lat = Math.floor(south); lat <= northTile; lat++) {
    for (let lon = Math.floor(west); lon <= eastTile; lon++) names.push(tileName(lat, lon));
  }
  return names.sort();
}

function tileCoords(name) {
  const lat = Number(name.slice(1, 3)) * (name[0] === 'S' ? -1 : 1);
  const lon = Number(name.slice(4, 7)) * (name[3] === 'W' ? -1 : 1);
  return { lat, lon };
}

/** Download/cache every Skadi tile touched by the corner lattice. */
export function loadHgtTiles(root, fresh = false) {
  const half = (MAP_SIZE * TILE) / 2;
  const bounds = {
    south: MAP_CENTER.lat - half / M_PER_DEG_LAT,
    north: MAP_CENTER.lat + half / M_PER_DEG_LAT,
    west: MAP_CENTER.lon - half / M_PER_DEG_LON,
    east: MAP_CENTER.lon + half / M_PER_DEG_LON,
  };
  const names = hgtTileNamesForBounds(bounds);
  const cacheDir = join(root, '.map-cache', 'terrain');
  mkdirSync(cacheDir, { recursive: true });
  const tiles = new Map();
  for (const name of names) {
    const band = name.slice(0, 3);
    const cacheFile = join(cacheDir, `${name}.hgt`);
    if (fresh || !existsSync(cacheFile)) {
      const url = `https://s3.amazonaws.com/elevation-tiles-prod/skadi/${band}/${name}.hgt.gz`;
      console.log(`downloading terrain ${url}...`);
      const compressed = execFileSync('curl', [
        '-sS', '--fail', '--retry', '4', '--max-time', '300', '-A',
        'neon-bay-map-import/1.0', url,
      ], { maxBuffer: 1 << 28 });
      writeFileSync(cacheFile, gunzipSync(compressed));
    } else {
      console.log(`using cached terrain: ${cacheFile}`);
    }
    const bytes = readFileSync(cacheFile);
    if (bytes.length !== HGT_SAMPLES * HGT_SAMPLES * 2) {
      throw new Error(`${name}: expected a 3601x3601 HGT tile, got ${bytes.length} bytes`);
    }
    tiles.set(name, { ...tileCoords(name), bytes });
  }
  return tiles;
}

function rawSample(tile, row, col) {
  return tile.bytes.readInt16BE((row * HGT_SAMPLES + col) * 2);
}

function validSample(tile, row, col) {
  const value = rawSample(tile, row, col);
  if (value !== -32768) return value;
  for (let radius = 1; radius <= 12; radius++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        const r = Math.max(0, Math.min(HGT_INTERVALS, row + dz));
        const c = Math.max(0, Math.min(HGT_INTERVALS, col + dx));
        const nearby = rawSample(tile, r, c);
        if (nearby !== -32768) return nearby;
      }
    }
  }
  return 0;
}

/** Bilinear SRTM sample. HGT row zero is the tile's north edge. */
export function sampleHgt(tiles, lat, lon) {
  const name = tileName(lat, lon);
  const tile = tiles.get(name);
  if (!tile) throw new Error(`missing HGT tile ${name} for ${lat},${lon}`);
  const x = Math.max(0, Math.min(HGT_INTERVALS, (lon - tile.lon) * HGT_INTERVALS));
  const z = Math.max(0, Math.min(HGT_INTERVALS, (tile.lat + 1 - lat) * HGT_INTERVALS));
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const x1 = Math.min(HGT_INTERVALS, x0 + 1);
  const z1 = Math.min(HGT_INTERVALS, z0 + 1);
  const tx = x - x0;
  const tz = z - z0;
  const north = validSample(tile, z0, x0) * (1 - tx) + validSample(tile, z0, x1) * tx;
  const south = validSample(tile, z1, x0) * (1 - tx) + validSample(tile, z1, x1) * tx;
  return north * (1 - tz) + south * tz;
}

function cell(grid, gx, gz) {
  if (gx < 0 || gz < 0 || gx >= MAP_SIZE || gz >= MAP_SIZE) return 5;
  return grid[gx + gz * MAP_SIZE];
}

function blur(values, frozen, width, passes) {
  for (let pass = 0; pass < passes; pass++) {
    const next = values.slice();
    for (let z = 0; z < width; z++) {
      for (let x = 0; x < width; x++) {
        const i = x + z * width;
        if (frozen?.[i]) continue;
        let sum = 0;
        let count = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const sx = x + dx;
            const sz = z + dz;
            if (sx < 0 || sz < 0 || sx >= width || sz >= width) continue;
            sum += values[sx + sz * width];
            count++;
          }
        }
        next[i] = sum / count;
      }
    }
    values.set(next);
  }
}

/**
 * Remove narrow positive SRTM surface features such as towers and tree canopy.
 * A greyscale morphological opening retains broad hills while estimating the
 * local ground envelope below features narrower than roughly 2*radius cells.
 */
export function removeUrbanSurfaceSpikes(values, width, { radius = 8, clearance = 2 } = {}) {
  if (values.length !== width * width) throw new Error('surface-spike filter size mismatch');
  const eroded = new Float64Array(values.length);
  const opened = new Float64Array(values.length);
  for (let z = 0; z < width; z++) {
    for (let x = 0; x < width; x++) {
      let minimum = Infinity;
      for (let dz = -radius; dz <= radius; dz++) {
        const sz = Math.max(0, Math.min(width - 1, z + dz));
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = Math.max(0, Math.min(width - 1, x + dx));
          minimum = Math.min(minimum, values[sx + sz * width]);
        }
      }
      eroded[x + z * width] = minimum;
    }
  }
  for (let z = 0; z < width; z++) {
    for (let x = 0; x < width; x++) {
      let maximum = -Infinity;
      for (let dz = -radius; dz <= radius; dz++) {
        const sz = Math.max(0, Math.min(width - 1, z + dz));
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = Math.max(0, Math.min(width - 1, x + dx));
          maximum = Math.max(maximum, eroded[sx + sz * width]);
        }
      }
      opened[x + z * width] = maximum;
    }
  }
  let count = 0;
  let maxReduction = 0;
  for (let i = 0; i < values.length; i++) {
    const cap = opened[i] + clearance;
    if (values[i] <= cap) continue;
    maxReduction = Math.max(maxReduction, values[i] - cap);
    values[i] = cap;
    count++;
  }
  return { count, maxReduction };
}

function constrainPair(heights, frozen, a, b, limit) {
  const delta = heights[b] - heights[a];
  if (Math.abs(delta) <= limit) return;
  const sign = Math.sign(delta);
  if (frozen[a] && frozen[b]) return;
  if (frozen[a]) heights[b] = heights[a] + sign * limit;
  else if (frozen[b]) heights[a] = heights[b] - sign * limit;
  else {
    const mean = (heights[a] + heights[b]) / 2;
    heights[a] = mean - sign * limit / 2;
    heights[b] = mean + sign * limit / 2;
  }
}

function touchesRoad(grid, ax, az, bx, bz) {
  if (az === bz) return cell(grid, Math.min(ax, bx), az - 1) === 1 || cell(grid, Math.min(ax, bx), az) === 1;
  return cell(grid, ax - 1, Math.min(az, bz)) === 1 || cell(grid, ax, Math.min(az, bz)) === 1;
}

function roadConstraints(grid, width, axisLimit) {
  const constraints = [];
  const seen = new Set();
  const add = (a, b, maxDelta) => {
    if (a > b) [a, b] = [b, a];
    const key = a * (width * width) + b;
    if (seen.has(key)) return;
    seen.add(key);
    constraints.push([a, b, maxDelta]);
  };
  for (let z = 0; z < MAP_SIZE; z++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      if (cell(grid, x, z) !== 1) continue;
      const nw = x + z * width;
      const ne = nw + 1;
      const sw = nw + width;
      const se = sw + 1;
      add(nw, ne, axisLimit);
      add(sw, se, axisLimit);
      add(nw, sw, axisLimit);
      add(ne, se, axisLimit);
      add(nw, se, axisLimit * Math.SQRT2);
      add(ne, sw, axisLimit * Math.SQRT2);
    }
  }
  return constraints;
}

function relaxRoadGrades(heights, frozen, grid, width, limit = MAX_GRADE * TILE) {
  const constraints = roadConstraints(grid, width, limit);
  for (let pass = 0; pass < 1200; pass++) {
    for (const [a, b, maxDelta] of constraints) constrainPair(heights, frozen, a, b, maxDelta);
    if (pass % 20 === 19) {
      let violation = 0;
      for (const [a, b, maxDelta] of constraints) {
        violation = Math.max(violation, Math.abs(heights[b] - heights[a]) - maxDelta);
      }
      if (violation < 1e-4) break;
    }
  }
}

function relaxQuantizedRoadGrades(values, frozen, grid, width) {
  const axisUnits = Math.floor((MAX_GRADE * TILE) / HEIGHT_SCALE);
  const constraints = roadConstraints(grid, width, axisUnits);
  for (let pass = 0; pass < 1200; pass++) {
    let violations = 0;
    for (const [a, b, maxDelta] of constraints) {
      const limit = Math.floor(maxDelta);
      const delta = values[b] - values[a];
      const excess = Math.abs(delta) - limit;
      if (excess <= 0 || (frozen[a] && frozen[b])) continue;
      violations++;
      // Monotonically lower the high endpoint. Unlike mean projection this
      // cannot oscillate on integer cycles, and it retains every local low
      // point as an anchor while cutting steep crests down to grade.
      if (delta > 0 && !frozen[b]) values[b] = values[a] + limit;
      else if (delta < 0 && !frozen[a]) values[a] = values[b] + limit;
      else if (delta > 0) values[a] = values[b] - limit;
      else values[b] = values[a] - limit;
    }
    if (violations === 0) break;
  }
}

/** Place authored buildings on the final terrain without modifying that terrain. */
function buildingFootprint(object) {
  if (Array.isArray(object.outline) && object.outline.length >= 3) {
    return object.outline.map(([x, z]) => [object.x + x, object.z + z]);
  }
  if (!Number.isFinite(object.width) || !Number.isFinite(object.depth)) return null;
  const cos = Math.cos(object.rotation ?? 0);
  const sin = Math.sin(object.rotation ?? 0);
  const points = [];
  for (const [x, z] of [
    [-object.width / 2, -object.depth / 2],
    [object.width / 2, -object.depth / 2],
    [object.width / 2, object.depth / 2],
    [-object.width / 2, object.depth / 2],
  ]) {
    points.push([object.x + x * cos + z * sin, object.z - x * sin + z * cos]);
  }
  return points;
}

export function placeBuildingsOnTerrain(
  heights,
  frozen,
  objectChunks,
  { mapSize = MAP_SIZE, tile = TILE } = {}
) {
  const width = mapSize + 1;
  if (heights.length !== width * width) throw new Error('building-pad height size mismatch');
  const groups = new Map();
  for (const object of Object.values(objectChunks ?? {}).flat()) {
    if (object.kind !== 'building') continue;
    const polygon = buildingFootprint(object);
    if (!polygon) continue;
    const sourceId = object.structureId ?? object.sourceId ??
      `building:${object.x}:${object.z}:${object.rotation ?? 0}:${object.width ?? 0}:${object.depth ?? 0}`;
    let group = groups.get(sourceId);
    if (!group) {
      group = { sourceId, objects: [], corners: new Set() };
      groups.set(sourceId, group);
    }
    group.objects.push(object);
    const xs = polygon.map(([x]) => x);
    const zs = polygon.map(([, z]) => z);
    const minCx = Math.max(-mapSize / 2, Math.floor(Math.min(...xs) / tile + 0.5));
    const maxCx = Math.min(mapSize / 2 - 1, Math.floor(Math.max(...xs) / tile + 0.5));
    const minCz = Math.max(-mapSize / 2, Math.floor(Math.min(...zs) / tile + 0.5));
    const maxCz = Math.min(mapSize / 2 - 1, Math.floor(Math.max(...zs) / tile + 0.5));
    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const clipped = clipPolygonToBounds(polygon, {
          minX: (cx - 0.5) * tile,
          maxX: (cx + 0.5) * tile,
          minZ: (cz - 0.5) * tile,
          maxZ: (cz + 0.5) * tile,
        });
        if (clipped.length < 3) continue;
        const gx = cx + mapSize / 2;
        const gz = cz + mapSize / 2;
        group.corners.add(gx + gz * width);
        group.corners.add(gx + 1 + gz * width);
        group.corners.add(gx + (gz + 1) * width);
        group.corners.add(gx + 1 + (gz + 1) * width);
      }
    }
  }

  for (const group of groups.values()) {
    const movable = [...group.corners].filter((index) => !frozen?.[index]);
    if (movable.length === 0) continue;
    const base = Math.min(...movable.map((index) => heights[index]));
    group.corners = new Set(movable);
    for (const object of group.objects) {
      object.baseY = Math.round((base + (object.baseOffset ?? 0)) * 10) / 10;
    }
  }
  return [...groups.values()];
}

export function maxRoadGrade(heights, grid) {
  const width = MAP_SIZE + 1;
  let max = 0;
  for (let z = 0; z < width; z++) {
    for (let x = 0; x < width; x++) {
      const i = x + z * width;
      if (x + 1 < width && touchesRoad(grid, x, z, x + 1, z)) max = Math.max(max, Math.abs(heights[i + 1] - heights[i]) / TILE);
      if (z + 1 < width && touchesRoad(grid, x, z, x, z + 1)) max = Math.max(max, Math.abs(heights[i + width] - heights[i]) / TILE);
    }
  }
  return max;
}

/** Convert source AHD structure levels into the game's sea-relative Y axis. */
export function normalizeInfrastructureElevations(objectChunks, seaDatum) {
  const relativeAhd = (value) => Math.round(((value - seaDatum) + 1e-8) * 10) / 10;
  let count = 0;
  for (const object of Object.values(objectChunks ?? {}).flat()) {
    if (object.kind === 'terrain-cutting') {
      if (Number.isFinite(object.floorAhd)) object.floorY = relativeAhd(object.floorAhd);
      count++;
      continue;
    }
    if (object.kind === 'station-canopy') {
      if (Number.isFinite(object.floorAhd)) object.floorY = relativeAhd(object.floorAhd);
      if (Number.isFinite(object.roofAhd)) object.roofY = relativeAhd(object.roofAhd);
      count++;
      continue;
    }
    if (object.kind !== 'transport-structure') continue;
    if (Number.isFinite(object.minAhd)) object.baseY = relativeAhd(object.minAhd);
    if (Number.isFinite(object.maxAhd)) object.topY = relativeAhd(object.maxAhd);
    if (Number.isFinite(object.baseY) && Number.isFinite(object.topY) && object.topY <= object.baseY) {
      object.topY = Math.round((object.baseY + 0.4) * 10) / 10;
    }
    count++;
  }
  return count;
}

function pointInAuthoredOutline(x, z, object) {
  let inside = false;
  for (let i = 0, j = object.outline.length - 1; i < object.outline.length; j = i++) {
    const ax = object.x + object.outline[i][0];
    const az = object.z + object.outline[i][1];
    const bx = object.x + object.outline[j][0];
    const bz = object.z + object.outline[j][1];
    if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside;
  }
  return inside;
}

/** Pin the reviewed cutting core to rail grade while preserving the original
 * corner samples in the authored record. The compiler uses those backups for
 * the terrain surrounding the exact vertical cut boundary. */
export function applyTerrainCuttings(
  quantized,
  objectChunks,
  { mapSize = MAP_SIZE, tile = TILE } = {}
) {
  const copies = new Map();
  for (const object of Object.values(objectChunks ?? {}).flat()) {
    if (object.kind !== 'terrain-cutting' || !Array.isArray(object.outline) || !Number.isFinite(object.floorY)) continue;
    const key = object.sourceId ?? object.cuttingId;
    const group = copies.get(key) ?? [];
    group.push(object);
    copies.set(key, group);
  }
  let changedCorners = 0;
  for (const group of copies.values()) {
    const cutting = group[0];
    const floorRaw = Math.round(cutting.floorY / HEIGHT_SCALE);
    const absolute = cutting.outline.map(([x, z]) => [cutting.x + x, cutting.z + z]);
    const minX = Math.max(0, Math.floor(Math.min(...absolute.map(([x]) => x)) / tile + mapSize / 2));
    const maxX = Math.min(mapSize, Math.ceil(Math.max(...absolute.map(([x]) => x)) / tile + mapSize / 2 + 1));
    const minZ = Math.max(0, Math.floor(Math.min(...absolute.map(([, z]) => z)) / tile + mapSize / 2));
    const maxZ = Math.min(mapSize, Math.ceil(Math.max(...absolute.map(([, z]) => z)) / tile + mapSize / 2 + 1));
    const terrainCorners = [];
    for (let gx = minX; gx <= maxX; gx++) {
      for (let gz = minZ; gz <= maxZ; gz++) {
        const ix = gx - mapSize / 2;
        const iz = gz - mapSize / 2;
        const x = (ix - 0.5) * tile;
        const z = (iz - 0.5) * tile;
        if (!pointInAuthoredOutline(x, z, cutting)) continue;
        const index = gx + gz * (mapSize + 1);
        terrainCorners.push([ix, iz, quantized[index]]);
        if (quantized[index] !== floorRaw) changedCorners++;
        quantized[index] = floorRaw;
      }
    }
    for (const copy of group) copy.terrainCorners = terrainCorners;
  }
  return { cuttings: copies.size, changedCorners };
}

/** Build the 721x721 processed terrain lattice from SRTM and the final cell grid. */
export function buildTerrainHeights(grid, tiles, { objectChunks = null } = {}) {
  if (grid.length !== MAP_SIZE * MAP_SIZE) throw new Error('terrain build grid size mismatch');
  const width = MAP_SIZE + 1;
  const heights = new Float64Array(width * width);
  for (let iz = 0; iz < width; iz++) {
    const z = (iz - MAP_SIZE / 2 - 0.5) * TILE;
    const lat = MAP_CENTER.lat - z / M_PER_DEG_LAT;
    for (let ix = 0; ix < width; ix++) {
      const x = (ix - MAP_SIZE / 2 - 0.5) * TILE;
      const lon = MAP_CENTER.lon + x / M_PER_DEG_LON;
      heights[ix + iz * width] = sampleHgt(tiles, lat, lon);
    }
  }

  let seaSum = 0;
  let seaCount = 0;
  for (let z = 0; z < MAP_SIZE; z++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      if (cell(grid, x, z) !== 5) continue;
      seaSum += (heights[x + z * width] + heights[x + 1 + z * width] +
        heights[x + (z + 1) * width] + heights[x + 1 + (z + 1) * width]) / 4;
      seaCount++;
    }
  }
  const seaDatum = seaCount > 0 ? seaSum / seaCount : 0;
  for (let i = 0; i < heights.length; i++) heights[i] -= seaDatum;
  normalizeInfrastructureElevations(objectChunks, seaDatum);
  const spikeFilter = removeUrbanSurfaceSpikes(heights, width);
  blur(heights, null, width, 2);

  const frozen = new Uint8Array(heights.length);
  const distance = new Int16Array(heights.length).fill(-1);
  const queue = new Int32Array(heights.length);
  let head = 0;
  let tail = 0;
  for (let z = 0; z < width; z++) {
    for (let x = 0; x < width; x++) {
      const i = x + z * width;
      const allWater = cell(grid, x - 1, z - 1) === 5 && cell(grid, x, z - 1) === 5 &&
        cell(grid, x - 1, z) === 5 && cell(grid, x, z) === 5;
      if (!allWater) continue;
      frozen[i] = 1;
      heights[i] = SEABED;
      distance[i] = 0;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    const z = Math.floor(i / width);
    for (const n of [x > 0 ? i - 1 : -1, x + 1 < width ? i + 1 : -1, z > 0 ? i - width : -1, z + 1 < width ? i + width : -1]) {
      if (n < 0 || distance[n] >= 0) continue;
      distance[n] = distance[i] + 1;
      queue[tail++] = n;
    }
  }
  for (let i = 0; i < heights.length; i++) {
    if (frozen[i]) continue;
    const d = distance[i];
    if (d > 0 && d <= 6) {
      const blend = (7 - d) / 6;
      heights[i] += (0.5 - heights[i]) * blend;
    }
    heights[i] = Math.max(0.3, heights[i]);
  }

  relaxRoadGrades(heights, frozen, grid, width);

  const quantized = new Int16Array(heights.length);
  const quantizedMeters = new Float64Array(heights.length);
  // A 0.1m payload cannot represent the exact 0.96m per-cell limit. The
  // integer pass below uses the largest representable delta below it (0.9m),
  // so quantization itself can never push a road above the 8% contract.
  for (let i = 0; i < heights.length; i++) {
    const value = Math.max(-3276.8, Math.min(3276.7, heights[i]));
    quantized[i] = Math.round(value / HEIGHT_SCALE);
  }
  relaxQuantizedRoadGrades(quantized, frozen, grid, width);
  const roadGrade = maxRoadGrade(Float64Array.from(quantized, (value) => value * HEIGHT_SCALE), grid);
  const cuttingResult = applyTerrainCuttings(quantized, objectChunks);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < heights.length; i++) {
    quantizedMeters[i] = quantized[i] * HEIGHT_SCALE;
    min = Math.min(min, quantizedMeters[i]);
    max = Math.max(max, quantizedMeters[i]);
  }
  // Buildings are consumers of the completed elevation lattice. Their flat
  // bases sit at the lowest covered sample so uphill terrain may hide a little
  // wall, but no building footprint can reshape roads, parks, or nearby lots.
  const buildingBases = placeBuildingsOnTerrain(quantizedMeters, frozen, objectChunks);
  let maxFootprintTerrainSpread = 0;
  for (const group of buildingBases) {
    const samples = [...group.corners].map((index) => quantizedMeters[index]);
    if (samples.length === 0) continue;
    const base = Math.min(...samples);
    maxFootprintTerrainSpread = Math.max(maxFootprintTerrainSpread, Math.max(...samples) - base);
    for (const object of group.objects) {
      object.baseY = Math.round((base + (object.baseOffset ?? 0)) * 10) / 10;
    }
  }
  return {
    quantized,
    heights: quantizedMeters,
    min,
    max,
    maxGrade: roadGrade,
    terrainCuttingCount: cuttingResult.cuttings,
    terrainCuttingCornerCount: cuttingResult.changedCorners,
    maxFootprintTerrainSpread,
    buildingBaseCount: buildingBases.length,
    seaDatum,
    surfaceSpikeCount: spikeFilter.count,
    maxSurfaceSpikeReduction: spikeFilter.maxReduction,
  };
}

export function writeHeightFile(path, values) {
  const bytes = Buffer.alloc(values.length * 2);
  for (let i = 0; i < values.length; i++) bytes.writeInt16LE(values[i], i * 2);
  writeFileSync(path, bytes);
}
