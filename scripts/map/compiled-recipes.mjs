import { createHash } from 'node:crypto';
import { ShapeUtils, Vector2 } from 'three';
import { stableStringify } from './compiled-format.mjs';

export const TILE = 12;
export const CHUNK_TILES = 10;
export const CHUNK_SIZE = TILE * CHUNK_TILES;
export const MAP_SIZE = 720;
export const MIN_CHUNK = -36;
export const MAX_CHUNK = 35;

const COVERAGE_BUILDING = 1;
const COVERAGE_TREE = 2;
const COVERAGE_PARKING = 4;
const TRANSPORT_BRIDGE = 2;
const TRANSPORT_TUNNEL = 4;

export const MATERIALS = [
  { name: 'asphalt', color: [0.078, 0.091, 0.125], roughness: 0.92 },
  { name: 'pavement', color: [0.323, 0.292, 0.393], roughness: 0.9 },
  { name: 'grass', color: [0.209, 0.578, 0.078], roughness: 1 },
  { name: 'water', color: [0.027, 0.542, 0.431], roughness: 0.18, metalness: 0.08 },
  { name: 'commercial', color: [0.485, 0.235, 0.624], roughness: 0.76 },
  { name: 'skyscraper', color: [0.165, 0.263, 0.431], roughness: 0.46, metalness: 0.18 },
  { name: 'suburban', color: [0.694, 0.449, 0.265], roughness: 0.88 },
  { name: 'industrial', color: [0.251, 0.278, 0.304], roughness: 0.82, metalness: 0.12 },
  { name: 'vegetation', color: [0.08, 0.38, 0.11], roughness: 1 },
  { name: 'prop', color: [0.14, 0.18, 0.22], roughness: 0.7, metalness: 0.25 },
  { name: 'art', color: [0.807, 0.107, 0.263], roughness: 0.35, metalness: 0.2 },
];

function hashNumber(cx, cz, salt = 0) {
  let h = (cx * 374761393 + cz * 668265263 + salt * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function fallbackId(kind, cx, cz, salt = 0) {
  return `generated:${kind}:${cx}:${cz}:${salt}`;
}

function sourceId(object) {
  if (typeof object.sourceId === 'string' && object.sourceId.length > 0) return object.sourceId;
  const digest = createHash('sha256').update(stableStringify(object)).digest('hex').slice(0, 20);
  return `generated:source:${digest}`;
}

function primitiveBuckets() {
  return new Map(MATERIALS.map((material) => [material.name, { material: material.name, positions: [], normals: [], indices: [] }]));
}

function addTriangle(bucket, a, b, c) {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz) || 1;
  nx /= length;
  ny /= length;
  nz /= length;
  const index = bucket.positions.length / 3;
  bucket.positions.push(...a, ...b, ...c);
  bucket.normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  bucket.indices.push(index, index + 1, index + 2);
}

function addQuad(bucket, a, b, c, d) {
  addTriangle(bucket, a, b, c);
  addTriangle(bucket, a, c, d);
}

function addBox(bucket, x, y, z, hx, hy, hz, rotation = 0) {
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const point = (lx, ly, lz) => [x + lx * c + lz * s, y + ly, z - lx * s + lz * c];
  const p = [
    point(-hx, -hy, -hz), point(hx, -hy, -hz), point(hx, -hy, hz), point(-hx, -hy, hz),
    point(-hx, hy, -hz), point(hx, hy, -hz), point(hx, hy, hz), point(-hx, hy, hz),
  ];
  addQuad(bucket, p[4], p[7], p[6], p[5]);
  addQuad(bucket, p[0], p[1], p[2], p[3]);
  addQuad(bucket, p[0], p[4], p[5], p[1]);
  addQuad(bucket, p[1], p[5], p[6], p[2]);
  addQuad(bucket, p[2], p[6], p[7], p[3]);
  addQuad(bucket, p[3], p[7], p[4], p[0]);
}

function triangulate(points) {
  if (points.length < 3) return [];
  const vectors = points.map(([x, z]) => new Vector2(x, z));
  return ShapeUtils.triangulateShape(vectors, []);
}

function addPolygonTop(bucket, points, yForPoint) {
  for (const face of triangulate(points)) {
    const a = points[face[0]];
    const b = points[face[1]];
    const c = points[face[2]];
    const av = [a[0], yForPoint(a), a[1]];
    const bv = [b[0], yForPoint(b), b[1]];
    const cv = [c[0], yForPoint(c), c[1]];
    // ShapeUtils winding depends on source winding; force the visible normal upward.
    const crossY = (bv[2] - av[2]) * (cv[0] - av[0]) - (bv[0] - av[0]) * (cv[2] - av[2]);
    if (crossY >= 0) addTriangle(bucket, av, bv, cv);
    else addTriangle(bucket, av, cv, bv);
  }
}

function prismTriangles(points, baseY, height) {
  const positions = [];
  const indices = [];
  const emit = (a, b, c) => {
    const start = positions.length / 3;
    positions.push(...a, ...b, ...c);
    indices.push(start, start + 1, start + 2);
  };
  for (const face of triangulate(points)) {
    const a = points[face[0]];
    const b = points[face[1]];
    const c = points[face[2]];
    emit([a[0], baseY, a[1]], [c[0], baseY, c[1]], [b[0], baseY, b[1]]);
    emit([a[0], baseY + height, a[1]], [b[0], baseY + height, b[1]], [c[0], baseY + height, c[1]]);
  }
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    emit([a[0], baseY, a[1]], [b[0], baseY, b[1]], [b[0], baseY + height, b[1]]);
    emit([a[0], baseY, a[1]], [b[0], baseY + height, b[1]], [a[0], baseY + height, a[1]]);
  }
  return { positions, indices };
}

function addPrism(bucket, points, baseY, height) {
  const triangles = prismTriangles(points, baseY, height);
  for (let i = 0; i < triangles.positions.length; i += 9) {
    addTriangle(bucket, triangles.positions.slice(i, i + 3), triangles.positions.slice(i + 3, i + 6), triangles.positions.slice(i + 6, i + 9));
  }
  return triangles;
}

function bufferWriter() {
  const chunks = [];
  return {
    u8(value) { const b = Buffer.alloc(1); b.writeUInt8(value); chunks.push(b); },
    u16(value) { const b = Buffer.alloc(2); b.writeUInt16LE(value); chunks.push(b); },
    i16(value) { const b = Buffer.alloc(2); b.writeInt16LE(value); chunks.push(b); },
    u32(value) { const b = Buffer.alloc(4); b.writeUInt32LE(value); chunks.push(b); },
    f32(value) { const b = Buffer.alloc(4); b.writeFloatLE(value); chunks.push(b); },
    bytes(value) { chunks.push(Buffer.from(value)); },
    finish() { return Buffer.concat(chunks); },
  };
}

function encodeColliders(cuboids, meshes, sourceIndices) {
  const writer = bufferWriter();
  writer.u16(1);
  writer.u16(0);
  writer.u32(cuboids.length);
  writer.u32(meshes.length);
  for (const collider of cuboids) {
    writer.f32(collider.x); writer.f32(collider.y); writer.f32(collider.z);
    writer.f32(collider.hx); writer.f32(collider.hy); writer.f32(collider.hz);
    writer.f32(collider.rotation ?? 0); writer.u32(sourceIndices.get(collider.sourceId));
  }
  for (const mesh of meshes) {
    writer.u32(sourceIndices.get(mesh.sourceId));
    writer.u32(mesh.positions.length / 3);
    writer.u32(mesh.indices.length);
    for (const value of mesh.positions) writer.f32(value);
    for (const value of mesh.indices) writer.u32(value);
  }
  return writer.finish();
}

function encodeNavigation(nodes, edges) {
  const writer = bufferWriter();
  writer.u16(1); writer.u16(nodes.length); writer.u32(edges.length);
  for (const node of nodes) {
    writer.i16(node.cx); writer.i16(node.cz); writer.u16(node.flags); writer.u16(node.speed);
  }
  for (const edge of edges) {
    writer.i16(edge.fromCx); writer.i16(edge.fromCz); writer.i16(edge.toCx); writer.i16(edge.toCz);
  }
  return writer.finish();
}

function encodeGameplay(cells, parked, sources, sourceIndices) {
  const writer = bufferWriter();
  writer.u16(1); writer.u16(cells.length); writer.u16(parked.length); writer.u16(sources.length);
  writer.bytes(cells);
  for (const spawn of parked) {
    writer.f32(spawn.x); writer.f32(spawn.z); writer.f32(spawn.rotation);
    writer.u32(spawn.seed); writer.u32(sourceIndices.get(spawn.sourceId));
  }
  const encoder = new TextEncoder();
  for (const source of sources) {
    const bytes = encoder.encode(source);
    if (bytes.length > 65535) throw new Error('source ID is too long');
    writer.u16(bytes.length); writer.bytes(bytes);
  }
  return writer.finish();
}

export function createCompilerContext({ meta, grid, heights, coverage, transport, speed, objectIndex }) {
  const index = (cx, cz) => {
    const gx = cx + MAP_SIZE / 2;
    const gz = cz + MAP_SIZE / 2;
    return gx < 0 || gz < 0 || gx >= MAP_SIZE || gz >= MAP_SIZE ? -1 : gx + gz * MAP_SIZE;
  };
  const codeAt = (cx, cz) => {
    const i = index(cx, cz);
    return i < 0 ? 5 : grid[i];
  };
  const coverageAt = (cx, cz) => {
    const i = index(cx, cz);
    return i < 0 ? 0 : coverage[i];
  };
  const transportAt = (cx, cz) => {
    const i = index(cx, cz);
    return i < 0 ? 0 : transport[i];
  };
  const isRoad = (cx, cz) => {
    if (codeAt(cx, cz) !== 1) return false;
    const gradeSeparated = (transportAt(cx, cz) & (TRANSPORT_BRIDGE | TRANSPORT_TUNNEL)) !== 0;
    return (coverageAt(cx, cz) & COVERAGE_BUILDING) === 0 || gradeSeparated;
  };
  const cornerRaw = (ix, iz) => {
    const gx = ix + MAP_SIZE / 2;
    const gz = iz + MAP_SIZE / 2;
    if (gx < 0 || gz < 0 || gx > MAP_SIZE || gz > MAP_SIZE) return -16;
    return heights[gx + gz * (MAP_SIZE + 1)];
  };
  const heightAt = (x, z) => {
    const fx = x / TILE + 0.5;
    const fz = z / TILE + 0.5;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const a = cornerRaw(ix, iz) * 0.1;
    const b = cornerRaw(ix + 1, iz) * 0.1;
    const c = cornerRaw(ix, iz + 1) * 0.1;
    const d = cornerRaw(ix + 1, iz + 1) * 0.1;
    return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * tz;
  };
  return { meta, grid, heights, coverage, transport, speed, objectIndex, index, codeAt, coverageAt, transportAt, isRoad, cornerRaw, heightAt };
}

function normalizeObjects(context, kx, kz) {
  const min = -MAP_SIZE * TILE / 2;
  const max = MAP_SIZE * TILE / 2;
  return (context.objectIndex.chunks[`${kx},${kz}`] ?? [])
    .filter((object) => Number.isFinite(object.x) && Number.isFinite(object.z) && object.x >= min && object.x <= max && object.z >= min && object.z <= max)
    .map((object) => ({ ...object, sourceId: sourceId(object) }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.sourceId.localeCompare(b.sourceId) || a.x - b.x || a.z - b.z);
}

export function compileChunkRecipe(context, kx, kz) {
  if (kx < MIN_CHUNK || kx > MAX_CHUNK || kz < MIN_CHUNK || kz > MAX_CHUNK) throw new Error(`chunk ${kx},${kz} is outside Melbourne bounds`);
  const c0x = kx * CHUNK_TILES;
  const c0z = kz * CHUNK_TILES;
  const buckets = primitiveBuckets();
  const cuboids = [];
  const collisionMeshes = [];
  const parked = [];
  const nodes = [];
  const edges = [];
  const cells = new Uint8Array(CHUNK_TILES * CHUNK_TILES);
  const sources = new Set();
  const objects = normalizeObjects(context, kx, kz);
  const objectsByKind = new Map();
  for (const object of objects) {
    if (!objectsByKind.has(object.kind)) objectsByKind.set(object.kind, []);
    objectsByKind.get(object.kind).push(object);
    sources.add(object.sourceId);
  }

  // Terrain recipe: one quantized heightfield shared by render and Rapier.
  const heightBytes = Buffer.alloc((CHUNK_TILES + 1) ** 2 * 2);
  let heightOffset = 0;
  for (let ix = 0; ix <= CHUNK_TILES; ix++) {
    for (let iz = 0; iz <= CHUNK_TILES; iz++) {
      heightBytes.writeInt16LE(context.cornerRaw(c0x + ix, c0z + iz), heightOffset);
      heightOffset += 2;
    }
  }
  const materialForCode = ['pavement', 'asphalt', 'pavement', 'grass', 'grass', 'water'];
  const roadMask = (cx, cz) =>
    (context.isRoad(cx, cz - 1) ? 1 : 0) |
    (context.isRoad(cx + 1, cz) ? 2 : 0) |
    (context.isRoad(cx, cz + 1) ? 4 : 0) |
    (context.isRoad(cx - 1, cz) ? 8 : 0);

  for (let dz = 0; dz < CHUNK_TILES; dz++) {
    for (let dx = 0; dx < CHUNK_TILES; dx++) {
      const cx = c0x + dx;
      const cz = c0z + dz;
      const code = context.codeAt(cx, cz);
      cells[dx + dz * CHUNK_TILES] = code;
      const bucket = buckets.get(materialForCode[code] ?? 'pavement');
      const x0 = (cx - 0.5) * TILE;
      const x1 = (cx + 0.5) * TILE;
      const z0 = (cz - 0.5) * TILE;
      const z1 = (cz + 0.5) * TILE;
      if (code === 5) {
        addQuad(bucket, [x0, 0.015, z0], [x0, 0.015, z1], [x1, 0.015, z1], [x1, 0.015, z0]);
        for (const [ox, oz] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
          if (context.codeAt(cx + ox, cz + oz) === 5) continue;
          const id = fallbackId('shoreline', cx, cz, (ox + 1) * 3 + oz + 1);
          sources.add(id);
          cuboids.push({ sourceId: id, x: cx * TILE + ox * TILE / 2, y: 2.5, z: cz * TILE + oz * TILE / 2, hx: ox === 0 ? TILE / 2 : 0.25, hy: 2.5, hz: oz === 0 ? TILE / 2 : 0.25, rotation: 0 });
        }
      } else {
        const y00 = context.cornerRaw(cx, cz) * 0.1;
        const y10 = context.cornerRaw(cx + 1, cz) * 0.1;
        const y01 = context.cornerRaw(cx, cz + 1) * 0.1;
        const y11 = context.cornerRaw(cx + 1, cz + 1) * 0.1;
        addQuad(bucket, [x0, y00, z0], [x0, y01, z1], [x1, y11, z1], [x1, y10, z0]);
      }

      if (context.isRoad(cx, cz)) {
        const flags = 3 | ((context.transportAt(cx, cz) & TRANSPORT_BRIDGE) ? 4 : 0) | ((context.transportAt(cx, cz) & TRANSPORT_TUNNEL) ? 8 : 0);
        const speedCode = context.speed[context.index(cx, cz)] ?? 0;
        const speedKmh = [50, 30, 40, 50, 60, 70][speedCode] ?? 50;
        nodes.push({ cx, cz, flags, speed: speedKmh });
        for (const [ox, oz] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
          if (context.isRoad(cx + ox, cz + oz)) edges.push({ fromCx: cx, fromCz: cz, toCx: cx + ox, toCz: cz + oz });
        }
      }

      const coverage = context.coverageAt(cx, cz);
      const mask = roadMask(cx, cz);
      if ((code === 2 || code === 3) && (coverage & COVERAGE_BUILDING) === 0 && mask !== 0) {
        const id = fallbackId('building', cx, cz);
        const width = TILE * (code === 2 ? 0.82 : 0.64);
        const depth = width;
        const height = code === 2 ? 10 + hashNumber(cx, cz, 1) * 28 : 5 + hashNumber(cx, cz, 2) * 4;
        const base = Math.min(context.cornerRaw(cx, cz), context.cornerRaw(cx + 1, cz), context.cornerRaw(cx, cz + 1), context.cornerRaw(cx + 1, cz + 1)) * 0.1;
        const material = code === 2 ? (height > 24 ? 'skyscraper' : 'commercial') : 'suburban';
        sources.add(id);
        addBox(buckets.get(material), cx * TILE, base + height / 2, cz * TILE, width / 2, height / 2, depth / 2);
        cuboids.push({ sourceId: id, x: cx * TILE, y: base + height / 2, z: cz * TILE, hx: width / 2, hy: height / 2, hz: depth / 2, rotation: 0 });
      } else if ((code === 3 || code === 4) && (coverage & (COVERAGE_TREE | COVERAGE_BUILDING)) === 0 && hashNumber(cx, cz, 7) < 0.48) {
        const id = fallbackId('tree', cx, cz);
        const x = cx * TILE + (hashNumber(cx, cz, 8) - 0.5) * TILE * 0.55;
        const z = cz * TILE + (hashNumber(cx, cz, 9) - 0.5) * TILE * 0.55;
        const height = 4.5 + hashNumber(cx, cz, 10) * 4;
        const base = context.heightAt(x, z);
        sources.add(id);
        addBox(buckets.get('vegetation'), x, base + height / 2, z, 0.28, height / 2, 0.28);
        addBox(buckets.get('vegetation'), x, base + height * 0.78, z, 1.5, height * 0.22, 1.5, Math.PI / 4);
        cuboids.push({ sourceId: id, x, y: base + height / 2, z, hx: 0.25, hy: height / 2, hz: 0.25, rotation: 0 });
      }
      if (context.isRoad(cx, cz) && ((cx + cz) % 3 + 3) % 3 === 0 && (mask === 5 || mask === 10)) {
        const id = fallbackId('streetlight', cx, cz);
        const side = ((cx + cz) / 3) % 2 === 0 ? 1 : -1;
        const x = cx * TILE + (mask === 5 ? side * TILE * 0.46 : 0);
        const z = cz * TILE + (mask === 10 ? side * TILE * 0.46 : 0);
        const base = context.heightAt(x, z);
        sources.add(id);
        addBox(buckets.get('prop'), x, base + 3, z, 0.09, 3, 0.09);
      }
      if (context.isRoad(cx, cz) && (coverage & COVERAGE_PARKING) === 0 && (mask === 5 || mask === 10) && hashNumber(cx, cz, 40) < 0.04) {
        const id = fallbackId('parking', cx, cz);
        const side = hashNumber(cx, cz, 41) < 0.5 ? 1 : -1;
        sources.add(id);
        parked.push({ sourceId: id, x: cx * TILE + (mask === 5 ? side * TILE * 0.3 : 0), z: cz * TILE + (mask === 10 ? side * TILE * 0.3 : 0), rotation: (mask === 10 ? Math.PI / 2 : 0) + (side < 0 ? Math.PI : 0), seed: Math.floor(hashNumber(cx, cz, 42) * 0xffffffff) >>> 0 });
      }
    }
  }

  for (const object of objects) {
    if (object.kind === 'road-surface' && Array.isArray(object.outline) && object.outline.length >= 3) {
      const points = object.outline.map(([x, z]) => [object.x + x, object.z + z]);
      addPolygonTop(buckets.get(object.surface === 'pavement' ? 'pavement' : 'asphalt'), points, ([x, z]) => context.heightAt(x, z) + 0.025);
    } else if (object.kind === 'building') {
      const baseY = Number.isFinite(object.baseY) ? object.baseY : context.heightAt(object.x, object.z);
      if (Array.isArray(object.outline) && object.outline.length >= 3) {
        const points = object.outline.map(([x, z]) => [object.x + x, object.z + z]);
        const triangles = addPrism(buckets.get(object.style ?? 'commercial'), points, baseY, object.height);
        collisionMeshes.push({ sourceId: object.sourceId, ...triangles });
      } else {
        addBox(buckets.get(object.style ?? 'commercial'), object.x, baseY + object.height / 2, object.z, object.width / 2, object.height / 2, object.depth / 2, object.rotation ?? 0);
        cuboids.push({ sourceId: object.sourceId, x: object.x, y: baseY + object.height / 2, z: object.z, hx: object.width / 2, hy: object.height / 2, hz: object.depth / 2, rotation: object.rotation ?? 0 });
      }
    } else if (object.kind === 'tree') {
      const base = context.heightAt(object.x, object.z);
      addBox(buckets.get('vegetation'), object.x, base + object.height / 2, object.z, 0.24, object.height / 2, 0.24);
      addBox(buckets.get('vegetation'), object.x, base + object.height * 0.8, object.z, 1.2, object.height * 0.2, 1.2, Math.PI / 4);
      cuboids.push({ sourceId: object.sourceId, x: object.x, y: base + object.height / 2, z: object.z, hx: 0.22, hy: object.height / 2, hz: 0.22, rotation: 0 });
    } else if (object.kind === 'parking') {
      parked.push({ sourceId: object.sourceId, x: object.x, z: object.z, rotation: object.rotation ?? 0, seed: Number.parseInt(createHash('sha256').update(object.sourceId).digest('hex').slice(0, 8), 16) });
    } else if (object.kind !== 'road-surface') {
      const base = context.heightAt(object.x, object.z);
      const isArt = object.kind === 'art';
      const height = object.kind === 'fountain' ? 0.8 : object.kind === 'bollard' ? 1.05 : 0.9;
      const half = object.kind === 'fountain' ? 1.4 : object.kind === 'seat' ? 0.85 : 0.3;
      addBox(buckets.get(isArt ? 'art' : 'prop'), object.x, base + height / 2, object.z, half, height / 2, half, object.rotation ?? 0);
      if (['fountain', 'barbecue', 'art'].includes(object.kind)) cuboids.push({ sourceId: object.sourceId, x: object.x, y: base + height / 2, z: object.z, hx: half, hy: height / 2, hz: half, rotation: object.rotation ?? 0 });
    }
  }

  parked.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  nodes.sort((a, b) => a.cz - b.cz || a.cx - b.cx);
  edges.sort((a, b) => a.fromCz - b.fromCz || a.fromCx - b.fromCx || a.toCz - b.toCz || a.toCx - b.toCx);
  cuboids.sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.x - b.x || a.z - b.z);
  collisionMeshes.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  const sourceList = [...sources].sort();
  const sourceIndices = new Map(sourceList.map((source, index) => [source, index]));
  const primitives = [...buckets.values()].filter((bucket) => bucket.positions.length > 0);
  const recipe = {
    kx, kz,
    objects: objects.map((object) => ({ kind: object.kind, sourceId: object.sourceId })),
    generatedSources: sourceList.filter((source) => source.startsWith('generated:')),
    heightHash: createHash('sha256').update(heightBytes).digest('hex'),
    nodeCount: nodes.length,
    colliderCount: cuboids.length + collisionMeshes.length,
    parkedCount: parked.length,
  };
  return {
    recipe,
    primitives,
    sections: {
      HGT1: heightBytes,
      COL1: encodeColliders(cuboids, collisionMeshes, sourceIndices),
      NAV1: encodeNavigation(nodes, edges),
      GME1: encodeGameplay(cells, parked, sourceList, sourceIndices),
    },
    counts: { nodes: nodes.length, edges: edges.length, cuboids: cuboids.length, meshes: collisionMeshes.length, parked: parked.length, sources: sourceList.length },
  };
}
