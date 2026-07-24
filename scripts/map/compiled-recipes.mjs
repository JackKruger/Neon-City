import { createHash } from 'node:crypto';
import { ShapeUtils, Vector2 } from 'three';
import { stableStringify } from './compiled-format.mjs';
import {
  CHUNK_SIZE,
  CHUNK_TILES,
  COLLISION_FLAGS,
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
const COLLISION_CUSTOM_TERRAIN = COLLISION_FLAGS.CustomTerrain;
const BRIDGE_APPROACH_LENGTH = 24;

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
  { name: 'commercial-rose', color: [0.52, 0.26, 0.39], roughness: 0.8 },
  { name: 'commercial-stone', color: [0.43, 0.38, 0.45], roughness: 0.86 },
  { name: 'skyscraper', color: [0.165, 0.263, 0.431], roughness: 0.46, metalness: 0.18 },
  { name: 'skyscraper-slate', color: [0.25, 0.31, 0.38], roughness: 0.5, metalness: 0.14 },
  { name: 'skyscraper-teal', color: [0.12, 0.32, 0.35], roughness: 0.44, metalness: 0.2 },
  { name: 'suburban', color: [0.694, 0.449, 0.265], roughness: 0.88 },
  { name: 'industrial', color: [0.251, 0.278, 0.304], roughness: 0.82, metalness: 0.12 },
  { name: 'window', color: [0.035, 0.105, 0.16], roughness: 0.24, metalness: 0.38 },
  { name: 'vegetation', color: [0.08, 0.38, 0.11], roughness: 1 },
  { name: 'prop', color: [0.14, 0.18, 0.22], roughness: 0.7, metalness: 0.25 },
  { name: 'art', color: [0.807, 0.107, 0.263], roughness: 0.35, metalness: 0.2 },
  { name: 'marking', color: [0.94, 0.92, 0.78], roughness: 0.72 },
  { name: 'rail', color: [0.34, 0.36, 0.39], roughness: 0.28, metalness: 0.82 },
  { name: 'ballast', color: [0.29, 0.28, 0.3], roughness: 0.96, metalness: 0.02 },
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

function textHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildingWallMaterialFor(object) {
  const variants = object.style === 'commercial'
    ? ['commercial', 'commercial-rose', 'commercial-stone']
    : object.style === 'skyscraper'
      ? ['skyscraper', 'skyscraper-slate', 'skyscraper-teal']
      : [object.style ?? 'commercial'];
  return variants[textHash(object.structureId ?? object.sourceId) % variants.length];
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

function addStreetlightRecipe(buckets, cuboids, sourceId, x, z, base, armRotation) {
  const c = Math.cos(armRotation);
  const s = Math.sin(armRotation);
  const offset = (distance) => ({ x: x + distance * c, z: z - distance * s });
  const arm = offset(0.48);
  const lamp = offset(0.92);
  addBox(buckets.get('rail'), x, base + 2.9, z, 0.085, 2.9, 0.085);
  addBox(buckets.get('rail'), arm.x, base + 5.65, arm.z, 0.48, 0.055, 0.055, armRotation);
  addBox(buckets.get('prop'), lamp.x, base + 5.55, lamp.z, 0.18, 0.1, 0.12, armRotation);
  cuboids.push({ sourceId, x, y: base + 2.9, z, hx: 0.1, hy: 2.9, hz: 0.1, rotation: 0 });
}

function addPointPropRecipe(buckets, cuboids, object, base) {
  const sourceId = object.sourceId;
  const rotation = object.rotation ?? 0;
  const place = (lx, lz) => ({
    x: object.x + lx * Math.cos(rotation) + lz * Math.sin(rotation),
    z: object.z - lx * Math.sin(rotation) + lz * Math.cos(rotation),
  });
  const box = (material, lx, y, lz, hx, hy, hz, extraRotation = 0) => {
    const point = place(lx, lz);
    addBox(buckets.get(material), point.x, base + y, point.z, hx, hy, hz, rotation + extraRotation);
  };
  const collider = (lx, y, lz, hx, hy, hz, extraRotation = 0) => {
    const point = place(lx, lz);
    cuboids.push({
      sourceId, x: point.x, y: base + y, z: point.z,
      hx, hy, hz, rotation: rotation + extraRotation,
    });
  };

  if (object.kind === 'bollard') {
    box('prop', 0, 0.45, 0, 0.13, 0.45, 0.13);
    box('rail', 0, 0.94, 0, 0.17, 0.06, 0.17, Math.PI / 4);
    collider(0, 0.5, 0, 0.15, 0.5, 0.15);
  } else if (object.kind === 'bicycle-rail') {
    for (const lx of [-0.62, 0.62]) {
      box('rail', lx, 0.45, 0, 0.055, 0.45, 0.055);
      collider(lx, 0.45, 0, 0.065, 0.45, 0.065);
    }
    box('rail', 0, 0.9, 0, 0.68, 0.055, 0.055);
    collider(0, 0.9, 0, 0.68, 0.065, 0.065);
  } else if (object.kind === 'bin') {
    box('prop', 0, 0.42, 0, 0.3, 0.42, 0.27);
    box('rail', 0, 0.88, 0, 0.34, 0.05, 0.3);
    box('rail', 0, 0.68, -0.285, 0.16, 0.09, 0.025);
    collider(0, 0.45, 0, 0.32, 0.45, 0.29);
  } else if (object.kind === 'fountain' && sourceId.startsWith('art:')) {
    box('concrete', 0, 0.22, 0, 1.2, 0.22, 1.2);
    box('water', 0, 0.455, 0, 0.92, 0.015, 0.92);
    box('art', 0, 0.86, 0, 0.18, 0.42, 0.18, Math.PI / 4);
    collider(0, 0.22, 0, 1.2, 0.22, 1.2);
    collider(0, 0.86, 0, 0.2, 0.42, 0.2);
  } else if (object.kind === 'fountain' && /trough/i.test(object.model ?? '')) {
    box('concrete', 0, 0.38, 0, 1.1, 0.38, 0.42);
    box('water', 0, 0.77, 0, 0.86, 0.015, 0.27);
    collider(0, 0.38, 0, 1.1, 0.38, 0.42);
  } else if (object.kind === 'fountain') {
    box('concrete', 0, 0.46, 0, 0.18, 0.46, 0.18);
    box('prop', 0, 0.93, -0.08, 0.29, 0.06, 0.24);
    box('rail', 0, 1.08, 0.08, 0.04, 0.16, 0.04);
    collider(0, 0.46, 0, 0.19, 0.46, 0.19);
    collider(0, 0.93, -0.08, 0.29, 0.06, 0.24);
  } else if (object.kind === 'seat') {
    box('prop', 0, 0.52, 0, 0.85, 0.08, 0.28);
    box('prop', 0, 0.84, 0.24, 0.85, 0.31, 0.055);
    for (const lx of [-0.58, 0.58]) box('rail', lx, 0.25, 0, 0.055, 0.25, 0.2);
    collider(0, 0.52, 0, 0.85, 0.08, 0.28);
    collider(0, 0.84, 0.24, 0.85, 0.31, 0.065);
    for (const lx of [-0.58, 0.58]) collider(lx, 0.25, 0, 0.065, 0.25, 0.2);
  } else if (object.kind === 'planter') {
    box('concrete', 0, 0.32, 0, 0.56, 0.32, 0.56);
    box('vegetation', 0, 0.69, 0, 0.47, 0.09, 0.47, Math.PI / 4);
    collider(0, 0.32, 0, 0.56, 0.32, 0.56);
  } else if (object.kind === 'barbecue') {
    box('concrete', 0, 0.38, 0, 0.24, 0.38, 0.24);
    box('prop', 0, 0.8, 0, 0.46, 0.07, 0.35);
    box('rail', 0, 0.91, 0, 0.34, 0.04, 0.26);
    collider(0, 0.38, 0, 0.24, 0.38, 0.24);
    collider(0, 0.8, 0, 0.46, 0.07, 0.35);
  } else if (object.kind === 'tree-guard') {
    for (const lx of [-0.48, 0.48]) {
      for (const lz of [-0.48, 0.48]) {
        box('rail', lx, 0.52, lz, 0.04, 0.52, 0.04);
        collider(lx, 0.52, lz, 0.05, 0.52, 0.05);
      }
    }
    for (const lz of [-0.48, 0.48]) box('rail', 0, 0.92, lz, 0.52, 0.04, 0.04);
    for (const lx of [-0.48, 0.48]) box('rail', lx, 0.92, 0, 0.52, 0.04, 0.04, Math.PI / 2);
  } else if (object.kind === 'information-pillar') {
    box('concrete', 0, 0.1, 0, 0.32, 0.1, 0.24);
    box('prop', 0, 0.92, 0, 0.26, 0.72, 0.18);
    box('rail', 0, 1.68, 0, 0.31, 0.04, 0.22);
    collider(0, 0.9, 0, 0.27, 0.8, 0.2);
  } else if (object.kind === 'art') {
    const variant = Number.parseInt(createHash('sha256').update(sourceId).digest('hex').slice(0, 8), 16) / 0xffffffff;
    box('concrete', 0, 0.16, 0, 0.5, 0.16, 0.5);
    box('art', 0, 0.86, 0, 0.18, 0.54, 0.18, variant * Math.PI / 2);
    box('art', 0.08, 1.42, 0, 0.46, 0.12, 0.16, -0.45 + variant * 0.9);
    collider(0, 0.16, 0, 0.5, 0.16, 0.5);
    collider(0, 0.88, 0, 0.25, 0.56, 0.25);
  } else {
    box('prop', 0, 0.45, 0, 0.3, 0.45, 0.3);
    collider(0, 0.45, 0, 0.3, 0.45, 0.3);
  }
}

function triangulate(points) {
  if (points.length < 3) return [];
  const vectors = points.map(([x, z]) => new Vector2(x, z));
  return ShapeUtils.triangulateShape(vectors, []);
}

function interpolatePoint(a, b, t) {
  return a.map((value, index) => value + (b[index] - value) * t);
}

function clipPolygonHalfPlane(points, a, b, keepInside, orientation) {
  const signed = (point) => orientation * ((b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]));
  const output = [];
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const previous = points[(index + points.length - 1) % points.length];
    const currentValue = signed(current);
    const previousValue = signed(previous);
    const currentInside = keepInside ? currentValue >= -1e-7 : currentValue <= 1e-7;
    const previousInside = keepInside ? previousValue >= -1e-7 : previousValue <= 1e-7;
    if (currentInside !== previousInside) {
      const denominator = previousValue - currentValue;
      const t = Math.abs(denominator) > 1e-9 ? previousValue / denominator : 0;
      output.push(interpolatePoint(previous, current, t));
    }
    if (currentInside) output.push(current);
  }
  return output;
}

/** Return the non-overlapping pieces of a polygon outside one convex cutter. */
function subtractConvexPolygon(points, cutter) {
  const orientation = polygonTwiceArea(cutter) >= 0 ? 1 : -1;
  let candidates = [points];
  const outside = [];
  for (let edge = 0; edge < cutter.length && candidates.length > 0; edge++) {
    const a = cutter[edge];
    const b = cutter[(edge + 1) % cutter.length];
    const next = [];
    for (const candidate of candidates) {
      const exterior = clipPolygonHalfPlane(candidate, a, b, false, orientation);
      if (exterior.length >= 3) outside.push(exterior);
      const interior = clipPolygonHalfPlane(candidate, a, b, true, orientation);
      if (interior.length >= 3) next.push(interior);
    }
    candidates = next;
  }
  return outside;
}

function subtractTerrainCutters(points, cutters) {
  let pieces = [points];
  for (const cutter of cutters) pieces = pieces.flatMap((piece) => subtractConvexPolygon(piece, cutter));
  return pieces;
}

function clipPolygonToChunk(points, bounds) {
  let result = points;
  const planes = [
    [[bounds.minX, bounds.minZ], [bounds.maxX, bounds.minZ]],
    [[bounds.maxX, bounds.minZ], [bounds.maxX, bounds.maxZ]],
    [[bounds.maxX, bounds.maxZ], [bounds.minX, bounds.maxZ]],
    [[bounds.minX, bounds.maxZ], [bounds.minX, bounds.minZ]],
  ];
  for (const [a, b] of planes) result = clipPolygonHalfPlane(result, a, b, true, 1);
  return result;
}

function clipLineToChunk(a, b, bounds) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, a[0] - bounds.minX], [dx, bounds.maxX - a[0]],
    [-dz, a[1] - bounds.minZ], [dz, bounds.maxZ - a[1]],
  ]) {
    if (Math.abs(p) < 1e-9) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [interpolatePoint(a, b, t0), interpolatePoint(a, b, t1)];
}

function captureTriangle(bucket, capture, a, b, c) {
  addTriangle(bucket, a, b, c);
  recordTriangle(capture, a, b, c);
}

function recordTriangle(capture, a, b, c) {
  const start = capture.positions.length / 3;
  capture.positions.push(...a, ...b, ...c);
  capture.indices.push(start, start + 1, start + 2);
}

function addPolygonTriangles(bucket, capture, points, heightAt) {
  for (const face of triangulate(points)) {
    const vertices = face.map((index) => [points[index][0], heightAt(points[index]), points[index][1]]);
    const crossY = (vertices[1][2] - vertices[0][2]) * (vertices[2][0] - vertices[0][0]) -
      (vertices[1][0] - vertices[0][0]) * (vertices[2][2] - vertices[0][2]);
    if (crossY >= 0) captureTriangle(bucket, capture, ...vertices);
    else captureTriangle(bucket, capture, vertices[0], vertices[2], vertices[1]);
  }
}

function absoluteOutline(object) {
  return object.outline.map(([x, z]) => [object.x + x, object.z + z]);
}

function absolutePath(object) {
  return object.points.map(([x, z]) => [object.x + x, object.z + z]);
}

function portalRampOutline(portal) {
  if (portal.covered || portal.points.length !== 2) return null;
  const points = absolutePath(portal);
  const direction = portal.side === 'west' ? -1 : 1;
  const shifted = points.map(([x, z]) => [x + direction * portal.approachLength, z]);
  return [...points, ...shifted.reverse()];
}

function subdivideTerrainFace(a, b, c, emit, shouldRefine = null, depth = 0, maxDepth = 8) {
  const distanceSq = (left, right) => (left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2;
  const abLength = distanceSq(a, b);
  const bcLength = distanceSq(b, c);
  const caLength = distanceSq(c, a);
  const longest = Math.max(abLength, bcLength, caLength);
  if ((longest > TILE ** 2 || shouldRefine?.(a, b, c)) && depth < maxDepth) {
    const midpoint = (left, right) => [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2];
    if (longest === abLength) {
      const ab = midpoint(a, b);
      subdivideTerrainFace(a, ab, c, emit, shouldRefine, depth + 1, maxDepth);
      subdivideTerrainFace(ab, b, c, emit, shouldRefine, depth + 1, maxDepth);
    } else if (longest === bcLength) {
      const bc = midpoint(b, c);
      subdivideTerrainFace(a, b, bc, emit, shouldRefine, depth + 1, maxDepth);
      subdivideTerrainFace(a, bc, c, emit, shouldRefine, depth + 1, maxDepth);
    } else {
      const ca = midpoint(c, a);
      subdivideTerrainFace(a, b, ca, emit, shouldRefine, depth + 1, maxDepth);
      subdivideTerrainFace(ca, b, c, emit, shouldRefine, depth + 1, maxDepth);
    }
    return;
  }
  emit(a, b, c);
}

function addPolygonTop(bucket, points, yForPoint, capture = null) {
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
    const vertices = crossY >= 0 ? [av, bv, cv] : [av, cv, bv];
    addTriangle(bucket, ...vertices);
    if (capture) {
      const index = capture.positions.length / 3;
      capture.positions.push(...vertices[0], ...vertices[1], ...vertices[2]);
      capture.indices.push(index, index + 1, index + 2);
    }
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

/** Render only the exposed perimeter of a building mass. Horizontal caps use
 * the roof material instead of reading as stray wall-coloured slabs. */
function polygonTwiceArea(points) {
  let result = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    result += a[0] * b[1] - b[0] * a[1];
  }
  return result;
}

function edgeOnBuildingSeam(a, b, seams) {
  if (!seams) return false;
  const near = (left, right) => Number.isFinite(right) && Math.abs(left - right) < 0.02;
  return (near(a[0], seams.minX) && near(b[0], seams.minX)) ||
    (near(a[0], seams.maxX) && near(b[0], seams.maxX)) ||
    (near(a[1], seams.minZ) && near(b[1], seams.minZ)) ||
    (near(a[1], seams.maxZ) && near(b[1], seams.maxZ));
}

function addBuildingWalls(bucket, windowBucket, points, baseY, topY, seams = null) {
  const clockwise = polygonTwiceArea(points) < 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (edgeOnBuildingSeam(a, b, seams)) continue;
    const bottomA = [a[0], baseY, a[1]];
    const bottomB = [b[0], baseY, b[1]];
    const topA = [a[0], topY, a[1]];
    const topB = [b[0], topY, b[1]];
    if (clockwise) addQuad(bucket, bottomA, bottomB, topB, topA);
    else addQuad(bucket, bottomB, bottomA, topA, topB);

    const edgeX = b[0] - a[0];
    const edgeZ = b[1] - a[1];
    const edgeLength = Math.hypot(edgeX, edgeZ);
    const wallHeight = topY - baseY;
    if (!windowBucket || edgeLength < 3.2 || wallHeight < 4.2) continue;
    const outwardX = (clockwise ? -edgeZ : edgeZ) / edgeLength;
    const outwardZ = (clockwise ? edgeX : -edgeX) / edgeLength;
    const inset = Math.min(0.65, edgeLength * 0.16);
    const ax = a[0] + edgeX * inset / edgeLength + outwardX * 0.045;
    const az = a[1] + edgeZ * inset / edgeLength + outwardZ * 0.045;
    const bx = b[0] - edgeX * inset / edgeLength + outwardX * 0.045;
    const bz = b[1] - edgeZ * inset / edgeLength + outwardZ * 0.045;
    const floors = Math.max(1, Math.floor((wallHeight - 1.4) / 3));
    const stride = Math.max(1, Math.ceil(floors / 14));
    for (let floor = 0; floor < floors; floor += stride) {
      const centerY = baseY + 1.85 + floor * 3;
      if (centerY + 0.48 >= topY) break;
      const lowA = [ax, centerY - 0.48, az];
      const lowB = [bx, centerY - 0.48, bz];
      const highA = [ax, centerY + 0.48, az];
      const highB = [bx, centerY + 0.48, bz];
      if (clockwise) addQuad(windowBucket, lowA, lowB, highB, highA);
      else addQuad(windowBucket, lowB, lowA, highA, highB);
    }
  }
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

function distanceToSegment(x, z, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSq)) : 0;
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
}

function distanceToObjectPath(x, z, object) {
  let result = Infinity;
  for (let index = 0; index + 1 < object.points.length; index++) {
    const a = object.points[index];
    const b = object.points[index + 1];
    result = Math.min(result, distanceToSegment(
      x, z,
      object.x + a[0], object.z + a[1],
      object.x + b[0], object.z + b[1]
    ));
  }
  return result;
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

/** Deck height inside the surveyed footprint plus a smooth, road-width
 * approach immediately beyond either end. The approach is only returned in
 * the bridge's longitudinal corridor, so crossing roads beneath stay on the
 * natural terrain. */
function bridgeSurfaceCandidateAt(x, z, object, terrainHeightAt) {
  const alongWidth = object.width >= object.depth;
  const c = Math.cos(object.rotation ?? 0);
  const s = Math.sin(object.rotation ?? 0);
  const axisX = alongWidth ? c : s;
  const axisZ = alongWidth ? -s : c;
  const crossX = -axisZ;
  const crossZ = axisX;
  const halfLength = Math.max(object.width, object.depth) / 2;
  const halfWidth = Math.min(object.width, object.depth) / 2;
  const dx = x - object.x;
  const dz = z - object.z;
  const along = dx * axisX + dz * axisZ;
  const across = Math.abs(dx * crossX + dz * crossZ);
  if (Math.abs(along) <= halfLength) {
    return pointInOutline(x, z, object)
      ? bridgeProfileHeightAt(x, z, object, terrainHeightAt)
      : null;
  }
  const distance = Math.abs(along) - halfLength;
  if (distance > BRIDGE_APPROACH_LENGTH || across > halfWidth + 1.5) return null;
  const sign = Math.sign(along) || 1;
  const endX = object.x + axisX * halfLength * sign;
  const endZ = object.z + axisZ * halfLength * sign;
  const outerX = object.x + axisX * (halfLength + BRIDGE_APPROACH_LENGTH) * sign;
  const outerZ = object.z + axisZ * (halfLength + BRIDGE_APPROACH_LENGTH) * sign;
  const deckEnd = bridgeProfileHeightAt(endX, endZ, object, terrainHeightAt);
  const outerGround = terrainHeightAt(outerX, outerZ);
  const t = 1 - distance / BRIDGE_APPROACH_LENGTH;
  const eased = t * t * (3 - 2 * t);
  return Math.max(terrainHeightAt(x, z), outerGround + (deckEnd - outerGround) * eased);
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
const ROOF_OVERHANG = 0.35;

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

/** A small mitered polygon offset gives roofs a readable eave without turning
 * concave surveyed footprints into oversized oriented boxes. */
function offsetPolygon(points, distance, seams = null) {
  const twiceArea = polygonTwiceArea(points);
  const side = twiceArea >= 0 ? 1 : -1;
  const outwardNormal = (a, b) => {
    if (edgeOnBuildingSeam(a, b, seams)) return [0, 0];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const length = Math.hypot(dx, dz) || 1;
    return [side * dz / length, -side * dx / length];
  };
  return points.map((point, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    const next = points[(index + 1) % points.length];
    const a = outwardNormal(previous, point);
    const b = outwardNormal(point, next);
    const denominator = Math.max(0.35, 1 + a[0] * b[0] + a[1] * b[1]);
    let ox = distance * (a[0] + b[0]) / denominator;
    let oz = distance * (a[1] + b[1]) / denominator;
    const length = Math.hypot(ox, oz);
    const limit = distance * 2.5;
    if (length > limit) {
      ox *= limit / length;
      oz *= limit / length;
    }
    const offset = [point[0] + ox, point[1] + oz];
    if (Number.isFinite(seams?.minX) && Math.abs(point[0] - seams.minX) < 0.02) offset[0] = seams.minX;
    if (Number.isFinite(seams?.maxX) && Math.abs(point[0] - seams.maxX) < 0.02) offset[0] = seams.maxX;
    if (Number.isFinite(seams?.minZ) && Math.abs(point[1] - seams.minZ) < 0.02) offset[1] = seams.minZ;
    if (Number.isFinite(seams?.maxZ) && Math.abs(point[1] - seams.maxZ) < 0.02) offset[1] = seams.maxZ;
    return offset;
  });
}

/** Emit a footprint-matched roof. Its height profile is evaluated in the
 * original oriented frame, so clipped pieces meet continuously at chunk seams
 * while each chunk emits only its own roof polygon. */
function addRoof(bucket, { points, x, z, rotation, width, depth, eaveY, ridgeY, roof, seams = null }) {
  const roofPoints = offsetPolygon(points, ROOF_OVERHANG, seams);
  const clockwise = polygonTwiceArea(roofPoints) < 0;
  let hw = width / 2 + ROOF_OVERHANG;
  let hd = depth / 2 + ROOF_OVERHANG;
  let rot = rotation;
  if (hd > hw) {
    [hw, hd] = [hd, hw];
    rot += Math.PI / 2;
  }
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const rise = Math.max(0, ridgeY - eaveY);
  const heightAt = ([px, pz]) => {
    if (rise <= 0 || !PITCHED_ROOFS.has(roof)) return ridgeY + 0.035;
    const dx = px - x;
    const dz = pz - z;
    const along = dx * cos - dz * sin;
    const across = dx * sin + dz * cos;
    let factor;
    if (roof === 'shed') factor = (across + hd) / (hd * 2);
    else if (roof === 'pyramid') factor = Math.min(1 - Math.abs(along) / hw, 1 - Math.abs(across) / hd);
    else if (roof === 'hip') factor = Math.min(1 - Math.abs(across) / hd, (hw - Math.abs(along)) / hd);
    else factor = 1 - Math.abs(across) / hd;
    return eaveY + rise * Math.max(0, Math.min(1, factor));
  };
  const shouldRefine = (a, b, c) => {
    const center = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
    const planeHeight = (heightAt(a) + heightAt(b) + heightAt(c)) / 3;
    return Math.abs(heightAt(center) - planeHeight) > 0.12;
  };
  const addFace = (a, b, c) => {
    const vertices = [a, b, c].map((point) => [point[0], heightAt(point), point[1]]);
    const crossY = (vertices[1][2] - vertices[0][2]) * (vertices[2][0] - vertices[0][0]) -
      (vertices[1][0] - vertices[0][0]) * (vertices[2][2] - vertices[0][2]);
    if (crossY >= 0) addTriangle(bucket, ...vertices);
    else addTriangle(bucket, vertices[0], vertices[2], vertices[1]);
  };
  const roofSubdivisionDepth = rise > 0 ? 2 : 0;
  for (const face of triangulate(roofPoints)) {
    subdivideTerrainFace(
      roofPoints[face[0]], roofPoints[face[1]], roofPoints[face[2]],
      addFace, shouldRefine, 0, roofSubdivisionDepth
    );
  }
  // Close gable ends and the thin outer eave so no sky shows between the wall
  // footprint and its slightly larger roof.
  for (let i = 0; i < roofPoints.length; i++) {
    const a = roofPoints[i];
    const b = roofPoints[(i + 1) % roofPoints.length];
    if (edgeOnBuildingSeam(a, b, seams)) continue;
    const topA = heightAt(a);
    const topB = heightAt(b);
    const bottomA = Math.min(eaveY - 0.12, topA - 0.12);
    const bottomB = Math.min(eaveY - 0.12, topB - 0.12);
    const lowA = [a[0], bottomA, a[1]];
    const lowB = [b[0], bottomB, b[1]];
    const highA = [a[0], topA, a[1]];
    const highB = [b[0], topB, b[1]];
    if (clockwise) addQuad(bucket, lowA, lowB, highB, highA);
    else addQuad(bucket, lowB, lowA, highA, highB);
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

function encodeColliders(cuboids, meshes, sourceIndices, flags = 0) {
  const writer = bufferWriter();
  writer.u16(NBCH_SECTIONS.COL1);
  writer.u16(flags);
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
  writer.u16(NBCH_SECTIONS.NAV3); writer.u16(nodes.length); writer.u32(edges.length);
  for (const node of nodes) {
    writer.i32(Math.round(node.x * 100)); writer.i32(Math.round((node.y ?? 0) * 100)); writer.i32(Math.round(node.z * 100));
    writer.u16(node.flags); writer.u16(node.speed);
  }
  for (const edge of edges) {
    writer.i32(Math.round(edge.fromX * 100)); writer.i32(Math.round(edge.fromZ * 100));
    writer.i32(Math.round(edge.toX * 100)); writer.i32(Math.round(edge.toZ * 100));
    writer.u16(edge.flags); writer.u16(0);
  }
  return writer.finish();
}

function encodeTransit(stops, sourceIndices) {
  const writer = bufferWriter();
  writer.u16(NBCH_SECTIONS.TRN1); writer.u16(stops.length);
  const encoder = new TextEncoder();
  for (const stop of stops) {
    writer.f32(stop.x); writer.f32(stop.y); writer.f32(stop.z);
    writer.u8(stop.mode === 'train' ? 2 : 1); writer.u8(0); writer.u16(0);
    writer.u32(sourceIndices.get(stop.sourceId));
    const name = encoder.encode(stop.name ?? '');
    if (name.length > 65535) throw new Error('transit stop name is too long');
    writer.u16(name.length); writer.bytes(name);
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
  const authored = Object.values(objectIndex.chunks ?? {}).flat();
  const uniqueBySource = (kind) => [...new Map(
    authored.filter((object) => object.kind === kind).map((object) => [sourceId(object), object])
  ).values()];
  const terrainCuttings = uniqueBySource('terrain-cutting');
  const terrainPortals = uniqueBySource('terrain-portal');
  const railStructures = uniqueBySource('rail-structure');
  const railPortals = uniqueBySource('rail-portal');
  const naturalCorners = new Map();
  for (const cutting of terrainCuttings) {
    for (const corner of cutting.terrainCorners ?? []) naturalCorners.set(`${corner[0]},${corner[1]}`, corner[2]);
  }
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
  const naturalCornerRaw = (ix, iz) => naturalCorners.get(`${ix},${iz}`) ?? cornerRaw(ix, iz);
  const interpolateHeight = (x, z, sampleCorner) => {
    const fx = x / TILE + 0.5;
    const fz = z / TILE + 0.5;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const a = sampleCorner(ix, iz) * 0.1;
    const b = sampleCorner(ix + 1, iz) * 0.1;
    const c = sampleCorner(ix, iz + 1) * 0.1;
    const d = sampleCorner(ix + 1, iz + 1) * 0.1;
    // Match addQuad's a-c-d / a-d-b diagonal exactly. Bilinear sampling can
    // fall below either rendered terrain triangle on a twisted height cell.
    return tz >= tx
      ? a + tx * (d - c) + tz * (c - a)
      : a + tx * (b - a) + tz * (d - b);
  };
  const naturalTerrainHeightAt = (x, z) => interpolateHeight(x, z, naturalCornerRaw);
  const cuttingAt = (x, z) => terrainCuttings.find((cutting) => pointInOutline(x, z, cutting)) ?? null;
  const cuttingProfileHeightAt = (x, z) => cuttingAt(x, z)?.floorY ?? null;
  // Terrain is only ever natural ground. Grade-separated rail lives on its own
  // rail-structure surfaces and never carves the heightfield, so terrainHeightAt
  // no longer consults a cutting profile (docs/grade-separation-plan.md phase 3).
  const terrainHeightAt = (x, z) => naturalTerrainHeightAt(x, z);
  const bridgeSurfaceHeightAt = (x, z) => {
    let result = terrainHeightAt(x, z);
    const cx = Math.round(x / TILE);
    const cz = Math.round(z / TILE);
    const kx = Math.floor(cx / CHUNK_TILES);
    const kz = Math.floor(cz / CHUNK_TILES);
    for (let oz = -1; oz <= 1; oz++) {
      for (let ox = -1; ox <= 1; ox++) {
        for (const object of objectIndex.chunks[`${kx + ox},${kz + oz}`] ?? []) {
          if (object.kind !== 'transport-structure' || object.structure !== 'bridge' || !object.roadDeck || !Number.isFinite(object.topY)) continue;
          const candidate = bridgeSurfaceCandidateAt(x, z, object, terrainHeightAt);
          if (candidate !== null) result = Math.max(result, candidate);
        }
      }
    }
    return result;
  };
  const tunnelSurfaceHeightAt = (x, z) => naturalTerrainHeightAt(x, z) - TUNNEL_SURFACE_DEPTH;
  const portalFloor = (portal) => terrainCuttings.find((cutting) => cutting.cuttingId === portal.cuttingId)?.floorY;
  // A rail structure owns its running surface directly: flat at railBedY inside
  // the footprint, ramped up toward natural ground through a portal at the
  // structure's maxGrade (one continuous transition, no cross-surface blends).
  // Returns null where no structure applies, so the legacy cutting/tunnel path
  // still resolves until the carve is retired. See docs/grade-separation-plan.md.
  const railStructureAt = (x, z) => railStructures.find((structure) => pointInOutline(x, z, structure)) ?? null;
  const railStructureBedHeightAt = (x, z) => {
    const inside = railStructureAt(x, z);
    // Flat bed inside the footprint. Outside, only a portal approach can carry
    // the bed (climbing to ground); elsewhere there is no structural surface.
    let result = inside && Number.isFinite(inside.railBedY) ? inside.railBedY : null;
    for (const portal of railPortals) {
      // A covered portal feeds a continuing tunnel, not daylight: the bed does
      // not ramp to ground there (the tunnel fallback carries it underground).
      if (portal.covered) continue;
      const structure = railStructures.find((candidate) => candidate.structureId === portal.structureId);
      if (!structure || !Number.isFinite(structure.railBedY)) continue;
      const portalX = portal.x + portal.points.reduce((sum, point) => sum + point[0], 0) / portal.points.length;
      if ((portal.side === 'east' && x < portalX - 2) || (portal.side === 'west' && x > portalX + 2)) continue;
      const distance = distanceToObjectPath(x, z, portal);
      if (distance > portal.approachLength) continue;
      const ramped = Math.min(naturalTerrainHeightAt(x, z), structure.railBedY + distance * portal.maxGrade);
      result = result === null ? ramped : Math.min(result, ramped);
    }
    return result;
  };
  const railSurfaceHeightAt = (x, z, structure) => {
    const structural = railStructureBedHeightAt(x, z);
    if (structural !== null) return structural;
    const reviewed = cuttingProfileHeightAt(x, z);
    if (reviewed !== null) return reviewed;
    if (structure !== 'tunnel') return bridgeSurfaceHeightAt(x, z);
    let result = tunnelSurfaceHeightAt(x, z);
    for (const portal of terrainPortals) {
      const floor = portalFloor(portal);
      if (!Number.isFinite(floor)) continue;
      const portalX = portal.x + portal.points.reduce((sum, point) => sum + point[0], 0) / portal.points.length;
      if ((portal.side === 'east' && x < portalX - 2) || (portal.side === 'west' && x > portalX + 2)) continue;
      const distance = distanceToObjectPath(x, z, portal);
      if (distance > portal.approachLength) continue;
      result = Math.max(floor, Math.min(result, floor + distance * portal.maxGrade));
    }
    return result;
  };
  return {
    meta, grid, heights, coverage, transport, speed, objectIndex,
    index, codeAt, coverageAt, transportAt, isRoad, cornerRaw, naturalCornerRaw,
    terrainCuttings, terrainPortals, railStructures, railPortals,
    naturalTerrainHeightAt, cuttingProfileHeightAt, railStructureBedHeightAt,
    terrainHeightAt, bridgeSurfaceHeightAt, tunnelSurfaceHeightAt, railSurfaceHeightAt,
    heightAt: terrainHeightAt,
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

function buildingChunkSeams(context, object, kx, kz) {
  const hasCopy = (x, z) => (context.objectIndex.chunks[`${x},${z}`] ?? [])
    .some((candidate) => candidate.kind === 'building' && sourceId(candidate) === object.sourceId);
  const minX = (kx * CHUNK_TILES - 0.5) * TILE;
  const maxX = ((kx + 1) * CHUNK_TILES - 0.5) * TILE;
  const minZ = (kz * CHUNK_TILES - 0.5) * TILE;
  const maxZ = ((kz + 1) * CHUNK_TILES - 0.5) * TILE;
  return {
    minX: hasCopy(kx - 1, kz) ? minX : null,
    maxX: hasCopy(kx + 1, kz) ? maxX : null,
    minZ: hasCopy(kx, kz - 1) ? minZ : null,
    maxZ: hasCopy(kx, kz + 1) ? maxZ : null,
  };
}

const NAV_VEHICLE = 1;
const NAV_PEDESTRIAN = 2;
const NAV_TRAM = 4;
const NAV_TRAIN = 8;
const TUNNEL_SURFACE_DEPTH = 5;

function navigationFromPaths(context, objects, kx, kz) {
  const nodes = new Map();
  const edges = [];
  const starts = [];
  const ends = [];
  const drivableSurfaces = objects.filter((object) =>
    object.kind === 'road-surface' &&
    ['carriageway', 'street-area'].includes(object.role) &&
    Array.isArray(object.outline)
  );
  const owner = (x, z) => ({
    // Ownership must use the same centimetre precision written to NAV3.
    // Otherwise rounding a negative half-cell can move the encoded node into
    // a neighboring chunk after ownership has already been decided.
    kx: Math.floor(navigationCellFromCentimeters(Math.round(x * 100)) / CHUNK_TILES),
    kz: Math.floor(navigationCellFromCentimeters(Math.round(z * 100)) / CHUNK_TILES),
  });
  const flagFor = (mode) => mode === 'pedestrian' ? NAV_PEDESTRIAN : mode === 'tram' ? NAV_TRAM : mode === 'train' ? NAV_TRAIN : NAV_VEHICLE;
  const nodeKey = (point, flags) => `${Math.round(point.x * 100)},${Math.round(point.z * 100)},${flags}`;
  const addNode = (point, flags, speed, heightAt) => {
    const owned = owner(point.x, point.z);
    if (owned.kx !== kx || owned.kz !== kz) return;
    const key = nodeKey(point, flags);
    const y = rounded(heightAt(point.x, point.z));
    const existing = nodes.get(key);
    if (!existing) nodes.set(key, { x: rounded(point.x), y, z: rounded(point.z), flags, speed });
    else existing.y = Math.max(existing.y, y);
  };
  for (const object of objects) {
    if (object.kind !== 'nav-path' || !Array.isArray(object.points) || object.points.length < 2) continue;
    const flags = flagFor(object.mode) | (object.flags ?? 0);
    const heightAt = object.mode === 'train'
      ? (x, z) => context.railSurfaceHeightAt(x, z, object.structure)
      : object.structure === 'tunnel'
        ? context.tunnelSurfaceHeightAt
        : context.bridgeSurfaceHeightAt;
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
    for (const point of points) addNode(point, flags, object.speed ?? 0, heightAt);
    starts.push({
      point: points[0], next: points[1], flags, speed: object.speed ?? 0,
      structure: object.structure ?? null, sourceId: object.sourceId, heightAt,
    });
    ends.push({
      point: points.at(-1), previous: points.at(-2), flags, speed: object.speed ?? 0,
      structure: object.structure ?? null, sourceId: object.sourceId, heightAt,
    });
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
  const connectorPoint = (from, to, incoming, outgoing, amount) => {
    const distance = Math.hypot(to.x - from.x, to.z - from.z);
    const handle = Math.min(5, Math.max(1.25, distance * 0.42));
    const p1 = { x: from.x + incoming.x * handle, z: from.z + incoming.z * handle };
    const p2 = { x: to.x - outgoing.x * handle, z: to.z - outgoing.z * handle };
    const inverse = 1 - amount;
    return {
      x: inverse ** 3 * from.x + 3 * inverse ** 2 * amount * p1.x +
        3 * inverse * amount ** 2 * p2.x + amount ** 3 * to.x,
      z: inverse ** 3 * from.z + 3 * inverse ** 2 * amount * p1.z +
        3 * inverse * amount ** 2 * p2.z + amount ** 3 * to.z,
    };
  };
  const surfaceHeight = (surface, x, z) => surface.structure === 'tunnel'
    ? context.tunnelSurfaceHeightAt(x, z)
    : context.bridgeSurfaceHeightAt(x, z);
  const connectorIsDrivable = (points, fromHeight, toHeight) => points.every((point, index) => {
    if (index === 0 || index === points.length - 1) return true;
    const amount = index / (points.length - 1);
    const expectedHeight = fromHeight + (toHeight - fromHeight) * amount;
    return drivableSurfaces.some((surface) =>
      pointInOutline(point.x, point.z, surface) &&
      Math.abs(surfaceHeight(surface, point.x, point.z) - expectedHeight) <= 1.25
    );
  });
  const addConnector = (end, candidate, incoming, incomingLength) => {
    const start = candidate.start;
    const outgoing = { x: start.next.x - start.point.x, z: start.next.z - start.point.z };
    const outgoingLength = Math.hypot(outgoing.x, outgoing.z) || 1;
    const incomingUnit = { x: incoming.x / incomingLength, z: incoming.z / incomingLength };
    const outgoingUnit = { x: outgoing.x / outgoingLength, z: outgoing.z / outgoingLength };
    const fromHeight = end.heightAt(end.point.x, end.point.z);
    const toHeight = start.heightAt(start.point.x, start.point.z);
    if (Math.abs(fromHeight - toHeight) > 1.25) return false;
    const parts = Math.max(1, Math.ceil(candidate.distance / 2.5));
    const points = Array.from(
      { length: parts + 1 },
      (_, index) => connectorPoint(end.point, start.point, incomingUnit, outgoingUnit, index / parts)
    );
    if (!connectorIsDrivable(points, fromHeight, toHeight)) return false;
    const speed = Math.min(end.speed, start.speed);
    for (const point of points.slice(1, -1)) {
      addNode(point, end.flags, speed, (x, z) => {
        const distance = Math.hypot(start.point.x - end.point.x, start.point.z - end.point.z) || 1;
        const amount = Math.min(1, Math.hypot(x - end.point.x, z - end.point.z) / distance);
        return fromHeight + (toHeight - fromHeight) * amount;
      });
    }
    for (let index = 0; index + 1 < points.length; index++) {
      const from = points[index];
      const to = points[index + 1];
      const owned = owner(from.x, from.z);
      if (owned.kx === kx && owned.kz === kz) edges.push({
        fromX: rounded(from.x), fromZ: rounded(from.z),
        toX: rounded(to.x), toZ: rounded(to.z), flags: end.flags,
      });
    }
    return true;
  };
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
      .sort((a, b) => a.distance - b.distance || b.dot - a.dot);
    let connected = 0;
    for (const candidate of candidates) {
      if ((end.flags & NAV_VEHICLE) !== 0) {
        if (addConnector(end, candidate, incoming, incomingLength)) connected++;
      } else {
        edges.push({
          fromX: rounded(end.point.x), fromZ: rounded(end.point.z),
          toX: rounded(candidate.start.point.x), toZ: rounded(candidate.start.point.z), flags: end.flags,
        });
        connected++;
      }
      if (connected >= 3) break;
    }
  }
  return { nodes: [...nodes.values()], edges };
}

function chunkBounds(kx, kz) {
  return {
    minX: (kx * CHUNK_TILES - 0.5) * TILE,
    minZ: (kz * CHUNK_TILES - 0.5) * TILE,
    maxX: ((kx + 1) * CHUNK_TILES - 0.5) * TILE,
    maxZ: ((kz + 1) * CHUNK_TILES - 0.5) * TILE,
  };
}

function boundaryIsPortal(a, b, cutting, portals) {
  return portals.some((portal) => portal.cuttingId === cutting.cuttingId &&
    distanceToObjectPath(a[0], a[1], portal) < 0.2 &&
    distanceToObjectPath(b[0], b[1], portal) < 0.2);
}

function addReviewedCuttingGeometry(context, cutting, kx, kz, buckets, capture) {
  const bounds = chunkBounds(kx, kz);
  const outline = absoluteOutline(cutting);
  const clippedFloor = clipPolygonToChunk(outline, bounds);
  if (clippedFloor.length >= 3) {
    addPolygonTriangles(buckets.get(cutting.surface === 'concrete' ? 'concrete' : 'ballast'), capture, clippedFloor, () => cutting.floorY);
  }
  for (let edge = 0; edge < outline.length; edge++) {
    const start = outline[edge];
    const end = outline[(edge + 1) % outline.length];
    if (boundaryIsPortal(start, end, cutting, context.terrainPortals)) continue;
    const clipped = clipLineToChunk(start, end, bounds);
    if (!clipped) continue;
    const length = Math.hypot(clipped[1][0] - clipped[0][0], clipped[1][1] - clipped[0][1]);
    const parts = Math.max(1, Math.ceil(length / 6));
    for (let part = 0; part < parts; part++) {
      const a = interpolatePoint(clipped[0], clipped[1], part / parts);
      const b = interpolatePoint(clipped[0], clipped[1], (part + 1) / parts);
      const topA = Math.max(cutting.floorY + 0.2, context.naturalTerrainHeightAt(a[0], a[1]));
      const topB = Math.max(cutting.floorY + 0.2, context.naturalTerrainHeightAt(b[0], b[1]));
      const lowA = [a[0], cutting.floorY, a[1]];
      const lowB = [b[0], cutting.floorY, b[1]];
      const highA = [a[0], topA, a[1]];
      const highB = [b[0], topB, b[1]];
      captureTriangle(buckets.get('concrete'), capture, lowA, lowB, highB);
      captureTriangle(buckets.get('concrete'), capture, lowA, highB, highA);
    }
  }
}

function addPortalRampGeometry(context, portal, kx, kz, buckets, capture) {
  const outline = portalRampOutline(portal);
  if (!outline) return;
  const cutting = context.terrainCuttings.find((candidate) => candidate.cuttingId === portal.cuttingId);
  if (!cutting) return;
  const clipped = clipPolygonToChunk(outline, chunkBounds(kx, kz));
  if (clipped.length < 3) return;
  addPolygonTriangles(buckets.get('ballast'), capture, clipped, ([x, z]) => Math.min(
    context.naturalTerrainHeightAt(x, z),
    cutting.floorY + distanceToObjectPath(x, z, portal) * portal.maxGrade
  ));
}

function addStationCanopyGeometry(object, kx, kz, buckets, cuboids, collisionMeshes) {
  if (!Number.isFinite(object.floorY) || !Number.isFinite(object.roofY) || object.roofY <= object.floorY + 0.5) return;
  const outline = absoluteOutline(object);
  const clipped = clipPolygonToChunk(outline, chunkBounds(kx, kz));
  if (clipped.length >= 3) {
    const roof = { positions: [], indices: [] };
    addPolygonTriangles(buckets.get('roof-metal'), roof, clipped, () => object.roofY);
    collisionMeshes.push({ sourceId: object.sourceId, ...roof });
  }
  const bounds = chunkBounds(kx, kz);
  for (let edge = 0; edge < outline.length; edge++) {
    const a = outline[edge];
    const b = outline[(edge + 1) % outline.length];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const supports = Math.max(1, Math.ceil(length / 22));
    for (let support = 0; support < supports; support++) {
      const t = (support + 0.5) / supports;
      const x = a[0] + (b[0] - a[0]) * t;
      const z = a[1] + (b[1] - a[1]) * t;
      if (x < bounds.minX || x >= bounds.maxX || z < bounds.minZ || z >= bounds.maxZ) continue;
      const height = object.roofY - object.floorY;
      addBox(buckets.get('concrete'), x, object.floorY + height / 2, z, 0.22, height / 2, 0.22);
      cuboids.push({
        sourceId: object.sourceId, x, y: object.floorY + height / 2, z,
        hx: 0.22, hy: height / 2, hz: 0.22, rotation: 0,
      });
    }
  }
}

// Retaining/tunnel walls around a rail structure's footprint. Edges are
// subdivided and per-segment culled to the chunk (like station-canopy supports),
// so a footprint spanning chunks never grows a wall along the chunk seam. topYFor
// may vary with position so an open-cut wall rises to meet the actual ground it
// retains rather than a flat parapet.
function addRailWalls(object, outline, kx, kz, baseY, topYFor, bucket, collisionMeshes) {
  const topAt = typeof topYFor === 'function' ? topYFor : () => topYFor;
  const bounds = chunkBounds(kx, kz);
  const capture = { positions: [], indices: [] };
  const emit = (a, b, c) => {
    addTriangle(bucket, a, b, c);
    const start = capture.positions.length / 3;
    capture.positions.push(...a, ...b, ...c);
    capture.indices.push(start, start + 1, start + 2);
  };
  for (let edge = 0; edge < outline.length; edge++) {
    const a = outline[edge];
    const b = outline[(edge + 1) % outline.length];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const segments = Math.max(1, Math.ceil(length / 2));
    for (let segment = 0; segment < segments; segment++) {
      const t0 = segment / segments;
      const t1 = (segment + 1) / segments;
      const mx = a[0] + (b[0] - a[0]) * (t0 + t1) / 2;
      const mz = a[1] + (b[1] - a[1]) * (t0 + t1) / 2;
      if (mx < bounds.minX || mx >= bounds.maxX || mz < bounds.minZ || mz >= bounds.maxZ) continue;
      const p0 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
      const p1 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
      const top0 = Math.max(baseY + 0.2, topAt(p0[0], p0[1]));
      const top1 = Math.max(baseY + 0.2, topAt(p1[0], p1[1]));
      emit([p0[0], baseY, p0[1]], [p1[0], baseY, p1[1]], [p1[0], top1, p1[1]]);
      emit([p0[0], baseY, p0[1]], [p1[0], top1, p1[1]], [p0[0], top0, p0[1]]);
    }
  }
  if (capture.indices.length > 0) collisionMeshes.push({ sourceId: object.sourceId, ...capture });
}

// A grade-separated rail corridor as an independent structure: the running
// bed sits at object.railBedY and never carves the terrain heightfield.
// - open-cut: bed + retaining walls up to parapetY (trench, no roof)
// - tunnel:   bed + walls + roof slab at roofY (fully covered)
// - viaduct:  bed on a supporting deck prism (elevated)
// See docs/grade-separation-plan.md.
function addRailStructureGeometry(context, object, kx, kz, buckets, cuboids, collisionMeshes) {
  const railBedY = object.railBedY;
  if (!Number.isFinite(railBedY) || !Array.isArray(object.outline) || object.outline.length < 3) return;
  const outline = absoluteOutline(object);
  const clipped = clipPolygonToChunk(outline, chunkBounds(kx, kz));
  if (clipped.length < 3) return;
  const surface = object.surface === 'concrete' ? 'concrete' : 'ballast';

  const bed = { positions: [], indices: [] };
  addPolygonTriangles(buckets.get(surface), bed, clipped, () => railBedY);
  collisionMeshes.push({ sourceId: object.sourceId, ...bed });

  if (object.structure === 'viaduct') {
    const thickness = Math.max(0.6, Math.min(1.5, object.deckThickness ?? 0.8));
    const baseY = railBedY - thickness;
    addPrism(buckets.get('concrete'), clipped, baseY, thickness);
    collisionMeshes.push({ sourceId: object.sourceId, ...prismTriangles(clipped, baseY, thickness) });
    return;
  }

  // Tunnel walls cap at the flat roof; open-cut retaining walls rise to meet the
  // natural ground they hold back (clamped to parapetY if authored), so the
  // trench edge joins the surrounding terrain instead of leaving a gap.
  const cap = object.structure === 'tunnel'
    ? object.roofY
    : (x, z) => {
        const ground = context.naturalTerrainHeightAt(x, z);
        return Number.isFinite(object.parapetY) ? Math.min(object.parapetY, ground) : ground;
      };
  if (typeof cap === 'function' || Number.isFinite(cap)) addRailWalls(object, outline, kx, kz, railBedY, cap, buckets.get('concrete'), collisionMeshes);

  if (object.structure === 'tunnel' && Number.isFinite(object.roofY) && object.roofY > railBedY + 0.5) {
    const roof = { positions: [], indices: [] };
    addPolygonTriangles(buckets.get('concrete'), roof, clipped, () => object.roofY);
    collisionMeshes.push({ sourceId: object.sourceId, ...roof });
  }
}

// A station platform stacks two independent walkable decks at one footprint:
// the low platform at track level and the concourse/entrance above it, joined
// by support columns. Neither touches the terrain heightfield — this is the
// "entrance above the tracks" that a single-valued surface cannot express.
function addStationPlatformGeometry(object, kx, kz, buckets, cuboids, collisionMeshes) {
  const platformY = object.platformY;
  if (!Number.isFinite(platformY) || !Array.isArray(object.outline) || object.outline.length < 3) return;
  const outline = absoluteOutline(object);
  const clipped = clipPolygonToChunk(outline, chunkBounds(kx, kz));
  if (clipped.length < 3) return;

  const platform = { positions: [], indices: [] };
  addPolygonTriangles(buckets.get('concrete'), platform, clipped, () => platformY);
  collisionMeshes.push({ sourceId: object.sourceId, ...platform });

  if (Number.isFinite(object.concourseY) && object.concourseY > platformY + 1.5) {
    const concourse = { positions: [], indices: [] };
    addPolygonTriangles(buckets.get('concrete'), concourse, clipped, () => object.concourseY);
    collisionMeshes.push({ sourceId: object.sourceId, ...concourse });
    // Columns, not walls: the platform edges stay open so trains and passengers
    // move through. Sample along the perimeter like station-canopy supports.
    const bounds = chunkBounds(kx, kz);
    const height = object.concourseY - platformY;
    for (let edge = 0; edge < outline.length; edge++) {
      const a = outline[edge];
      const b = outline[(edge + 1) % outline.length];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const columns = Math.max(1, Math.ceil(length / 12));
      for (let column = 0; column < columns; column++) {
        const t = (column + 0.5) / columns;
        const x = a[0] + (b[0] - a[0]) * t;
        const z = a[1] + (b[1] - a[1]) * t;
        if (x < bounds.minX || x >= bounds.maxX || z < bounds.minZ || z >= bounds.maxZ) continue;
        addBox(buckets.get('concrete'), x, platformY + height / 2, z, 0.3, height / 2, 0.3);
        cuboids.push({ sourceId: object.sourceId, x, y: platformY + height / 2, z, hx: 0.3, hy: height / 2, hz: 0.3, rotation: 0 });
      }
    }
  }
}

export function compileChunkRecipe(context, kx, kz) {
  if (kx < MIN_CHUNK || kx > MAX_CHUNK || kz < MIN_CHUNK || kz > MAX_CHUNK) throw new Error(`chunk ${kx},${kz} is outside Melbourne bounds`);
  const c0x = kx * CHUNK_TILES;
  const c0z = kz * CHUNK_TILES;
  const buckets = primitiveBuckets();
  const cuboids = [];
  const collisionMeshes = [];
  const parked = [];
  const transitStops = [];
  const nodes = [];
  const edges = [];
  const cells = new Uint8Array(CHUNK_TILES * CHUNK_TILES);
  const sources = new Set();
  const objects = normalizeObjects(context, kx, kz);
  const objectsByKind = new Map();
  for (const object of objects) {
    if (!objectsByKind.has(object.kind)) objectsByKind.set(object.kind, []);
    objectsByKind.get(object.kind).push(object);
    // Portal copies cover their possible approach envelope, but most do not
    // emit anything in a given chunk. Add their source only when a local ramp
    // actually contributes geometry below.
    if (object.kind !== 'terrain-portal') sources.add(object.sourceId);
  }
  // Retain the object-level guard for older inputs that predate the explicit
  // source-coverage bit.
  const authoredBuildingArea = objectsByKind.has('building');
  const authoredNavigation = objectsByKind.has('nav-path');
  const localCuttings = [...new Map((objectsByKind.get('terrain-cutting') ?? [])
    .filter((object) => clipPolygonToChunk(absoluteOutline(object), chunkBounds(kx, kz)).length >= 3)
    .map((object) => [object.sourceId, object])).values()];
  const localPortalRamps = [...new Map((objectsByKind.get('terrain-portal') ?? [])
    .filter((object) => !object.covered)
    .filter((object) => {
      const outline = portalRampOutline(object);
      return outline && clipPolygonToChunk(outline, chunkBounds(kx, kz)).length >= 3;
    })
    .map((object) => [object.sourceId, object])).values()];
  // Open-cut rail structures are visible trenches: the terrain mesh must have a
  // hole over their footprint so you can see and drop into the cut. This is a
  // topological hole in the mesh, not a heightfield carve — heightAt is
  // untouched; the structure's own bed fills the void. Covered tunnels keep the
  // ground whole and so are never terrain cutters. See docs/grade-separation-plan.md.
  const localRailOpenCuts = [...new Map((objectsByKind.get('rail-structure') ?? [])
    .filter((object) => object.structure === 'open-cut' && Array.isArray(object.outline))
    .filter((object) => clipPolygonToChunk(absoluteOutline(object), chunkBounds(kx, kz)).length >= 3)
    .map((object) => [object.sourceId, object])).values()];
  const customTerrainCollision = localCuttings.length > 0 || localPortalRamps.length > 0 || localRailOpenCuts.length > 0;
  const terrainCapture = { positions: [], indices: [] };
  const terrainCutters = [
    ...localCuttings.map(absoluteOutline),
    ...localPortalRamps.map(portalRampOutline).filter(Boolean),
    ...localRailOpenCuts.map(absoluteOutline),
  ];

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
  const hasExactRoadSurfaces = context.objectIndex.roadSurfaces === true;
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
      // Exact carriageway polygons need a contrasting substrate. Keeping the
      // old raster cell asphalt underneath turns every road into a blocky 12 m
      // carpet and visually erases the authored kerb line.
      const baseMaterial = code === 1 && hasExactRoadSurfaces ? 'pavement' : (materialForCode[code] ?? 'pavement');
      const bucket = buckets.get(baseMaterial);
      const x0 = (cx - 0.5) * TILE;
      const x1 = (cx + 0.5) * TILE;
      const z0 = (cz - 0.5) * TILE;
      const z1 = (cz + 0.5) * TILE;
      if (code === 5) {
        addQuad(bucket, [x0, 0.015, z0], [x0, 0.015, z1], [x1, 0.015, z1], [x1, 0.015, z0]);
        if (customTerrainCollision) {
          const y00 = context.naturalCornerRaw(cx, cz) * 0.1;
          const y10 = context.naturalCornerRaw(cx + 1, cz) * 0.1;
          const y01 = context.naturalCornerRaw(cx, cz + 1) * 0.1;
          const y11 = context.naturalCornerRaw(cx + 1, cz + 1) * 0.1;
          recordTriangle(terrainCapture, [x0, y00, z0], [x0, y01, z1], [x1, y11, z1]);
          recordTriangle(terrainCapture, [x0, y00, z0], [x1, y11, z1], [x1, y10, z0]);
        }
        for (const [ox, oz] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
          if (context.codeAt(cx + ox, cz + oz) === 5) continue;
          const id = fallbackId('shoreline', cx, cz, (ox + 1) * 3 + oz + 1);
          sources.add(id);
          cuboids.push({ sourceId: id, x: cx * TILE + ox * TILE / 2, y: 2.5, z: cz * TILE + oz * TILE / 2, hx: ox === 0 ? TILE / 2 : 0.25, hy: 2.5, hz: oz === 0 ? TILE / 2 : 0.25, rotation: 0 });
        }
      } else {
        const sample = customTerrainCollision ? context.naturalCornerRaw : context.cornerRaw;
        const y00 = sample(cx, cz) * 0.1;
        const y10 = sample(cx + 1, cz) * 0.1;
        const y01 = sample(cx, cz + 1) * 0.1;
        const y11 = sample(cx + 1, cz + 1) * 0.1;
        if (customTerrainCollision) {
          const triangles = [
            [[x0, z0, y00], [x0, z1, y01], [x1, z1, y11]],
            [[x0, z0, y00], [x1, z1, y11], [x1, z0, y10]],
          ];
          for (const triangle of triangles) {
            for (const piece of subtractTerrainCutters(triangle, terrainCutters)) {
              for (let vertex = 1; vertex + 1 < piece.length; vertex++) {
                const toWorldVertex = (point) => [point[0], point[2], point[1]];
                captureTriangle(bucket, terrainCapture, toWorldVertex(piece[0]), toWorldVertex(piece[vertex]), toWorldVertex(piece[vertex + 1]));
              }
            }
          }
        } else {
          addQuad(bucket, [x0, y00, z0], [x0, y01, z1], [x1, y11, z1], [x1, y10, z0]);
        }
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
        const points = [
          [cx * TILE - width / 2, cz * TILE - depth / 2],
          [cx * TILE + width / 2, cz * TILE - depth / 2],
          [cx * TILE + width / 2, cz * TILE + depth / 2],
          [cx * TILE - width / 2, cz * TILE + depth / 2],
        ];
        addBuildingWalls(buckets.get(material), buckets.get('window'), points, base, base + height);
        addRoof(buckets.get(roofMaterialFor(material)), {
          points, x: cx * TILE, z: cz * TILE, rotation: 0, width, depth,
          eaveY: base + height, ridgeY: base + height, roof: 'flat',
        });
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
        const armRotation = mask === 5
          ? (side > 0 ? Math.PI : 0)
          : (side > 0 ? Math.PI / 2 : -Math.PI / 2);
        sources.add(id);
        addStreetlightRecipe(buckets, cuboids, id, x, z, base, armRotation);
      }
      if (context.isRoad(cx, cz) && (coverage & COVERAGE_PARKING) === 0 && (mask === 5 || mask === 10) && hashNumber(cx, cz, 40) < 0.04) {
        const id = fallbackId('parking', cx, cz);
        const side = hashNumber(cx, cz, 41) < 0.5 ? 1 : -1;
        sources.add(id);
        parked.push({ sourceId: id, x: cx * TILE + (mask === 5 ? side * TILE * 0.3 : 0), z: cz * TILE + (mask === 10 ? side * TILE * 0.3 : 0), rotation: (mask === 10 ? Math.PI / 2 : 0) + (side < 0 ? Math.PI : 0), seed: Math.floor(hashNumber(cx, cz, 42) * 0xffffffff) >>> 0 });
      }
    }
  }

  if (customTerrainCollision) {
    for (const cutting of localCuttings) addReviewedCuttingGeometry(context, cutting, kx, kz, buckets, terrainCapture);
    for (const portal of localPortalRamps) addPortalRampGeometry(context, portal, kx, kz, buckets, terrainCapture);
    const terrainSource = localCuttings[0]?.sourceId ?? localPortalRamps[0]?.sourceId ?? localRailOpenCuts[0].sourceId;
    sources.add(terrainSource);
    collisionMeshes.push({ sourceId: terrainSource, ...terrainCapture });
  }

  for (const object of objects) {
    if (object.kind === 'road-surface' && Array.isArray(object.outline) && object.outline.length >= 3) {
      const points = object.outline.map(([x, z]) => [object.x + x, object.z + z]);
      const material = MATERIALS.some((entry) => entry.name === object.surface) ? object.surface : 'asphalt';
      const elevation = object.elevation ?? 0.025;
      const sitsOnBridge = object.structure === 'bridge' ||
        (object.structure !== 'tunnel' && material === 'pavement');
      const isTrainSurface = object.sourceId.startsWith('train:') || /^train-/.test(object.role ?? '');
      const surfaceHeightAt = isTrainSurface
        ? (x, z) => context.railSurfaceHeightAt(x, z, object.structure)
        : object.structure === 'tunnel'
          ? context.tunnelSurfaceHeightAt
          : sitsOnBridge ? context.bridgeSurfaceHeightAt : context.terrainHeightAt;
      if (elevation >= 0.1 && ['pavement', 'concrete'].includes(material)) {
        const collision = addRaisedPolygon(buckets.get(material), points, surfaceHeightAt, elevation);
        collisionMeshes.push({ sourceId: object.sourceId, ...collision });
      } else {
        const collision = object.structure === 'bridge' && ['carriageway', 'tram-bed', 'cycleway'].includes(object.role)
          ? { positions: [], indices: [] }
          : null;
        addPolygonTop(buckets.get(material), points, ([x, z]) => surfaceHeightAt(x, z) + elevation, collision);
        if (collision && collision.indices.length > 0) collisionMeshes.push({ sourceId: object.sourceId, ...collision });
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
    } else if (object.kind === 'rail-structure') {
      addRailStructureGeometry(context, object, kx, kz, buckets, cuboids, collisionMeshes);
    } else if (object.kind === 'station-platform') {
      addStationPlatformGeometry(object, kx, kz, buckets, cuboids, collisionMeshes);
    } else if (object.kind === 'station-canopy') {
      addStationCanopyGeometry(object, kx, kz, buckets, cuboids, collisionMeshes);
    } else if (object.kind === 'building') {
      const baseY = Number.isFinite(object.baseY) ? object.baseY : context.heightAt(object.x, object.z);
      const bucket = buckets.get(buildingWallMaterialFor(object));
      const seams = buildingChunkSeams(context, object, kx, kz);
      // Carve a pitched cap out of the top; walls drop to the eave and the roof
      // fills up to the real ridge height. Collision stays a full-height flat
      // prism/box, so gameplay volumes are unchanged.
      const roofHeight = roofCapHeight(object.roof, object.width, object.depth, object.height);
      const wallHeight = object.height - roofHeight;
      let points;
      if (Array.isArray(object.outline) && object.outline.length >= 3) {
        points = object.outline.map(([x, z]) => [object.x + x, object.z + z]);
        addBuildingWalls(bucket, buckets.get('window'), points, baseY, baseY + wallHeight, seams);
        collisionMeshes.push({ sourceId: object.sourceId, ...prismTriangles(points, baseY, object.height) });
      } else {
        const cos = Math.cos(object.rotation ?? 0);
        const sin = Math.sin(object.rotation ?? 0);
        points = [
          [-object.width / 2, -object.depth / 2],
          [object.width / 2, -object.depth / 2],
          [object.width / 2, object.depth / 2],
          [-object.width / 2, object.depth / 2],
        ].map(([x, z]) => [object.x + x * cos + z * sin, object.z - x * sin + z * cos]);
        addBuildingWalls(bucket, buckets.get('window'), points, baseY, baseY + wallHeight, seams);
        cuboids.push({ sourceId: object.sourceId, x: object.x, y: baseY + object.height / 2, z: object.z, hx: object.width / 2, hy: object.height / 2, hz: object.depth / 2, rotation: object.rotation ?? 0 });
      }
      addRoof(buckets.get(roofMaterialFor(object.style)), {
        points, x: object.x, z: object.z, rotation: object.rotation ?? 0,
        width: object.width, depth: object.depth,
        eaveY: baseY + wallHeight, ridgeY: baseY + object.height, roof: object.roof,
        seams,
      });
    } else if (object.kind === 'tree') {
      const base = context.heightAt(object.x, object.z);
      addBox(buckets.get('vegetation'), object.x, base + object.height / 2, object.z, 0.24, object.height / 2, 0.24);
      addBox(buckets.get('vegetation'), object.x, base + object.height * 0.8, object.z, 1.2, object.height * 0.2, 1.2, Math.PI / 4);
      cuboids.push({ sourceId: object.sourceId, x: object.x, y: base + object.height / 2, z: object.z, hx: 0.22, hy: object.height / 2, hz: 0.22, rotation: 0 });
    } else if (object.kind === 'parking') {
      parked.push({ sourceId: object.sourceId, x: object.x, z: object.z, rotation: object.rotation ?? 0, seed: Number.parseInt(createHash('sha256').update(object.sourceId).digest('hex').slice(0, 8), 16) });
    } else if (object.kind === 'transit-stop') {
      const stopHeight = object.mode === 'train'
        ? context.railSurfaceHeightAt(object.x, object.z, object.structure)
        : context.bridgeSurfaceHeightAt(object.x, object.z);
      transitStops.push({
        sourceId: object.sourceId, mode: object.mode, name: object.name ?? '', x: object.x,
        y: stopHeight + 0.05, z: object.z,
      });
      const base = stopHeight;
      addBox(buckets.get('prop'), object.x, base + 1.25, object.z, 0.07, 1.25, 0.07);
      addBox(buckets.get('prop'), object.x, base + 2.25, object.z, 0.28, 0.18, 0.04);
    } else if (!['road-surface', 'nav-path', 'terrain-cutting', 'terrain-portal'].includes(object.kind)) {
      const base = context.bridgeSurfaceHeightAt(object.x, object.z);
      addPointPropRecipe(buckets, cuboids, object, base);
    }
  }

  if (authoredNavigation) {
    const authored = navigationFromPaths(context, objects, kx, kz);
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
      COL1: encodeColliders(cuboids, collisionMeshes, sourceIndices, customTerrainCollision ? COLLISION_CUSTOM_TERRAIN : 0),
      NAV3: encodeNavigation(nodes, edges),
      GME1: encodeGameplay(cells, parked, sourceList, sourceIndices),
      TRN1: encodeTransit(transitStops, sourceIndices),
    },
    counts: { nodes: nodes.length, edges: edges.length, cuboids: cuboids.length, meshes: collisionMeshes.length, parked: parked.length, sources: sourceList.length },
  };
}
