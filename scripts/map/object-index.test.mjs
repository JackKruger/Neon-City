import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { objectIndexFiles, readObjectIndex, writeObjectIndex } from './object-index.mjs';

test('object index shards round-trip and support targeted chunk loading', () => {
  const root = mkdtempSync(join(tmpdir(), 'neon-object-index-'));
  try {
    const chunks = {
      '-13,-1': [{ kind: 'tree', sourceId: 'west' }],
      '-1,-1': [{ kind: 'tree', sourceId: 'center' }],
      '12,12': [{ kind: 'tree', sourceId: 'east' }],
    };
    writeObjectIndex(root, 'test', chunks, true);
    const manifest = JSON.parse(readFileSync(join(root, 'test.objects.json'), 'utf8'));
    assert.equal(manifest.version, 3);
    assert.equal(manifest.shardChunks, 12);
    assert.equal(Object.keys(manifest.shards).length, 3);

    const targeted = readObjectIndex(root, 'test', new Set(['-1,-1']));
    assert.deepEqual(Object.keys(targeted.chunks), ['-1,-1']);
    assert.equal(targeted.roadSurfaces, true);
    assert.equal(objectIndexFiles(root, 'test', new Set(['-1,-1'])).length, 2,
      'targeted source hashing should include only the manifest and intersecting shard');

    const complete = readObjectIndex(root, 'test');
    assert.deepEqual(Object.keys(complete.chunks).sort(), Object.keys(chunks).sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
