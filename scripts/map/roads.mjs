import { inMap, toWorld } from './geo.mjs';

const MAX_PATH_LENGTH = 90;
const MAX_SEGMENT_LENGTH = 45;
const DEFAULT_WIDTHS = {
  motorway: 18,
  trunk: 16,
  primary: 14,
  secondary: 12,
  tertiary: 10,
  residential: 8,
  unclassified: 7,
  living_street: 6,
  service: 6,
  pedestrian: 5,
};

const rounded = (value) => Math.round(value * 100) / 100;

/** Infer a physical carriageway width from OSM tags, in metres. */
export function roadWidth(tags = {}) {
  const highway = String(tags.highway ?? 'service').replace(/_link$/, '');
  const fallback = DEFAULT_WIDTHS[highway] ?? DEFAULT_WIDTHS.service;
  const taggedWidth = Number.parseFloat(tags.width);
  if (Number.isFinite(taggedWidth) && taggedWidth >= 2 && taggedWidth <= 40) return taggedWidth;
  const lanes = Number.parseInt(tags.lanes, 10);
  if (Number.isFinite(lanes) && lanes > 0 && lanes <= 12) {
    return Math.max(fallback, lanes * 3.2 + 1.2);
  }
  return fallback;
}

function direction(a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  return length < 0.05 ? null : { x: dx / length, z: dz / length, length };
}

function roadPath(points, width) {
  if (points.length < 2) return null;
  const halfWidth = width / 2;
  const segments = points.slice(0, -1).map((point, i) => direction(point, points[i + 1]));
  if (segments.some((segment) => !segment)) return null;
  const center = {
    x: (points[0].x + points.at(-1).x) / 2,
    z: (points[0].z + points.at(-1).z) / 2,
  };
  const side = (i, sign) => {
    const before = segments[Math.max(0, i - 1)];
    const after = segments[Math.min(segments.length - 1, i)];
    let nx = -(before.z + after.z);
    let nz = before.x + after.x;
    const normalLength = Math.hypot(nx, nz);
    if (normalLength < 0.1) {
      nx = -after.z;
      nz = after.x;
    } else {
      nx /= normalLength;
      nz /= normalLength;
    }
    const afterNormal = { x: -after.z, z: after.x };
    const projection = Math.max(0.5, nx * afterNormal.x + nz * afterNormal.z);
    const offset = Math.min(halfWidth * 2, halfWidth / projection) * sign;
    let x = points[i].x;
    let z = points[i].z;
    // Square caps overlap adjoining path chunks and other ways at junctions.
    if (i === 0) {
      x -= after.x * halfWidth;
      z -= after.z * halfWidth;
    } else if (i === points.length - 1) {
      x += before.x * halfWidth;
      z += before.z * halfWidth;
    }
    return [rounded(x + nx * offset - center.x), rounded(z + nz * offset - center.z)];
  };
  const outline = [
    ...points.map((_, i) => side(i, 1)),
    ...points.map((_, i) => side(i, -1)).reverse(),
  ];
  return { x: rounded(center.x), z: rounded(center.z), outline };
}

/** Convert Overpass highway centerlines to short, buffered polygon strips. */
export function roadSurfacesFromOverpass(data) {
  const surfaces = [];
  for (const element of data?.elements ?? []) {
    if (element.type !== 'way' || !element.tags?.highway || !Array.isArray(element.geometry)) continue;
    const points = element.geometry
      .filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lon))
      .map((point) => ({ ...toWorld(point.lat, point.lon), lat: point.lat, lon: point.lon }));
    const width = roadWidth(element.tags);
    const surface = element.tags.highway === 'pedestrian' ? 'pavement' : 'asphalt';
    const dense = points.length > 0 ? [points[0]] : [];
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (!inMap(a.lat, a.lon, width) && !inMap(b.lat, b.lon, width)) continue;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const parts = Math.max(1, Math.ceil(length / MAX_SEGMENT_LENGTH));
      for (let part = 1; part <= parts; part++) {
        const t = part / parts;
        dense.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      }
    }
    let path = dense.length > 0 ? [dense[0]] : [];
    let pathLength = 0;
    for (let i = 1; i < dense.length; i++) {
      const segment = direction(dense[i - 1], dense[i]);
      if (!segment) continue;
      if (path.length > 1 && pathLength + segment.length > MAX_PATH_LENGTH) {
        const polygon = roadPath(path, width);
        if (polygon) surfaces.push({ kind: 'road-surface', surface, ...polygon });
        path = [path.at(-1)];
        pathLength = 0;
      }
      path.push(dense[i]);
      pathLength += segment.length;
    }
    const polygon = roadPath(path, width);
    if (polygon) surfaces.push({ kind: 'road-surface', surface, ...polygon });
  }
  return surfaces;
}
