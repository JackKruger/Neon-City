import { CHUNK_TILES, TILE, chunkKeyForWorld, inMap, toWorld } from './geo.mjs';

const MAX_PATH_LENGTH = 90;
const MAX_SEGMENT_LENGTH = 30;
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
  footway: 1.8,
  path: 1.8,
  cycleway: 1.8,
};

export const STREET_DEFAULTS = Object.freeze({
  trafficLane: 3.2,
  parkingLane: 2.2,
  cycleLane: 1.8,
  suburbanFootpath: 1.8,
  activityFootpath: 2.5,
  kerbHeight: 0.13,
  tramGauge: 1.435,
});

const rounded = (value) => Math.round(value * 100) / 100;

function metres(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Number.parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Infer a physical carriageway width from OSM tags, in metres. */
export function roadWidth(tags = {}) {
  const highway = String(tags.highway ?? 'service').replace(/_link$/, '');
  const fallback = DEFAULT_WIDTHS[highway] ?? DEFAULT_WIDTHS.service;
  const taggedWidth = metres(tags.width);
  if (taggedWidth !== null && taggedWidth >= 0.8 && taggedWidth <= 40) return taggedWidth;
  const lanes = Number.parseInt(tags.lanes, 10);
  if (Number.isFinite(lanes) && lanes > 0 && lanes <= 12) {
    const parking = /lane|street_side/.test(`${tags['parking:both'] ?? ''} ${tags.parking ?? ''}`) ? STREET_DEFAULTS.parkingLane * 2 : 0;
    return Math.max(fallback, lanes * STREET_DEFAULTS.trafficLane + (parking || 1.2));
  }
  return fallback;
}

export function sidewalkWidth(tags = {}, side = 'both') {
  const explicit = metres(tags[`sidewalk:${side}:width`]) ?? metres(tags['sidewalk:width']);
  if (explicit !== null) return Math.min(8, Math.max(0.8, explicit));
  return /^(primary|secondary|tertiary|pedestrian)/.test(String(tags.highway ?? ''))
    ? STREET_DEFAULTS.activityFootpath
    : STREET_DEFAULTS.suburbanFootpath;
}

function direction(a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  return length < 0.05 ? null : { x: dx / length, z: dz / length, length };
}

function offsetPath(points, offset) {
  if (Math.abs(offset) < 0.001) return points.map(({ x, z }) => ({ x, z }));
  const segments = points.slice(0, -1).map((point, i) => direction(point, points[i + 1]));
  if (segments.some((segment) => !segment)) return [];
  return points.map((point, i) => {
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
    const limited = Math.min(Math.abs(offset) * 2, Math.abs(offset) / projection) * Math.sign(offset);
    return { x: point.x + nx * limited, z: point.z + nz * limited };
  });
}

function roadPath(points, width) {
  if (points.length < 2) return null;
  const halfWidth = width / 2;
  const left = offsetPath(points, halfWidth);
  const right = offsetPath(points, -halfWidth);
  if (left.length < 2 || right.length < 2) return null;
  const center = {
    x: (points[0].x + points.at(-1).x) / 2,
    z: (points[0].z + points.at(-1).z) / 2,
  };
  // Extend caps so consecutive pieces overlap without visible cracks.
  const extend = (path, atStart, amount) => {
    const index = atStart ? 0 : path.length - 1;
    const neighbor = atStart ? 1 : path.length - 2;
    const d = direction(path[neighbor], path[index]);
    if (d) path[index] = { x: path[index].x + d.x * amount, z: path[index].z + d.z * amount };
  };
  extend(left, true, halfWidth); extend(right, true, halfWidth);
  extend(left, false, halfWidth); extend(right, false, halfWidth);
  return {
    x: rounded(center.x),
    z: rounded(center.z),
    outline: [...left, ...right.reverse()].map((point) => [rounded(point.x - center.x), rounded(point.z - center.z)]),
  };
}

function relativePath(points) {
  const center = { x: (points[0].x + points.at(-1).x) / 2, z: (points[0].z + points.at(-1).z) / 2 };
  return {
    x: rounded(center.x), z: rounded(center.z),
    points: points.map((point) => [rounded(point.x - center.x), rounded(point.z - center.z)]),
  };
}

function pathParts(points, width, visit) {
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
      visit(path);
      path = [path.at(-1)];
      pathLength = 0;
    }
    path.push(dense[i]);
    pathLength += segment.length;
  }
  if (path.length > 1) visit(path);
}

function sidewalkSides(tags) {
  const value = String(tags.sidewalk ?? '').toLowerCase();
  if (['no', 'none', 'separate'].includes(value)) return [];
  if (['left', 'right'].includes(value)) return [value];
  if (value === 'both' || tags['sidewalk:left'] === 'yes' || tags['sidewalk:right'] === 'yes') {
    return ['left', 'right'].filter((side) => tags[`sidewalk:${side}`] !== 'no');
  }
  const highway = String(tags.highway ?? '').replace(/_link$/, '');
  return ['motorway', 'trunk', 'service'].includes(highway) ? [] : ['left', 'right'];
}

function speedKmh(tags, highway) {
  const speed = metres(tags.maxspeed);
  if (speed !== null && speed <= 130) return Math.round(speed);
  return ({ motorway: 100, trunk: 80, primary: 60, secondary: 60, living_street: 20 }[highway] ?? 50);
}

/** Compact, chunk-indexed road names and limits for the in-game HUD. */
export function roadInfoFromOverpass(data) {
  const rawSegments = [];
  const names = new Set();
  const excluded = new Set(['footway', 'path', 'steps', 'cycleway', 'pedestrian']);
  const compact = (value) => Math.round(value * 10) / 10;

  for (const element of data?.elements ?? []) {
    if (element.type !== 'way' || !Array.isArray(element.geometry)) continue;
    const tags = element.tags ?? {};
    const highway = String(tags.highway ?? '').replace(/_link$/, '');
    if (!highway || excluded.has(highway)) continue;
    const name = String(tags.name ?? tags.ref ?? '').replace(/\s+/g, ' ').trim() || null;
    if (name) names.add(name);
    const speed = speedKmh(tags, highway);
    const points = element.geometry
      .filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lon))
      .map((point) => ({ ...toWorld(point.lat, point.lon), lat: point.lat, lon: point.lon }));
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (!inMap(a.lat, a.lon, MAX_SEGMENT_LENGTH) && !inMap(b.lat, b.lon, MAX_SEGMENT_LENGTH)) continue;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const parts = Math.max(1, Math.ceil(length / MAX_SEGMENT_LENGTH));
      for (let part = 0; part < parts; part++) {
        const t0 = part / parts;
        const t1 = (part + 1) / parts;
        const ax = compact(a.x + (b.x - a.x) * t0);
        const az = compact(a.z + (b.z - a.z) * t0);
        const bx = compact(a.x + (b.x - a.x) * t1);
        const bz = compact(a.z + (b.z - a.z) * t1);
        rawSegments.push({ name, speed, ax, az, bx, bz });
      }
    }
  }

  const nameList = [...names].sort((a, b) => a.localeCompare(b));
  const nameIndices = new Map(nameList.map((name, index) => [name, index]));
  const chunks = {};
  for (const segment of rawSegments) {
    const key = chunkKeyForWorld((segment.ax + segment.bx) / 2, (segment.az + segment.bz) / 2);
    (chunks[key] ??= []).push([
      segment.name ? nameIndices.get(segment.name) : -1,
      segment.speed,
      segment.ax,
      segment.az,
      segment.bx,
      segment.bz,
    ]);
  }
  const sortedChunks = {};
  for (const key of Object.keys(chunks).sort()) {
    sortedChunks[key] = chunks[key].sort((a, b) => a[3] - b[3] || a[2] - b[2] || a[0] - b[0]);
  }
  return { version: 1, chunkTiles: CHUNK_TILES, tileSize: TILE, names: nameList, chunks: sortedChunks };
}

function laneCounts(tags) {
  const oneway = ['yes', '1', 'true'].includes(String(tags.oneway).toLowerCase());
  const reverse = String(tags.oneway) === '-1';
  const total = Math.max(1, Math.min(12, Number.parseInt(tags.lanes, 10) || (oneway || reverse ? 1 : 2)));
  if (oneway || reverse) return { forward: reverse ? 0 : total, backward: reverse ? total : 0 };
  const forward = Math.max(1, Number.parseInt(tags['lanes:forward'], 10) || Math.ceil(total / 2));
  const backward = Math.max(1, Number.parseInt(tags['lanes:backward'], 10) || Math.floor(total / 2));
  return { forward, backward };
}

/**
 * Convert OSM transport centrelines into semantic, bounded street features.
 * Road surfaces remain backwards-compatible; nav-path records are compiler-only.
 */
export function roadSurfacesFromOverpass(data) {
  const features = [];
  for (const element of data?.elements ?? []) {
    if (element.type !== 'way' || !Array.isArray(element.geometry)) continue;
    const tags = element.tags ?? {};
    const highway = String(tags.highway ?? '').replace(/_link$/, '');
    const railway = String(tags.railway ?? '');
    const platform = railway === 'platform' || tags.public_transport === 'platform';
    const areaHighway = String(tags['area:highway'] ?? '');
    if (!highway && railway !== 'tram' && !platform && !areaHighway) continue;
    const points = element.geometry
      .filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lon))
      .map((point) => ({ ...toWorld(point.lat, point.lon), lat: point.lat, lon: point.lon }));
    if (points.length < 2) continue;
    const isClosed = points.length >= 4 && Math.hypot(points[0].x - points.at(-1).x, points[0].z - points.at(-1).z) < 0.1;
    if ((platform || areaHighway || tags.area === 'yes') && isClosed) {
      const ring = points.slice(0, -1);
      const center = {
        x: ring.reduce((sum, point) => sum + point.x, 0) / ring.length,
        z: ring.reduce((sum, point) => sum + point.z, 0) / ring.length,
      };
      features.push({
        kind: 'road-surface', sourceId: `${platform ? 'platform' : 'street-area'}:${element.id ?? 'anonymous'}`,
        role: platform ? 'tram-platform' : 'street-area',
        surface: platform || highway === 'pedestrian' ? 'pavement' : 'asphalt',
        elevation: platform ? 0.18 : 0.027, x: rounded(center.x), z: rounded(center.z),
        outline: ring.map((point) => [rounded(point.x - center.x), rounded(point.z - center.z)]),
      });
      continue;
    }
    const source = `${railway === 'tram' ? 'tram' : 'road'}:${element.id ?? 'anonymous'}`;
    const width = railway === 'tram' ? 2.8 : roadWidth(tags);
    let part = 0;
    pathParts(points, width + 12, (path) => {
      const partId = part++;
      const addSurface = (role, surface, stripPoints, stripWidth, elevation = 0.025) => {
        const polygon = roadPath(stripPoints, stripWidth);
        if (polygon) features.push({
          kind: 'road-surface', sourceId: `${source}:${partId}:${role}`, role, surface, elevation, ...polygon,
        });
      };
      const addNav = (mode, navPoints, speed = 0, flags = 0) => {
        if (navPoints.length >= 2) features.push({
          kind: 'nav-path', sourceId: `${source}:${partId}:nav:${mode}:${features.length}`, mode, speed, flags, ...relativePath(navPoints),
        });
      };

      if (railway === 'tram') {
        const halfGauge = STREET_DEFAULTS.tramGauge / 2;
        addSurface('tram-bed', tags.embedded === 'yes' ? 'asphalt' : 'concrete', path, 2.8, 0.028);
        addSurface('tram-rail-left', 'rail', offsetPath(path, halfGauge), 0.075, 0.055);
        addSurface('tram-rail-right', 'rail', offsetPath(path, -halfGauge), 0.075, 0.055);
        addNav('tram', path, speedKmh(tags, 'tram'));
        return;
      }

      if (['footway', 'path', 'steps'].includes(highway)) {
        addSurface('footpath', 'pavement', path, roadWidth(tags), STREET_DEFAULTS.kerbHeight);
        addNav('pedestrian', path, 5);
        return;
      }
      if (highway === 'cycleway') {
        addSurface('cycleway', 'cycleway', path, roadWidth(tags));
        addNav('pedestrian', path, 12);
        return;
      }
      if (highway === 'pedestrian') {
        addSurface('pedestrian', 'pavement', path, width, STREET_DEFAULTS.kerbHeight);
        addNav('pedestrian', path, 5);
        return;
      }

      addSurface('carriageway', 'asphalt', path, width);
      const counts = laneCounts(tags);
      const speed = speedKmh(tags, highway);
      const laneWidth = Math.min(STREET_DEFAULTS.trafficLane, width / Math.max(1, counts.forward + counts.backward));
      for (let lane = 0; lane < counts.forward; lane++) {
        const offset = counts.backward > 0
          ? -(lane + 0.5) * laneWidth
          : ((counts.forward - 1) / 2 - lane) * laneWidth;
        addNav('vehicle', offsetPath(path, offset), speed);
      }
      for (let lane = 0; lane < counts.backward; lane++) {
        const offset = counts.forward > 0
          ? -(lane + 0.5) * laneWidth
          : ((counts.backward - 1) / 2 - lane) * laneWidth;
        addNav('vehicle', offsetPath([...path].reverse(), offset), speed);
      }

      if (counts.forward > 0 && counts.backward > 0) addSurface('centre-line', 'marking', path, 0.11, 0.04);
      for (let lane = 1; lane < counts.forward; lane++) {
        addSurface(`lane-line-forward-${lane}`, 'marking', offsetPath(path, -lane * laneWidth), 0.09, 0.04);
      }
      for (let lane = 1; lane < counts.backward; lane++) {
        addSurface(`lane-line-backward-${lane}`, 'marking', offsetPath(path, lane * laneWidth), 0.09, 0.04);
      }
      if (counts.backward === 0 && counts.forward > 1) {
        for (let lane = 1; lane < counts.forward; lane++) {
          const offset = (counts.forward / 2 - lane) * laneWidth;
          addSurface(`lane-line-oneway-${lane}`, 'marking', offsetPath(path, offset), 0.09, 0.04);
        }
      }
      const medianWidth = metres(tags['median:width']) ?? (/yes|median|island/.test(`${tags.median ?? ''} ${tags.divider ?? ''}`) ? 1.5 : null);
      if (medianWidth !== null) addSurface('median', 'concrete', path, Math.min(6, medianWidth), 0.15);
      for (const [side, sign] of [['left', 1], ['right', -1]]) {
        const parking = `${tags[`parking:${side}`] ?? ''} ${tags[`parking:lane:${side}`] ?? ''}`;
        if (/lane|parallel|diagonal|perpendicular/.test(parking)) {
          addSurface(`parking-lane-${side}`, 'asphalt', offsetPath(path, sign * (width / 2 - STREET_DEFAULTS.parkingLane / 2)), STREET_DEFAULTS.parkingLane, 0.032);
          addSurface(`parking-line-${side}`, 'marking', offsetPath(path, sign * (width / 2 - STREET_DEFAULTS.parkingLane)), 0.09, 0.04);
        }
        const cycle = `${tags[`cycleway:${side}`] ?? ''} ${tags.cycleway ?? ''}`;
        if (/lane|track|shared_lane/.test(cycle)) {
          addSurface(`cycle-lane-${side}`, 'cycleway', offsetPath(path, sign * (width / 2 - STREET_DEFAULTS.cycleLane / 2)), STREET_DEFAULTS.cycleLane, 0.035);
        }
      }
      for (const side of sidewalkSides(tags)) {
        const footWidth = sidewalkWidth(tags, side);
        const sign = side === 'left' ? 1 : -1;
        const sidewalk = offsetPath(path, sign * (width / 2 + footWidth / 2));
        addSurface(`footpath-${side}`, 'pavement', sidewalk, footWidth, STREET_DEFAULTS.kerbHeight);
        addNav('pedestrian', sidewalk, 5);
      }
    });
  }
  return features;
}
