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
    NAV1: Buffer.from([1, 0, 0, 0]),
    GME1: Buffer.from([1, 0, 0, 0]),
  };
  const encoded = encodeChunkContainer(4, -16, sections);
  const parsed = parseChunkContainer(encoded, { kx: 4, kz: -16 });
  assert.equal(parsed.version, 1);
  assert.deepEqual([...parsed.sections], Object.entries(sections).map(([type, bytes]) => [type, Buffer.from(bytes)]));
  const malformed = Buffer.from(encoded);
  malformed.writeUInt32LE(malformed.length + 4, 20);
  assert.throws(() => parseChunkContainer(malformed), /malformed NBCH section/);
  const incompatible = Buffer.from(encoded);
  incompatible.writeUInt16LE(99, 4);
  assert.throws(() => parseChunkContainer(incompatible), /unsupported NBCH version/);
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
