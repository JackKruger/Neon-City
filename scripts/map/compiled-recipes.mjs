import { createHash } from 'node:crypto';
import { ShapeUtils, Vector2 } from 'three';
import { stableStringify } from './compiled-format.mjs';
import {
  CHUNK_SIZE,
  CHUNK_TILES,
  COVERAGE_FLAGS,
  MAP_SIZE,
  MAX_CHUNK,
  MIN_CHUNK,
  NBCH_SECTIONS,
  TILE,
  TRANSPORT_FLAGS,
} from './contract.mjs';

export { CHUNK_SIZE, CHUNK_TILES, MAP_SIZE, MAX_CHUNK, MIN_CHUNK, TILE } from './contract.mjs';

const COVERAGE_BUILDING = COVERAGE_FLAGS.Building;
const COVERAGE_TREE = COVERAGE_FLAGS.Tree;
const COVERAGE_PARKING = COVERAGE_FLAGS.Parking;
export const COVERAGE_BUILDING_SOURCE = COVERAGE_FLAGS.BuildingSource;
const TRANSPORT_BRIDGE = TRANSPORT_FLAGS.Bridge;
const TRANSPORT_TUNNEL = TRANSPORT_FLAGS.Tunnel;

/** Resolve the authored cell represented by an encoded centimetre coordinate. */
export function navigationCellFromCentimeters(value) {
  return Math.round(value / (TILE * 100));
}
const rounded = (value) => Math.round(value * 100) / 100;

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
  { name: 'marking', color: [0.94, 0.92, 0.78], roughness: 0.72 },
  { name: 'rail', color: [0.34, 0.36, 0.39], roughness: 0.28, metalness: 0.82 },
  { name: 'concrete', color: [0.42, 0.43, 0.45], roughness: 0.94 },
  { name: 'cycleway', color: [0.34, 0.18, 0.14], roughness: 0.9 },
  { name: 'roof-tile', color: [0.44, 0.16, 0.12], roughness: 0.85 },
  { name: 'roof-metal', color: [0.18, 0.2, 0.24], roughness: 0.55, metalness: 0.45 },
  { name: 'roof-membrane', color: [0.14, 0.13, 0.18], roughness: 0.7, metalness: 0.1 },
];

// Pitched roofs get their own material so they read as a distinct surface
// instead of extending the wall colour up over the ridge.
function roofMaterialFor(style) {
  if (style === 'suburban') return 'roof-tile';
  if (style === 'industrial') return 'roof-metal';
  return 'roof-membrane';
}

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

function subdivideTerrainFace(a, b, c, emit, shouldRefine = null, depth = 0) {
  const distanceSq = (left, right) => (left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2;
  const abLength = distanceSq(a, b);
  const bcLength = distanceSq(b, c);
  const caLength = distanceSq(c, a);
  const longest = Math.max(abLength, bcLength, caLength);
  if ((longest > TILE ** 2 || shouldRefine?.(a, b, c)) && depth < 8) {
    const midpoint = (left, right) => [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2];
    if (longest === abLength) {
      const ab = midpoint(a, b);
      subdivideTerrainFace(a, ab, c, emit, shouldRefine, depth + 1);
      subdivideTerrainFace(ab, b, c, emit, shouldRefine, depth + 1);
    } else if (longest === bcLength) {
      const bc = midpoint(b, c);
      subdivideTerrainFace(a, b, bc, emit, shouldRefine, depth + 1);
      subdivideTerrainFace(a, bc, c, emit, shouldRefine, depth + 1);
    } else {
      const ca = midpoint(c, a);
      subdivideTerrainFace(a, b, ca, emit, shouldRefine, depth + 1);
      subdivideTerrainFace(ca, b, c, emit, shouldRefine, depth + 1);
    }
    return;
  }
  emit(a, b, c);
}

function addPolygonTop(bucket, points, yForPoint) {
  const shouldRefine = (a, b, c) => {
    const center = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
    const planeHeight = (yForPoint(a) + yForPoint(b) + yForPoint(c)) / 3;
    return Math.abs(yForPoint(center) - planeHeight) > 0.02;
  };
  const addFace = (a, b, c) => {
    const av = [a[0], yForPoint(a), a[1]];
    const bv = [b[0], yForPoint(b), b[1]];
    const cv = [c[0], yForPoint(c), c[1]];
    // ShapeUtils winding depends on source winding; force the visible normal upward.
    const crossY = (bv[2] - av[2]) * (cv[0] - av[0]) - (bv[0] - av[0]) * (cv[2] - av[2]);
    if (crossY >= 0) addTriangle(bucket, av, bv, cv);
    else addTriangle(bucket, av, cv, bv);
  };
  for (const face of triangulate(points)) {
    subdivideTerrainFace(points[face[0]], points[face[1]], points[face[2]], addFace, shouldRefine);
  }
}

function addRaisedPolygon(bucket, points, heightAt, elevation) {
  const positions = [];
  const indices = [];
  const emit = (a, b, c) => {
    addTriangle(bucket, a, b, c);
    const index = positions.length / 3;
    positions.push(...a, ...b, ...c);
    indices.push(index, index + 1, index + 2);
  };
  const addTopFace = (a, b, c) => {
    const source = [a, b, c].map((point) => {
      return [point[0], heightAt(point[0], point[1]) + elevation, point[1]];
    });
    const [av, bv, cv] = source;
    const crossY = (bv[2] - av[2]) * (cv[0] - av[0]) - (bv[0] - av[0]) * (cv[2] - av[2]);
    if (crossY >= 0) emit(av, bv, cv); else emit(av, cv, bv);
  };
  const shouldRefine = (a, b, c) => {
    const center = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
    const planeHeight = (heightAt(a[0], a[1]) + heightAt(b[0], b[1]) + heightAt(c[0], c[1])) / 3;
    return Math.abs(heightAt(center[0], center[1]) - planeHeight) > 0.02;
  };
  for (const face of triangulate(points)) {
    subdivideTerrainFace(points[face[0]], points[face[1]], points[face[2]], addTopFace, shouldRefine);
  }
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const bottomA = [a[0], heightAt(a[0], a[1]) + 0.025, a[1]];
    const bottomB = [b[0], heightAt(b[0], b[1]) + 0.025, b[1]];
    const topA = [a[0], heightAt(a[0], a[1]) + elevation, a[1]];
    const topB = [b[0], heightAt(b[0], b[1]) + elevation, b[1]];
    emit(bottomA, bottomB, topB);
    emit(bottomA, topB, topA);
  }
  return { positions, indices };
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

function pointInOutline(x, z, object) {
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

function bridgeProfileHeightAt(x, z, object, terrainHeightAt) {
  const alongWidth = object.width >= object.depth;
  const c = Math.cos(object.rotation ?? 0);
  const s = Math.sin(object.rotation ?? 0);
  const axisX = alongWidth ? c : s;
  const axisZ = alongWidth ? -s : c;
  const halfLength = Math.max(object.width, object.depth) / 2;
  const startY = terrainHeightAt(object.x - axisX * halfLength, object.z - axisZ * halfLength);
  const endY = terrainHeightAt(object.x + axisX * halfLength, object.z + axisZ * halfLength);
  const centerGround = terrainHeightAt(object.x, object.z);
  const sourceDeck = Number.isFinite(object.topY) ? object.topY : centerGround + 0.8;
  if ((startY + endY) / 2 < centerGround + 0.45) return Math.max(sourceDeck, centerGround + 0.45);
  const middle = (startY + endY) / 2;
  const maxDelta = halfLength * 2 * 0.05;
  const delta = Math.max(-maxDelta, Math.min(maxDelta, endY - startY));
  const deckStart = middle - delta / 2;
  const deckEnd = middle + delta / 2;
  const along = (x - object.x) * axisX + (z - object.z) * axisZ;
  const t = Math.max(0, Math.min(1, (along + halfLength) / (halfLength * 2)));
  return deckStart + (deckEnd - deckStart) * t;
}

function profiledSlabTriangles(points, topAt, thickness) {
  const positions = [];
  const indices = [];
  const emit = (a, b, c, upward) => {
    const crossY = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    const values = (crossY >= 0) === upward ? [a, b, c] : [a, c, b];
    const start = positions.length / 3;
    positions.push(...values[0], ...values[1], ...values[2]);
    indices.push(start, start + 1, start + 2);
  };
  const top = ([x, z]) => [x, topAt(x, z), z];
  const bottom = (point) => {
    const value = top(point);
    value[1] -= thickness;
    return value;
  };
  const face = (a, b, c) => {
    emit(top(a), top(b), top(c), true);
    emit(bottom(a), bottom(b), bottom(c), false);
  };
  for (const triangle of triangulate(points)) {
    subdivideTerrainFace(points[triangle[0]], points[triangle[1]], points[triangle[2]], face);
  }
  for (let index = 0; index < points.length; index++) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const parts = Math.max(1, Math.ceil(Math.hypot(end[0] - start[0], end[1] - start[1]) / 8));
    for (let part = 0; part < parts; part++) {
      const at = (t) => [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t];
      const a = at(part / parts);
      const b = at((part + 1) / parts);
      const topA = top(a); const topB = top(b);
      const bottomA = bottom(a); const bottomB = bottom(b);
      emit(bottomA, bottomB, topB, true);
      emit(bottomA, topB, topA, true);
    }
  }
  return { positions, indices };
}

function addProfiledSlab(bucket, points, topAt, thickness) {
  const triangles = profiledSlabTriangles(points, topAt, thickness);
  for (let index = 0; index < triangles.positions.length; index += 9) {
    addTriangle(
      bucket,
      triangles.positions.slice(index, index + 3),
      triangles.positions.slice(index + 3, index + 6),
      triangles.positions.slice(index + 6, index + 9)
    );
  }
  return triangles;
}

// Roof types that get a pitched cap; everything else stays flat-topped.
const PITCHED_ROOFS = new Set(['gable', 'hip', 'pyramid', 'shed']);

/**
 * Height of the pitched cap for a building, derived from its short footprint
 * axis so the pitch reads at a natural ~25-30 deg. Returns 0 (flat) when the
 * roof type is flat/unknown or the building is too tall for a pitch to look
 * right (towers keep flat/parapet tops). The cap is carved out of the total
 * height so the ridge sits at the building's real height and walls drop to the
 * eave, leaving collision (a full-height flat prism) untouched.
 */
function roofCapHeight(roof, width, depth, height) {
  if (!PITCHED_ROOFS.has(roof) || height > 25) return 0;
  const shortHalf = Math.min(width, depth) / 2;
  const rise = roof === 'pyramid' ? Math.min(width, depth) / 2 : shortHalf;
  return Math.max(1, Math.min(rise, 6, height * 0.6));
}

/**
 * Emit a pitched roof (gable/hip/pyramid/shed) into the render bucket, built in
 * the footprint's oriented frame from the same width/depth/rotation the walls
 * use. The ridge runs along the longer axis. Vertices use the addBox local
 * transform so the roof lines up with the walls exactly for rectangular
 * footprints (the overwhelming majority); non-rectangular footprints get a
 * close oriented-box cap. Purely visual — collision is generated separately.
 */
function addRoof(bucket, { x, z, rotation, width, depth, eaveY, ridgeY, roof }) {
  // Keep the ridge on the longer axis by swapping to a 90-deg-rotated frame.
  let hw = width / 2;
  let hd = depth / 2;
  let rot = rotation;
  if (hd > hw) {
    [hw, hd] = [hd, hw];
    rot += Math.PI / 2;
  }
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const P = (lx, ly, lz) => [x + lx * cos + lz * sin, ly, z - lx * sin + lz * cos];
  const tri = (a, b, c) => addTriangle(bucket, a, b, c);
  const quad = (a, b, c, d) => addQuad(bucket, a, b, c, d);
  // Eave corners, walking the footprint counter-clockwise when seen from above.
  const A = P(-hw, eaveY, -hd);
  const B = P(hw, eaveY, -hd);
  const C = P(hw, eaveY, hd);
  const D = P(-hw, eaveY, hd);

  if (roof === 'pyramid') {
    const apex = P(0, ridgeY, 0);
    tri(A, B, apex);
    tri(B, C, apex);
    tri(C, D, apex);
    tri(D, A, apex);
    return;
  }
  if (roof === 'shed') {
    // Mono-pitch: low eave along -depth, high edge along +depth.
    const highD = P(-hw, ridgeY, hd);
    const highC = P(hw, ridgeY, hd);
    quad(A, B, highC, highD); // sloped face
    quad(D, C, highC, highD); // raised gable wall on the high side
    tri(A, highD, D); // left triangle
    tri(B, C, highC); // right triangle
    return;
  }
  // gable / hip: ridge spans the full length for a gable, insets by the short
  // half-depth for a hip (giving sloped ends instead of vertical gables).
  const ridgeHalf = roof === 'hip' ? Math.max(0, hw - hd) : hw;
  const ridgeNeg = P(-ridgeHalf, ridgeY, 0);
  const ridgePos = P(ridgeHalf, ridgeY, 0);
  quad(A, B, ridgePos, ridgeNeg); // -depth slope
  quad(C, D, ridgeNeg, ridgePos); // +depth slope
  if (roof === 'hip' && ridgeHalf < hw) {
    tri(B, C, ridgePos); // +length hip end
    tri(D, A, ridgeNeg); // -length hip end
  } else {
    tri(B, ridgePos, C); // +length gable wall
    tri(D, ridgeNeg, A); // -length gable wall
  }
}

function bufferWriter() {
  const chunks = [];
  return {
    u8(value) { const b = Buffer.alloc(1); b.writeUInt8(value); chunks.push(b); },
    u16(value) { const b = Buffer.alloc(2); b.writeUInt16LE(value); chunks.push(b); },
    i16(value) { const b = Buffer.alloc(2); b.writeInt16LE(value); chunks.push(b); },
    i32(value) { const b = Buffer.alloc(4); b.writeInt32LE(value); chunks.push(b); },
    u32(value) { const b = Buffer.alloc(4); b.writeUInt32LE(value); chunks.push(b); },
    f32(value) { const b = Buffer.alloc(4); b.writeFloatLE(value); chunks.push(b); },
    bytes(value) { chunks.push(Buffer.from(value)); },
    finish() { return Buffer.concat(chunks); },
  };
}

function encodeColliders(cuboids, meshes, sourceIndices) {
  const writer = bufferWriter();
  writer.u16(NBCH_SECTIONS.COL1);
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
  writer.u16(NBCH_SECTIONS.NAV2); writer.u16(nodes.length); writer.u32(edges.length);
  for (const node of nodes) {
    writer.i32(Math.round(node.x * 100)); writer.i32(Math.round(node.z * 100));
    writer.u16(node.flags); writer.u16(node.speed);
  }
  for (const edge of edges) {
    writer.i32(Math.round(edge.fromX * 100)); writer.i32(Math.round(edge.fromZ * 100));
    writer.i32(Math.round(edge.toX * 100)); writer.i32(Math.round(edge.toZ * 100));
    writer.u16(edge.flags); writer.u16(0);
  }
  return writer.finish();
}

function encodeGameplay(cells, parked, sources, sourceIndices) {
  const writer = bufferWriter();
  writer.u16(NBCH_SECTIONS.GME1); writer.u16(cells.length); writer.u16(parked.length); writer.u16(sources.length);
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
  const terrainHeightAt = (x, z) => {
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
    // Match addQuad's a-c-d / a-d-b diagonal exactly. Bilinear sampling can
    // fall below either rendered terrain triangle on a twisted height cell.
    return tz >= tx
      ? a + tx * (d - c) + tz * (c - a)
      : a + tx * (b - a) + tz * (d - b);
  };
  const bridgeSurfaceHeightAt = (x, z) => {
    let result = terrainHeightAt(x, z);
    const cx = Math.round(x / TILE);
    const cz = Math.round(z / TILE);
    for (const object of objectIndex.chunks[`${Math.floor(cx / CHUNK_TILES)},${Math.floor(cz / CHUNK_TILES)}`] ?? []) {
      if (object.kind !== 'transport-structure' || object.structure !== 'bridge' || !object.roadDeck || !Number.isFinite(object.topY)) continue;
      if (pointInOutline(x, z, object)) {
        result = Math.max(result, bridgeProfileHeightAt(x, z, object, terrainHeightAt));
      }
    }
    return result;
  };
  return {
    meta, grid, heights, coverage, transport, speed, objectIndex,
    index, codeAt, coverageAt, transportAt, isRoad, cornerRaw,
    terrainHeightAt, bridgeSurfaceHeightAt, heightAt: terrainHeightAt,
  };
}

function normalizeObjects(context, kx, kz) {
  const min = -MAP_SIZE * TILE / 2;
  const max = MAP_SIZE * TILE / 2;
  return (context.objectIndex.chunks[`${kx},${kz}`] ?? [])
    .filter((object) => Number.isFinite(object.x) && Number.isFinite(object.z) && object.x >= min && object.x <= max && object.z >= min && object.z <= max)
    .map((object) => ({ ...object, sourceId: sourceId(object) }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.sourceId.localeCompare(b.sourceId) || a.x - b.x || a.z - b.z);
}

const NAV_VEHICLE = 1;
const NAV_PEDESTRIAN = 2;
const NAV_TRAM = 4;

function navigationFromPaths(objects, kx, kz) {
  const nodes = new Map();
  const edges = [];
  const starts = [];
  const ends = [];
  const owner = (x, z) => ({
    // Ownership must use the same centimetre precision written to NAV2.
    // Otherwise rounding a negative half-cell can move the encoded node into
    // a neighboring chunk after ownership has already been decided.
    kx: Math.floor(navigationCellFromCentimeters(Math.round(x * 100)) / CHUNK_TILES),
    kz: Math.floor(navigationCellFromCentimeters(Math.round(z * 100)) / CHUNK_TILES),
  });
  const flagFor = (mode) => mode === 'pedestrian' ? NAV_PEDESTRIAN : mode === 'tram' ? NAV_TRAM : NAV_VEHICLE;
  const nodeKey = (point, flags) => `${Math.round(point.x * 100)},${Math.round(point.z * 100)},${flags}`;
  const addNode = (point, flags, speed) => {
    const owned = owner(point.x, point.z);
    if (owned.kx !== kx || owned.kz !== kz) return;
    const key = nodeKey(point, flags);
    if (!nodes.has(key)) nodes.set(key, { x: rounded(point.x), z: rounded(point.z), flags, speed });
  };
  for (const object of objects) {
    if (object.kind !== 'nav-path' || !Array.isArray(object.points) || object.points.length < 2) continue;
    const flags = flagFor(object.mode) | (object.flags ?? 0);
    const source = object.points.map(([x, z]) => ({ x: object.x + x, z: object.z + z }));
    const points = [source[0]];
    for (let i = 1; i < source.length; i++) {
      const a = source[i - 1];
      const b = source[i];
      const parts = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 10));
      for (let part = 1; part <= parts; part++) {
        const t = part / parts;
        points.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      }
    }
    for (const point of points) addNode(point, flags, object.speed ?? 0);
    starts.push({ point: points[0], next: points[1], flags, sourceId: object.sourceId });
    ends.push({ point: points.at(-1), previous: points.at(-2), flags, sourceId: object.sourceId });
    for (let i = 0; i + 1 < points.length; i++) {
      const from = points[i];
      const to = points[i + 1];
      const owned = owner(from.x, from.z);
      if (owned.kx === kx && owned.kz === kz) edges.push({
        fromX: rounded(from.x), fromZ: rounded(from.z), toX: rounded(to.x), toZ: rounded(to.z), flags,
      });
    }
  }
  // OSM ways commonly end at an intersection. Join compatible directed lane
  // endpoints across the paved junction instead of leaving every source way
  // as an isolated route. The short limit avoids joining parallel streets.
  for (const end of ends) {
    const owned = owner(end.point.x, end.point.z);
    if (owned.kx !== kx || owned.kz !== kz) continue;
    const incoming = { x: end.point.x - end.previous.x, z: end.point.z - end.previous.z };
    const incomingLength = Math.hypot(incoming.x, incoming.z) || 1;
    const candidates = starts
      .filter((start) => start.flags === end.flags && start.sourceId !== end.sourceId)
      .map((start) => {
        const distance = Math.hypot(start.point.x - end.point.x, start.point.z - end.point.z);
        const outgoing = { x: start.next.x - start.point.x, z: start.next.z - start.point.z };
        const outgoingLength = Math.hypot(outgoing.x, outgoing.z) || 1;
        const dot = (incoming.x * outgoing.x + incoming.z * outgoing.z) / (incomingLength * outgoingLength);
        return { start, distance, dot };
      })
      .filter((candidate) => candidate.distance > 0.05 && candidate.distance <= 15 && candidate.dot > -0.35)
      .sort((a, b) => a.distance - b.distance || b.dot - a.dot)
      .slice(0, 3);
    for (const candidate of candidates) edges.push({
      fromX: rounded(end.point.x), fromZ: rounded(end.point.z),
      toX: rounded(candidate.start.point.x), toZ: rounded(candidate.start.point.z), flags: end.flags,
    });
  }
  return { nodes: [...nodes.values()], edges };
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
  // Retain the object-level guard for older inputs that predate the explicit
  // source-coverage bit.
  const authoredBuildingArea = objectsByKind.has('building');
  const authoredNavigation = objectsByKind.has('nav-path');

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

      if (context.isRoad(cx, cz) && !authoredNavigation) {
        const flags = 3 | ((context.transportAt(cx, cz) & TRANSPORT_BRIDGE) ? 8 : 0) | ((context.transportAt(cx, cz) & TRANSPORT_TUNNEL) ? 16 : 0);
        const speedCode = context.speed[context.index(cx, cz)] ?? 0;
        const speedKmh = [50, 30, 40, 50, 60, 70][speedCode] ?? 50;
        nodes.push({ x: cx * TILE, z: cz * TILE, flags, speed: speedKmh });
        for (const [ox, oz] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
          if (context.isRoad(cx + ox, cz + oz)) edges.push({
            fromX: cx * TILE, fromZ: cz * TILE,
            toX: (cx + ox) * TILE, toZ: (cz + oz) * TILE, flags,
          });
        }
      }

      const coverage = context.coverageAt(cx, cz);
      const mask = roadMask(cx, cz);
      if (!authoredBuildingArea && (coverage & COVERAGE_BUILDING_SOURCE) === 0 && (code === 2 || code === 3) && (coverage & COVERAGE_BUILDING) === 0 && mask !== 0) {
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
      const material = MATERIALS.some((entry) => entry.name === object.surface) ? object.surface : 'asphalt';
      const elevation = object.elevation ?? 0.025;
      const sitsOnBridge = object.structure === 'bridge' ||
        (object.structure !== 'tunnel' && material === 'pavement');
      const surfaceHeightAt = sitsOnBridge ? context.bridgeSurfaceHeightAt : context.terrainHeightAt;
      if (elevation >= 0.1 && ['pavement', 'concrete'].includes(material)) {
        const collision = addRaisedPolygon(buckets.get(material), points, surfaceHeightAt, elevation);
        collisionMeshes.push({ sourceId: object.sourceId, ...collision });
      } else {
        addPolygonTop(buckets.get(material), points, ([x, z]) => surfaceHeightAt(x, z) + elevation);
      }
    } else if (object.kind === 'transport-structure') {
      if (object.structure === 'bridge' && Array.isArray(object.outline) && object.outline.length >= 3) {
        const points = object.outline.map(([x, z]) => [object.x + x, object.z + z]);
        const terrain = context.terrainHeightAt(object.x, object.z);
        const topY = Number.isFinite(object.topY) ? object.topY : terrain + 0.1;
        const sourceBase = Number.isFinite(object.baseY) ? object.baseY : topY - 0.8;
        if (object.roadDeck) {
          const thickness = Math.max(0.45, Math.min(1.5, topY - sourceBase));
          const profile = (x, z) => bridgeProfileHeightAt(x, z, object, context.terrainHeightAt);
          const collision = addProfiledSlab(buckets.get('concrete'), points, profile, thickness);
          collisionMeshes.push({ sourceId: object.sourceId, ...collision });
        } else {
          const baseY = Math.min(sourceBase, topY - 0.25);
          addPrism(buckets.get('concrete'), points, baseY, topY - baseY);
          collisionMeshes.push({ sourceId: object.sourceId, ...prismTriangles(points, baseY, topY - baseY) });
        }
      } else if (object.structure === 'tunnel' && object.roadDeck) {
        const alongWidth = object.width >= object.depth;
        const length = Math.max(object.width, object.depth);
        const outerWidth = Math.max(5, Math.min(24, Math.min(object.width, object.depth)));
        const rotation = (object.rotation ?? 0) + (alongWidth ? 0 : Math.PI / 2);
        const floorY = context.terrainHeightAt(object.x, object.z);
        const measuredTop = Number.isFinite(object.topY) ? object.topY : floorY + 5;
        const clearance = Math.max(3.6, Math.min(6.5, measuredTop - floorY));
        const wall = 0.38;
        const innerHalf = Math.max(2.2, outerWidth / 2 - wall);
        const boxes = [{
          x: object.x, y: floorY + clearance + wall / 2, z: object.z,
          hx: length / 2, hy: wall / 2, hz: outerWidth / 2,
        }];
        for (const side of [-1, 1]) boxes.push({
          x: object.x + Math.sin(rotation) * (innerHalf + wall / 2) * side,
          y: floorY + clearance / 2,
          z: object.z + Math.cos(rotation) * (innerHalf + wall / 2) * side,
          hx: length / 2, hy: clearance / 2, hz: wall / 2,
        });
        for (const box of boxes) {
          addBox(buckets.get('concrete'), box.x, box.y, box.z, box.hx, box.hy, box.hz, rotation);
          cuboids.push({ sourceId: object.sourceId, ...box, rotation });
        }
      }
    } else if (object.kind === 'building') {
      const baseY = Number.isFinite(object.baseY) ? object.baseY : context.heightAt(object.x, object.z);
      const bucket = buckets.get(object.style ?? 'commercial');
      // Carve a pitched cap out of the top; walls drop to the eave and the roof
      // fills up to the real ridge height. Collision stays a full-height flat
      // prism/box, so gameplay volumes are unchanged.
      const roofHeight = roofCapHeight(object.roof, object.width, object.depth, object.height);
      const wallHeight = object.height - roofHeight;
      if (Array.isArray(object.outline) && object.outline.length >= 3) {
        const points = object.outline.map(([x, z]) => [object.x + x, object.z + z]);
        addPrism(bucket, points, baseY, wallHeight);
        collisionMeshes.push({ sourceId: object.sourceId, ...prismTriangles(points, baseY, object.height) });
      } else {
        addBox(bucket, object.x, baseY + wallHeight / 2, object.z, object.width / 2, wallHeight / 2, object.depth / 2, object.rotation ?? 0);
        cuboids.push({ sourceId: object.sourceId, x: object.x, y: baseY + object.height / 2, z: object.z, hx: object.width / 2, hy: object.height / 2, hz: object.depth / 2, rotation: object.rotation ?? 0 });
      }
      if (roofHeight > 0) {
        addRoof(buckets.get(roofMaterialFor(object.style)), {
          x: object.x, z: object.z, rotation: object.rotation ?? 0,
          width: object.width, depth: object.depth,
          eaveY: baseY + wallHeight, ridgeY: baseY + object.height, roof: object.roof,
        });
      }
    } else if (object.kind === 'tree') {
      const base = context.heightAt(object.x, object.z);
      addBox(buckets.get('vegetation'), object.x, base + object.height / 2, object.z, 0.24, object.height / 2, 0.24);
      addBox(buckets.get('vegetation'), object.x, base + object.height * 0.8, object.z, 1.2, object.height * 0.2, 1.2, Math.PI / 4);
      cuboids.push({ sourceId: object.sourceId, x: object.x, y: base + object.height / 2, z: object.z, hx: 0.22, hy: object.height / 2, hz: 0.22, rotation: 0 });
    } else if (object.kind === 'parking') {
      parked.push({ sourceId: object.sourceId, x: object.x, z: object.z, rotation: object.rotation ?? 0, seed: Number.parseInt(createHash('sha256').update(object.sourceId).digest('hex').slice(0, 8), 16) });
    } else if (object.kind !== 'road-surface' && object.kind !== 'nav-path') {
      const base = context.bridgeSurfaceHeightAt(object.x, object.z);
      const isArt = object.kind === 'art';
      const height = object.kind === 'fountain' ? 0.8 : object.kind === 'bollard' ? 1.05 : 0.9;
      const half = object.kind === 'fountain' ? 1.4 : object.kind === 'seat' ? 0.85 : 0.3;
      addBox(buckets.get(isArt ? 'art' : 'prop'), object.x, base + height / 2, object.z, half, height / 2, half, object.rotation ?? 0);
      if (['fountain', 'barbecue', 'art'].includes(object.kind)) cuboids.push({ sourceId: object.sourceId, x: object.x, y: base + height / 2, z: object.z, hx: half, hy: height / 2, hz: half, rotation: object.rotation ?? 0 });
    }
  }

  if (authoredNavigation) {
    const authored = navigationFromPaths(objects, kx, kz);
    nodes.push(...authored.nodes);
    edges.push(...authored.edges);
  }

  parked.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  nodes.sort((a, b) => a.z - b.z || a.x - b.x || a.flags - b.flags);
  edges.sort((a, b) => a.fromZ - b.fromZ || a.fromX - b.fromX || a.toZ - b.toZ || a.toX - b.toX || a.flags - b.flags);
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
      NAV2: encodeNavigation(nodes, edges),
      GME1: encodeGameplay(cells, parked, sourceList, sourceIndices),
    },
    counts: { nodes: nodes.length, edges: edges.length, cuboids: cuboids.length, meshes: collisionMeshes.length, parked: parked.length, sources: sourceList.length },
  };
}
