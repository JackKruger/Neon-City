import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { roadSurfacesFromOverpass } from './roads.mjs';
import { readObjectIndex, writeObjectIndex } from './object-index.mjs';
import { COVERAGE_FLAGS, TRANSPORT_FLAGS, VERSIONS } from './contract.mjs';

export const TRANSPORT = {
  ROAD: TRANSPORT_FLAGS.Road,
  BRIDGE: TRANSPORT_FLAGS.Bridge,
  TUNNEL: TRANSPORT_FLAGS.Tunnel,
  RAIL: TRANSPORT_FLAGS.Rail,
  TRAM: TRANSPORT_FLAGS.Tram,
  FOOTPATH: TRANSPORT_FLAGS.Footpath,
  ROUNDABOUT: TRANSPORT_FLAGS.Roundabout,
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

export const COVERAGE = {
  BUILDING: COVERAGE_FLAGS.Building,
  TREE: COVERAGE_FLAGS.Tree,
  PARKING: COVERAGE_FLAGS.Parking,
  PROP: COVERAGE_FLAGS.Prop,
  ADDRESS: COVERAGE_FLAGS.Address,
  BUILDING_SOURCE: COVERAGE_FLAGS.BuildingSource,
};

const ODS_ROOT = 'https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets';
const VICMAP_RAIL_WFS = 'https://opendata.maps.vic.gov.au/geoserver/wfs?' + new URLSearchParams({
  service: 'WFS',
  version: '2.0.0',
  request: 'GetFeature',
  typeNames: 'open-data-platform:tr_rail',
  outputFormat: 'application/json',
  srsName: 'EPSG:4326',
  // Melbourne map bounds plus a small edge allowance.
  bbox: '144.9108,-37.8739,145.0092,-37.7961,EPSG:4326',
}).toString();
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
  footpaths: {
    file: 'footpaths.geojson',
    dataset: 'footpaths',
    title: 'City of Melbourne Footpaths',
    license: 'CC BY 4.0',
  },
  tramTracks: { file: 'tram-tracks.geojson', title: 'PTV Tram Track Centreline', license: 'CC BY 4.0' },
  railTracks: {
    file: 'rail-tracks.geojson',
    title: 'Vicmap Transport Railway Line',
    license: 'CC BY 4.0',
    url: VICMAP_RAIL_WFS,
  },
  streetOverrides: { file: 'street-overrides.geojson', title: 'Neon Bay reviewed street corrections', license: 'Project data' },
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
  if (options.download && (definition.dataset || definition.url) && (!existsSync(path) || options.refresh)) {
    path = join(cacheDir, definition.file);
    console.log(`[open-data] downloading ${definition.title}`);
    download(definition.url ?? exportUrl(definition.dataset), path);
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
      ...(definition.url ? { url: definition.url } : {}),
    });
    return features;
  } catch (error) {
    report.sources.push({ key, title: definition.title, status: 'invalid', file: definition.file, error: error.message });
    console.warn(`[open-data] ${definition.file}: ${error.message}`);
    return null;
  }
}

function addObject(chunks, object) {
  if (
    (object.kind === 'terrain-cutting' || object.kind === 'station-canopy') &&
    object.outline?.length >= 3
  ) {
    const absolute = object.outline.map(([x, z]) => [object.x + x, object.z + z]);
    const minX = Math.min(...absolute.map(([x]) => x));
    const maxX = Math.max(...absolute.map(([x]) => x));
    const minZ = Math.min(...absolute.map(([, z]) => z));
    const maxZ = Math.max(...absolute.map(([, z]) => z));
    const [minKx, minKz] = chunkKeyForWorld(minX, minZ).split(',').map(Number);
    const [maxKx, maxKz] = chunkKeyForWorld(maxX, maxZ).split(',').map(Number);
    for (let kz = minKz; kz <= maxKz; kz++) {
      for (let kx = minKx; kx <= maxKx; kx++) (chunks[`${kx},${kz}`] ??= []).push(object);
    }
    return;
  }
  if (object.kind === 'terrain-portal' && object.points?.length >= 2) {
    const absolute = object.points.map(([x, z]) => [object.x + x, object.z + z]);
    const margin = Math.max(0, object.approachLength ?? 0);
    const minX = Math.min(...absolute.map(([x]) => x)) - margin;
    const maxX = Math.max(...absolute.map(([x]) => x)) + margin;
    const minZ = Math.min(...absolute.map(([, z]) => z)) - margin;
    const maxZ = Math.max(...absolute.map(([, z]) => z)) + margin;
    const [minKx, minKz] = chunkKeyForWorld(minX, minZ).split(',').map(Number);
    const [maxKx, maxKz] = chunkKeyForWorld(maxX, maxZ).split(',').map(Number);
    for (let kz = minKz; kz <= maxKz; kz++) {
      for (let kx = minKx; kx <= maxKx; kx++) (chunks[`${kx},${kz}`] ??= []).push(object);
    }
    return;
  }
  if (
    (object.kind === 'road-surface' || object.kind === 'building' ||
      (object.kind === 'transport-structure' && object.structure === 'bridge')) &&
    object.outline?.length >= 3
  ) {
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
  if (object.kind === 'nav-path' && object.points?.length >= 2) {
    const absolute = object.points.map(([x, z]) => [object.x + x, object.z + z]);
    const minX = Math.min(...absolute.map(([x]) => x));
    const maxX = Math.max(...absolute.map(([x]) => x));
    const minZ = Math.min(...absolute.map(([, z]) => z));
    const maxZ = Math.max(...absolute.map(([, z]) => z));
    const keys = new Set([
      chunkKeyForWorld(minX, minZ), chunkKeyForWorld(maxX, minZ),
      chunkKeyForWorld(minX, maxZ), chunkKeyForWorld(maxX, maxZ),
      ...absolute.map(([x, z]) => chunkKeyForWorld(x, z)),
    ]);
    for (const key of keys) (chunks[key] ??= []).push(object);
    return;
  }
  const key = chunkKeyForWorld(object.x, object.z);
  (chunks[key] ??= []).push(object);
}

async function importReviewedTerrain(root, chunks, report) {
  void root;
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'map-overrides', 'flinders-street-cutting.geojson');
  if (!existsSync(path)) throw new Error('reviewed Flinders Street cutting override is missing');
  const features = await readFeatures(path);
  const canopyComponents = new Map();
  let cuttings = 0;
  let portals = 0;
  for (const feature of features) {
    const properties = feature.properties ?? {};
    const record = textValue(properties, 'record');
    if (record === 'terrain-cutting') {
      const polygon = polygons(feature.geometry)[0]?.[0];
      const world = simplifyWorldRing(polygon, 0.05, 256);
      if (world.length < 3) throw new Error(`reviewed cutting ${properties.id ?? feature.id} has no polygon`);
      const x = world.reduce((sum, point) => sum + point.x, 0) / world.length;
      const z = world.reduce((sum, point) => sum + point.z, 0) / world.length;
      const floorAhd = numeric(properties, 'floor_ahd');
      if (floorAhd === null) throw new Error(`reviewed cutting ${properties.id ?? feature.id} has no floor_ahd`);
      const id = textValue(properties, 'id') || String(feature.id ?? cuttings);
      addObject(chunks, {
        kind: 'terrain-cutting',
        sourceId: `terrain-cutting:${id}`,
        cuttingId: id,
        x: round(x),
        z: round(z),
        floorAhd: round(floorAhd),
        surface: textValue(properties, 'surface') || 'ballast',
        structureId: textValue(properties, 'structure_id'),
        provenance: {
          cityStructure: properties.city_structure_source,
          vicmap: properties.vicmap_source,
          railEnvelopeMethod: properties.rail_envelope_method,
          review: properties.review,
        },
        outline: world.map((point) => [round(point.x - x), round(point.z - z)]),
      });
      const structureId = textValue(properties, 'structure_id');
      const componentId = textValue(properties, 'canopy_component_id');
      if (structureId && componentId) {
        const components = canopyComponents.get(structureId) ?? new Set();
        components.add(componentId);
        canopyComponents.set(structureId, components);
      }
      cuttings++;
    } else if (record === 'terrain-portal') {
      const line = lineStrings(feature.geometry)[0];
      const world = (line ?? []).map(([lon, lat]) => toWorld(lat, lon));
      if (world.length < 2) throw new Error(`reviewed portal ${properties.id ?? feature.id} has no line`);
      const x = world.reduce((sum, point) => sum + point.x, 0) / world.length;
      const z = world.reduce((sum, point) => sum + point.z, 0) / world.length;
      const id = textValue(properties, 'id') || String(feature.id ?? portals);
      addObject(chunks, {
        kind: 'terrain-portal',
        sourceId: `terrain-portal:${id}`,
        portalId: id,
        cuttingId: textValue(properties, 'cutting_id'),
        side: textValue(properties, 'side') === 'west' ? 'west' : 'east',
        covered: properties.covered === true,
        approachLength: round(numeric(properties, 'approach_length') ?? 96),
        maxGrade: round(numeric(properties, 'max_grade') ?? 0.05),
        sourceIds: Array.isArray(properties.source_ids) ? properties.source_ids.map(String) : [],
        x: round(x),
        z: round(z),
        points: world.map((point) => [round(point.x - x), round(point.z - z)]),
      });
      portals++;
    }
  }
  report.sources.push({
    key: 'reviewedTerrain',
    title: 'Neon Bay reviewed Flinders Street Station cutting',
    license: 'Project data derived from CC BY 4.0 sources',
    status: 'loaded',
    file: 'data/map-overrides/flinders-street-cutting.geojson',
    records: features.length,
  });
  return { cuttings, portals, canopyComponents };
}

/** Rebuild a legacy centroid-owned object index using clipped polygon ownership. */
export function rechunkObjectIndex(index) {
  if (index?.version >= VERSIONS.objectIndex && index.ownership === 'clipped-polygons') return index;
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
    version: VERSIONS.objectIndex,
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
    numeric(properties, 'footprint_extrusion') ??
    (() => {
      const max = numeric(properties, 'footprint_max_elevation');
      const min = numeric(properties, 'footprint_min_elevation');
      return max !== null && min !== null ? max - min : null;
    })() ??
    numeric(properties, 'structure_extrusion', 'structure_height', 'height', 'height_m') ??
    (() => {
      const max = numeric(properties, 'structure_max_elevation', 'max_elevation');
      const min = numeric(properties, 'structure_min_elevation', 'min_elevation');
      return max !== null && min !== null ? max - min : null;
    })()
  );
}

function buildingStructureId(properties) {
  return textValue(properties, 'structure_id', 'structureid', 'building_id', 'objectid');
}

function isInfrastructureFootprint(properties) {
  const footprintType = textValue(
    properties,
    'footprint_type',
    'footprinttype',
    'structure_type',
    'structuretype'
  ).toLowerCase();
  return /\b(bridge|footbridge|overpass|tunnel|underpass)\b/.test(footprintType);
}

function infrastructureKind(properties) {
  const footprintType = textValue(properties, 'footprint_type', 'footprinttype').toLowerCase();
  return /tunnel|underpass/.test(footprintType) ? 'tunnel' : 'bridge';
}

function addTransportStructure(feature, ring, bounds, structure, chunks, sourceId) {
  const outline = simplifyWorldRing(ring).map((point) => [
    round(point.x - bounds.x),
    round(point.z - bounds.z),
  ]);
  if (outline.length < 3) return false;
  const properties = feature.properties ?? {};
  const component = textValue(properties, 'footprint_type', 'footprinttype', 'structure_type', 'structuretype')
    .toLowerCase() || 'structure';
  const minAhd = numeric(properties, 'footprint_min_elevation', 'structure_min_elevation', 'min_elevation');
  const maxAhd = numeric(properties, 'footprint_max_elevation', 'structure_max_elevation', 'max_elevation');
  addObject(chunks, {
    kind: 'transport-structure',
    sourceId,
    structure,
    component,
    roadDeck: isInfrastructureFootprint(properties),
    x: round(bounds.x),
    z: round(bounds.z),
    rotation: round(bounds.rotation),
    width: round(Math.max(1, bounds.width)),
    depth: round(Math.max(1, bounds.depth)),
    ...(minAhd !== null ? { minAhd: round(minAhd) } : {}),
    ...(maxAhd !== null ? { maxAhd: round(maxAhd) } : {}),
    outline,
  });
  return true;
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

function markWorldTransport(layer, points, flags) {
  let previous = null;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (TILE / 3)));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const cell = toGrid(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      if (!cell) {
        previous = null;
        continue;
      }
      if (previous && cell.gx !== previous.gx && cell.gz !== previous.gz) {
        layer[previous.gx + cell.gz * MAP_SIZE] |= flags;
      }
      layer[cell.index] |= flags;
      previous = cell;
    }
  }
}

/** Seed semantic transport flags from the same OSM paths used to render roads. */
function importRoadObjectTransport(objects, layer) {
  let accepted = 0;
  for (const object of objects) {
    if (object.kind !== 'nav-path' || !Array.isArray(object.points) || object.points.length < 2) continue;
    let flags = object.mode === 'vehicle'
      ? TRANSPORT.ROAD
      : object.mode === 'tram'
        ? TRANSPORT.RAIL | TRANSPORT.TRAM
        : object.mode === 'train'
          ? TRANSPORT.RAIL
          : TRANSPORT.FOOTPATH;
    if (object.structure === 'bridge') flags |= TRANSPORT.BRIDGE;
    else if (object.structure === 'tunnel') flags |= TRANSPORT.TUNNEL;
    markWorldTransport(
      layer,
      object.points.map(([x, z]) => ({ x: object.x + x, z: object.z + z })),
      flags
    );
    accepted++;
  }
  return accepted;
}

/** Build the semantic transport raster from the exact rendered/navigation paths. */
export function transportLayerFromRoadObjects(objects) {
  const layer = new Uint8Array(MAP_SIZE * MAP_SIZE);
  importRoadObjectTransport(objects, layer);
  return layer;
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

function importFootpathSurfaces(features, chunks) {
  if (!features) return 0;
  let accepted = 0;
  for (const feature of features) {
    const id = textValue(feature.properties, 'asset_id', 'mccid', 'objectid', 'roadseg_id') || accepted;
    for (const polygon of polygons(feature.geometry)) {
      const world = simplifyWorldRing(polygon[0]);
      if (world.length < 3) continue;
      const x = world.reduce((sum, point) => sum + point.x, 0) / world.length;
      const z = world.reduce((sum, point) => sum + point.z, 0) / world.length;
      addObject(chunks, {
        kind: 'road-surface', sourceId: `footpath:${id}:${accepted}`, role: 'footpath-authoritative',
        surface: 'pavement', elevation: 0.13, x: round(x), z: round(z),
        outline: world.map((point) => [round(point.x - x), round(point.z - z)]),
      });
      accepted++;
    }
  }
  return accepted;
}

function suppressInferredFootpaths(chunks) {
  let removed = 0;
  for (const values of Object.values(chunks)) {
    if (!values.some((object) => object.kind === 'road-surface' && object.role === 'footpath-authoritative')) continue;
    for (let i = values.length - 1; i >= 0; i--) {
      if (values[i].kind === 'road-surface' && /^footpath-(left|right)$/.test(values[i].role ?? '')) {
        values.splice(i, 1);
        removed++;
      }
    }
  }
  return removed;
}

function importTramTracks(features, chunks) {
  if (!features) return 0;
  const elements = [];
  let id = 0;
  for (const feature of features) {
    for (const line of lineStrings(feature.geometry)) {
      if (line.length < 2) continue;
      elements.push({
        type: 'way', id: `ptv-${id++}`,
        tags: { railway: 'tram', ...(feature.properties ?? {}) },
        geometry: line.map(([lon, lat]) => ({ lon, lat })),
      });
    }
  }
  for (const object of roadSurfacesFromOverpass({ elements })) addObject(chunks, object);
  return elements.length;
}

function importRailTracks(features, chunks) {
  if (!features) return 0;
  const elements = [];
  let fallbackId = 0;
  for (const feature of features) {
    const properties = feature.properties ?? {};
    const description = `${property(properties, 'feature_type_code', 'feature_type', 'railway_type', 'type') ?? ''}`.toLowerCase();
    const railway = /tram/.test(description) ? 'tram' : 'rail';
    const inactive = /dismantled|disused|marshalling|siding/.test(description);
    const structure = /bridge/.test(description) ? { bridge: 'yes' }
      : /underground|uground|tunnel/.test(description) ? { tunnel: 'yes' }
        : {};
    const featureId = property(properties, 'pfi', 'ufi', 'feature_ufi') ?? feature.id ?? fallbackId++;
    let part = 0;
    for (const line of lineStrings(feature.geometry)) {
      if (line.length < 2) continue;
      elements.push({
        type: 'way', id: `vicmap-${featureId}-${part++}`,
        tags: {
          ...properties,
          ...structure,
          railway,
          'transit:active': inactive ? 'no' : 'yes',
        },
        geometry: line.map(([lon, lat]) => ({ lon, lat })),
      });
    }
  }
  for (const object of roadSurfacesFromOverpass({ elements })) addObject(chunks, object);
  return elements.length;
}

function railModes(features) {
  const modes = new Set();
  for (const feature of features ?? []) {
    const properties = feature.properties ?? {};
    const description = `${property(properties, 'feature_type_code', 'feature_type', 'railway_type', 'type') ?? ''}`.toLowerCase();
    modes.add(/tram/.test(description) ? 'tram' : 'train');
  }
  return modes;
}

function suppressFallbackRail(chunks, modes) {
  let removed = 0;
  const prefixes = [...modes].map((mode) => `${mode}:`);
  for (const values of Object.values(chunks)) {
    for (let i = values.length - 1; i >= 0; i--) {
      const object = values[i];
      if (!['nav-path', 'road-surface'].includes(object.kind)) continue;
      if (!modes.has(object.mode) && !prefixes.some((prefix) => object.sourceId?.startsWith(prefix))) continue;
      values.splice(i, 1);
      removed++;
    }
  }
  return removed;
}

function importStreetOverrides(features, chunks) {
  if (!features) return 0;
  let accepted = 0;
  const lines = [];
  for (const feature of features) {
    const properties = feature.properties ?? {};
    for (const polygon of polygons(feature.geometry)) {
      const world = simplifyWorldRing(polygon[0], 0.1, 256);
      if (world.length < 3) continue;
      const x = world.reduce((sum, point) => sum + point.x, 0) / world.length;
      const z = world.reduce((sum, point) => sum + point.z, 0) / world.length;
      addObject(chunks, {
        kind: 'road-surface', sourceId: `street-override:${properties.id ?? accepted}`,
        role: properties.role ?? 'reviewed-override', surface: properties.surface ?? 'pavement',
        elevation: numeric(properties, 'elevation') ?? 0.025, x: round(x), z: round(z),
        outline: world.map((point) => [round(point.x - x), round(point.z - z)]),
      });
      accepted++;
    }
    for (const line of lineStrings(feature.geometry)) {
      const mode = properties.mode ?? 'vehicle';
      lines.push({
        type: 'way', id: `override-${properties.id ?? lines.length}`,
        tags: {
          ...properties,
          ...(mode === 'tram' ? { railway: 'tram' } : {}),
          ...(mode === 'train' ? { railway: 'rail' } : {}),
          ...(!properties.highway && mode !== 'tram' && mode !== 'train' ? { highway: mode === 'pedestrian' ? 'footway' : 'residential' } : {}),
        },
        geometry: line.map(([lon, lat]) => ({ lon, lat })),
      });
      accepted++;
    }
  }
  for (const object of roadSurfacesFromOverpass({ elements: lines })) addObject(chunks, object);
  return accepted;
}

function importBuildings(features, chunks, coverage, heightLayer, landUseLayer, dsm, canopyComponents = new Map()) {
  if (!features) return { accepted: 0, rejected: 0, excludedInfrastructure: 0, infrastructureComponents: 0 };
  const byStructure = new Map();
  let rejected = 0;
  let anonymousInfrastructure = 0;
  let infrastructureComponents = 0;
  const infrastructureIds = new Map();
  for (const feature of features) {
    if (!isInfrastructureFootprint(feature.properties)) continue;
    const id = buildingStructureId(feature.properties);
    if (id) {
      const kind = infrastructureKind(feature.properties);
      if (kind === 'tunnel' || !infrastructureIds.has(id)) infrastructureIds.set(id, kind);
    }
    else anonymousInfrastructure++;
  }
  for (let featureIndex = 0; featureIndex < features.length; featureIndex++) {
    const feature = features[featureIndex];
    // This source is named "Building Footprints", but it also contains bridge
    // decks and tunnel structures. Exclude their whole structure_id group:
    // one bridge can also have Jetty, Tram Stop or generic Structure pieces.
    // Treating any of those records as solid prisms blocks the OSM road.
    const explicitId = buildingStructureId(feature.properties);
    const ring = featureRing(feature);
    const bounds = ring && orientedBounds(ring);
    const groupedKind = explicitId ? infrastructureIds.get(explicitId) : null;
    const directKind = isInfrastructureFootprint(feature.properties) ? infrastructureKind(feature.properties) : null;
    const structure = groupedKind ?? directKind;
    if (structure) {
      if (!ring || !bounds || !toGrid(bounds.x, bounds.z) || bounds.width * bounds.depth < 2) {
        rejected++;
        continue;
      }
      const componentId = textValue(feature.properties, 'objectid', 'component_id') || featureIndex;
      if (addTransportStructure(
        feature,
        ring,
        bounds,
        structure,
        chunks,
        `infrastructure:${structure}:${explicitId || componentId}:${componentId}`
      )) infrastructureComponents++;
      continue;
    }
    if (!ring || !bounds || !toGrid(bounds.x, bounds.z) || bounds.width * bounds.depth < 12) {
      rejected++;
      continue;
    }
    const id = explicitId || `${bounds.x},${bounds.z}`;
    const componentId = textValue(feature.properties, 'objectid', 'component_id') || featureIndex;
    const group = byStructure.get(id) ?? { components: [], minAhd: Infinity };
    const componentMin = numeric(feature.properties, 'footprint_min_elevation');
    if (componentMin !== null) group.minAhd = Math.min(group.minAhd, componentMin);
    group.components.push({ feature, ring, bounds, componentId, componentMin });
    byStructure.set(id, group);
  }
  const pending = [];
  for (const [id, group] of byStructure) {
    const structureId = `building:${id}`;
    for (const component of group.components) {
      const { feature, ring, bounds, componentId, componentMin } = component;
      const grid = toGrid(bounds.x, bounds.z);
      const landUse = grid ? landUseLayer[grid.index] : LAND_USE.UNKNOWN;
      const height = buildingHeight(feature.properties);
      const sourceId = `${structureId}:${componentId}`;
      const baseOffset = Number.isFinite(group.minAhd) && componentMin !== null
        ? Math.max(0, componentMin - group.minAhd)
        : 0;
      const structureHeight = numeric(feature.properties, 'structure_extrusion', 'structure_height') ??
        baseOffset + (Number(height) || 0);
      const placement = { sourceId, structureId, baseOffset, structureHeight };
      if (canopyComponents.get(String(id))?.has(String(componentId))) {
        addStationCanopy(feature, ring, bounds, chunks, {
          sourceId,
          structureId,
          floorAhd: numeric(feature.properties, 'footprint_min_elevation') ?? group.minAhd,
          roofAhd: numeric(feature.properties, 'footprint_max_elevation'),
        });
      } else if (!height && dsm) pending.push({ feature, ring, bounds, landUse, ...placement });
      else addBuilding(feature, ring, bounds, landUse, height, chunks, coverage, heightLayer, placement);
    }
  }
  return {
    accepted: byStructure.size,
    rejected,
    excludedInfrastructure: infrastructureIds.size + anonymousInfrastructure,
    infrastructureComponents,
    pending,
  };
}

function addStationCanopy(feature, ring, bounds, chunks, placement) {
  const outline = simplifyWorldRing(ring, 0.35, 192).map((point) => [
    round(point.x - bounds.x),
    round(point.z - bounds.z),
  ]);
  if (outline.length < 3 || !Number.isFinite(placement.floorAhd) || !Number.isFinite(placement.roofAhd)) {
    throw new Error(`station canopy ${placement.sourceId} has invalid surveyed geometry`);
  }
  addObject(chunks, {
    kind: 'station-canopy',
    sourceId: placement.sourceId,
    structureId: placement.structureId,
    component: textValue(feature.properties, 'objectid', 'component_id'),
    x: round(bounds.x),
    z: round(bounds.z),
    rotation: round(bounds.rotation),
    width: round(Math.max(2, bounds.width)),
    depth: round(Math.max(2, bounds.depth)),
    floorAhd: round(placement.floorAhd),
    roofAhd: round(placement.roofAhd),
    outline,
  });
}

function addBuilding(feature, ring, bounds, landUse, rawHeight, chunks, coverage, heightLayer, placement) {
  const measuredHeight = Number(rawHeight);
  const height = Number.isFinite(measuredHeight) && measuredHeight > 0
    ? Math.max(0.25, Math.min(255, measuredHeight))
    : Math.max(3, Math.min(255, Math.max(5, Math.sqrt(bounds.width * bounds.depth) * 0.7)));
  const totalHeight = Math.max(height, Math.min(255, Number(placement.structureHeight) || height));
  const style = classifyBuildingStyle(landUse, totalHeight);
  const { structureHeight: _structureHeight, ...objectPlacement } = placement;
  const outline = simplifyWorldRing(ring).map((point) => [
    round(point.x - bounds.x),
    round(point.z - bounds.z),
  ]);
  addObject(chunks, {
    kind: 'building',
    ...objectPlacement,
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
    fillPolygon(temp, polygon, Math.round(totalHeight));
    for (let i = 0; i < temp.length; i++) if (temp[i]) heightLayer[i] = Math.max(heightLayer[i], temp[i]);
  }
}

function coverageBuilding(coverage) {
  // fillPolygon assigns rather than ORs; retain other coverage bits afterwards in point importers.
  void coverage;
  return COVERAGE.BUILDING;
}

/**
 * Mark where the footprint dataset is authoritative, independently from cells
 * occupied by buildings. The source has no boundary polygon, so infer a
 * conservative chunk mask from its footprint pieces: add a one-chunk seam
 * buffer and retain enclosed gaps such as parks and large civic lots.
 */
export function markBuildingSourceCoverage(
  coverage,
  chunks,
  { mapSize = MAP_SIZE, chunkTiles = CHUNK_TILES, bufferChunks = 1 } = {}
) {
  if (coverage.length !== mapSize * mapSize) throw new Error('building source coverage size mismatch');
  if (mapSize % chunkTiles !== 0 || (mapSize / chunkTiles) % 2 !== 0) {
    throw new Error('building source coverage requires an even chunk grid');
  }
  const chunkWidth = mapSize / chunkTiles;
  const minChunk = -chunkWidth / 2;
  const maxChunk = minChunk + chunkWidth - 1;
  const chunkIndex = (kx, kz) => kx - minChunk + (kz - minChunk) * chunkWidth;
  const inBounds = (kx, kz) => kx >= minChunk && kx <= maxChunk && kz >= minChunk && kz <= maxChunk;
  const seeds = new Uint8Array(chunkWidth * chunkWidth);
  for (const [key, objects] of Object.entries(chunks ?? {})) {
    if (!objects.some((object) => object.kind === 'building')) continue;
    const [kx, kz] = key.split(',').map(Number);
    if (inBounds(kx, kz)) seeds[chunkIndex(kx, kz)] = 1;
  }

  const covered = seeds.slice();
  for (let kz = minChunk; kz <= maxChunk; kz++) {
    for (let kx = minChunk; kx <= maxChunk; kx++) {
      if (!seeds[chunkIndex(kx, kz)]) continue;
      for (let dz = -bufferChunks; dz <= bufferChunks; dz++) {
        for (let dx = -bufferChunks; dx <= bufferChunks; dx++) {
          if (inBounds(kx + dx, kz + dz)) covered[chunkIndex(kx + dx, kz + dz)] = 1;
        }
      }
    }
  }

  // Flood from the map edge to distinguish genuinely uncovered exterior from
  // empty chunks enclosed by authoritative source coverage.
  const outside = new Uint8Array(covered.length);
  const queue = new Int32Array(covered.length);
  let head = 0;
  let tail = 0;
  const enqueue = (x, z) => {
    const index = x + z * chunkWidth;
    if (covered[index] || outside[index]) return;
    outside[index] = 1;
    queue[tail++] = index;
  };
  for (let i = 0; i < chunkWidth; i++) {
    enqueue(i, 0);
    enqueue(i, chunkWidth - 1);
    enqueue(0, i);
    enqueue(chunkWidth - 1, i);
  }
  while (head < tail) {
    const index = queue[head++];
    const x = index % chunkWidth;
    const z = Math.floor(index / chunkWidth);
    if (x > 0) enqueue(x - 1, z);
    if (x + 1 < chunkWidth) enqueue(x + 1, z);
    if (z > 0) enqueue(x, z - 1);
    if (z + 1 < chunkWidth) enqueue(x, z + 1);
  }

  let seedChunks = 0;
  let coveredChunks = 0;
  for (let z = 0; z < chunkWidth; z++) {
    for (let x = 0; x < chunkWidth; x++) {
      const index = x + z * chunkWidth;
      seedChunks += seeds[index];
      if (!covered[index] && outside[index]) continue;
      coveredChunks++;
      const gx0 = x * chunkTiles;
      const gz0 = z * chunkTiles;
      for (let gz = gz0; gz < gz0 + chunkTiles; gz++) {
        for (let gx = gx0; gx < gx0 + chunkTiles; gx++) {
          coverage[gx + gz * mapSize] |= COVERAGE.BUILDING_SOURCE;
        }
      }
    }
  }
  return { seedChunks, coveredChunks, coveredCells: coveredChunks * chunkTiles * chunkTiles };
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
  if (/tree guard/.test(value)) return 'tree-guard';
  if (/information pillar/.test(value)) return 'information-pillar';
  return null;
}

const POINT_OBJECT_KINDS = new Set([
  'bollard', 'bicycle-rail', 'bin', 'fountain', 'seat', 'planter',
  'barbecue', 'art', 'tree-guard', 'information-pillar',
]);

function pointModel(properties) {
  return textValue(
    properties,
    'model_no', 'model_number', 'model_descr', 'model_description',
    'description', 'structure', 'asset_type'
  ).slice(0, 120);
}

function pointSourceId(feature, kind, world, art) {
  const properties = feature.properties ?? {};
  const namespace = art ? 'art' : 'furniture';
  const identifier = property(
    properties,
    'gis_id', 'asset_id', 'assetid', 'objectid', 'object_id', 'ufi', 'id', 'fid'
  );
  if (identifier !== undefined) {
    const token = encodeURIComponent(String(identifier).trim()).slice(0, 160);
    if (token) return `${namespace}:${token}`;
  }
  const stableProperties = Object.entries(properties)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, value]);
  const digest = createHash('sha256')
    .update(JSON.stringify([kind, round(world.x), round(world.z), stableProperties]))
    .digest('hex')
    .slice(0, 20);
  return `${namespace}:${kind}:${digest}`;
}

function sourceRotation(properties) {
  const radians = numeric(properties, 'rotation_rad', 'rotation_radians', 'angle_rad', 'bearing_rad');
  const degrees = numeric(
    properties,
    'rotation', 'rotation_deg', 'angle', 'angle_deg',
    'bearing', 'bearing_deg', 'azimuth', 'orientation', 'heading'
  );
  if (radians === null && degrees === null) return null;
  // Survey bearings are clockwise from north. Recipe rotation aligns the
  // object's local X axis with the resulting world-space direction.
  const rotation = radians !== null ? radians : Math.PI / 2 - degrees * Math.PI / 180;
  return Math.atan2(Math.sin(rotation), Math.cos(rotation));
}

function nearestPathRotation(chunks, x, z, maximumDistance = 24) {
  const [kx, kz] = chunkKeyForWorld(x, z).split(',').map(Number);
  let closestDistanceSq = maximumDistance ** 2;
  let closestRotation = null;
  const seen = new Set();
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (const path of chunks[`${kx + dx},${kz + dz}`] ?? []) {
        if (path.kind !== 'nav-path' || !Array.isArray(path.points) || path.points.length < 2) continue;
        const signature = path.sourceId ?? JSON.stringify(path);
        if (seen.has(signature)) continue;
        seen.add(signature);
        for (let index = 0; index + 1 < path.points.length; index++) {
          const [ax, az] = path.points[index];
          const [bx, bz] = path.points[index + 1];
          const startX = path.x + ax;
          const startZ = path.z + az;
          const deltaX = bx - ax;
          const deltaZ = bz - az;
          const lengthSq = deltaX ** 2 + deltaZ ** 2;
          if (lengthSq < 0.0001) continue;
          const t = Math.max(0, Math.min(1, ((x - startX) * deltaX + (z - startZ) * deltaZ) / lengthSq));
          const distanceSq = (x - startX - deltaX * t) ** 2 + (z - startZ - deltaZ * t) ** 2;
          if (distanceSq >= closestDistanceSq) continue;
          closestDistanceSq = distanceSq;
          closestRotation = Math.atan2(-deltaZ, deltaX);
        }
      }
    }
  }
  return closestRotation;
}

function importPointObjects(features, chunks, coverage, art = false) {
  if (!features) return 0;
  let accepted = 0;
  const seen = new Set();
  const candidates = [];
  for (const feature of features) {
    const point = pointCoordinates(feature);
    if (!point || !inMap(point[1], point[0])) continue;
    const kind = art ? (/fountain/i.test(Object.values(feature.properties ?? {}).join(' ')) ? 'fountain' : 'art') : furnitureKind(feature.properties);
    if (!kind) continue;
    const world = toWorld(point[1], point[0]);
    const grid = toGrid(world.x, world.z);
    if (!grid) continue;
    candidates.push({
      feature,
      kind,
      world,
      grid,
      sourceId: pointSourceId(feature, kind, world, art),
    });
  }
  candidates.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  for (const candidate of candidates) {
    const { feature, kind, world, grid, sourceId } = candidate;
    const spacing = kind === 'bollard' || kind === 'bicycle-rail' ? 2 : kind === 'art' ? 1.5 : 0.75;
    const dedupeKey = `${kind}:${Math.round(world.x / spacing)}:${Math.round(world.z / spacing)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const model = pointModel(feature.properties);
    const rotation = sourceRotation(feature.properties) ?? nearestPathRotation(chunks, world.x, world.z) ?? 0;
    addObject(chunks, {
      kind,
      sourceId,
      ...(model ? { model } : {}),
      x: round(world.x),
      z: round(world.z),
      rotation: round(rotation),
    });
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
    // The source point is already the mapped kerbside location. Keep it at
    // centimetre precision; snapping to a 12 m cell centre can move a parked
    // car into a traffic lane or onto the opposite side of the street.
    addObject(chunks, {
      kind: 'parking',
      sourceId: `parking:${textValue(feature.properties, 'bay_id', 'kerbsideid', 'roadsegmentid') || i}:${round(world.x)}:${round(world.z)}`,
      x: round(world.x),
      z: round(world.z),
      rotation: roadOrientation(roadMask, road.gx, road.gz),
    });
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
    addBuilding(item.feature, item.ring, item.bounds, item.landUse, height, chunks, coverage, heightLayer, {
      sourceId: item.sourceId,
      structureId: item.structureId,
      baseOffset: item.baseOffset,
      structureHeight: item.structureHeight,
    });
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
  report.results.osmTransportPaths = importRoadObjectTransport(roadSurfaces, layers.transport);

  report.results.footpaths = importFootpathSurfaces(await loadSource(cacheDir, 'footpaths', options, report), chunks);
  report.results.suppressedInferredFootpaths = suppressInferredFootpaths(chunks);
  const tramTracks = await loadSource(cacheDir, 'tramTracks', options, report);
  const railTracks = await loadSource(cacheDir, 'railTracks', options, report);
  const authoritativeRailModes = railModes(railTracks);
  if (tramTracks?.length) authoritativeRailModes.add('tram');
  report.results.suppressedOsmRail = suppressFallbackRail(chunks, authoritativeRailModes);
  report.results.tramTracks = importTramTracks(tramTracks, chunks);
  report.results.railTracks = importRailTracks(railTracks, chunks);
  report.results.streetOverrides = importStreetOverrides(await loadSource(cacheDir, 'streetOverrides', options, report), chunks);
  const reviewedTerrain = await importReviewedTerrain(root, chunks, report);
  report.results.reviewedTerrain = {
    cuttings: reviewedTerrain.cuttings,
    portals: reviewedTerrain.portals,
  };

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
  const buildingResult = importBuildings(
    await loadSource(cacheDir, 'buildings', options, report),
    chunks,
    layers.coverage,
    layers.height,
    layers.landuse,
    dsm,
    reviewedTerrain.canopyComponents
  );
  if (dsm) await finishDsmBuildings(buildingResult.pending, dsm, chunks, layers.coverage, layers.height);
  else for (const item of buildingResult.pending ?? []) addBuilding(
    item.feature,
    item.ring,
    item.bounds,
    item.landUse,
    null,
    chunks,
    layers.coverage,
    layers.height,
    {
      sourceId: item.sourceId,
      structureId: item.structureId,
      baseOffset: item.baseOffset,
      structureHeight: item.structureHeight,
    }
  );
  const buildingSourceCoverage = markBuildingSourceCoverage(layers.coverage, chunks);
  report.results.buildings = {
    accepted: buildingResult.accepted,
    rejected: buildingResult.rejected,
    excludedInfrastructure: buildingResult.excludedInfrastructure,
    infrastructureComponents: buildingResult.infrastructureComponents,
    sourceCoverageChunks: buildingSourceCoverage.coveredChunks,
  };

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
  writeObjectIndex(outputDir, 'melbourne', chunks, roadSurfaces.length > 0);
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

/** Refresh only mapped street furniture/public art, preserving every other authored object. */
export async function refreshMelbournePointObjects({ root, options = {} }) {
  const cacheDir = join(root, '.map-cache', 'open-data');
  const outputDir = join(root, 'public', 'maps');
  const coveragePath = join(outputDir, 'melbourne.coverage.bin');
  const sourceReportPath = join(outputDir, 'melbourne.sources.json');
  const index = readObjectIndex(outputDir, 'melbourne');
  const coverage = new Uint8Array(readFileSync(coveragePath));
  if (coverage.length !== MAP_SIZE * MAP_SIZE) throw new Error('authored prop coverage size mismatch');
  for (let index = 0; index < coverage.length; index++) coverage[index] &= ~COVERAGE.PROP;

  const chunks = {};
  for (const [key, objects] of Object.entries(index.chunks)) {
    chunks[key] = objects.filter((object) => !POINT_OBJECT_KINDS.has(object.kind));
  }
  const pointReport = { version: 1, sources: [], results: {} };
  pointReport.results.furniture = importPointObjects(
    await loadSource(cacheDir, 'furniture', options, pointReport),
    chunks,
    coverage
  );
  pointReport.results.art = importPointObjects(
    await loadSource(cacheDir, 'art', options, pointReport),
    chunks,
    coverage,
    true
  );
  const thinnedPointObjects = thinChunkObjects(chunks);
  if (Object.keys(thinnedPointObjects).length > 0) pointReport.results.thinnedPointObjects = thinnedPointObjects;
  for (const values of Object.values(chunks)) {
    values.sort((left, right) => left.kind.localeCompare(right.kind) || left.x - right.x || left.z - right.z);
  }

  writeObjectIndex(outputDir, 'melbourne', chunks, index.roadSurfaces);
  writeLayer(outputDir, 'coverage', coverage);
  const report = existsSync(sourceReportPath)
    ? JSON.parse(readFileSync(sourceReportPath, 'utf8'))
    : { version: 1, sources: [], results: {} };
  const refreshedSources = new Map(pointReport.sources.map((source) => [source.key, source]));
  report.sources = (report.sources ?? []).map((source) => refreshedSources.get(source.key) ?? source);
  const existingSourceKeys = new Set(report.sources.map((source) => source.key));
  report.sources.push(...pointReport.sources.filter((source) => !existingSourceKeys.has(source.key)));
  report.results = {
    ...(report.results ?? {}),
    ...pointReport.results,
  };
  writeFileSync(sourceReportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(
    `[open-data] refreshed ${pointReport.results.furniture} furniture and ` +
    `${pointReport.results.art} art objects without rebuilding roads or buildings`
  );
  return { report: pointReport, coverage, objectChunks: chunks };
}

export function openDataInputsPresent(root) {
  const cacheDir = join(root, '.map-cache', 'open-data');
  return existsSync(cacheDir) && readdirSync(cacheDir).some((name) => /\.(geojson|json|shp|csv|psv|tiff?)$/i.test(name));
}

export function openDataHelp() {
  return Object.entries(SOURCE_DEFINITIONS).map(([key, value]) => `${key.padEnd(12)} ${value.file}`).join('\n');
}
