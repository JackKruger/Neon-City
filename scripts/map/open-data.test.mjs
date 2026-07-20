import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MAP_SIZE } from './geo.mjs';
import { readObjectIndex } from './object-index.mjs';
import {
  COVERAGE,
  LAND_USE,
  TRANSPORT,
  enrichMelbourneMap,
  markBuildingSourceCoverage,
  refreshMelbournePointObjects,
} from './open-data.mjs';

const polygon = (name, ring, extra = {}) => ({
  type: 'Feature',
  properties: { name, ...extra },
  geometry: { type: 'Polygon', coordinates: [ring] },
});
const point = (properties, coordinates) => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates } });
const line = (properties, coordinates) => ({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates } });

test('open data enrichment emits all runtime contracts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'neon-city-map-'));
  try {
    const cache = join(root, '.map-cache', 'open-data');
    mkdirSync(cache, { recursive: true });
    const writeGeo = (name, features) => writeFileSync(join(cache, name), JSON.stringify({ type: 'FeatureCollection', features }));
    const block = [[144.9596, -37.8346], [144.9604, -37.8346], [144.9604, -37.8354], [144.9596, -37.8354], [144.9596, -37.8346]];
    const building = [[144.9599, -37.8349], [144.9601, -37.8349], [144.9601, -37.8351], [144.9599, -37.8351], [144.9599, -37.8349]];
    const buildingRoof = [[144.95995, -37.83495], [144.96005, -37.83495], [144.96005, -37.83505], [144.95995, -37.83505], [144.95995, -37.83495]];
    const bridgeFootprint = [[144.9596, -37.83498], [144.9604, -37.83498], [144.9604, -37.83502], [144.9596, -37.83502], [144.9596, -37.83498]];
    const tunnelFootprint = [[144.9596, -37.83508], [144.9604, -37.83508], [144.9604, -37.83512], [144.9596, -37.83512], [144.9596, -37.83508]];
    const bridgeCompanion = [[144.95955, -37.83496], [144.96045, -37.83496], [144.96045, -37.83504], [144.95955, -37.83504], [144.95955, -37.83496]];
    const road = [[144.9595, -37.835], [144.9605, -37.835]];

    writeGeo('vicmap-planning.geojson', [polygon('Commercial 1 Zone', block)]);
    writeGeo('vicmap-transport.geojson', [line({ feature_type: 'Road Bridge' }, road)]);
    writeGeo('speed-zones.geojson', [line({ speed_zone: 40 }, road)]);
    writeGeo('building-footprints.geojson', [
      polygon('building', building, {
        objectid: 'A1', structure_id: 'A', footprint_extrusion: 28,
        footprint_min_elevation: 2, footprint_max_elevation: 30, roof_type: 'Flat',
      }),
      polygon('building roof', buildingRoof, {
        objectid: 'A2', structure_id: 'A', footprint_extrusion: 5,
        footprint_min_elevation: 20, footprint_max_elevation: 25, roof_type: 'Flat',
      }),
      polygon('bridge', bridgeFootprint, {
        structure_id: 'B', footprint_type: 'Bridge', structure_extrusion: 4,
        footprint_min_elevation: 2, footprint_max_elevation: 6,
      }),
      polygon('bridge companion', bridgeCompanion, {
        structure_id: 'B', footprint_type: 'Jetty', structure_extrusion: 1,
        footprint_min_elevation: 1, footprint_max_elevation: 5,
      }),
      polygon('tunnel', tunnelFootprint, {
        structure_id: 'T', footprint_type: 'Tunnel', structure_extrusion: 4,
        footprint_min_elevation: -2, footprint_max_elevation: 3,
      }),
    ]);
    writeGeo('urban-forest-trees.geojson', [point({ common_name: 'Elm', tree_height: 9 }, [144.96025, -37.8348])]);
    writeGeo('street-furniture.geojson', [
      point({ asset_type: 'Bollard', gis_id: 'F-123', model_no: 'BOL-7', bearing: 90 }, [144.9603, -37.8349]),
      point({ asset_type: 'Tree Guard', gis_id: 'F-124' }, [144.96032, -37.83486]),
      point({ asset_type: 'Information Pillar', gis_id: 'F-125' }, [144.96034, -37.83482]),
    ]);
    writeGeo('public-art.geojson', [point({ asset_type: 'Monument', asset_id: 'ART-9' }, [144.96035, -37.8349])]);
    writeGeo('parking-bays.geojson', Array.from({ length: 4 }, (_, i) => point({ bay_id: i }, [144.9597 + i * 0.0001, -37.835])));
    writeFileSync(join(cache, 'vicmap-address.csv'), 'LATITUDE,LONGITUDE,ROAD_NAME\n-37.83505,144.96005,Swanston Street\n');
    writeGeo('geoscape-localities.geojson', [polygon('Melbourne', block, { locality_name: 'Melbourne' })]);

    const grid = new Uint8Array(MAP_SIZE * MAP_SIZE).fill(3);
    const result = await enrichMelbourneMap({
      root,
      grid,
      roadSurfaces: [{
        kind: 'road-surface',
        surface: 'asphalt',
        x: 0,
        z: 0,
        outline: [[-8, -4], [8, -4], [8, 4], [-8, 4]],
      }, {
        kind: 'nav-path',
        sourceId: 'road:test:nav',
        mode: 'vehicle',
        speed: 40,
        structure: 'bridge',
        x: 0,
        z: 0,
        points: [[-8, 0], [8, 0]],
      }],
      baseSuburbs: null,
    });
    const output = join(root, 'public', 'maps');
    const transport = new Uint8Array(readFileSync(join(output, 'melbourne.transport.bin')));
    const speed = new Uint8Array(readFileSync(join(output, 'melbourne.speed.bin')));
    const landUse = new Uint8Array(readFileSync(join(output, 'melbourne.landuse.bin')));
    const height = new Uint8Array(readFileSync(join(output, 'melbourne.height.bin')));
    const address = new Uint8Array(readFileSync(join(output, 'melbourne.address.bin')));
    const coverage = new Uint8Array(readFileSync(join(output, 'melbourne.coverage.bin')));
    const objects = readObjectIndex(output, 'melbourne');

    for (const layer of [transport, speed, landUse, height, address, coverage]) assert.equal(layer.length, MAP_SIZE * MAP_SIZE);
    assert.ok(transport.some((value) => (value & (TRANSPORT.ROAD | TRANSPORT.BRIDGE)) !== 0));
    assert.ok(speed.some((value) => value === 2));
    assert.ok(landUse.some((value) => value === LAND_USE.COMMERCIAL));
    assert.ok(height.some((value) => value === 28));
    assert.ok(address.some((value) => value > 0));
    assert.ok(coverage.some((value) => (value & COVERAGE.BUILDING) !== 0));
    assert.ok(coverage.some((value) => (value & COVERAGE.BUILDING_SOURCE) !== 0));
    assert.ok(result.report.results.buildings.sourceCoverageChunks > 0);
    assert.equal(result.report.results.buildings.excludedInfrastructure, 2);
    assert.equal(result.report.results.buildings.infrastructureComponents, 3);
    assert.ok(result.report.results.osmTransportPaths > 0);
    const authored = Object.values(objects.chunks).flat();
    for (const kind of ['road-surface', 'building', 'tree', 'bollard', 'tree-guard', 'information-pillar', 'art', 'parking']) {
      assert.ok(authored.some((item) => item.kind === kind), kind);
    }
    assert.equal(objects.roadSurfaces, true);
    assert.ok(authored.find((item) => item.kind === 'building')?.outline?.length >= 3);
    const buildingComponents = new Map(
      authored
        .filter((item) => item.kind === 'building' && item.structureId === 'building:A')
        .map((item) => [item.sourceId, item])
    );
    assert.equal(buildingComponents.size, 2);
    assert.equal(buildingComponents.get('building:A:A1')?.baseOffset, 0);
    assert.equal(buildingComponents.get('building:A:A2')?.baseOffset, 18);
    assert.equal(buildingComponents.get('building:A:A2')?.height, 5);
    const parking = authored.find((item) => item.kind === 'parking');
    assert.ok(parking?.sourceId?.startsWith('parking:'));
    assert.notEqual(parking.x % 12, 0, 'mapped parking was snapped to a road-cell centre');
    const bollard = authored.find((item) => item.kind === 'bollard');
    assert.equal(bollard?.sourceId, 'furniture:F-123');
    assert.equal(bollard?.model, 'BOL-7');
    assert.equal(bollard?.rotation, 0, 'east-facing survey bearing should align the local X axis east');
    assert.equal(authored.find((item) => item.kind === 'art')?.sourceId, 'art:ART-9');
    assert.ok(!authored.some((item) => item.sourceId === 'building:B' || item.sourceId === 'building:T'));
    const infrastructure = authored.filter((item) => item.kind === 'transport-structure');
    assert.ok(infrastructure.some((item) => item.structure === 'bridge' && item.component === 'bridge' && item.roadDeck));
    assert.ok(infrastructure.some((item) => item.structure === 'bridge' && item.component === 'jetty' && !item.roadDeck));
    assert.ok(infrastructure.some((item) => item.structure === 'tunnel' && item.roadDeck));
    assert.ok(infrastructure.every((item) => Number.isFinite(item.minAhd) && Number.isFinite(item.maxAhd)));
    assert.equal(result.suburbs?.[0]?.name, 'Melbourne');

    const buildingSnapshot = authored.filter((item) => item.kind === 'building');
    writeGeo('street-furniture.geojson', [
      point({ asset_type: 'Litter Bin', gis_id: 'F-200', model_no: 'BIN-2' }, [144.9603, -37.8349]),
    ]);
    await refreshMelbournePointObjects({ root });
    const refreshed = Object.values(readObjectIndex(output, 'melbourne').chunks).flat();
    assert.deepEqual(refreshed.filter((item) => item.kind === 'building'), buildingSnapshot,
      'props-only refresh changed building records');
    assert.ok(!refreshed.some((item) => item.sourceId === 'furniture:F-123'));
    assert.equal(refreshed.find((item) => item.kind === 'bin')?.sourceId, 'furniture:F-200');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('building source coverage buffers footprint chunks and fills enclosed gaps', () => {
  const mapSize = 80;
  const chunkTiles = 10;
  const coverage = new Uint8Array(mapSize * mapSize);
  coverage[0] = COVERAGE.TREE;
  const chunks = {};
  for (let z = -1; z <= 1; z++) {
    for (let x = -1; x <= 1; x++) {
      if (x === 0 && z === 0) continue;
      chunks[`${x},${z}`] = [{ kind: 'building' }];
    }
  }
  const result = markBuildingSourceCoverage(coverage, chunks, {
    mapSize,
    chunkTiles,
    bufferChunks: 0,
  });
  const cell = (gx, gz) => coverage[gx + gz * mapSize];
  assert.equal(result.seedChunks, 8);
  assert.equal(result.coveredChunks, 9);
  assert.ok((cell(45, 45) & COVERAGE.BUILDING_SOURCE) !== 0, 'enclosed empty chunk is not covered');
  assert.equal(cell(5, 5) & COVERAGE.BUILDING_SOURCE, 0, 'exterior chunk is incorrectly covered');
  assert.ok((coverage[0] & COVERAGE.TREE) !== 0, 'existing coverage bits were overwritten');

  const buffered = new Uint8Array(mapSize * mapSize);
  const bufferedResult = markBuildingSourceCoverage(buffered, {
    '0,0': [{ kind: 'building' }],
  }, { mapSize, chunkTiles });
  assert.equal(bufferedResult.coveredChunks, 9);
  assert.ok((buffered[35 + 35 * mapSize] & COVERAGE.BUILDING_SOURCE) !== 0, 'neighboring chunk buffer is absent');
});
