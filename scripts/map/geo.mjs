export const TILE = 12;
export const MAP_SIZE = 720;
export const MAP_CENTER = { lat: -37.835, lon: 144.96 };
export const CHUNK_TILES = 10;

const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((MAP_CENTER.lat * Math.PI) / 180);

export function toWorld(lat, lon) {
  return {
    x: (lon - MAP_CENTER.lon) * M_PER_DEG_LON,
    z: (MAP_CENTER.lat - lat) * M_PER_DEG_LAT,
  };
}

export function toGrid(x, z) {
  const gx = Math.round(x / TILE) + MAP_SIZE / 2;
  const gz = Math.round(z / TILE) + MAP_SIZE / 2;
  if (gx < 0 || gz < 0 || gx >= MAP_SIZE || gz >= MAP_SIZE) return null;
  return { gx, gz, index: gx + gz * MAP_SIZE };
}

export function coordinateToGrid(coordinate) {
  if (!Array.isArray(coordinate) || coordinate.length < 2) return null;
  return toGrid(...Object.values(toWorld(coordinate[1], coordinate[0])));
}

export function inMap(lat, lon, margin = 0) {
  const { x, z } = toWorld(lat, lon);
  const half = (MAP_SIZE * TILE) / 2 + margin;
  return Math.abs(x) <= half && Math.abs(z) <= half;
}

export function lineStrings(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString') return geometry.coordinates;
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
}

export function polygons(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

export function pointCoordinates(feature) {
  const geometry = feature?.geometry;
  if (geometry?.type === 'Point') return geometry.coordinates;
  const p = feature?.properties ?? {};
  const location = property(p, 'location', 'geo_point_2d', 'geopoint');
  if (Array.isArray(location) && location.length >= 2) {
    const [a, b] = location.map(Number);
    return Math.abs(a) <= 90 ? [b, a] : [a, b];
  }
  if (location && Number.isFinite(Number(location.lon)) && Number.isFinite(Number(location.lat))) {
    return [Number(location.lon), Number(location.lat)];
  }
  const lat = Number(property(p, 'latitude', 'lat', 'y'));
  const lon = Number(property(p, 'longitude', 'lon', 'lng', 'x'));
  return Number.isFinite(lat) && Number.isFinite(lon) ? [lon, lat] : null;
}

export function markLine(mask, coordinates, value = 1, radius = 0) {
  let previous = null;
  for (let i = 0; i < coordinates.length - 1; i++) {
    const a = toWorld(coordinates[i][1], coordinates[i][0]);
    const b = toWorld(coordinates[i + 1][1], coordinates[i + 1][0]);
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(length / (TILE / 3)));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const grid = toGrid(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      if (!grid) {
        previous = null;
        continue;
      }
      if (previous && grid.gx !== previous.gx && grid.gz !== previous.gz) {
        paint(mask, previous.gx, grid.gz, value, radius);
      }
      paint(mask, grid.gx, grid.gz, value, radius);
      previous = grid;
    }
  }
}

function paint(mask, gx, gz, value, radius) {
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = gx + dx;
      const z = gz + dz;
      if (x >= 0 && z >= 0 && x < MAP_SIZE && z < MAP_SIZE) mask[x + z * MAP_SIZE] = value;
    }
  }
}

export function fillPolygon(mask, ring, value = 1) {
  if (!Array.isArray(ring) || ring.length < 4) return;
  const points = ring.map(([lon, lat]) => toWorld(lat, lon));
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }
  const gz0 = Math.max(0, Math.round(minZ / TILE) + MAP_SIZE / 2);
  const gz1 = Math.min(MAP_SIZE - 1, Math.round(maxZ / TILE) + MAP_SIZE / 2);
  for (let gz = gz0; gz <= gz1; gz++) {
    const z = (gz - MAP_SIZE / 2) * TILE;
    const intersections = [];
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (a.z === b.z || z < Math.min(a.z, b.z) || z >= Math.max(a.z, b.z)) continue;
      intersections.push(a.x + ((z - a.z) / (b.z - a.z)) * (b.x - a.x));
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const gx0 = Math.max(0, Math.round(intersections[i] / TILE) + MAP_SIZE / 2);
      const gx1 = Math.min(MAP_SIZE - 1, Math.round(intersections[i + 1] / TILE) + MAP_SIZE / 2);
      for (let gx = gx0; gx <= gx1; gx++) mask[gx + gz * MAP_SIZE] = value;
    }
  }
}

export function orientedBounds(ring) {
  const points = ring.slice(0, -1).map(([lon, lat]) => toWorld(lat, lon));
  if (points.length < 3) return null;
  const center = points.reduce((sum, p) => ({ x: sum.x + p.x, z: sum.z + p.z }), { x: 0, z: 0 });
  center.x /= points.length;
  center.z /= points.length;
  let xx = 0;
  let zz = 0;
  let xz = 0;
  for (const p of points) {
    const x = p.x - center.x;
    const z = p.z - center.z;
    xx += x * x;
    zz += z * z;
    xz += x * z;
  }
  const rotation = 0.5 * Math.atan2(2 * xz, xx - zz);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    const dx = p.x - center.x;
    const dz = p.z - center.z;
    const x = dx * cos + dz * sin;
    const z = -dx * sin + dz * cos;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return {
    x: center.x + ((minX + maxX) / 2) * cos - ((minZ + maxZ) / 2) * sin,
    z: center.z + ((minX + maxX) / 2) * sin + ((minZ + maxZ) / 2) * cos,
    width: maxX - minX,
    depth: maxZ - minZ,
    rotation: -rotation,
  };
}

function pointSegmentDistanceSq(point, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq === 0) return (point.x - a.x) ** 2 + (point.z - a.z) ** 2;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSq));
  const x = a.x + dx * t;
  const z = a.z + dz * t;
  return (point.x - x) ** 2 + (point.z - z) ** 2;
}

function simplifyOpenPath(points, toleranceSq) {
  if (points.length <= 2) return points;
  let farthest = -1;
  let maxDistanceSq = toleranceSq;
  for (let i = 1; i < points.length - 1; i++) {
    const distanceSq = pointSegmentDistanceSq(points[i], points[0], points.at(-1));
    if (distanceSq > maxDistanceSq) {
      farthest = i;
      maxDistanceSq = distanceSq;
    }
  }
  if (farthest < 0) return [points[0], points.at(-1)];
  return [
    ...simplifyOpenPath(points.slice(0, farthest + 1), toleranceSq).slice(0, -1),
    ...simplifyOpenPath(points.slice(farthest), toleranceSq),
  ];
}

/** Convert a closed lon/lat ring to a compact world-space polygon. */
export function simplifyWorldRing(ring, tolerance = 0.75, maxPoints = 96) {
  if (!Array.isArray(ring) || ring.length < 4) return [];
  const points = ring.map(([lon, lat]) => toWorld(lat, lon));
  if (Math.hypot(points[0].x - points.at(-1).x, points[0].z - points.at(-1).z) < 0.01) {
    points.pop();
  }
  if (points.length < 3) return [];

  let farthest = 1;
  let farthestDistanceSq = 0;
  for (let i = 1; i < points.length; i++) {
    const distanceSq = (points[i].x - points[0].x) ** 2 + (points[i].z - points[0].z) ** 2;
    if (distanceSq > farthestDistanceSq) {
      farthest = i;
      farthestDistanceSq = distanceSq;
    }
  }
  let currentTolerance = tolerance;
  let simplified = points;
  do {
    const first = simplifyOpenPath(points.slice(0, farthest + 1), currentTolerance ** 2);
    const second = simplifyOpenPath([...points.slice(farthest), points[0]], currentTolerance ** 2);
    simplified = [...first.slice(0, -1), ...second.slice(0, -1)];
    currentTolerance *= 1.5;
  } while (simplified.length > maxPoints);
  return simplified;
}

export function chunkKeyForWorld(x, z) {
  const cx = Math.round(x / TILE);
  const cz = Math.round(z / TILE);
  return `${Math.floor(cx / CHUNK_TILES)},${Math.floor(cz / CHUNK_TILES)}`;
}

export function nearestCell(mask, gx, gz, radius = 2) {
  let best = null;
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = gx + dx;
      const z = gz + dz;
      if (x < 0 || z < 0 || x >= MAP_SIZE || z >= MAP_SIZE) continue;
      const index = x + z * MAP_SIZE;
      if (!mask[index]) continue;
      const distance = dx * dx + dz * dz;
      if (!best || distance < best.distance) best = { gx: x, gz: z, index, distance };
    }
  }
  return best;
}

export function featureCollection(value) {
  if (value?.type === 'FeatureCollection' && Array.isArray(value.features)) return value.features;
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.results)) {
    return value.results.map((properties) => ({
      type: 'Feature',
      properties,
      geometry: properties.geo_shape?.geometry ?? properties.geo_shape ?? null,
    }));
  }
  throw new Error('expected a GeoJSON FeatureCollection or Opendatasoft result set');
}

export function property(properties, ...names) {
  const entries = Object.entries(properties ?? {});
  for (const name of names) {
    const match = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (match && match[1] !== null && match[1] !== '') return match[1];
  }
  return undefined;
}
