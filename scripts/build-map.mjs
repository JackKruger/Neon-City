#!/usr/bin/env node
/**
 * Build an authored city map from OpenStreetMap data.
 *
 * Queries Overpass for roads, water, coastline, parks and land use inside
 * MAP.bbox, rasterizes everything onto the game's cell grid (one cell =
 * TILE meters), and writes:
 *
 *   public/maps/<name>.bin   raw cell grid (one byte per cell, see CODES)
 *   public/maps/<name>-height.bin  Int16 LE corner heights in decimeters
 *   public/maps/<name>.json  metadata: size, spawn point, attribution
 *   public/maps/<name>.png   preview image (also usable as a minimap)
 *
 * Map data © OpenStreetMap contributors, licensed under ODbL:
 * https://www.openstreetmap.org/copyright
 *
 * Usage: node scripts/build-map.mjs [--fresh] [--roads-only] [--road-info-only] [--heights-only]
 *   --fresh         ignore cached source responses and re-download
 *   --roads-only    update polygon road objects without rebuilding other data
 *   --road-info-only update HUD road names and speed limits from cached OSM
 *   --heights-only  rebake terrain against the existing authored cell grid
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  enrichMelbourneMap,
  openDataHelp,
  openDataInputsPresent,
  rechunkObjectIndex,
} from './map/open-data.mjs';
import { CHUNK_TILES, MAP_CENTER, MAP_SIZE, TILE, toGrid, toWorld } from './map/geo.mjs';
import { CELL_CODES as CODES, MAP_CONTRACT, MAP_ID, VERSIONS } from './map/contract.mjs';
import {
  OBJECT_SHARD_CHUNKS,
  readObjectIndex,
  writeObjectIndex as writeShardedObjectIndex,
} from './map/object-index.mjs';
import { roadInfoFromOverpass, roadSurfacesFromOverpass } from './map/roads.mjs';
import {
  HEIGHT_SCALE,
  buildTerrainHeights,
  loadHgtTiles,
  writeHeightFile,
} from './map/terrain.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAP_FORMAT_VERSION = VERSIONS.authoredMap;
const OBJECT_INDEX_VERSION = VERSIONS.objectIndex;

const MAP = {
  name: MAP_ID,
  /** Grid size in cells (world spans size*TILE meters, centered on `center`). */
  size: MAP_SIZE,
  center: MAP_CENTER,
  /** Downtown ellipse forced to commercial (Hoddle Grid + Southbank). */
  cbd: { lat: -37.8155, lon: 144.9615, radiusM: 1400 },
  /** Spawn near Flinders Street Station. */
  spawn: { lat: -37.8183, lon: 144.967 },
  /**
   * Flood-fill seeds for open sea (Port Phillip Bay): the south-west region
   * of the bbox. Given as lat/lon; must be open water.
   */
  seaSeeds: [
    { lat: -37.868, lon: 144.915 },
    { lat: -37.86, lon: 144.925 },
    { lat: -37.872, lon: 144.94 },
  ],
};

// --- geometry helpers -------------------------------------------------------

const M_PER_DEG_LAT = 111320;
const mPerDegLon = M_PER_DEG_LAT * Math.cos((MAP.center.lat * Math.PI) / 180);
const HALF = (MAP.size * TILE) / 2;

function bbox() {
  const dLat = HALF / M_PER_DEG_LAT;
  const dLon = HALF / mPerDegLon;
  // Overpass order: south, west, north, east.
  return [MAP.center.lat - dLat, MAP.center.lon - dLon, MAP.center.lat + dLat, MAP.center.lon + dLon];
}

// --- Overpass ---------------------------------------------------------------

const ENDPOINTS = [
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];
const UA = 'neon-bay-map-import/1.0 (hobby game; github.com/JackKruger/Neon-City)';

function overpassQuery() {
  const bb = bbox().join(',');
  const roads =
    '^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|pedestrian|footway|path|cycleway|steps)(_link)?$';
  const green = '^(park|garden|golf_course|nature_reserve)$';
  const greenLanduse = '^(grass|recreation_ground|forest|meadow|cemetery|village_green)$';
  const commercial = '^(commercial|retail|industrial)$';
  return `[out:json][timeout:180];
(
  way["highway"~"${roads}"](${bb});
  way["highway"="service"]["service"!~"^(driveway|parking_aisle|drive-through)$"](${bb});
  way["railway"="tram"](${bb});
  way["railway"="platform"](${bb});
  way["public_transport"="platform"](${bb});
  way["area:highway"](${bb});
  way["highway"="crossing"](${bb});
  way["natural"="coastline"](${bb});
  way["natural"="water"](${bb});
  relation["natural"="water"](${bb});
  way["waterway"~"^(riverbank|dock)$"](${bb});
  way["waterway"~"^(river|canal)$"](${bb});
  way["leisure"~"${green}"](${bb});
  relation["leisure"~"${green}"](${bb});
  way["landuse"~"${greenLanduse}"](${bb});
  way["landuse"~"${commercial}"](${bb});
  relation["landuse"~"${commercial}"](${bb});
  relation["boundary"="administrative"]["admin_level"="10"](${bb});
  relation["place"="suburb"](${bb});
);
out geom;`;
}

/** Fetch via curl (honors the environment's HTTPS proxy), with retries. */
function fetchOverpass() {
  const cacheDir = join(ROOT, '.map-cache');
  const query = overpassQuery();
  const queryHash = createHash('sha1').update(query).digest('hex').slice(0, 8);
  const cacheFile = join(cacheDir, `${MAP.name}-${queryHash}.json`);
  if (!process.argv.includes('--fresh') && existsSync(cacheFile)) {
    console.log(`using cached Overpass response: ${cacheFile}`);
    return JSON.parse(readFileSync(cacheFile, 'utf8'));
  }
  // HUD road metadata can safely be regenerated from the latest complete OSM
  // snapshot even when harmless query edits changed the cache hash.
  if (!process.argv.includes('--fresh') && process.argv.includes('--road-info-only') && existsSync(cacheDir)) {
    const fallback = readdirSync(cacheDir)
      .filter((name) => new RegExp(`^${MAP.name}-[0-9a-f]+\\.json$`).test(name))
      .sort()
      .at(-1);
    if (fallback) {
      const fallbackPath = join(cacheDir, fallback);
      console.log(`using cached Overpass snapshot: ${fallbackPath}`);
      return JSON.parse(readFileSync(fallbackPath, 'utf8'));
    }
  }
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      console.log(`querying ${endpoint} (attempt ${attempt + 1})...`);
      const out = execFileSync(
        'curl',
        ['-sS', '--fail', '--max-time', '240', '-A', UA, '-H', 'Accept: application/json',
          '--data-binary', query, endpoint],
        { maxBuffer: 1 << 30 }
      );
      const data = JSON.parse(out.toString('utf8'));
      if (!Array.isArray(data.elements)) throw new Error('malformed response');
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(data));
      console.log(`fetched ${data.elements.length} elements (cached to ${cacheFile})`);
      return data;
    } catch (e) {
      lastErr = e;
      const wait = 2 ** attempt;
      console.log(`  failed (${e.message?.split('\n')[0]}); retrying in ${wait}s`);
      execFileSync('sleep', [String(wait)]);
    }
  }
  throw lastErr;
}

// --- rasterization ----------------------------------------------------------

/** Mark cells under a polyline; inserts corner cells so the result is 4-connected. */
function markLine(mask, coords) {
  let prev = null;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = toWorld(coords[i].lat, coords[i].lon);
    const b = toWorld(coords[i + 1].lat, coords[i + 1].lon);
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(len / (TILE / 3)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const g = toGrid(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      if (!g) {
        prev = null;
        continue;
      }
      if (prev && g.gx !== prev.gx && g.gz !== prev.gz) {
        mask[prev.gx + g.gz * MAP.size] = 1; // keep 4-connectivity on diagonals
      }
      mask[g.gx + g.gz * MAP.size] = 1;
      prev = g;
    }
  }
}

/** Even-odd scanline fill of a closed ring (array of {lat,lon}). */
function fillPolygon(mask, ring, value = 1) {
  const pts = ring.map((c) => toWorld(c.lat, c.lon));
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const gz0 = Math.max(0, Math.round(minZ / TILE) + MAP.size / 2);
  const gz1 = Math.min(MAP.size - 1, Math.round(maxZ / TILE) + MAP.size / 2);
  for (let gz = gz0; gz <= gz1; gz++) {
    const z = (gz - MAP.size / 2) * TILE; // scan through cell centers
    const xs = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (a.z === b.z) continue;
      if (z < Math.min(a.z, b.z) || z >= Math.max(a.z, b.z)) continue;
      xs.push(a.x + ((z - a.z) / (b.z - a.z)) * (b.x - a.x));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const gx0 = Math.max(0, Math.round(xs[k] / TILE) + MAP.size / 2);
      const gx1 = Math.min(MAP.size - 1, Math.round(xs[k + 1] / TILE) + MAP.size / 2);
      for (let gx = gx0; gx <= gx1; gx++) mask[gx + gz * MAP.size] = value;
    }
  }
}

/** Closed rings from an element: a closed way, or stitched outer members of a relation. */
function ringsOf(el) {
  if (el.type === 'way') {
    const g = el.geometry ?? [];
    if (g.length >= 4 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon) {
      return [g];
    }
    return [];
  }
  // Relation: stitch outer ways into rings by matching endpoints.
  const pieces = (el.members ?? [])
    .filter((m) => m.type === 'way' && (m.role === 'outer' || m.role === '') && m.geometry)
    .map((m) => [...m.geometry]);
  const rings = [];
  while (pieces.length > 0) {
    const ring = pieces.shift();
    let extended = true;
    while (extended) {
      const last = ring[ring.length - 1];
      if (ring[0].lat === last.lat && ring[0].lon === last.lon) break;
      extended = false;
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i];
        const same = (a, b) => a.lat === b.lat && a.lon === b.lon;
        if (same(p[0], last)) ring.push(...p.slice(1));
        else if (same(p[p.length - 1], last)) ring.push(...p.reverse().slice(1));
        else continue;
        pieces.splice(i, 1);
        extended = true;
        break;
      }
    }
    const closed =
      ring.length >= 4 &&
      ring[0].lat === ring[ring.length - 1].lat &&
      ring[0].lon === ring[ring.length - 1].lon;
    if (closed) rings.push(ring);
  }
  return rings;
}

function floodSea(waterMask, coastMask, roadMask) {
  const flooded = new Uint8Array(MAP.size * MAP.size);
  const queue = [];
  for (const seed of MAP.seaSeeds) {
    const w = toWorld(seed.lat, seed.lon);
    const g = toGrid(w.x, w.z);
    if (g && !coastMask[g.gx + g.gz * MAP.size]) queue.push(g.gx + g.gz * MAP.size);
  }
  while (queue.length > 0) {
    const i = queue.pop();
    if (flooded[i] || coastMask[i]) continue;
    flooded[i] = 1;
    const gx = i % MAP.size;
    const gz = (i / MAP.size) | 0;
    if (gx > 0) queue.push(i - 1);
    if (gx < MAP.size - 1) queue.push(i + 1);
    if (gz > 0) queue.push(i - MAP.size);
    if (gz < MAP.size - 1) queue.push(i + MAP.size);
  }
  let count = 0;
  for (let i = 0; i < flooded.length; i++) {
    if (flooded[i]) {
      waterMask[i] = 1;
      count++;
    }
  }
  const frac = count / flooded.length;
  console.log(`sea flood: ${(frac * 100).toFixed(1)}% of map`);
  if (frac > 0.45) {
    throw new Error('sea flood covered nearly half the map — coastline leak, check seeds/barrier');
  }
  void roadMask;
}

// --- PNG preview ------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function writePng(path, w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

const PREVIEW_COLORS = {
  '.': [0x9a, 0x93, 0xa8],
  '#': [0x3a, 0x3f, 0x4a],
  C: [0xc0, 0x86, 0xd8],
  S: [0xf4, 0xe3, 0xb2],
  P: [0x7e, 0xc8, 0x50],
  '~': [0x2e, 0xc4, 0xb6],
};

function writeRoadSurfacesOnly(data) {
  const outDir = join(ROOT, 'public', 'maps');
  const path = join(outDir, `${MAP.name}.objects.json`);
  if (!existsSync(path)) throw new Error(`authored object map not found: ${path}`);
  const objects = readObjectIndex(outDir, MAP.name);
  const surfaces = roadSurfacesFromOverpass(data);
  const retained = Object.values(objects.chunks).flat()
    .filter((object) => (object.kind !== 'road-surface' || object.role === 'footpath-authoritative') && object.kind !== 'nav-path');
  const rebuilt = rechunkObjectIndex({
    version: 1,
    roadSurfaces: surfaces.length > 0,
    chunks: { legacy: [...retained, ...surfaces] },
  });
  writeObjectIndex(outDir, rebuilt.chunks, rebuilt.roadSurfaces);
  const metaPath = join(outDir, `${MAP.name}.json`);
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  installFormatManifest(meta, true);
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  console.log(`wrote ${surfaces.length} polygon road surfaces to public/maps/${MAP.name}.objects.json`);
}

function writeRoadInfo(data) {
  const outDir = join(ROOT, 'public', 'maps');
  const roadInfo = roadInfoFromOverpass(data);
  writeFileSync(join(outDir, `${MAP.name}.roads.json`), JSON.stringify(roadInfo));
  const segmentCount = Object.values(roadInfo.chunks).reduce((sum, segments) => sum + segments.length, 0);
  console.log(`wrote ${segmentCount} road segments and ${roadInfo.names.length} names to public/maps/${MAP.name}.roads.json`);
  return roadInfo;
}

function writeObjectIndex(outDir, chunks, roadSurfaces) {
  writeShardedObjectIndex(outDir, MAP.name, chunks, roadSurfaces);
}

function installFormatManifest(meta, hasObjects) {
  meta.formatVersion = MAP_FORMAT_VERSION;
  meta.heightGrid = {
    version: 1,
    file: `${MAP.name}-height.bin`,
    encoding: 'int16le',
    scale: HEIGHT_SCALE,
    width: MAP.size + 1,
    height: MAP.size + 1,
  };
  meta.chunkGrid = {
    version: 1,
    tiles: CHUNK_TILES,
    size: CHUNK_TILES * TILE,
    coordinates: MAP_CONTRACT.coordinateConvention,
    origin: 'map-center',
    ownership: 'clipped-polygons',
  };
  if (hasObjects) {
    meta.objectIndex = {
      version: OBJECT_INDEX_VERSION,
      file: `${MAP.name}.objects.json`,
      chunkTiles: CHUNK_TILES,
      ownership: 'clipped-polygons',
      shardChunks: OBJECT_SHARD_CHUNKS,
    };
    meta.objects = `${MAP.name}.objects.json`;
  }
  return meta;
}

// --- main -------------------------------------------------------------------

async function main() {
  if (process.argv.includes('--list-open-data')) {
    console.log('Place exported GeoJSON files in .map-cache/open-data using these names:\n');
    console.log(openDataHelp());
    console.log('\nUse --download-open-data to fetch supported City of Melbourne datasets.');
    return;
  }
  if (process.argv.includes('--heights-only')) {
    const outDir = join(ROOT, 'public', 'maps');
    const grid = new Uint8Array(readFileSync(join(outDir, `${MAP.name}.bin`)));
    const objectsPath = join(outDir, `${MAP.name}.objects.json`);
    const objectIndex = existsSync(objectsPath)
      ? rechunkObjectIndex(readObjectIndex(outDir, MAP.name))
      : null;
    const result = buildTerrainHeights(
      grid,
      loadHgtTiles(ROOT, process.argv.includes('--fresh')),
      { objectChunks: objectIndex?.chunks ?? null }
    );
    writeHeightFile(join(outDir, `${MAP.name}-height.bin`), result.quantized);
    if (objectIndex) writeObjectIndex(outDir, objectIndex.chunks, objectIndex.roadSurfaces);
    const metaPath = join(outDir, `${MAP.name}.json`);
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    installFormatManifest(meta, Boolean(objectIndex));
    if (!String(meta.attribution ?? '').includes('SRTM')) {
      meta.attribution = `${meta.attribution}; elevation data NASA SRTM via AWS Open Data`;
    }
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
    console.log(`terrain: ${result.min.toFixed(1)}m..${result.max.toFixed(1)}m, sea datum ${result.seaDatum.toFixed(2)}m, max road grade ${(result.maxGrade * 100).toFixed(2)}%, ${result.surfaceSpikeCount} SRTM spikes lowered (max ${result.maxSurfaceSpikeReduction.toFixed(1)}m), ${result.buildingBaseCount} building bases, max footprint terrain spread ${result.maxFootprintTerrainSpread.toFixed(2)}m`);
    console.log(`wrote public/maps/${MAP.name}-height.bin`);
    return;
  }
  const data = fetchOverpass();
  if (process.argv.includes('--road-info-only')) {
    writeRoadInfo(data);
    return;
  }
  if (process.argv.includes('--roads-only')) {
    writeRoadSurfacesOnly(data);
    writeRoadInfo(data);
    return;
  }
  if (process.argv.includes('--fetch-osm-only')) {
    console.log('OSM source cached; map assets were left unchanged.');
    return;
  }
  const N = MAP.size * MAP.size;
  const roads = new Uint8Array(N);
  const water = new Uint8Array(N);
  const coast = new Uint8Array(N);
  const parks = new Uint8Array(N);
  const comm = new Uint8Array(N);

  const suburbRelations = data.elements
    .filter((el) => {
      const tags = el.tags ?? {};
      return (
        el.type === 'relation' &&
        ((tags.boundary === 'administrative' && tags.admin_level === '10') ||
          tags.place === 'suburb') &&
        typeof tags.name === 'string' &&
        tags.name.trim().length > 0
      );
    })
    .sort((a, b) => a.tags.name.localeCompare(b.tags.name) || a.id - b.id);
  if (suburbRelations.length > 254) {
    throw new Error(`map contains ${suburbRelations.length} suburbs; the byte grid supports at most 254`);
  }
  const rawSuburbGrid = new Uint8Array(N).fill(255);
  for (let i = 0; i < suburbRelations.length; i++) {
    for (const ring of ringsOf(suburbRelations[i])) fillPolygon(rawSuburbGrid, ring, i);
  }

  let counts = { road: 0, water: 0, coast: 0, park: 0, comm: 0 };
  for (const el of data.elements) {
    const tags = el.tags ?? {};
    if (el.type === 'way' && tags.highway && !/^(footway|path|cycleway|steps)$/.test(tags.highway)) {
      markLine(roads, el.geometry ?? []);
      counts.road++;
    } else if (el.type === 'way' && tags.natural === 'coastline') {
      markLine(coast, el.geometry ?? []);
      counts.coast++;
    } else if (
      tags.natural === 'water' ||
      tags.waterway === 'riverbank' ||
      tags.waterway === 'dock'
    ) {
      const rings = ringsOf(el);
      for (const r of rings) fillPolygon(water, r);
      if (rings.length === 0 && el.type === 'way') markLine(water, el.geometry ?? []);
      counts.water++;
    } else if (el.type === 'way' && (tags.waterway === 'river' || tags.waterway === 'canal')) {
      markLine(water, el.geometry ?? []);
      counts.water++;
    } else if (tags.leisure || (tags.landuse && !/commercial|retail|industrial/.test(tags.landuse))) {
      for (const r of ringsOf(el)) fillPolygon(parks, r);
      counts.park++;
    } else if (tags.landuse) {
      for (const r of ringsOf(el)) fillPolygon(comm, r);
      counts.comm++;
    }
  }
  console.log('rasterized:', counts);

  // Coastline cells are water too (they're the waterline), and act as the
  // flood barrier so the sea fill can't leak inland.
  floodSea(water, coast, roads);
  for (let i = 0; i < N; i++) if (coast[i]) water[i] = 1;

  // Downtown override: commercial inside the CBD ellipse.
  const cbd = toWorld(MAP.cbd.lat, MAP.cbd.lon);
  const grid = new Uint8Array(N).fill(CODES.S);
  for (let gz = 0; gz < MAP.size; gz++) {
    for (let gx = 0; gx < MAP.size; gx++) {
      const i = gx + gz * MAP.size;
      const x = (gx - MAP.size / 2) * TILE;
      const z = (gz - MAP.size / 2) * TILE;
      if (parks[i]) grid[i] = CODES.P;
      if (comm[i]) grid[i] = CODES.C;
      if (Math.hypot(x - cbd.x, z - cbd.z) < MAP.cbd.radiusM && grid[i] === CODES.S) {
        grid[i] = CODES.C;
      }
      if (water[i]) grid[i] = CODES['~'];
      if (roads[i]) grid[i] = CODES['#']; // last: bridges win over water
    }
  }

  // Spawn: nearest road cell to the requested point.
  const sw = toWorld(MAP.spawn.lat, MAP.spawn.lon);
  const sg = toGrid(sw.x, sw.z);
  let spawnCell = null;
  outer: for (let r = 0; r < 50; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const gx = sg.gx + dx;
        const gz = sg.gz + dz;
        if (gx < 0 || gz < 0 || gx >= MAP.size || gz >= MAP.size) continue;
        if (grid[gx + gz * MAP.size] === CODES['#']) {
          spawnCell = { gx, gz };
          break outer;
        }
      }
    }
  }
  if (!spawnCell) throw new Error('no road cell near spawn point');
  const spawn = {
    x: (spawnCell.gx - MAP.size / 2) * TILE,
    z: (spawnCell.gz - MAP.size / 2) * TILE,
  };

  // Remove polygons that do not intersect the map and calculate stable label
  // anchors from the cells that remain after adjacent boundaries are painted.
  const suburbCounts = new Uint32Array(suburbRelations.length);
  for (const value of rawSuburbGrid) if (value !== 255) suburbCounts[value]++;
  const oldToNew = new Uint8Array(suburbRelations.length).fill(255);
  const keptRelations = [];
  for (let oldIndex = 0; oldIndex < suburbRelations.length; oldIndex++) {
    if (suburbCounts[oldIndex] === 0) continue;
    oldToNew[oldIndex] = keptRelations.length;
    keptRelations.push(suburbRelations[oldIndex]);
  }
  let suburbGrid = new Uint8Array(N).fill(255);
  const sumsX = new Float64Array(keptRelations.length);
  const sumsZ = new Float64Array(keptRelations.length);
  const keptCounts = new Uint32Array(keptRelations.length);
  for (let i = 0; i < N; i++) {
    const oldIndex = rawSuburbGrid[i];
    if (oldIndex === 255) continue;
    const newIndex = oldToNew[oldIndex];
    suburbGrid[i] = newIndex;
    const gx = i % MAP.size;
    const gz = (i / MAP.size) | 0;
    sumsX[newIndex] += (gx - MAP.size / 2) * TILE;
    sumsZ[newIndex] += (gz - MAP.size / 2) * TILE;
    keptCounts[newIndex]++;
  }
  let suburbs = keptRelations.map((relation, i) => ({
    name: relation.tags.name,
    x: Math.round(sumsX[i] / keptCounts[i]),
    z: Math.round(sumsZ[i] / keptCounts[i]),
  }));

  const outDir = join(ROOT, 'public', 'maps');
  mkdirSync(outDir, { recursive: true });
  const enrich =
    process.argv.includes('--open-data') ||
    process.argv.includes('--download-open-data') ||
    openDataInputsPresent(ROOT);
  let enrichment = null;
  if (enrich) {
    enrichment = await enrichMelbourneMap({
      root: ROOT,
      grid,
      roadSurfaces: roadSurfacesFromOverpass(data),
      baseSuburbs: { grid: suburbGrid, suburbs },
      options: {
        download: process.argv.includes('--download-open-data'),
        refresh: process.argv.includes('--refresh-open-data'),
      },
    });
    suburbs = enrichment.suburbs ?? suburbs;
    suburbGrid = enrichment.suburbGrid ?? suburbGrid;
  }
  const terrain = buildTerrainHeights(
    grid,
    loadHgtTiles(ROOT, process.argv.includes('--fresh')),
    { objectChunks: enrichment?.objectChunks ?? null }
  );
  writeFileSync(join(outDir, `${MAP.name}.bin`), grid);
  writeFileSync(join(outDir, `${MAP.name}.suburbs.bin`), suburbGrid);
  writeHeightFile(join(outDir, `${MAP.name}-height.bin`), terrain.quantized);
  if (enrichment?.objectChunks) {
    writeObjectIndex(outDir, enrichment.objectChunks, enrichment.roadSurfaces);
  }
  writeRoadInfo(data);

  const meta = {
    version: enrichment ? 3 : 2,
    name: MAP.name,
    width: MAP.size,
    height: MAP.size,
    tile: TILE,
    spawn,
    center: MAP.center,
    suburbs,
    ...(enrichment ? {
      layers: ['transport', 'speed', 'landuse', 'height', 'address', 'coverage'],
      objects: `${MAP.name}.objects.json`,
      sources: `${MAP.name}.sources.json`,
    } : {}),
    attribution: enrichment
      ? 'Map data © OpenStreetMap contributors (ODbL); open data © City of Melbourne and Victorian Government (CC BY 4.0); elevation data NASA SRTM via AWS Open Data'
      : 'Map data © OpenStreetMap contributors (ODbL) — openstreetmap.org/copyright; elevation data NASA SRTM via AWS Open Data',
  };
  installFormatManifest(meta, Boolean(enrichment));
  writeFileSync(join(outDir, `${MAP.name}.json`), JSON.stringify(meta, null, 2) + '\n');

  const rgb = Buffer.alloc(N * 3);
  const byCode = Object.fromEntries(Object.entries(CODES).map(([ch, code]) => [code, PREVIEW_COLORS[ch]]));
  for (let i = 0; i < N; i++) {
    const c = byCode[grid[i]];
    rgb[i * 3] = c[0];
    rgb[i * 3 + 1] = c[1];
    rgb[i * 3 + 2] = c[2];
  }
  writePng(join(outDir, `${MAP.name}.png`), MAP.size, MAP.size, rgb);

  const tally = {};
  for (const [ch, code] of Object.entries(CODES)) {
    tally[ch] = ((100 * grid.filter((v) => v === code).length) / N).toFixed(1) + '%';
  }
  console.log('cell mix:', tally);
  const covered = keptCounts.reduce((sum, count) => sum + count, 0);
  console.log(`suburbs: ${suburbs.length}, coverage: ${((covered / N) * 100).toFixed(1)}%`);
  console.log(`spawn: world (${spawn.x}, ${spawn.z})`);
  console.log(`terrain: ${terrain.min.toFixed(1)}m..${terrain.max.toFixed(1)}m, sea datum ${terrain.seaDatum.toFixed(2)}m, max road grade ${(terrain.maxGrade * 100).toFixed(2)}%, ${terrain.surfaceSpikeCount} SRTM spikes lowered (max ${terrain.maxSurfaceSpikeReduction.toFixed(1)}m), ${terrain.buildingBaseCount} building bases, max footprint terrain spread ${terrain.maxFootprintTerrainSpread.toFixed(2)}m`);
  console.log(`wrote public/maps/${MAP.name}.{bin,suburbs.bin,json,png} and ${MAP.name}-height.bin`);
}

await main();
