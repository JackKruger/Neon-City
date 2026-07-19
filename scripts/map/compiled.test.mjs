import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compileMelbourne } from '../compile-map.mjs';
import { validateCompiledMap } from '../validate-compiled-map.mjs';
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

test('NBCH round-trips its versioned section table and rejects corrupt offsets', () => {
  const sections = {
    HGT1: Buffer.alloc(242),
    COL1: Buffer.from([1, 0, 0, 0]),
    NAV2: Buffer.from([2, 0, 0, 0]),
    GME1: Buffer.from([1, 0, 0, 0]),
  };
  const encoded = encodeChunkContainer(4, -16, sections);
  const parsed = parseChunkContainer(encoded, { kx: 4, kz: -16 });
  assert.equal(parsed.version, 2);
  assert.deepEqual([...parsed.sections], Object.entries(sections).map(([type, bytes]) => [type, Buffer.from(bytes)]));
  const malformed = Buffer.from(encoded);
  malformed.writeUInt32LE(malformed.length + 4, 20);
  assert.throws(() => parseChunkContainer(malformed), /malformed NBCH section/);
  const incompatible = Buffer.from(encoded);
  incompatible.writeUInt16LE(99, 4);
  assert.throws(() => parseChunkContainer(incompatible), /unsupported NBCH version/);
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

test('pitched roofs cap the render mesh at the ridge while collision stays flat', () => {
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
    'flat roofs keep the original two-level box and add no ridge geometry');
  assert.ok(!flat.primitives.some((primitive) => primitive.material.startsWith('roof-')),
    'flat roofs emit no roof material');
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
  for (let meshIndex = 0; meshIndex < meshCount; meshIndex++) {
    const sourceIndex = collision.readUInt32LE(collisionOffset);
    const vertexCount = collision.readUInt32LE(collisionOffset + 4);
    const indexCount = collision.readUInt32LE(collisionOffset + 8);
    collisionOffset += 12;
    const ys = [];
    for (let vertex = 0; vertex < vertexCount; vertex++) ys.push(collision.readFloatLE(collisionOffset + vertex * 12 + 4));
    collisionOffset += vertexCount * 12 + indexCount * 4;
    if (!sources[sourceIndex]?.startsWith('building:')) continue;
    const levels = [...new Set(ys.map((value) => value.toFixed(4)))];
    assert.equal(levels.length, 2, `building collider ${sources[sourceIndex]} is not flattened to one base and roof level`);
    flattenedBuildingMeshes++;
  }
  assert.ok(flattenedBuildingMeshes > 0);
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
