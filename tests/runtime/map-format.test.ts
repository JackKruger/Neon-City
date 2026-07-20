import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAP_CONTRACT } from '../../src/world/MapContract';
import { parseCompiledChunk, validateCompiledManifest } from '../../src/world/CompiledFormat';
import { selectPrewarmChunkKeys } from '../../src/world/CityStreamer';
import {
  CONTAINER_VERSION,
  encodeChunkContainer,
  MANIFEST_VERSION,
  RUNTIME_VERSION,
} from '../../scripts/map/compiled-format.mjs';
import { MAP_CONTRACT as NODE_CONTRACT, NBCH_SECTIONS } from '../../scripts/map/contract.mjs';

function sections() {
  const collision = Buffer.alloc(12);
  collision.writeUInt16LE(NBCH_SECTIONS.COL1, 0);
  const navigation = Buffer.alloc(8);
  navigation.writeUInt16LE(NBCH_SECTIONS.NAV2, 0);
  const gameplay = Buffer.alloc(108);
  gameplay.writeUInt16LE(NBCH_SECTIONS.GME1, 0);
  gameplay.writeUInt16LE(100, 2);
  return { HGT1: Buffer.alloc(121 * 2), COL1: collision, NAV2: navigation, GME1: gameplay };
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

describe('shared map contract', () => {
  it('keeps runtime and compiler constants aligned with the committed manifest', () => {
    expect(MAP_CONTRACT).toEqual(NODE_CONTRACT);
    expect(MANIFEST_VERSION).toBe(MAP_CONTRACT.versions.compiledManifest);
    expect(CONTAINER_VERSION).toBe(MAP_CONTRACT.versions.container);
    expect(RUNTIME_VERSION).toBe(MAP_CONTRACT.versions.runtime);
    expect(MAP_CONTRACT.nbchSections).toEqual({ HGT1: 1, COL1: 1, NAV2: 2, GME1: 1 });
    const manifest = JSON.parse(readFileSync('public/maps/melbourne.compiled.json', 'utf8'));
    expect(validateCompiledManifest(manifest).mapId).toBe(MAP_CONTRACT.mapId);
  });
});

describe('compiled map prewarming', () => {
  const edge = { kx: 2, kz: -18 };
  const partialEdge = new Set(['2,-18', '3,-18', '2,-17', '3,-17']);

  it('loads the available neighborhood at the edge of a partial map', () => {
    expect(selectPrewarmChunkKeys(partialEdge, edge, true).sort()).toEqual([...partialEdge].sort());
  });

  it('still requires the center chunk and complete neighborhoods for full maps', () => {
    expect(() => selectPrewarmChunkKeys(partialEdge, edge, false)).toThrow(/missing required spawn chunk/);
    expect(() => selectPrewarmChunkKeys(partialEdge, { kx: 1, kz: -18 }, true)).toThrow(/missing required spawn chunk 1,-18/);
  });
});

describe('cross-environment NBCH format', () => {
  it('parses a container encoded by the Node compiler with the runtime parser', () => {
    const encoded = encodeChunkContainer(3, -4, sections());
    const parsed = parseCompiledChunk(arrayBuffer(encoded), 3, -4);
    expect(parsed).toMatchObject({ kx: 3, kz: -4, cuboids: [], meshes: [], navNodes: [], navEdges: [], parked: [], sources: [] });
    expect(parsed.heights).toHaveLength(121);
    expect(parsed.cells).toHaveLength(100);
  });

  it('rejects truncated headers and sections', () => {
    const encoded = encodeChunkContainer(1, 2, sections());
    expect(() => parseCompiledChunk(arrayBuffer(encoded.subarray(0, 10)), 1, 2)).toThrow(/header is truncated/);
    expect(() => parseCompiledChunk(arrayBuffer(encoded.subarray(0, encoded.length - 1)), 1, 2)).toThrow(/malformed compiled section|truncated|length/);
  });

  it('rejects wrong versions, coordinates, and missing sections', () => {
    const encoded = encodeChunkContainer(1, 2, sections());
    const wrongContainer = Buffer.from(encoded);
    wrongContainer.writeUInt16LE(CONTAINER_VERSION + 1, 4);
    expect(() => parseCompiledChunk(arrayBuffer(wrongContainer), 1, 2)).toThrow(/unsupported compiled container/);
    expect(() => parseCompiledChunk(arrayBuffer(encoded), 8, 2)).toThrow(/coordinate mismatch/);

    const missing = Buffer.from(encoded);
    missing.writeUInt16LE(16 + 3 * 16, 6);
    missing.writeUInt16LE(3, 12);
    expect(() => parseCompiledChunk(arrayBuffer(missing), 1, 2)).toThrow(/missing compiled section GME1/);
  });

  it('rejects wrong section versions and invalid source indices', () => {
    const encoded = Buffer.from(encodeChunkContainer(0, 0, sections()));
    const collisionOffset = encoded.readUInt32LE(16 + 16 + 4);
    encoded.writeUInt16LE(NBCH_SECTIONS.COL1 + 1, collisionOffset);
    expect(() => parseCompiledChunk(arrayBuffer(encoded), 0, 0)).toThrow(/unsupported COL1/);

    const invalidSections = sections();
    invalidSections.COL1 = Buffer.alloc(44);
    invalidSections.COL1.writeUInt16LE(NBCH_SECTIONS.COL1, 0);
    invalidSections.COL1.writeUInt32LE(1, 4);
    invalidSections.COL1.writeUInt32LE(0, 40);
    const invalidSource = encodeChunkContainer(0, 0, invalidSections);
    expect(() => parseCompiledChunk(arrayBuffer(invalidSource), 0, 0)).toThrow(/source index is out of range/);
  });
});
