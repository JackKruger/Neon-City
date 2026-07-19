#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTAINER_VERSION,
  MANIFEST_VERSION,
  parseChunkContainer,
  parseGlb,
  sha256,
  stableStringify,
} from './map/compiled-format.mjs';
import { CHUNK_SIZE, CHUNK_TILES, MAX_CHUNK, MIN_CHUNK, TILE } from './map/compiled-recipes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function chunkKey(kx, kz) {
  return `${kx},${kz}`;
}

function validateGlbDocument(bytes, gltf, key) {
  const jsonLength = bytes.readUInt32LE(12);
  const binaryHeader = 20 + jsonLength;
  ensure(binaryHeader + 8 <= bytes.length && bytes.readUInt32LE(binaryHeader + 4) === 0x004e4942, `chunk ${key} has no GLB binary chunk`);
  const binaryLength = bytes.readUInt32LE(binaryHeader);
  ensure(binaryHeader + 8 + binaryLength === bytes.length, `chunk ${key} GLB binary length mismatch`);
  ensure(gltf.buffers?.length >= 1 && gltf.buffers[0].byteLength <= binaryLength, `chunk ${key} GLB buffer declaration is invalid`);
  for (let index = 1; index < gltf.buffers.length; index++) ensure(gltf.buffers[index].extensions?.EXT_meshopt_compression?.fallback === true, `chunk ${key} GLB buffer ${index} is not a Meshopt fallback buffer`);
  for (const [index, view] of (gltf.bufferViews ?? []).entries()) {
    ensure(Number.isInteger(view.buffer) && view.buffer >= 0 && view.buffer < gltf.buffers.length && (view.byteOffset ?? 0) + view.byteLength <= gltf.buffers[view.buffer].byteLength, `chunk ${key} GLB buffer view ${index} is out of range`);
    const meshopt = view.extensions?.EXT_meshopt_compression;
    if (meshopt) ensure(Number.isInteger(meshopt.buffer) && meshopt.buffer >= 0 && meshopt.buffer < gltf.buffers.length && (meshopt.byteOffset ?? 0) + meshopt.byteLength <= gltf.buffers[meshopt.buffer].byteLength, `chunk ${key} Meshopt view ${index} is out of range`);
  }
  for (const [index, accessor] of (gltf.accessors ?? []).entries()) {
    ensure(Number.isInteger(accessor.bufferView) && accessor.bufferView >= 0 && accessor.bufferView < gltf.bufferViews.length && Number.isInteger(accessor.count) && accessor.count >= 0, `chunk ${key} GLB accessor ${index} is invalid`);
  }
  for (const mesh of gltf.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      ensure(Number.isInteger(primitive.indices) && primitive.indices < gltf.accessors.length, `chunk ${key} GLB primitive indices are invalid`);
      ensure(Object.values(primitive.attributes ?? {}).every((accessor) => Number.isInteger(accessor) && accessor < gltf.accessors.length), `chunk ${key} GLB primitive attributes are invalid`);
    }
  }
}

function decodeNavigation(section, entry, nodes, edges) {
  ensure(section.length >= 8 && section.readUInt16LE(0) === 1, `chunk ${chunkKey(entry.kx, entry.kz)} has invalid NAV1 header`);
  const nodeCount = section.readUInt16LE(2);
  const edgeCount = section.readUInt32LE(4);
  ensure(section.length === 8 + nodeCount * 8 + edgeCount * 8, `chunk ${chunkKey(entry.kx, entry.kz)} has invalid NAV1 length`);
  let offset = 8;
  for (let i = 0; i < nodeCount; i++) {
    const cx = section.readInt16LE(offset);
    const cz = section.readInt16LE(offset + 2);
    ensure(Math.floor(cx / CHUNK_TILES) === entry.kx && Math.floor(cz / CHUNK_TILES) === entry.kz, `navigation node ${cx},${cz} has wrong owner`);
    const key = `${cx},${cz}`;
    ensure(!nodes.has(key), `duplicate navigation node ${key}`);
    nodes.add(key);
    offset += 8;
  }
  for (let i = 0; i < edgeCount; i++) {
    const edge = {
      fromCx: section.readInt16LE(offset),
      fromCz: section.readInt16LE(offset + 2),
      toCx: section.readInt16LE(offset + 4),
      toCz: section.readInt16LE(offset + 6),
    };
    ensure(Math.abs(edge.fromCx - edge.toCx) + Math.abs(edge.fromCz - edge.toCz) === 1, `navigation edge is not cell-adjacent in ${entry.kx},${entry.kz}`);
    edges.push(edge);
    offset += 8;
  }
}

export function validateCompiledMap(outputRoot = join(ROOT, 'public', 'maps')) {
  const manifestPath = join(outputRoot, 'melbourne.compiled.json');
  ensure(existsSync(manifestPath), `compiled manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const provenancePath = join(outputRoot, 'melbourne.compiled.provenance.json');
  ensure(existsSync(provenancePath), `compiler provenance not found: ${provenancePath}`);
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  ensure(manifest.version === MANIFEST_VERSION, `unsupported manifest version ${manifest.version}`);
  ensure(manifest.mapId === 'melbourne' && manifest.required?.containerVersion === CONTAINER_VERSION, 'incompatible compiled manifest requirements');
  ensure(manifest.tileSize === TILE && manifest.chunkTiles === CHUNK_TILES && manifest.chunkSize === CHUNK_SIZE, 'compiled map dimensions are incompatible');
  ensure(manifest.validChunkBounds.minX === MIN_CHUNK && manifest.validChunkBounds.maxX === MAX_CHUNK && manifest.validChunkBounds.minZ === MIN_CHUNK && manifest.validChunkBounds.maxZ === MAX_CHUNK, 'compiled map bounds are incompatible');
  ensure(Array.isArray(manifest.chunks) && manifest.chunks.length > 0, 'compiled manifest has no chunks');
  ensure(provenance.buildId === manifest.buildId && stableStringify(provenance.dependencyHashes) === stableStringify(manifest.dependencyHashes), 'compiler provenance does not match manifest');
  ensure(!/timestamp|createdAt|generatedAt/i.test(JSON.stringify(provenance)), 'compiler provenance contains nondeterministic timestamps');
  for (const file of [...provenance.sourceFiles, ...provenance.compilerFiles]) {
    const path = join(ROOT, file.path);
    ensure(existsSync(path) && sha256(readFileSync(path)) === file.hash, `compiler provenance hash mismatch: ${file.path}`);
  }
  const chunkDirectory = join(outputRoot, 'melbourne', 'chunks');
  const entries = new Map();
  const expectedFiles = new Set();
  const nodes = new Set();
  const edges = [];
  let totalRender = 0;
  let totalData = 0;

  for (const entry of manifest.chunks) {
    const key = chunkKey(entry.kx, entry.kz);
    ensure(!entries.has(key), `duplicate manifest chunk ${key}`);
    ensure(entry.kx >= MIN_CHUNK && entry.kx <= MAX_CHUNK && entry.kz >= MIN_CHUNK && entry.kz <= MAX_CHUNK, `out-of-range manifest chunk ${key}`);
    const expectedBounds = {
      minX: (entry.kx * CHUNK_TILES - 0.5) * TILE,
      minZ: (entry.kz * CHUNK_TILES - 0.5) * TILE,
      maxX: ((entry.kx + 1) * CHUNK_TILES - 0.5) * TILE,
      maxZ: ((entry.kz + 1) * CHUNK_TILES - 0.5) * TILE,
    };
    ensure(Object.entries(expectedBounds).every(([name, value]) => entry.bounds[name] === value), `chunk ${key} bounds mismatch`);
    const glbName = `${entry.kx}_${entry.kz}.glb`;
    const binName = `${entry.kx}_${entry.kz}.bin`;
    ensure(entry.renderUrl === `/maps/melbourne/chunks/${glbName}` && entry.dataUrl === `/maps/melbourne/chunks/${binName}`, `chunk ${key} URL mismatch`);
    const glb = readFileSync(join(chunkDirectory, glbName));
    const bin = readFileSync(join(chunkDirectory, binName));
    ensure(glb.length === entry.renderBytes && bin.length === entry.dataBytes, `chunk ${key} byte size mismatch`);
    ensure(sha256(glb) === entry.renderHash && sha256(bin) === entry.dataHash, `chunk ${key} content hash mismatch`);
    const gltf = parseGlb(glb);
    ensure(!gltf.extensionsRequired || gltf.extensionsRequired.every((extension) => manifest.required.gltfExtensions.includes(extension)), `chunk ${key} requires an undeclared glTF extension`);
    validateGlbDocument(glb, gltf, key);
    const container = parseChunkContainer(bin, entry);
    ensure(container.sections.get('HGT1').length === 121 * 2, `chunk ${key} HGT1 length mismatch`);
    ensure(container.sections.get('COL1').length >= 12 && container.sections.get('COL1').readUInt16LE(0) === 1, `chunk ${key} COL1 is invalid`);
    ensure(container.sections.get('GME1').length >= 8 && container.sections.get('GME1').readUInt16LE(0) === 1, `chunk ${key} GME1 is invalid`);
    decodeNavigation(container.sections.get('NAV1'), entry, nodes, edges);
    entries.set(key, entry);
    expectedFiles.add(glbName);
    expectedFiles.add(binName);
    totalRender += glb.length;
    totalData += bin.length;
  }

  for (const edge of edges) {
    ensure(nodes.has(`${edge.fromCx},${edge.fromCz}`), `dangling navigation edge source ${edge.fromCx},${edge.fromCz}`);
    const targetChunk = chunkKey(Math.floor(edge.toCx / CHUNK_TILES), Math.floor(edge.toCz / CHUNK_TILES));
    if (entries.has(targetChunk) || !manifest.partial) ensure(nodes.has(`${edge.toCx},${edge.toCz}`), `dangling navigation edge target ${edge.toCx},${edge.toCz}`);
  }
  const actualFiles = new Set(readdirSync(chunkDirectory).filter((name) => name.endsWith('.glb') || name.endsWith('.bin')));
  ensure(actualFiles.size === expectedFiles.size && [...actualFiles].every((name) => expectedFiles.has(name)), 'compiled chunk directory contains stale or orphan assets');
  ensure(manifest.totals.chunks === entries.size && manifest.totals.renderBytes === totalRender && manifest.totals.dataBytes === totalData, 'compiled manifest totals mismatch');
  if (!manifest.partial) ensure(entries.size === (MAX_CHUNK - MIN_CHUNK + 1) ** 2, 'full compiled manifest does not cover all Melbourne chunks');
  return { chunks: entries.size, nodes: nodes.size, edges: edges.length, bytes: totalRender + totalData, buildId: manifest.buildId };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outputIndex = process.argv.findIndex((argument) => argument === '--output');
  const inline = process.argv.find((argument) => argument.startsWith('--output='));
  const outputRoot = inline ? inline.slice('--output='.length) : outputIndex >= 0 ? process.argv[outputIndex + 1] : join(ROOT, 'public', 'maps');
  const result = validateCompiledMap(outputRoot);
  console.log(`validated ${result.chunks} chunks, ${result.nodes} navigation nodes, ${result.bytes} bytes (build ${result.buildId})`);
}
