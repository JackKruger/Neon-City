import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compileMelbourne, publishCompiledMap } from '../compile-map.mjs';
import { navigationChunkFromCentimeters, validateCompiledMap } from '../validate-compiled-map.mjs';
import {
  encodeChunkContainer,
  parseChunkContainer,
  parseGlb,
  sha256,
} from './compiled-format.mjs';
import {
  COVERAGE_BUILDING_SOURCE,
  MAP_SIZE,
  compileChunkRecipe,
  createCompilerContext,
} from './compiled-recipes.mjs';
import { COLLISION_FLAGS } from './contract.mjs';
import { readObjectIndex } from './object-index.mjs';

function filesBelow(root, prefix = '') {
  const output = [];
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    if (statSync(path).isDirectory()) output.push(...filesBelow(path, relative));
    else output.push([relative, readFileSync(path)]);
  }
  return output;
}

let committedContextCache;
function committedCompilerContext() {
  if (committedContextCache) return committedContextCache;
  const mapRoot = join(import.meta.dirname, '..', '..', 'public', 'maps');
  const bytes = (name) => new Uint8Array(readFileSync(join(mapRoot, name)));
  const encodedHeights = readFileSync(join(mapRoot, 'melbourne-height.bin'));
  const heights = new Int16Array(encodedHeights.length / 2);
  for (let index = 0; index < heights.length; index++) heights[index] = encodedHeights.readInt16LE(index * 2);
  const objectIndex = readObjectIndex(mapRoot, 'melbourne');
  const context = createCompilerContext({
    meta: JSON.parse(readFileSync(join(mapRoot, 'melbourne.json'), 'utf8')),
    grid: bytes('melbourne.bin'), heights,
    coverage: bytes('melbourne.coverage.bin'), transport: bytes('melbourne.transport.bin'),
    speed: bytes('melbourne.speed.bin'), objectIndex,
  });
  committedContextCache = { context, mapRoot, objectIndex };
  return committedContextCache;
}

function collisionSources(gameplay) {
  let offset = 108 + gameplay.readUInt16LE(4) * 20;
  const sources = [];
  for (let index = 0; index < gameplay.readUInt16LE(6); index++) {
    const length = gameplay.readUInt16LE(offset);
    offset += 2;
    sources.push(gameplay.toString('utf8', offset, offset + length));
    offset += length;
  }
  return sources;
}

function collisionMeshTriangles(collision, sources, sourceId) {
  let offset = 12 + collision.readUInt32LE(4) * 32;
  const triangles = [];
  for (let meshIndex = 0; meshIndex < collision.readUInt32LE(8); meshIndex++) {
    const sourceIndex = collision.readUInt32LE(offset);
    const vertexCount = collision.readUInt32LE(offset + 4);
    const indexCount = collision.readUInt32LE(offset + 8);
    offset += 12;
    const vertices = Array.from({ length: vertexCount }, (_, index) => [
      collision.readFloatLE(offset + index * 12),
      collision.readFloatLE(offset + index * 12 + 4),
      collision.readFloatLE(offset + index * 12 + 8),
    ]);
    offset += vertexCount * 12;
    if (sources[sourceIndex] === sourceId) {
      for (let index = 0; index < indexCount; index += 3) triangles.push([
        vertices[collision.readUInt32LE(offset + index * 4)],
        vertices[collision.readUInt32LE(offset + (index + 1) * 4)],
        vertices[collision.readUInt32LE(offset + (index + 2) * 4)],
      ]);
    }
    offset += indexCount * 4;
  }
  return triangles;
}

test('NBCH round-trips its versioned section table and rejects corrupt offsets', () => {
  const sections = {
    HGT1: Buffer.alloc(242),
    COL1: Buffer.from([1, 0, 0, 0]),
    NAV3: Buffer.from([3, 0, 0, 0]),
    GME1: Buffer.from([1, 0, 0, 0]),
    TRN1: Buffer.from([1, 0, 0, 0]),
  };
  const encoded = encodeChunkContainer(4, -16, sections);
  const parsed = parseChunkContainer(encoded, { kx: 4, kz: -16 });
  assert.equal(parsed.version, 3);
  assert.deepEqual([...parsed.sections], Object.entries(sections).map(([type, bytes]) => [type, Buffer.from(bytes)]));
  const malformed = Buffer.from(encoded);
  malformed.writeUInt32LE(malformed.length + 4, 20);
  assert.throws(() => parseChunkContainer(malformed), /malformed NBCH section/);
  const incompatible = Buffer.from(encoded);
  incompatible.writeUInt16LE(99, 4);
  assert.throws(() => parseChunkContainer(incompatible), /unsupported NBCH version/);
});

test('compiled-map publication restores every previous artifact after a partial install', () => {
  const root = mkdtempSync(join(tmpdir(), 'neon-map-publication-'));
  const output = join(root, 'output');
  const staging = join(output, '.staging');
  const stagedCity = join(staging, 'city');
  const stagedManifest = join(staging, 'manifest.json');
  const missingProvenance = join(staging, 'missing-provenance.json');
  try {
    mkdirSync(join(output, 'melbourne'), { recursive: true });
    mkdirSync(stagedCity, { recursive: true });
    writeFileSync(join(output, 'melbourne', 'marker'), 'old city');
    writeFileSync(join(stagedCity, 'marker'), 'new city');
    writeFileSync(join(output, 'melbourne.compiled.json'), 'old manifest');
    writeFileSync(join(output, 'melbourne.compiled.provenance.json'), 'old provenance');
    writeFileSync(stagedManifest, 'new manifest');

    assert.throws(
      () => publishCompiledMap(staging, output, stagedCity, stagedManifest, missingProvenance),
      /ENOENT/
    );
    assert.equal(readFileSync(join(output, 'melbourne', 'marker'), 'utf8'), 'old city');
    assert.equal(readFileSync(join(output, 'melbourne.compiled.json'), 'utf8'), 'old manifest');
    assert.equal(readFileSync(join(output, 'melbourne.compiled.provenance.json'), 'utf8'), 'old provenance');
    assert.equal(existsSync(join(staging, 'previous-city')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('authoritative building source coverage suppresses generated fallback buildings', () => {
  const grid = new Uint8Array(MAP_SIZE ** 2).fill(5);
  const index = (cx, cz) => cx + MAP_SIZE / 2 + (cz + MAP_SIZE / 2) * MAP_SIZE;
  grid[index(0, 0)] = 2;
  grid[index(1, 0)] = 1;
  const base = {
    meta: {},
    grid,
    heights: new Int16Array((MAP_SIZE + 1) ** 2),
    coverage: new Uint8Array(MAP_SIZE ** 2),
    transport: new Uint8Array(MAP_SIZE ** 2),
    speed: new Uint8Array(MAP_SIZE ** 2),
  };
  const withoutSource = compileChunkRecipe(createCompilerContext({
    ...base,
    objectIndex: { chunks: {} },
  }), 0, 0);
  assert.ok(withoutSource.recipe.generatedSources.includes('generated:building:0:0:0'));

  const sourceCoverage = new Uint8Array(MAP_SIZE ** 2);
  for (let z = 0; z < 10; z++) {
    for (let x = 0; x < 10; x++) sourceCoverage[index(x, z)] |= COVERAGE_BUILDING_SOURCE;
  }
  const withSource = compileChunkRecipe(createCompilerContext({
    ...base,
    coverage: sourceCoverage,
    objectIndex: { chunks: {} },
  }), 0, 0);
  assert.ok(!withSource.recipe.generatedSources.some((source) => source.startsWith('generated:building:')));

  const withLegacyFootprint = compileChunkRecipe(createCompilerContext({
    ...base,
    objectIndex: {
      chunks: {
        '0,0': [{
          kind: 'building', sourceId: 'building:legit', x: 48, z: 48,
          width: 10, depth: 10, height: 12, rotation: 0, style: 'commercial',
        }],
      },
    },
  }), 0, 0);
  assert.ok(!withLegacyFootprint.recipe.generatedSources.some((source) => source.startsWith('generated:building:')));
});

test('compiled road polygons are subdivided and stay clear of curved terrain', () => {
  const grid = new Uint8Array(MAP_SIZE ** 2);
  const heights = new Int16Array((MAP_SIZE + 1) ** 2);
  for (let z = 0; z <= MAP_SIZE; z++) {
    for (let x = 0; x <= MAP_SIZE; x++) heights[x + z * (MAP_SIZE + 1)] = (x + z) % 3;
  }
  const context = createCompilerContext({
    meta: {}, grid, heights,
    coverage: new Uint8Array(MAP_SIZE ** 2),
    transport: new Uint8Array(MAP_SIZE ** 2),
    speed: new Uint8Array(MAP_SIZE ** 2),
    objectIndex: { chunks: { '0,0': [{
      kind: 'road-surface', sourceId: 'road:test', role: 'carriageway', surface: 'asphalt',
      elevation: 0.06, x: 45, z: 45, outline: [[-45, -5], [45, -5], [45, 5], [-45, 5]],
    }] } },
  });
  const compiled = compileChunkRecipe(context, 0, 0);
  const asphalt = compiled.primitives.find((primitive) => primitive.material === 'asphalt');
  assert.ok(asphalt.positions.length / 3 > 6, 'long road triangles were not subdivided');
  for (let i = 0; i < asphalt.positions.length; i += 3) {
    const x = asphalt.positions[i];
    const y = asphalt.positions[i + 1];
    const z = asphalt.positions[i + 2];
    assert.ok(y >= context.heightAt(x, z) + 0.059, `road vertex has insufficient clearance at ${x},${z}`);
  }
  for (let i = 0; i < asphalt.positions.length; i += 9) {
    const vertices = [0, 3, 6].map((offset) => ({
      x: asphalt.positions[i + offset], y: asphalt.positions[i + offset + 1], z: asphalt.positions[i + offset + 2],
    }));
    const samples = [
      vertices.reduce((sum, vertex) => ({ x: sum.x + vertex.x / 3, y: sum.y + vertex.y / 3, z: sum.z + vertex.z / 3 }), { x: 0, y: 0, z: 0 }),
      ...[[0, 1], [1, 2], [2, 0]].map(([a, b]) => ({
        x: (vertices[a].x + vertices[b].x) / 2,
        y: (vertices[a].y + vertices[b].y) / 2,
        z: (vertices[a].z + vertices[b].z) / 2,
      })),
    ];
    for (const sample of samples) {
      assert.ok(sample.y > context.heightAt(sample.x, sample.z), `terrain rises through road triangle at ${sample.x},${sample.z}`);
    }
  }
});

test('exact road polygons replace the blocky raster asphalt substrate', () => {
  const grid = new Uint8Array(MAP_SIZE ** 2);
  grid[MAP_SIZE / 2 + MAP_SIZE / 2 * MAP_SIZE] = 1;
  const result = compileChunkRecipe(createCompilerContext({
    meta: {}, grid,
    heights: new Int16Array((MAP_SIZE + 1) ** 2),
    coverage: new Uint8Array(MAP_SIZE ** 2),
    transport: new Uint8Array(MAP_SIZE ** 2),
    speed: new Uint8Array(MAP_SIZE ** 2),
    objectIndex: { roadSurfaces: true, chunks: { '0,0': [{
      kind: 'road-surface', sourceId: 'road:exact', role: 'carriageway', surface: 'asphalt',
      elevation: 0.06, x: 0, z: 0, outline: [[-2, -5], [2, -5], [2, 5], [-2, 5]],
    }] } },
  }), 0, 0);
  const asphalt = result.primitives.find((primitive) => primitive.material === 'asphalt');
  assert.ok(Math.max(...asphalt.positions.filter((_, index) => index % 3 === 0).map(Math.abs)) <= 2.01,
    '12 m raster asphalt still obscures the exact carriageway edge');
});

test('negative boundary navigation ownership follows encoded centimetres', () => {
  const path = {
    kind: 'nav-path', sourceId: 'nav:negative-boundary', mode: 'vehicle', speed: 40,
    x: -1447.73, z: -3126.004, points: [[0, 0], [0, -1]],
  };
  const context = createCompilerContext({
    meta: {},
    grid: new Uint8Array(MAP_SIZE ** 2),
    heights: new Int16Array((MAP_SIZE + 1) ** 2),
    coverage: new Uint8Array(MAP_SIZE ** 2),
    transport: new Uint8Array(MAP_SIZE ** 2),
    speed: new Uint8Array(MAP_SIZE ** 2),
    objectIndex: { chunks: { '-13,-27': [path], '-13,-26': [path] } },
  });
  const coordinates = (kz) => {
    const nav = compileChunkRecipe(context, -13, kz).sections.NAV3;
    const count = nav.readUInt16LE(2);
    return Array.from({ length: count }, (_, index) => {
      const offset = 8 + index * 16;
      return [nav.readInt32LE(offset), nav.readInt32LE(offset + 8)];
    });
  };
  assert.ok(coordinates(-26).some(([x, z]) => x === -144773 && z === -312600));
  assert.ok(!coordinates(-27).some(([x, z]) => x === -144773 && z === -312600));
  assert.deepEqual(
    navigationChunkFromCentimeters(-429113, -432741),
    { kx: -36, kz: -37 },
    'an edge beyond the south boundary must remain outside the full-city manifest'
  );
});

test('transit stops compile into named mode-specific TRN1 records', () => {
  const stop = {
    kind: 'transit-stop', sourceId: 'stop:flinders', mode: 'train',
    name: 'Flinders Street', x: 500, z: -1900,
  };
  const context = createCompilerContext({
    meta: {},
    grid: new Uint8Array(MAP_SIZE ** 2),
    heights: new Int16Array((MAP_SIZE + 1) ** 2),
    coverage: new Uint8Array(MAP_SIZE ** 2),
    transport: new Uint8Array(MAP_SIZE ** 2),
    speed: new Uint8Array(MAP_SIZE ** 2),
    objectIndex: { chunks: { '4,-16': [stop] } },
  });
  const section = compileChunkRecipe(context, 4, -16).sections.TRN1;
  assert.equal(section.readUInt16LE(0), 1);
  assert.equal(section.readUInt16LE(2), 1);
  assert.equal(section.readUInt8(16), 2);
  const nameLength = section.readUInt16LE(24);
  assert.equal(section.toString('utf8', 26, 26 + nameLength), 'Flinders Street');
});

test('building roofs cover their real footprint while collision stays flat', () => {
  const base = {
    meta: {},
    grid: new Uint8Array(MAP_SIZE ** 2),
    heights: new Int16Array((MAP_SIZE + 1) ** 2),
    coverage: new Uint8Array(MAP_SIZE ** 2),
    transport: new Uint8Array(MAP_SIZE ** 2),
    speed: new Uint8Array(MAP_SIZE ** 2),
  };
  const building = (roof, sourceId) => ({
    kind: 'building', sourceId, x: 48, z: 48, rotation: 0,
    width: 12, depth: 6, height: 9, style: 'suburban', roof, baseY: 0,
    outline: [[-6, -3], [6, -3], [6, 3], [-6, 3]],
  });
  const yLevels = (primitive) => {
    const ys = [];
    for (let i = 1; i < primitive.positions.length; i += 3) ys.push(primitive.positions[i]);
    return ys;
  };
  const gable = compileChunkRecipe(createCompilerContext({
    ...base,
    objectIndex: { chunks: { '0,0': [building('gable', 'building:gable')] } },
  }), 0, 0);
  const walls = yLevels(gable.primitives.find((primitive) => primitive.material === 'suburban'));
  assert.equal(Math.round(Math.min(...walls)), 0, 'walls should still start at the base');
  assert.equal(Math.round(Math.max(...walls)), 6, 'walls should stop at the eave below the ridge');
  // The pitched cap lives in its own style-aware roof material, not the wall bucket.
  const roof = yLevels(gable.primitives.find((primitive) => primitive.material === 'roof-tile'));
  assert.equal(Math.round(Math.min(...roof)), 6, 'roof should start at the eave');
  assert.equal(Math.round(Math.max(...roof)), 9, 'ridge should reach the real building height');

  const flat = compileChunkRecipe(createCompilerContext({
    ...base,
    objectIndex: { chunks: { '0,0': [building('flat', 'building:flat')] } },
  }), 0, 0);
  const flatWalls = yLevels(flat.primitives.find((primitive) => primitive.material === 'suburban'));
  assert.deepEqual([...new Set(flatWalls.map((y) => Math.round(y)))].sort((a, b) => a - b), [0, 9],
    'flat walls should retain the full surveyed height');
  const flatRoof = flat.primitives.find((primitive) => primitive.material === 'roof-tile');
  assert.ok(flatRoof, 'flat buildings should have a distinct roof surface');
  assert.ok(yLevels(flatRoof).every((y) => y >= 8.87 && y <= 9.04),
    'flat roof and fascia should stay tight to the wall top');
  assert.ok(flat.primitives.some((primitive) => primitive.material === 'window'),
    'building walls should include a distinct facade treatment');

  const concave = {
    ...building('gable', 'building:concave'),
    width: 12,
    depth: 12,
    outline: [[-6, -6], [6, -6], [6, -2], [-2, -2], [-2, 6], [-6, 6]],
  };
  const shaped = compileChunkRecipe(createCompilerContext({
    ...base,
    objectIndex: { chunks: { '0,0': [concave] } },
  }), 0, 0);
  const shapedRoof = shaped.primitives.find((primitive) => primitive.material === 'roof-tile');
  for (let i = 0; i < shapedRoof.positions.length; i += 9) {
    const centerX = (shapedRoof.positions[i] + shapedRoof.positions[i + 3] + shapedRoof.positions[i + 6]) / 3;
    const centerZ = (shapedRoof.positions[i + 2] + shapedRoof.positions[i + 5] + shapedRoof.positions[i + 8]) / 3;
    assert.ok(!(centerX > 46.5 && centerZ > 46.5),
      'roof triangles should not bridge across a concave footprint cut-out');
  }
});

test('building render faces stop cleanly at streamed chunk seams', () => {
  const base = {
    meta: {},
    grid: new Uint8Array(MAP_SIZE ** 2),
    heights: new Int16Array((MAP_SIZE + 1) ** 2),
    coverage: new Uint8Array(MAP_SIZE ** 2),
    transport: new Uint8Array(MAP_SIZE ** 2),
    speed: new Uint8Array(MAP_SIZE ** 2),
  };
  const common = {
    kind: 'building', sourceId: 'building:seam', structureId: 'building:seam',
    x: 114, z: 48, rotation: 0, width: 20, depth: 12, height: 8,
    style: 'commercial', roof: 'gable', baseY: 0,
  };
  const left = { ...common, outline: [[-10, -6], [0, -6], [0, 6], [-10, 6]] };
  const right = { ...common, outline: [[0, -6], [10, -6], [10, 6], [0, 6]] };
  const context = createCompilerContext({
    ...base,
    objectIndex: { chunks: { '0,0': [left], '1,0': [right] } },
  });
  const compiled = compileChunkRecipe(context, 0, 0);
  const walls = compiled.primitives.find((primitive) => primitive.material.startsWith('commercial'));
  for (let i = 0; i < walls.positions.length; i += 9) {
    const xs = [walls.positions[i], walls.positions[i + 3], walls.positions[i + 6]];
    assert.ok(!xs.every((x) => Math.abs(x - 114) < 0.02),
      'an artificial wall was emitted along the chunk cut');
  }
  const roof = compiled.primitives.find((primitive) => primitive.material === 'roof-membrane');
  const roofXs = roof.positions.filter((_, index) => index % 3 === 0);
  assert.ok(Math.max(...roofXs) <= 114.01, 'roof overhang crossed an artificial chunk cut');
});

test('reviewed cutting emits seam-safe render and identical custom terrain collision', () => {
  const base = {
    meta: {},
    grid: new Uint8Array(MAP_SIZE ** 2),
    heights: new Int16Array((MAP_SIZE + 1) ** 2).fill(100),
    coverage: new Uint8Array(MAP_SIZE ** 2),
    transport: new Uint8Array(MAP_SIZE ** 2),
    speed: new Uint8Array(MAP_SIZE ** 2),
  };
  const cutting = {
    kind: 'terrain-cutting', sourceId: 'terrain-cutting:test', cuttingId: 'test',
    x: 114, z: 48, floorY: 4.1, surface: 'ballast', terrainCorners: [],
    outline: [[-20, -20], [20, -20], [20, 20], [-20, 20]],
  };
  const context = createCompilerContext({
    ...base,
    objectIndex: { chunks: { '0,0': [cutting], '1,0': [structuredClone(cutting)] } },
  });
  const compiled = [compileChunkRecipe(context, 0, 0), compileChunkRecipe(context, 1, 0)];
  for (const result of compiled) {
    assert.equal(result.sections.COL1.readUInt16LE(2), COLLISION_FLAGS.CustomTerrain);
    assert.equal(result.counts.meshes, 1);
    const collision = result.sections.COL1;
    const vertexCount = collision.readUInt32LE(16);
    const vertices = [];
    for (let index = 0; index < vertexCount; index++) {
      const offset = 24 + index * 12;
      vertices.push([collision.readFloatLE(offset), collision.readFloatLE(offset + 4), collision.readFloatLE(offset + 8)]);
    }
    const rendered = new Set(result.primitives.flatMap((primitive) => {
      const keys = [];
      for (let index = 0; index < primitive.positions.length; index += 3) {
        keys.push(primitive.positions.slice(index, index + 3).map((value) => value.toFixed(4)).join(','));
      }
      return keys;
    }));
    assert.ok(vertices.every((vertex) => rendered.has(vertex.map((value) => value.toFixed(4)).join(','))),
      'custom terrain collision diverges from rendered terrain');
    assert.ok(vertices.some(([x, y]) => Math.abs(x - 114) < 0.01 && Math.abs(y - 4.1) < 0.01),
      'floor does not meet the streamed chunk seam');
    const concrete = result.primitives.find((primitive) => primitive.material === 'concrete');
    for (let index = 0; index < (concrete?.positions.length ?? 0); index += 9) {
      const xs = [concrete.positions[index], concrete.positions[index + 3], concrete.positions[index + 6]];
      assert.ok(!xs.every((x) => Math.abs(x - 114) < 0.01), 'artificial retaining wall emitted at chunk seam');
    }
  }
});

test('reviewed rail profile wins over terrain and tunnel offsets through Swanston clearance', () => {
  const base = {
    meta: {}, grid: new Uint8Array(MAP_SIZE ** 2),
    heights: new Int16Array((MAP_SIZE + 1) ** 2).fill(120),
    coverage: new Uint8Array(MAP_SIZE ** 2), transport: new Uint8Array(MAP_SIZE ** 2),
    speed: new Uint8Array(MAP_SIZE ** 2),
  };
  const cutting = {
    kind: 'terrain-cutting', sourceId: 'terrain-cutting:test-profile', cuttingId: 'profile',
    x: 60, z: 50, floorY: 3.1, surface: 'ballast', terrainCorners: [],
    outline: [[-40, -30], [40, -30], [40, 30], [-40, 30]],
  };
  const portal = {
    kind: 'terrain-portal', sourceId: 'terrain-portal:test-east', cuttingId: 'profile',
    side: 'east', covered: true, approachLength: 160, maxGrade: 0.05,
    x: 100, z: 50, points: [[0, -30], [0, 30]],
  };
  const rail = {
    kind: 'road-surface', sourceId: 'train:test:bed', role: 'train-bed', structure: 'tunnel',
    surface: 'ballast', elevation: 0.09, x: 100, z: 50,
    outline: [[-50, -2], [50, -2], [50, 2], [-50, 2]],
  };
  const nav = {
    kind: 'nav-path', sourceId: 'train:test:nav', mode: 'train', speed: 80, structure: 'tunnel',
    x: 100, z: 50, points: [[-50, 0], [50, 0]],
  };
  const context = createCompilerContext({
    ...base, objectIndex: { chunks: { '0,0': [cutting, portal, rail, nav], '1,0': [portal, rail, nav] } },
  });
  assert.equal(context.railSurfaceHeightAt(60, 50, 'tunnel'), 3.1);
  const trackAtSwanston = context.railSurfaceHeightAt(130, 50, 'tunnel');
  assert.ok(context.terrainHeightAt(130, 50) - trackAtSwanston >= 4.5,
    'road-to-track clearance is below 4.5 m');
  const result = compileChunkRecipe(context, 0, 0);
  const ballast = result.primitives.find((primitive) => primitive.material === 'ballast');
  assert.ok(ballast.positions.some((value, index) => index % 3 === 1 && Math.abs(value - 3.19) < 0.01));
  const navSection = result.sections.NAV3;
  const nodeCount = navSection.readUInt16LE(2);
  const trainHeights = Array.from({ length: nodeCount }, (_, index) => 8 + index * 16)
    .filter((offset) => (navSection.readUInt16LE(offset + 12) & 8) !== 0)
    .map((offset) => navSection.readInt32LE(offset + 4) / 100);
  assert.ok(trainHeights.includes(3.1), 'train navigation does not share the reviewed floor');
  assert.ok(trainHeights.every((height) => height < 12), 'train navigation leaked to road height');
});

test('committed Swanston Street crossing retains surveyed road-to-track clearance', () => {
  const { context } = committedCompilerContext();
  assert.equal(context.railSurfaceHeightAt(624, -1859, 'tunnel'), 3,
    'station rail does not use the reviewed 4.1 m AHD floor');
  // Surveyed east portal / Swanston Street crossing, immediately beyond the
  // open cutting and before the Vicmap underground rail continues east.
  const x = 680;
  const z = -1850;
  const roadY = context.naturalTerrainHeightAt(x, z);
  const trackY = context.railSurfaceHeightAt(x, z, 'tunnel');
  assert.ok(roadY - trackY >= 4.5,
    `Swanston Street clearance is ${(roadY - trackY).toFixed(2)}m`);
  assert.ok(trackY < roadY - 0.1, 'train rail leaked to Swanston Street road height');
});

test('committed cutting never lowers Flinders Street or ordinary vehicle navigation', () => {
  const { context, mapRoot, objectIndex } = committedCompilerContext();
  const roadIndex = JSON.parse(readFileSync(join(mapRoot, 'melbourne.roads.json'), 'utf8'));
  const flindersName = roadIndex.names.indexOf('Flinders Street');
  assert.ok(flindersName >= 0);
  let flindersSamples = 0;
  let flindersMaximumGrade = 0;
  let flindersMinimumY = Infinity;
  for (const lines of Object.values(roadIndex.chunks)) {
    for (const line of lines) {
      if (line[0] !== flindersName) continue;
      const midpointX = (line[2] + line[4]) / 2;
      const midpointZ = (line[3] + line[5]) / 2;
      if (midpointX >= 150 && midpointX <= 750 && midpointZ >= -2050 && midpointZ <= -1650) {
        flindersMinimumY = Math.min(flindersMinimumY, context.bridgeSurfaceHeightAt(midpointX, midpointZ));
        const distance = Math.hypot(line[4] - line[2], line[5] - line[3]);
        if (distance >= 0.5) flindersMaximumGrade = Math.max(flindersMaximumGrade, Math.abs(
          context.bridgeSurfaceHeightAt(line[4], line[5]) - context.bridgeSurfaceHeightAt(line[2], line[3])
        ) / distance);
      }
      for (const [x, z] of [[line[2], line[3]], [line[4], line[5]], [(line[2] + line[4]) / 2, (line[3] + line[5]) / 2]]) {
        if (x < 150 || x > 750 || z < -2050 || z > -1650) continue;
        flindersSamples++;
        assert.equal(context.cuttingProfileHeightAt(x, z), null,
          `Flinders Street ${x.toFixed(1)},${z.toFixed(1)} overlaps the rail cutting`);
      }
    }
  }
  assert.ok(flindersSamples > 20, 'Flinders Street regression area was not sampled');
  assert.ok(flindersMaximumGrade <= 0.08,
    `Flinders Street grade is ${(flindersMaximumGrade * 100).toFixed(1)}%`);
  assert.ok(flindersMinimumY >= 14,
    `Flinders Street was lowered to ${flindersMinimumY.toFixed(1)}m near the station`);

  const authored = [...new Map(Object.values(objectIndex.chunks).flat()
    .map((object) => [object.sourceId, object])).values()];
  const stationBuildings = authored.filter((object) => object.kind === 'building' && object.structureId === 'building:804817');
  assert.ok(stationBuildings.length > 0 && stationBuildings.every((object) => object.baseY >= 6.8),
    'station entrance/concourse components no longer remain above track grade');
  let maximumGrade = 0;
  for (const path of authored.filter((object) => object.kind === 'nav-path' && object.mode === 'vehicle' &&
    object.structure !== 'bridge' && object.structure !== 'tunnel' &&
    object.x > 150 && object.x < 750 && object.z > -2050 && object.z < -1650)) {
    const points = path.points.map(([x, z]) => [path.x + x, path.z + z]);
    for (let index = 1; index < points.length; index++) {
      const [ax, az] = points[index - 1];
      const [bx, bz] = points[index];
      const distance = Math.hypot(bx - ax, bz - az);
      if (distance < 0.5) continue;
      const grade = Math.abs(context.bridgeSurfaceHeightAt(bx, bz) - context.bridgeSurfaceHeightAt(ax, az)) / distance;
      maximumGrade = Math.max(maximumGrade, grade);
    }
  }
  assert.ok(maximumGrade <= 0.2, `ordinary station-area road discontinuity is ${(maximumGrade * 100).toFixed(1)}%`);
});

test('every custom-terrain chunk has complete, non-overlapping projected collision coverage', () => {
  const { context } = committedCompilerContext();
  let checked = 0;
  for (let kz = -18; kz <= -14; kz++) {
    for (let kx = 2; kx <= 6; kx++) {
      const result = compileChunkRecipe(context, kx, kz);
      if ((result.sections.COL1.readUInt16LE(2) & COLLISION_FLAGS.CustomTerrain) === 0) continue;
      checked++;
      const sources = collisionSources(result.sections.GME1);
      const triangles = collisionMeshTriangles(
        result.sections.COL1,
        sources,
        'terrain-cutting:flinders-street-station'
      ).filter(([a, b, c]) => Math.abs(
        (b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])
      ) > 1e-6);
      assert.ok(triangles.length > 0, `custom terrain mesh ${kx},${kz} is absent`);
      const minX = (kx * 10 - 0.5) * 12;
      const minZ = (kz * 10 - 0.5) * 12;
      for (let sampleZ = minZ + 1.73; sampleZ < minZ + 120; sampleZ += 4.37) {
        for (let sampleX = minX + 2.11; sampleX < minX + 120; sampleX += 3.89) {
          let inclusiveCovers = 0;
          let interiorCovers = 0;
          for (const [a, b, c] of triangles) {
            const side = (p, q) => (q[0] - p[0]) * (sampleZ - p[2]) - (q[2] - p[2]) * (sampleX - p[0]);
            const signs = [side(a, b), side(b, c), side(c, a)];
            inclusiveCovers += Number(signs.every((value) => value >= -1e-6) || signs.every((value) => value <= 1e-6));
            interiorCovers += Number(signs.every((value) => value > 1e-5) || signs.every((value) => value < -1e-5));
          }
          assert.ok(inclusiveCovers >= 1, `terrain hole at ${sampleX.toFixed(2)},${sampleZ.toFixed(2)} in ${kx},${kz}`);
          assert.ok(interiorCovers <= 1, `overlapping terrain at ${sampleX.toFixed(2)},${sampleZ.toFixed(2)} in ${kx},${kz}`);
        }
      }
    }
  }
  assert.ok(checked > 0, 'no custom terrain chunks were checked');
});

test('real transport structures compile as concrete geometry with collision', () => {
  const base = {
    meta: {},
    grid: new Uint8Array(MAP_SIZE ** 2),
    heights: new Int16Array((MAP_SIZE + 1) ** 2),
    coverage: new Uint8Array(MAP_SIZE ** 2),
    transport: new Uint8Array(MAP_SIZE ** 2),
    speed: new Uint8Array(MAP_SIZE ** 2),
  };
  const bridge = {
    kind: 'transport-structure', sourceId: 'infrastructure:bridge:test:deck',
    structure: 'bridge', component: 'bridge', roadDeck: true,
    x: 48, z: 48, rotation: 0, width: 20, depth: 8, baseY: 1, topY: 3,
    outline: [[-10, -4], [10, -4], [10, 4], [-10, 4]],
  };
  const tunnel = {
    kind: 'transport-structure', sourceId: 'infrastructure:tunnel:test:shell',
    structure: 'tunnel', component: 'tunnel', roadDeck: true,
    x: 72, z: 48, rotation: 0, width: 20, depth: 8, baseY: 0, topY: 5,
    outline: [[-10, -4], [10, -4], [10, 4], [-10, 4]],
  };
  const bridgeRoad = {
    kind: 'road-surface', sourceId: 'road:test:bridge', role: 'carriageway',
    structure: 'bridge', surface: 'asphalt', elevation: 0.06,
    x: 48, z: 48, outline: [[-10, -3], [10, -3], [10, 3], [-10, 3]],
  };
  const authoritativeFootpath = {
    kind: 'road-surface', sourceId: 'footpath:test:bridge', role: 'footpath-authoritative',
    surface: 'pavement', elevation: 0.13,
    x: 48, z: 48, outline: [[-8, -3], [8, -3], [8, -2], [-8, -2]],
  };
  const bollard = {
    kind: 'bollard', sourceId: 'bollard:test:bridge', x: 48, z: 48, rotation: 0,
  };
  const tunnelRail = {
    kind: 'road-surface', sourceId: 'train:test:tunnel:bed', role: 'train-bed',
    structure: 'tunnel', surface: 'ballast', elevation: 0.09,
    x: 72, z: 48, outline: [[-10, -2], [10, -2], [10, 2], [-10, 2]],
  };
  const tunnelNavigation = {
    kind: 'nav-path', sourceId: 'train:test:tunnel:nav', mode: 'train', speed: 80,
    structure: 'tunnel', x: 72, z: 48, points: [[-10, 0], [10, 0]],
  };
  const context = createCompilerContext({
    ...base,
    objectIndex: { chunks: { '0,0': [bridge, bridgeRoad, authoritativeFootpath, bollard, tunnel, tunnelRail, tunnelNavigation] } },
  });
  assert.equal(context.terrainHeightAt(48, 48), 0);
  assert.equal(context.heightAt(48, 48), 0, 'bridge must not replace natural terrain');
  assert.equal(context.tunnelSurfaceHeightAt(72, 48), -5, 'tunnel deck must remain below the terrain surface');
  assert.equal(context.bridgeSurfaceHeightAt(48, 48), 3);
  assert.equal(context.bridgeSurfaceHeightAt(38, 48), 3, 'surveyed deck should stay level to its end');
  assert.equal(context.bridgeSurfaceHeightAt(41, 48), 3, 'short bridge spans must not contain steep ramps');
  assert.ok(context.bridgeSurfaceHeightAt(37.9, 48) > 2.9, 'bridge approach should meet the deck without a step');
  assert.ok(context.bridgeSurfaceHeightAt(26, 48) > 1 && context.bridgeSurfaceHeightAt(26, 48) < 2,
    'bridge approach should ease between terrain and deck');
  assert.equal(context.bridgeSurfaceHeightAt(14, 48), 0, 'natural terrain beyond the approach stays separate');
  const result = compileChunkRecipe(context, 0, 0);
  assert.ok(result.primitives.some((primitive) => primitive.material === 'concrete'));
  const asphalt = result.primitives.find((primitive) => primitive.material === 'asphalt');
  assert.ok(asphalt.positions.some((value, index) => index % 3 === 1 && value > 3),
    'bridge-tagged road was not draped over the deck profile');
  const pavement = result.primitives.find((primitive) => primitive.material === 'pavement');
  assert.ok(pavement.positions.some((value, index) => index % 3 === 1 && value >= 3.13),
    'authoritative footpath was not placed on the bridge deck');
  const props = result.primitives.find((primitive) => primitive.material === 'prop');
  assert.ok(props.positions.some((value, index) => index % 3 === 1 && value >= 3),
    'bridge furniture was not placed on the bridge deck');
  const ballast = result.primitives.find((primitive) => primitive.material === 'ballast');
  assert.ok(ballast.positions.every((value, index) => index % 3 !== 1 || value < -4.8),
    'tunnel rail was rendered on top of the terrain');
  const navigation = result.sections.NAV3;
  const navigationCount = navigation.readUInt16LE(2);
  const trainNodeHeights = Array.from({ length: navigationCount }, (_, index) => 8 + index * 16)
    .filter((offset) => (navigation.readUInt16LE(offset + 12) & 8) !== 0)
    .map((offset) => navigation.readInt32LE(offset + 4));
  assert.ok(trainNodeHeights.length > 0 && trainNodeHeights.every((height) => height === -500),
    'tunnel train navigation was not compiled at tunnel depth');
  assert.equal(result.counts.meshes, 3, 'bridge, carriageway approach, and raised footpath should compile collision meshes');
  assert.equal(result.counts.cuboids, 4, 'tunnel shell and bridge bollard should compile solid cuboids');
  assert.equal(result.recipe.colliderCount, 7);
});

test('street furniture uses distinct low-poly recipes with matching solid collision', () => {
  const base = {
    meta: {},
    grid: new Uint8Array(MAP_SIZE ** 2),
    heights: new Int16Array((MAP_SIZE + 1) ** 2),
    coverage: new Uint8Array(MAP_SIZE ** 2),
    transport: new Uint8Array(MAP_SIZE ** 2),
    speed: new Uint8Array(MAP_SIZE ** 2),
  };
  const kinds = [
    ['bollard', 'Bollard'],
    ['bicycle-rail', 'Hoop'],
    ['bin', 'Litter Bin'],
    ['fountain', 'Drinking Fountain'],
    ['seat', 'Seat'],
    ['planter', 'Planter'],
    ['barbecue', 'Barbeque'],
    ['art', 'Monument'],
    ['tree-guard', 'Tree Guard'],
    ['information-pillar', 'Information Pillar'],
  ];
  const objects = kinds.map(([kind, model], index) => ({
    kind,
    model,
    sourceId: `furniture:test:${kind}`,
    x: 5 + (index % 5) * 18,
    z: 5 + Math.floor(index / 5) * 18,
    rotation: index * 0.1,
  }));
  const result = compileChunkRecipe(createCompilerContext({
    ...base,
    objectIndex: { chunks: { '0,0': objects } },
  }), 0, 0);
  assert.equal(result.counts.cuboids, 21);
  assert.equal(result.recipe.colliderCount, 21);
  for (const material of ['prop', 'rail', 'concrete', 'vegetation', 'art']) {
    assert.ok(result.primitives.some((primitive) => primitive.material === material), `${material} prop geometry is absent`);
  }
  assert.ok(result.primitives.find((primitive) => primitive.material === 'prop').positions.length > 36 * 3,
    'props still resemble one generic box apiece');
});

test('generated streetlights have an arm, lamp head, and pole collision', () => {
  const grid = new Uint8Array(MAP_SIZE ** 2);
  const index = (cx, cz) => cx + MAP_SIZE / 2 + (cz + MAP_SIZE / 2) * MAP_SIZE;
  for (const cz of [-1, 0, 1]) grid[index(0, cz)] = 1;
  const result = compileChunkRecipe(createCompilerContext({
    meta: {}, grid,
    heights: new Int16Array((MAP_SIZE + 1) ** 2),
    coverage: new Uint8Array(MAP_SIZE ** 2),
    transport: new Uint8Array(MAP_SIZE ** 2),
    speed: new Uint8Array(MAP_SIZE ** 2),
    objectIndex: { chunks: {} },
  }), 0, 0);
  assert.ok(result.recipe.generatedSources.includes('generated:streetlight:0:0:0'));
  assert.equal(result.counts.cuboids, 1);
  assert.ok(result.primitives.some((primitive) => primitive.material === 'rail'));
  assert.ok(result.primitives.some((primitive) => primitive.material === 'prop'));
});

test('committed spawn compilation has valid hashes, GLBs, containers, and navigation', () => {
  const root = join(import.meta.dirname, '..', '..', 'public', 'maps');
  const result = validateCompiledMap(root);
  assert.ok(result.chunks >= 9);
  assert.ok(result.nodes > 0);
  const manifest = JSON.parse(readFileSync(join(root, 'melbourne.compiled.json'), 'utf8'));
  const spawn = manifest.chunks.find((chunk) => chunk.kx === 4 && chunk.kz === -16);
  assert.ok(spawn, 'golden spawn chunk is missing');
  const glb = readFileSync(join(root, 'melbourne', 'chunks', '4_-16.glb'));
  assert.equal(sha256(glb), spawn.renderHash);
  const gltf = parseGlb(glb);
  assert.match(gltf.asset.generator, /^glTF-Transform v4\./);
  assert.ok(gltf.extensionsRequired.includes('EXT_meshopt_compression'));
  assert.ok(gltf.extensionsRequired.includes('KHR_mesh_quantization'));
  assert.ok(gltf.meshes[0].primitives.length >= 4);

  const container = parseChunkContainer(readFileSync(join(root, 'melbourne', 'chunks', '4_-16.bin')), { kx: 4, kz: -16 });
  const heightSource = readFileSync(join(root, 'melbourne-height.bin'));
  const heights = container.sections.get('HGT1');
  for (let ix = 0; ix <= 10; ix++) {
    for (let iz = 0; iz <= 10; iz++) {
      const globalX = 40 + ix + 360;
      const globalZ = -160 + iz + 360;
      assert.equal(heights.readInt16LE((ix * 11 + iz) * 2), heightSource.readInt16LE((globalX + globalZ * 721) * 2));
    }
  }

  const gameplay = container.sections.get('GME1');
  const parkedCount = gameplay.readUInt16LE(4);
  const sourceCount = gameplay.readUInt16LE(6);
  let gameplayOffset = 8 + 100 + parkedCount * 20;
  const sources = [];
  for (let i = 0; i < sourceCount; i++) {
    const length = gameplay.readUInt16LE(gameplayOffset);
    gameplayOffset += 2;
    sources.push(gameplay.toString('utf8', gameplayOffset, gameplayOffset + length));
    gameplayOffset += length;
  }
  assert.ok(sources.some((source) => source.startsWith('building:')), 'stable building source IDs are absent');

  const collision = container.sections.get('COL1');
  const cuboidCount = collision.readUInt32LE(4);
  const meshCount = collision.readUInt32LE(8);
  let collisionOffset = 12 + cuboidCount * 32;
  let flattenedBuildingMeshes = 0;
  let stationCanopyMeshes = 0;
  for (let meshIndex = 0; meshIndex < meshCount; meshIndex++) {
    const sourceIndex = collision.readUInt32LE(collisionOffset);
    const vertexCount = collision.readUInt32LE(collisionOffset + 4);
    const indexCount = collision.readUInt32LE(collisionOffset + 8);
    collisionOffset += 12;
    const ys = [];
    for (let vertex = 0; vertex < vertexCount; vertex++) ys.push(collision.readFloatLE(collisionOffset + vertex * 12 + 4));
    collisionOffset += vertexCount * 12 + indexCount * 4;
    if (sources[sourceIndex] === 'building:804817:1139') {
      assert.deepEqual([...new Set(ys.map((value) => value.toFixed(1)))], ['9.3'],
        'station canopy collision is not confined to its surveyed roof');
      stationCanopyMeshes++;
      continue;
    }
    if (!sources[sourceIndex]?.startsWith('building:')) continue;
    const levels = [...new Set(ys.map((value) => value.toFixed(4)))];
    assert.equal(levels.length, 2, `building collider ${sources[sourceIndex]} is not flattened to one base and roof level`);
    flattenedBuildingMeshes++;
  }
  assert.ok(flattenedBuildingMeshes > 0);
  assert.ok(stationCanopyMeshes > 0, 'open station canopy collision is absent');
});

test('spawn compilation is byte-identical for identical inputs', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'neon-map-determinism-'));
  const first = join(root, 'first');
  const second = join(root, 'second');
  try {
    const a = await compileMelbourne({ scope: 'spawn', outputRoot: first, quiet: true });
    const b = await compileMelbourne({ scope: 'spawn', outputRoot: second, quiet: true });
    assert.equal(a.buildId, b.buildId);
    const filesA = filesBelow(first);
    const filesB = filesBelow(second);
    assert.deepEqual(filesA.map(([name]) => name), filesB.map(([name]) => name));
    for (let i = 0; i < filesA.length; i++) {
      assert.equal(Buffer.compare(filesA[i][1], filesB[i][1]), 0, filesA[i][0]);
    }
    validateCompiledMap(first);
    validateCompiledMap(second);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
