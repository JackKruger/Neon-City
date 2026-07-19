import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { parse as parseDelimited } from 'csv-parse/sync';
import { fromFile } from 'geotiff';
import proj4 from 'proj4';
import { read as readShapefile } from 'shapefile';
import {
  CHUNK_TILES,
  MAP_CENTER,
  MAP_SIZE,
  TILE,
  chunkKeyForWorld,
  featureCollection,
  fillPolygon,
  inMap,
  lineStrings,
  markLine,
  nearestCell,
  orientedBounds,
  pointCoordinates,
  polygons,
  property,
  simplifyWorldRing,
  splitPolygonByChunks,
  toGrid,
  toWorld,
} from './geo.mjs';

export const TRANSPORT = {
  ROAD: 1,
  BRIDGE: 2,
  TUNNEL: 4,
  RAIL: 8,
  TRAM: 16,
  FOOTPATH: 32,
  ROUNDABOUT: 64,
};

export const LAND_USE = {
  UNKNOWN: 0,
  RESIDENTIAL_LOW: 1,
  RESIDENTIAL_HIGH: 2,
  COMMERCIAL: 3,
  RETAIL: 4,
  INDUSTRIAL: 5,
  CIVIC: 6,
  OPEN_SPACE: 7,
  TRANSPORT: 8,
  WATER: 9,
};

export const COVERAGE = { BUILDING: 1, TREE: 2, PARKING: 4, PROP: 8, ADDRESS: 16 };

const ODS_ROOT = 'https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets';
const SOURCE_DEFINITIONS = {
  buildings: {
    file: 'building-footprints.geojson',
    dataset: '2023-building-footprints',
    title: 'City of Melbourne 2023 Building Footprints',
    license: 'CC BY 4.0',
  },
  trees: {
    file: 'urban-forest-trees.geojson',
    dataset: 'trees-with-species-and-dimensions-urban-forest',
    title: 'City of Melbourne Urban Forest Trees',
    license: 'CC BY 4.0',
  },
  canopy: {
    file: 'tree-canopies.geojson',
    dataset: 'tree-canopies-2021-urban-forest',
    title: 'City of Melbourne Tree Canopies 2021',
    license: 'CC BY 4.0',
  },
  furniture: {
    file: 'street-furniture.geojson',
    dataset: 'street-furniture-including-bollards-bicycle-rails-bins-drinking-fountains-horse-',
    title: 'City of Melbourne Street Furniture',
    license: 'CC BY 4.0',
  },
  art: {
    file: 'public-art.geojson',
    dataset: 'public-artworks-fountains-and-monuments',
    title: 'City of Melbourne Public Artworks, Fountains and Monuments',
    license: 'CC BY 4.0',
  },
  parking: {
    file: 'parking-bays.geojson',
    dataset: 'on-street-parking-bays',
    title: 'City of Melbourne On-street Parking Bays',
    license: 'CC BY 4.0',
  },
  transport: { file: 'vicmap-transport.geojson', title: 'Vicmap Transport', license: 'CC BY 4.0' },
  speeds: { file: 'speed-zones.geojson', title: 'Victorian Speed Zones', license: 'CC BY 4.0' },
  planning: { file: 'vicmap-planning.geojson', title: 'Vicmap Planning', license: 'CC BY 4.0' },
  clue: { file: 'clue-floor-space.geojson', title: 'City of Melbourne CLUE Floor Space', license: 'CC BY 4.0' },
  addresses: { file: 'vicmap-address.geojson', title: 'Vicmap Address', license: 'CC BY 4.0' },
  gnaf: { file: 'gnaf-address.geojson', title: 'G-NAF', license: 'Open G-NAF End User Licence' },
  geoscape: { file: 'geoscape-localities.geojson', title: 'Geoscape Localities', license: 'CC BY 4.0' },
  abs: { file: 'abs-localities.geojson', title: 'ABS ASGS Boundaries', license: 'CC BY 4.0' },
};

function exportUrl(dataset) {
  return `${ODS_ROOT}/${dataset}/exports/geojson?lang=en&timezone=Australia%2FMelbourne`;
}

function download(url, path) {
  mkdirSync(dirname(path), { recursive: true });
  execFileSync('curl', ['-sS', '--fail', '--location', '--retry', '3', '-A', 'neon-city-map-builder/2.0', url, '-o', path], {
    stdio: 'inherit',
  });
}

async function readFeatures(path) {
  const extension = extname(path).toLowerCase();
  if (extension === '.shp') {
    const collection = await readShapefile(path);
    const prjPath = path.slice(0, -4) + '.prj';
    if (existsSync(prjPath)) reprojectCollection(collection, readFileSync(prjPath, 'utf8'));
    return featureCollection(collection);
  }
  if (extension === '.csv' || extension === '.psv') {
    const input = readFileSync(path, 'utf8');
    const header = input.slice(0, input.indexOf('\n'));
    const delimiter = extension === '.psv' || header.includes('|') ? '|' : header.includes('\t') ? '\t' : ',';
    const records = parseDelimited(input, { columns: true, delimiter, skip_empty_lines: true, relax_column_count: true, bom: true });
    return records.map((properties) => {
      let geometry = null;
      const rawGeometry = property(properties, 'geo_shape', 'geometry');
      if (typeof rawGeometry === 'string' && rawGeometry.trim().startsWith('{')) {
        try { geometry = JSON.parse(rawGeometry); } catch { /* point fields remain available */ }
      }
      return { type: 'Feature', properties, geometry };
    });
  }
  return featureCollection(JSON.parse(readFileSync(path, 'utf8')));
}

function reprojectCollection(collection, sourceProjection) {
  const transform = proj4(sourceProjection, 'EPSG:4326');
  const visit = (coordinates) => {
    if (!Array.isArray(coordinates)) return coordinates;
    if (coordinates.length >= 2 && typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
      return transform.forward(coordinates);
    }
    return coordinates.map(visit);
  };
  for (const feature of collection.features ?? []) {
    if (feature.geometry?.coordinates) feature.geometry.coordinates = visit(feature.geometry.coordinates);
  }
}

function findSourcePath(cacheDir, filename) {
  const preferred = join(cacheDir, filename);
  if (existsSync(preferred)) return preferred;
  const stem = preferred.slice(0, -extname(preferred).length);
  return ['.shp', '.csv', '.psv', '.json'].map((extension) => stem + extension).find(existsSync) ?? preferred;
}

async function loadSource(cacheDir, key, options, report) {
  const definition = SOURCE_DEFINITIONS[key];
  let path = findSourcePath(cacheDir, definition.file);
  if (options.download && definition.dataset && (!existsSync(path) || options.refresh)) {
    path = join(cacheDir, definition.file);
    console.log(`[open-data] downloading ${definition.title}`);
    download(exportUrl(definition.dataset), path);
  }
  if (!existsSync(path)) {
    report.sources.push({ key, title: definition.title, status: 'missing', file: definition.file });
    return null;
  }
  try {
    const features = await readFeatures(path);
    report.sources.push({
      key,
      title: definition.title,
      license: definition.license,
      status: 'loaded',
      file: basename(path),
      records: features.length,
      retrievedAt: statSync(path).mtime.toISOString(),
    });
    return features;
  } catch (error) {
    report.sources.push({ key, title: definition.title, status: 'invalid', file: definition.file, error: error.message });
    console.warn(`[open-data] ${definition.file}: ${error.message}`);
    return null;
  }
}

function addObject(chunks, object) {
  if ((object.kind === 'road-surface' || object.kind === 'building') && object.outline?.length >= 3) {
    const sourceId = object.sourceId ??
      `${object.kind}:${object.x}:${object.z}:${object.rotation ?? 0}:${object.width ?? 0}:${object.depth ?? 0}`;
    const polygon = object.outline.map(([x, z]) => [object.x + x, object.z + z]);
    for (const part of splitPolygonByChunks(polygon)) {
      (chunks[part.key] ??= []).push({
        ...object,
        sourceId,
        outline: part.polygon.map(([x, z]) => [round(x - object.x), round(z - object.z)]),
      });
    }
    return;
  }
  const key = chunkKeyForWorld(object.x, object.z);
  (chunks[key] ??= []).push(object);
}

/** Rebuild a legacy centroid-owned object index using clipped polygon ownership. */
export function rechunkObjectIndex(index) {
  if (index?.version >= 2 && index.ownership === 'clipped-polygons') return index;
  const chunks = {};
  const seen = new Set();
  for (const object of Object.values(index?.chunks ?? {}).flat()) {
    const signature = JSON.stringify(object);
    if (seen.has(signature)) continue;
    seen.add(signature);
    addObject(chunks, object);
  }
  for (const values of Object.values(chunks)) {
    values.sort((a, b) => a.kind.localeCompare(b.kind) || a.x - b.x || a.z - b.z);
  }
  return {
    version: 2,
    chunkTiles: CHUNK_TILES,
    ownership: 'clipped-polygons',
    roadSurfaces: index?.roadSurfaces === true,
    chunks,
  };
}

function featureRing(feature) {
  const candidates = polygons(feature.geometry);
  if (candidates.length === 0) return null;
  return candidates
    .map((polygon) => polygon[0])
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] ?? null;
}

function numeric(properties, ...names) {
  const value = Number(property(properties, ...names));
  return Number.isFinite(value) ? value : null;
}

function textValue(properties, ...names) {
  return String(property(properties, ...names) ?? '').trim();
}

function classifyLandUse(properties) {
  const value = Object.values(properties ?? {}).join(' ').toLowerCase();
  if (/water|port water/.test(value)) return LAND_USE.WATER;
  if (/public park|open space|conservation|green wedge|recreation/.test(value)) return LAND_USE.OPEN_SPACE;
  if (/industrial|port zone/.test(value)) return LAND_USE.INDUSTRIAL;
  if (/commercial|capital city|mixed use/.test(value)) return LAND_USE.COMMERCIAL;
  if (/retail|entertainment|hospitality/.test(value)) return LAND_USE.RETAIL;
  if (/residential growth|high density|activity centre/.test(value)) return LAND_USE.RESIDENTIAL_HIGH;
  if (/residential|neighbourhood/.test(value)) return LAND_USE.RESIDENTIAL_LOW;
  if (/transport|road|rail|parking/.test(value)) return LAND_USE.TRANSPORT;
  if (/public use|education|hospital|civic|special use/.test(value)) return LAND_USE.CIVIC;
  return LAND_USE.UNKNOWN;
}

function classifyBuildingStyle(landUse, height) {
  if (landUse === LAND_USE.INDUSTRIAL) return 'industrial';
  if (landUse === LAND_USE.RESIDENTIAL_LOW && height < 14) return 'suburban';
  if (height >= 45) return 'skyscraper';
  return 'commercial';
}

function buildingHeight(properties) {
  return (
    numeric(properties, 'structure_extrusion', 'structure_height', 'height', 'height_m') ??
    (() => {
      const max = numeric(properties, 'structure_max_elevation', 'footprint_max_elevation', 'max_elevation');
      const min = numeric(properties, 'structure_min_elevation', 'footprint_min_elevation', 'min_elevation');
      return max !== null && min !== null ? max - min : null;
    })()
  );
}

function importLandUse(features, layer, codeGrid) {
  if (!features) return 0;
  let accepted = 0;
  for (const feature of features) {
    const code = classifyLandUse(feature.properties);
    if (code === LAND_USE.UNKNOWN) continue;
    for (const polygon of polygons(feature.geometry)) {
      if (!polygon[0]) continue;
      fillPolygon(layer, polygon[0], code);
      accepted++;
    }
  }
  for (let i = 0; i < layer.length; i++) {
    if (layer[i] === LAND_USE.WATER) codeGrid[i] = 5;
    else if (layer[i] === LAND_USE.OPEN_SPACE && codeGrid[i] !== 1) codeGrid[i] = 4;
    else if ((layer[i] === LAND_USE.COMMERCIAL || layer[i] === LAND_USE.RETAIL || layer[i] === LAND_USE.INDUSTRIAL || layer[i] === LAND_USE.RESIDENTIAL_HIGH) && codeGrid[i] !== 1 && codeGrid[i] !== 5) codeGrid[i] = 2;
    else if (layer[i] === LAND_USE.RESIDENTIAL_LOW && codeGrid[i] !== 1 && codeGrid[i] !== 5) codeGrid[i] = 3;
  }
  return accepted;
}

function transportFlags(properties) {
  const value = Object.values(properties ?? {}).join(' ').toLowerCase();
  let flags = 0;
  if (/tram|light rail/.test(value)) flags |= TRANSPORT.TRAM | TRANSPORT.RAIL;
  else if (/rail|train/.test(value)) flags |= TRANSPORT.RAIL;
  if (/footpath|footbridge|pedestrian|walking/.test(value)) flags |= TRANSPORT.FOOTPATH;
  if (flags === 0 || /road|street|highway|freeway|connector|bridge/.test(value)) flags |= TRANSPORT.ROAD;
  if (/bridge|overpass/.test(value)) flags |= TRANSPORT.BRIDGE;
  if (/tunnel|underpass/.test(value)) flags |= TRANSPORT.TUNNEL;
  if (/roundabout/.test(value)) flags |= TRANSPORT.ROUNDABOUT;
  return flags;
}

function importTransport(features, layer, codeGrid) {
  if (!features) return 0;
  let accepted = 0;
  for (const feature of features) {
    const flags = transportFlags(feature.properties);
    const parts = lineStrings(feature.geometry);
    if (parts.length === 0) continue;
    const featureLayer = new Uint8Array(layer.length);
    for (const line of parts) markLine(featureLayer, line, flags);
    for (let i = 0; i < layer.length; i++) {
      if (!featureLayer[i]) continue;
      layer[i] |= featureLayer[i];
      if (featureLayer[i] & TRANSPORT.ROAD) codeGrid[i] = 1;
    }
    accepted++;
  }
  return accepted;
}

function speedClass(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value <= 30) return 1;
  if (value <= 40) return 2;
  if (value <= 50) return 3;
  if (value <= 60) return 4;
  return 5;
}

function importSpeeds(features, speedLayer, roadMask) {
  if (!features) return 0;
  let accepted = 0;
  for (const feature of features) {
    const limit = numeric(feature.properties, 'speed_zone', 'speedzone', 'speed_limit', 'speedlimit', 'speed', 'speed_kmh');
    const code = speedClass(limit);
    if (!code) continue;
    const marked = new Uint8Array(speedLayer.length);
    for (const line of lineStrings(feature.geometry)) markLine(marked, line, code);
    for (let i = 0; i < marked.length; i++) {
      if (!marked[i]) continue;
      const gx = i % MAP_SIZE;
      const gz = Math.floor(i / MAP_SIZE);
      const road = nearestCell(roadMask, gx, gz, 2);
      if (!road) continue;
      if (speedLayer[road.index] === 0 || code < speedLayer[road.index]) speedLayer[road.index] = code;
    }
    accepted++;
  }
  return accepted;
}

function importBuildings(features, chunks, coverage, heightLayer, landUseLayer, dsm) {
  if (!features) return { accepted: 0, rejected: 0 };
  const byStructure = new Map();
  let rejected = 0;
  for (const feature of features) {
    const ring = featureRing(feature);
    const bounds = ring && orientedBounds(ring);
    if (!ring || !bounds || !toGrid(bounds.x, bounds.z) || bounds.width * bounds.depth < 12) {
      rejected++;
      continue;
    }
    const id = textValue(feature.properties, 'structure_id', 'structureid', 'building_id', 'objectid') || `${bounds.x},${bounds.z}`;
    const previous = byStructure.get(id);
    if (!previous || bounds.width * bounds.depth > previous.bounds.width * previous.bounds.depth) {
      byStructure.set(id, { feature, ring, bounds });
    }
  }
  const pending = [];
  for (const [id, { feature, ring, bounds }] of byStructure) {
    const grid = toGrid(bounds.x, bounds.z);
    const landUse = grid ? landUseLayer[grid.index] : LAND_USE.UNKNOWN;
    let height = buildingHeight(feature.properties);
    const sourceId = `building:${id}`;
    if (!height && dsm) pending.push({ feature, ring, bounds, landUse, sourceId });
    else addBuilding(feature, ring, bounds, landUse, height, chunks, coverage, heightLayer, sourceId);
  }
  return { accepted: byStructure.size, rejected, pending };
}

function addBuilding(feature, ring, bounds, landUse, rawHeight, chunks, coverage, heightLayer, sourceId) {
  const height = Math.max(3, Math.min(255, Number(rawHeight) || Math.max(5, Math.sqrt(bounds.width * bounds.depth) * 0.7)));
  const style = classifyBuildingStyle(landUse, height);
  const outline = simplifyWorldRing(ring).map((point) => [
    round(point.x - bounds.x),
    round(point.z - bounds.z),
  ]);
  addObject(chunks, {
    kind: 'building',
    sourceId,
    x: round(bounds.x),
    z: round(bounds.z),
    rotation: round(bounds.rotation),
    width: round(Math.max(2, bounds.width)),
    depth: round(Math.max(2, bounds.depth)),
    height: round(height),
    style,
    roof: textValue(feature.properties, 'roof_type', 'rooftype').toLowerCase() || undefined,
    ...(outline.length >= 3 ? { outline } : {}),
  });
  for (const polygon of [ring]) {
    fillPolygon(coverage, polygon, coverageBuilding(coverage));
    const temp = new Uint8Array(heightLayer.length);
    fillPolygon(temp, polygon, Math.round(height));
    for (let i = 0; i < temp.length; i++) if (temp[i]) heightLayer[i] = Math.max(heightLayer[i], temp[i]);
  }
}

function coverageBuilding(coverage) {
  // fillPolygon assigns rather than ORs; retain other coverage bits afterwards in point importers.
  void coverage;
  return COVERAGE.BUILDING;
}

function treeHeight(properties) {
  return numeric(properties, 'tree_height', 'height', 'height_m', 'height_metre') ?? 6;
}

function importTrees(features, chunks, coverage) {
  if (!features) return 0;
  let accepted = 0;
  for (const feature of features) {
    const point = pointCoordinates(feature);
    if (!point || !inMap(point[1], point[0])) continue;
    const world = toWorld(point[1], point[0]);
    const grid = toGrid(world.x, world.z);
    if (!grid) continue;
    const species = textValue(feature.properties, 'common_name', 'commonname', 'species', 'scientific_name');
    const height = Math.max(2.5, Math.min(20, treeHeight(feature.properties)));
    addObject(chunks, {
      kind: 'tree',
      x: round(world.x),
      z: round(world.z),
      height: round(height),
      variant: /palm|cycad/.test(species.toLowerCase()) ? 'small' : 'large',
    });
    coverage[grid.index] |= COVERAGE.TREE;
    accepted++;
  }
  return accepted;
}

function importCanopies(features, chunks, coverage) {
  if (!features) return 0;
  let accepted = 0;
  for (const feature of features) {
    const ring = featureRing(feature);
    const bounds = ring && orientedBounds(ring);
    if (!bounds) continue;
    const grid = toGrid(bounds.x, bounds.z);
    if (!grid || treeCoveredNearby(coverage, grid.gx, grid.gz)) continue;
    const height = Math.max(3.5, Math.min(14, Math.sqrt(Math.max(4, bounds.width * bounds.depth)) * 0.9));
    addObject(chunks, {
      kind: 'tree',
      x: round(bounds.x),
      z: round(bounds.z),
      height: round(height),
      variant: height < 5 ? 'small' : 'large',
    });
    coverage[grid.index] |= COVERAGE.TREE;
    accepted++;
  }
  return accepted;
}

function treeCoveredNearby(coverage, gx, gz) {
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = gx + dx;
      const z = gz + dz;
      if (x < 0 || z < 0 || x >= MAP_SIZE || z >= MAP_SIZE) continue;
      if (coverage[x + z * MAP_SIZE] & COVERAGE.TREE) return true;
    }
  }
  return false;
}

function furnitureKind(properties) {
  const value = Object.values(properties ?? {}).join(' ').toLowerCase();
  if (/bollard/.test(value)) return 'bollard';
  if (/bicycle|bike|hoop|rail/.test(value)) return 'bicycle-rail';
  if (/bin|litter/.test(value)) return 'bin';
  if (/drink|fountain|trough/.test(value)) return 'fountain';
  if (/seat|picnic|bench/.test(value)) return 'seat';
  if (/planter|floral|crate/.test(value)) return 'planter';
  if (/barbeque|barbecue/.test(value)) return 'barbecue';
  return null;
}

function importPointObjects(features, chunks, coverage, art = false) {
  if (!features) return 0;
  let accepted = 0;
  const seen = new Set();
  for (const feature of features) {
    const point = pointCoordinates(feature);
    if (!point || !inMap(point[1], point[0])) continue;
    const kind = art ? (/fountain/i.test(Object.values(feature.properties ?? {}).join(' ')) ? 'fountain' : 'art') : furnitureKind(feature.properties);
    if (!kind) continue;
    const world = toWorld(point[1], point[0]);
    const grid = toGrid(world.x, world.z);
    if (!grid) continue;
    const spacing = kind === 'bollard' || kind === 'bicycle-rail' ? 2 : kind === 'art' ? 1.5 : 0.75;
    const dedupeKey = `${kind}:${Math.round(world.x / spacing)}:${Math.round(world.z / spacing)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    addObject(chunks, { kind, x: round(world.x), z: round(world.z), rotation: 0 });
    coverage[grid.index] |= COVERAGE.PROP;
    accepted++;
  }
  return accepted;
}

function roadOrientation(roadMask, gx, gz) {
  const at = (x, z) => x >= 0 && z >= 0 && x < MAP_SIZE && z < MAP_SIZE && roadMask[x + z * MAP_SIZE];
  const vertical = Number(at(gx, gz - 1)) + Number(at(gx, gz + 1));
  const horizontal = Number(at(gx - 1, gz)) + Number(at(gx + 1, gz));
  return horizontal > vertical ? Math.PI / 2 : 0;
}

function importParking(features, chunks, coverage, roadMask) {
  if (!features) return 0;
  let accepted = 0;
  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    const point = pointCoordinates(feature) ?? (() => {
      const ring = featureRing(feature);
      const bounds = ring && orientedBounds(ring);
      if (!bounds) return null;
      const lon = MAP_CENTER.lon + bounds.x / (111320 * Math.cos((MAP_CENTER.lat * Math.PI) / 180));
      const lat = MAP_CENTER.lat - bounds.z / 111320;
      return [lon, lat];
    })();
    if (!point || !inMap(point[1], point[0])) continue;
    const world = toWorld(point[1], point[0]);
    const grid = toGrid(world.x, world.z);
    if (!grid) continue;
    const road = nearestCell(roadMask, grid.gx, grid.gz, 2);
    if (!road) continue;
    coverage[road.index] |= COVERAGE.PARKING;
    // Keep one representative parked car per four mapped bays.
    if ((i * 2654435761 >>> 0) % 4 !== 0) continue;
    const x = (road.gx - MAP_SIZE / 2) * TILE;
    const z = (road.gz - MAP_SIZE / 2) * TILE;
    addObject(chunks, { kind: 'parking', x, z, rotation: roadOrientation(roadMask, road.gx, road.gz) });
    accepted++;
  }
  return accepted;
}

function importAddresses(features, density, coverage) {
  if (!features) return { accepted: 0, streets: [] };
  const streets = new Set();
  let accepted = 0;
  for (const feature of features) {
    const point = pointCoordinates(feature);
    if (!point || !inMap(point[1], point[0])) continue;
    const world = toWorld(point[1], point[0]);
    const grid = toGrid(world.x, world.z);
    if (!grid) continue;
    density[grid.index] = Math.min(255, density[grid.index] + 1);
    coverage[grid.index] |= COVERAGE.ADDRESS;
    const street = textValue(feature.properties, 'road_name', 'street_name', 'streetname', 'address_detail', 'street');
    if (street) streets.add(street.replace(/\s+/g, ' ').trim());
    accepted++;
  }
  return { accepted, streets: [...streets].sort((a, b) => a.localeCompare(b)) };
}

function importBoundaries(features) {
  if (!features) return null;
  const records = [];
  for (const feature of features) {
    const name = textValue(feature.properties, 'locality_name', 'localityname', 'sal_name21', 'sal_name', 'suburb', 'name');
    const polygon = polygons(feature.geometry)[0];
    const id = textValue(feature.properties, 'locality_pid', 'locality_id', 'sal_code21', 'sal_code', 'ssc_code21', 'id');
    if (name && polygon?.[0]) records.push({ name, id: id || undefined, ring: polygon[0] });
  }
  records.sort((a, b) => a.name.localeCompare(b.name));
  if (records.length === 0 || records.length > 254) return null;
  const grid = new Uint8Array(MAP_SIZE * MAP_SIZE).fill(255);
  records.forEach((record, index) => fillPolygon(grid, record.ring, index));
  const sumsX = new Float64Array(records.length);
  const sumsZ = new Float64Array(records.length);
  const counts = new Uint32Array(records.length);
  for (let i = 0; i < grid.length; i++) {
    const index = grid[i];
    if (index === 255) continue;
    sumsX[index] += ((i % MAP_SIZE) - MAP_SIZE / 2) * TILE;
    sumsZ[index] += (Math.floor(i / MAP_SIZE) - MAP_SIZE / 2) * TILE;
    counts[index]++;
  }
  const kept = records.map((record, old) => ({ record, old })).filter(({ old }) => counts[old] > 0);
  const remap = new Uint8Array(records.length).fill(255);
  kept.forEach(({ old }, index) => { remap[old] = index; });
  for (let i = 0; i < grid.length; i++) if (grid[i] !== 255) grid[i] = remap[grid[i]];
  return {
    grid,
    areas: kept.map(({ record }, index) => ({ index, name: record.name, id: record.id })),
    suburbs: kept.map(({ record, old }) => ({
      name: record.name,
      x: Math.round(sumsX[old] / counts[old]),
      z: Math.round(sumsZ[old] / counts[old]),
    })),
  };
}

class DsmSampler {
  static async open(path) {
    if (!path || !existsSync(path)) return null;
    const files = statSync(path).isDirectory()
      ? readdirSync(path).filter((name) => /\.tiff?$/i.test(name)).map((name) => join(path, name))
      : [path];
    const tiles = [];
    for (const file of files) {
      const tiff = await fromFile(file);
      const image = await tiff.getImage();
      const keys = image.getGeoKeys();
      const epsg = keys.ProjectedCSTypeGeoKey ?? keys.GeographicTypeGeoKey ?? 4326;
      tiles.push({ file, image, bbox: image.getBoundingBox(), epsg, blocks: new Map() });
    }
    return new DsmSampler(tiles);
  }

  constructor(tiles) {
    this.tiles = tiles;
    proj4.defs('EPSG:28355', '+proj=utm +zone=55 +south +ellps=GRS80 +units=m +no_defs');
    proj4.defs('EPSG:7855', '+proj=utm +zone=55 +south +ellps=GRS80 +units=m +no_defs');
  }

  async sample(lon, lat) {
    for (const tile of this.tiles) {
      const coordinate = tile.epsg === 4326 ? [lon, lat] : proj4('EPSG:4326', `EPSG:${tile.epsg}`, [lon, lat]);
      const [minX, minY, maxX, maxY] = tile.bbox;
      if (coordinate[0] < minX || coordinate[0] > maxX || coordinate[1] < minY || coordinate[1] > maxY) continue;
      const width = tile.image.getWidth();
      const height = tile.image.getHeight();
      const px = Math.max(0, Math.min(width - 1, Math.floor(((coordinate[0] - minX) / (maxX - minX)) * width)));
      const py = Math.max(0, Math.min(height - 1, Math.floor(((maxY - coordinate[1]) / (maxY - minY)) * height)));
      const raster = await tile.image.readRasters({ window: [px, py, px + 1, py + 1] });
      const value = Number(raster[0][0]);
      return Number.isFinite(value) ? value : null;
    }
    return null;
  }
}

async function finishDsmBuildings(pending, dsm, chunks, coverage, heightLayer) {
  if (!pending?.length) return;
  for (const item of pending) {
    const center = MAP_CENTER;
    const lon = center.lon + item.bounds.x / (111320 * Math.cos((center.lat * Math.PI) / 180));
    const lat = center.lat - item.bounds.z / 111320;
    const roof = await dsm.sample(lon, lat);
    // Without a DTM, use the footprint's minimum AHD as ground when supplied.
    const ground = numeric(item.feature.properties, 'structure_min_elevation', 'footprint_min_elevation', 'min_elevation');
    const height = roof !== null && ground !== null ? roof - ground : null;
    addBuilding(item.feature, item.ring, item.bounds, item.landUse, height, chunks, coverage, heightLayer, item.sourceId);
  }
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function writeLayer(outputDir, name, data) {
  writeFileSync(join(outputDir, `melbourne.${name}.bin`), data);
}

function thinChunkObjects(chunks) {
  const limits = { tree: 220, parking: 40, bollard: 120, 'bicycle-rail': 120, bin: 100, seat: 100 };
  const removed = {};
  for (const [key, values] of Object.entries(chunks)) {
    const groups = Map.groupBy(values, (value) => value.kind);
    const kept = [];
    for (const [kind, group] of groups) {
      group.sort((a, b) => a.x - b.x || a.z - b.z);
      const limit = limits[kind] ?? Infinity;
      if (group.length <= limit) {
        kept.push(...group);
        continue;
      }
      removed[kind] = (removed[kind] ?? 0) + group.length - limit;
      for (let i = 0; i < limit; i++) kept.push(group[Math.floor((i * group.length) / limit)]);
    }
    chunks[key] = kept;
  }
  return removed;
}

export async function enrichMelbourneMap({ root, grid, roadSurfaces = [], baseSuburbs, options = {} }) {
  const cacheDir = join(root, '.map-cache', 'open-data');
  const outputDir = join(root, 'public', 'maps');
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  const report = { version: 1, sources: [], results: {} };
  const N = MAP_SIZE * MAP_SIZE;
  const layers = {
    transport: new Uint8Array(N),
    speed: new Uint8Array(N),
    landuse: new Uint8Array(N),
    height: new Uint8Array(N),
    address: new Uint8Array(N),
    coverage: new Uint8Array(N),
  };
  const chunks = {};
  for (const surface of roadSurfaces) addObject(chunks, surface);

  const planning = await loadSource(cacheDir, 'planning', options, report);
  const clue = await loadSource(cacheDir, 'clue', options, report);
  report.results.landuse = importLandUse(planning, layers.landuse, grid) + importLandUse(clue, layers.landuse, grid);

  const transport = await loadSource(cacheDir, 'transport', options, report);
  report.results.transport = importTransport(transport, layers.transport, grid);
  const roadMask = Uint8Array.from(grid, (code) => code === 1 ? 1 : 0);
  report.results.speeds = importSpeeds(await loadSource(cacheDir, 'speeds', options, report), layers.speed, roadMask);

  const dsmPath = process.env.MELBOURNE_DSM_PATH ?? join(cacheDir, 'melbourne-dsm.tif');
  const dsm = await DsmSampler.open(dsmPath);
  report.sources.push({ key: 'dsm', title: 'City of Melbourne Digital Surface Model', status: dsm ? 'loaded' : 'missing', file: basename(dsmPath) });
  const buildingResult = importBuildings(await loadSource(cacheDir, 'buildings', options, report), chunks, layers.coverage, layers.height, layers.landuse, dsm);
  if (dsm) await finishDsmBuildings(buildingResult.pending, dsm, chunks, layers.coverage, layers.height);
  else for (const item of buildingResult.pending ?? []) addBuilding(item.feature, item.ring, item.bounds, item.landUse, null, chunks, layers.coverage, layers.height, item.sourceId);
  report.results.buildings = { accepted: buildingResult.accepted, rejected: buildingResult.rejected };

  report.results.trees = importTrees(await loadSource(cacheDir, 'trees', options, report), chunks, layers.coverage);
  const canopy = await loadSource(cacheDir, 'canopy', options, report);
  report.results.canopyFallbackTrees = importCanopies(canopy, chunks, layers.coverage);
  report.results.furniture = importPointObjects(await loadSource(cacheDir, 'furniture', options, report), chunks, layers.coverage);
  report.results.art = importPointObjects(await loadSource(cacheDir, 'art', options, report), chunks, layers.coverage, true);
  report.results.parking = importParking(await loadSource(cacheDir, 'parking', options, report), chunks, layers.coverage, roadMask);

  const addressFeatures = await loadSource(cacheDir, 'addresses', options, report) ?? await loadSource(cacheDir, 'gnaf', options, report);
  const addressResult = importAddresses(addressFeatures, layers.address, layers.coverage);
  report.results.addresses = addressResult.accepted;

  const boundaries =
    importBoundaries(await loadSource(cacheDir, 'geoscape', options, report)) ??
    importBoundaries(await loadSource(cacheDir, 'abs', options, report)) ??
    baseSuburbs;

  report.results.thinnedObjects = thinChunkObjects(chunks);
  for (const [name, layer] of Object.entries(layers)) writeLayer(outputDir, name, layer);
  for (const values of Object.values(chunks)) values.sort((a, b) => a.kind.localeCompare(b.kind) || a.x - b.x || a.z - b.z);
  writeFileSync(join(outputDir, 'melbourne.objects.json'), JSON.stringify({
    version: 2,
    chunkTiles: CHUNK_TILES,
    ownership: 'clipped-polygons',
    roadSurfaces: roadSurfaces.length > 0,
    chunks,
  }));
  writeFileSync(join(outputDir, 'melbourne.addresses.json'), JSON.stringify({ version: 1, streets: addressResult.streets }));
  writeFileSync(join(outputDir, 'melbourne.areas.json'), JSON.stringify({ version: 1, areas: boundaries?.areas ?? [] }));
  writeFileSync(join(outputDir, 'melbourne.sources.json'), JSON.stringify(report, null, 2) + '\n');
  if (boundaries?.grid) writeFileSync(join(outputDir, 'melbourne.suburbs.bin'), boundaries.grid);
  console.log(`[open-data] wrote ${Object.keys(chunks).length} object chunks; report: public/maps/melbourne.sources.json`);
  return {
    suburbs: boundaries?.suburbs ?? baseSuburbs?.suburbs,
    suburbGrid: boundaries?.grid ?? baseSuburbs?.grid,
    report,
    layers,
    objectChunks: chunks,
    roadSurfaces: roadSurfaces.length > 0,
  };
}

export function openDataInputsPresent(root) {
  const cacheDir = join(root, '.map-cache', 'open-data');
  return existsSync(cacheDir) && readdirSync(cacheDir).some((name) => /\.(geojson|json|shp|csv|psv|tiff?)$/i.test(name));
}

export function openDataHelp() {
  return Object.entries(SOURCE_DEFINITIONS).map(([key, value]) => `${key.padEnd(12)} ${value.file}`).join('\n');
}
