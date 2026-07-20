import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CELL_CODES,
  CHUNK_SIZE,
  CHUNK_TILES,
  COVERAGE_FLAGS,
  MAP_CONTRACT,
  MAP_SIZE,
  MAX_CHUNK,
  MIN_CHUNK,
  NBCH_SECTIONS,
  TILE,
  TRANSPORT_FLAGS,
  VERSIONS,
} from './contract.mjs';

test('shared contract contains the compiler/runtime Melbourne invariants', () => {
  assert.equal(TILE, 12);
  assert.equal(MAP_SIZE, 720);
  assert.equal(CHUNK_TILES, 10);
  assert.equal(CHUNK_SIZE, 120);
  assert.deepEqual([MIN_CHUNK, MAX_CHUNK], [-36, 35]);
  assert.deepEqual(CELL_CODES, { '.': 0, '#': 1, C: 2, S: 3, P: 4, '~': 5 });
  assert.equal(TRANSPORT_FLAGS.Bridge, 2);
  assert.equal(COVERAGE_FLAGS.BuildingSource, 32);
  assert.deepEqual(NBCH_SECTIONS, { HGT1: 1, COL1: 1, NAV3: 3, GME1: 1, TRN1: 1 });
  assert.deepEqual(VERSIONS, MAP_CONTRACT.versions);
});

test('committed manifest is compatible with the shared contract', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../public/maps/melbourne.compiled.json', import.meta.url)));
  assert.equal(manifest.mapId, MAP_CONTRACT.mapId);
  assert.equal(manifest.coordinateConvention, MAP_CONTRACT.coordinateConvention);
  assert.equal(manifest.tileSize, TILE);
  assert.equal(manifest.chunkTiles, CHUNK_TILES);
  assert.equal(manifest.chunkSize, CHUNK_SIZE);
  assert.deepEqual(manifest.validChunkBounds, MAP_CONTRACT.validChunkBounds);
  assert.equal(manifest.version, VERSIONS.compiledManifest);
  assert.equal(manifest.compilerVersion, VERSIONS.compiler);
  assert.equal(manifest.required.runtimeVersion, VERSIONS.runtime);
  assert.equal(manifest.required.containerVersion, VERSIONS.container);
});
