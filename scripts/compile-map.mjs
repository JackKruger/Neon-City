#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import {
  CONTAINER_VERSION,
  encodeChunkContainer,
  encodeGlb,
  GLTF_VERSION,
  MANIFEST_VERSION,
  parseGlb,
  RUNTIME_VERSION,
  sha256,
  stableStringify,
} from './map/compiled-format.mjs';
import {
  CHUNK_SIZE,
  CHUNK_TILES,
  compileChunkRecipe,
  createCompilerContext,
  MAP_SIZE,
  MATERIALS,
  MAX_CHUNK,
  MIN_CHUNK,
  TILE,
} from './map/compiled-recipes.mjs';
import { MAP_CONTRACT, MAP_CONTRACT_PATH, MAP_ID, VERSIONS } from './map/contract.mjs';
import { objectIndexFiles, readObjectIndex } from './map/object-index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_MAP_DIR = join(ROOT, 'public', 'maps');
const gltfIO = new NodeIO()
  .setLogger(new Logger(Logger.Verbosity.SILENT))
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

async function optimizeGlb(input) {
  await MeshoptEncoder.ready;
  const document = await gltfIO.readBinary(input);
  await document.transform(
    dedup(),
    weld(),
    prune(),
    meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 14, quantizeNormal: 10 })
  );
  return Buffer.from(await gltfIO.writeBinary(document));
}

function argument(name, fallback = null) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function readBytes(name) {
  return readFileSync(join(SOURCE_MAP_DIR, name));
}

function readInt16LE(name) {
  const bytes = readBytes(name);
  if (bytes.length % 2 !== 0) throw new Error(`${name} has an odd byte length`);
  const values = new Int16Array(bytes.length / 2);
  for (let i = 0; i < values.length; i++) values[i] = bytes.readInt16LE(i * 2);
  return values;
}

function filesBelow(root) {
  if (!existsSync(root)) return [];
  const output = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) visit(path);
      else output.push(path);
    }
  };
  visit(root);
  return output;
}

function hashFiles(paths, base = ROOT) {
  const hash = createHash('sha256');
  for (const path of [...paths].sort()) {
    hash.update(relative(base, path));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function selectedChunks(scope, spawn) {
  if (scope === 'all') {
    const chunks = [];
    for (let kz = MIN_CHUNK; kz <= MAX_CHUNK; kz++) {
      for (let kx = MIN_CHUNK; kx <= MAX_CHUNK; kx++) chunks.push({ kx, kz });
    }
    return chunks;
  }
  if (scope !== 'spawn') throw new Error(`unsupported compile scope "${scope}"`);
  const spawnCx = Math.round(spawn.x / TILE);
  const spawnCz = Math.round(spawn.z / TILE);
  const center = { kx: Math.floor(spawnCx / CHUNK_TILES), kz: Math.floor(spawnCz / CHUNK_TILES) };
  const chunks = [];
  // Match the runtime's normal load radius so the pilot can stream at spawn
  // without immediately stepping outside its committed fixture.
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) chunks.push({ kx: center.kx + dx, kz: center.kz + dz });
  }
  return chunks.sort((a, b) => a.kz - b.kz || a.kx - b.kx);
}

/** Publish the staged directory and metadata as one recoverable operation. */
export function publishCompiledMap(stagingRoot, outputRoot, stagingCity, stagedManifest, stagedProvenance) {
  const publications = [
    { staged: stagingCity, target: join(outputRoot, 'melbourne'), backup: join(stagingRoot, 'previous-city'), directory: true },
    { staged: stagedManifest, target: join(outputRoot, 'melbourne.compiled.json'), backup: join(stagingRoot, 'previous-manifest.json'), directory: false },
    { staged: stagedProvenance, target: join(outputRoot, 'melbourne.compiled.provenance.json'), backup: join(stagingRoot, 'previous-provenance.json'), directory: false },
  ];
  const backedUp = [];
  const installed = [];
  try {
    for (const publication of publications) {
      if (!existsSync(publication.target)) continue;
      renameSync(publication.target, publication.backup);
      backedUp.push(publication);
    }
    for (const publication of publications) {
      renameSync(publication.staged, publication.target);
      installed.push(publication);
    }
  } catch (publicationError) {
    let rollbackError = null;
    for (const publication of installed.reverse()) {
      try {
        if (existsSync(publication.target)) rmSync(publication.target, { recursive: publication.directory, force: true });
      } catch (error) {
        rollbackError ??= error;
      }
    }
    for (const publication of backedUp.reverse()) {
      try {
        if (existsSync(publication.backup)) renameSync(publication.backup, publication.target);
      } catch (error) {
        rollbackError ??= error;
      }
    }
    if (rollbackError) {
      const failure = new AggregateError(
        [publicationError, rollbackError],
        `compiled-map publication and rollback failed; recovery files remain in ${stagingRoot}`
      );
      failure.preserveStaging = true;
      throw failure;
    }
    throw publicationError;
  }
}

export async function compileMelbourne({ scope = 'all', outputRoot = join(ROOT, 'public', 'maps'), quiet = false } = {}) {
  const meta = JSON.parse(readBytes('melbourne.json'));
  if (meta.width !== MAP_SIZE || meta.height !== MAP_SIZE || meta.tile !== TILE) throw new Error('Melbourne source grid is incompatible with compiler configuration');
  const grid = new Uint8Array(readBytes('melbourne.bin'));
  const coverage = new Uint8Array(readBytes('melbourne.coverage.bin'));
  const transport = new Uint8Array(readBytes('melbourne.transport.bin'));
  const speed = new Uint8Array(readBytes('melbourne.speed.bin'));
  const heights = readInt16LE('melbourne-height.bin');
  const chunks = selectedChunks(scope, meta.spawn);
  const wantedObjectChunks = new Set();
  for (const { kx, kz } of chunks) {
    for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++) wantedObjectChunks.add(`${kx + ox},${kz + oz}`);
  }
  const objectIndex = readObjectIndex(SOURCE_MAP_DIR, 'melbourne', wantedObjectChunks);
  if (grid.length !== MAP_SIZE ** 2 || coverage.length !== grid.length || transport.length !== grid.length || speed.length !== grid.length) throw new Error('Melbourne source layers have incompatible lengths');
  if (heights.length !== (MAP_SIZE + 1) ** 2) throw new Error('Melbourne height lattice has incompatible dimensions');
  if (objectIndex.version !== VERSIONS.objectIndex || objectIndex.chunkTiles !== CHUNK_TILES || objectIndex.ownership !== 'clipped-polygons') throw new Error(`Melbourne object index requires clipped-polygons version ${VERSIONS.objectIndex}`);

  const sourcePaths = [
    'melbourne.json', 'melbourne.bin', 'melbourne-height.bin', 'melbourne.coverage.bin',
    'melbourne.transport.bin', 'melbourne.speed.bin', 'melbourne.landuse.bin',
    'melbourne.height.bin', 'melbourne.address.bin',
    'melbourne.sources.json',
  ].map((name) => join(SOURCE_MAP_DIR, name)).concat(objectIndexFiles(SOURCE_MAP_DIR, 'melbourne', wantedObjectChunks));
  const compilerPaths = [
    fileURLToPath(MAP_CONTRACT_PATH),
    join(ROOT, 'scripts', 'map', 'contract.mjs'),
    join(ROOT, 'scripts', 'compile-map.mjs'),
    join(ROOT, 'scripts', 'map', 'compiled-format.mjs'),
    join(ROOT, 'scripts', 'map', 'object-index.mjs'),
    join(ROOT, 'scripts', 'map', 'compiled-recipes.mjs'),
    join(ROOT, 'package-lock.json'),
  ];
  const dependencyHashes = {
    sources: hashFiles(sourcePaths),
    configuration: sha256(stableStringify({ tile: TILE, chunkTiles: CHUNK_TILES, mapSize: MAP_SIZE, bounds: [MIN_CHUNK, MAX_CHUNK], materials: MATERIALS, gltfOptimization: { dedup: true, weld: true, prune: true, meshopt: 'medium', quantizePosition: 14, quantizeNormal: 10 } })),
    generators: hashFiles(compilerPaths),
    assetPacks: hashFiles(filesBelow(join(ROOT, 'public', 'assets'))),
  };
  const buildId = sha256(stableStringify(dependencyHashes)).slice(0, 24);
  mkdirSync(outputRoot, { recursive: true });
  const stagingRoot = mkdtempSync(join(outputRoot, '.melbourne-compile-'));
  const stagingCity = join(stagingRoot, 'melbourne');
  const stagingChunks = join(stagingCity, 'chunks');
  mkdirSync(stagingChunks, { recursive: true });
  const context = createCompilerContext({ meta, grid, heights, coverage, transport, speed, objectIndex });
  const manifestChunks = [];
  let renderBytes = 0;
  let dataBytes = 0;
  const requiredGltfExtensions = new Set();
  let preserveStagingOnError = false;

  try {
    for (let i = 0; i < chunks.length; i++) {
      const { kx, kz } = chunks[i];
      const compiled = compileChunkRecipe(context, kx, kz);
      const glb = await optimizeGlb(encodeGlb(compiled.primitives, MATERIALS));
      const bin = encodeChunkContainer(kx, kz, compiled.sections);
      for (const extension of parseGlb(glb).extensionsRequired ?? []) requiredGltfExtensions.add(extension);
      const base = `${kx}_${kz}`;
      writeFileSync(join(stagingChunks, `${base}.glb`), glb);
      writeFileSync(join(stagingChunks, `${base}.bin`), bin);
      const inputHash = sha256(stableStringify(compiled.recipe));
      manifestChunks.push({
        kx,
        kz,
        bounds: {
          minX: (kx * CHUNK_TILES - 0.5) * TILE,
          minZ: (kz * CHUNK_TILES - 0.5) * TILE,
          maxX: ((kx + 1) * CHUNK_TILES - 0.5) * TILE,
          maxZ: ((kz + 1) * CHUNK_TILES - 0.5) * TILE,
        },
        renderUrl: `/maps/melbourne/chunks/${base}.glb`,
        dataUrl: `/maps/melbourne/chunks/${base}.bin`,
        renderBytes: glb.length,
        dataBytes: bin.length,
        renderHash: sha256(glb),
        dataHash: sha256(bin),
        inputHash,
        empty: {
          render: compiled.primitives.length === 0,
          collision: compiled.counts.cuboids + compiled.counts.meshes === 0,
          navigation: compiled.counts.nodes === 0,
          gameplay: compiled.counts.parked === 0 && compiled.counts.sources === 0,
        },
        counts: compiled.counts,
      });
      renderBytes += glb.length;
      dataBytes += bin.length;
      if (!quiet && (scope === 'spawn' || (i + 1) % 100 === 0 || i + 1 === chunks.length)) console.log(`compiled ${i + 1}/${chunks.length} chunks`);
    }

    manifestChunks.sort((a, b) => a.kz - b.kz || a.kx - b.kx);
    const manifest = {
      version: MANIFEST_VERSION,
      mapId: MAP_ID,
      buildId,
      compilerVersion: VERSIONS.compiler,
      coordinateConvention: MAP_CONTRACT.coordinateConvention,
      tileSize: TILE,
      chunkTiles: CHUNK_TILES,
      chunkSize: CHUNK_SIZE,
      validChunkBounds: { minX: MIN_CHUNK, maxX: MAX_CHUNK, minZ: MIN_CHUNK, maxZ: MAX_CHUNK },
      spawn: meta.spawn,
      scope,
      partial: scope !== 'all',
      required: {
        runtimeVersion: RUNTIME_VERSION,
        containerVersion: CONTAINER_VERSION,
        gltfVersion: GLTF_VERSION,
        gltfExtensions: [...requiredGltfExtensions].sort(),
      },
      dependencyHashes,
      totals: { chunks: manifestChunks.length, renderBytes, dataBytes },
      chunks: manifestChunks,
    };
    const provenance = {
      version: VERSIONS.provenance,
      mapId: MAP_ID,
      buildId,
      scope,
      dependencyHashes,
      sourceFiles: sourcePaths.map((path) => ({ path: relative(ROOT, path), hash: sha256(readFileSync(path)) })),
      compilerFiles: compilerPaths.map((path) => ({ path: relative(ROOT, path), hash: sha256(readFileSync(path)) })),
    };

    const stagedManifest = join(stagingRoot, 'melbourne.compiled.json');
    const stagedProvenance = join(stagingRoot, 'melbourne.compiled.provenance.json');
    writeFileSync(stagedManifest, `${stableStringify(manifest)}\n`);
    writeFileSync(stagedProvenance, `${stableStringify(provenance)}\n`);
    try {
      publishCompiledMap(stagingRoot, outputRoot, stagingCity, stagedManifest, stagedProvenance);
    } catch (error) {
      preserveStagingOnError = error?.preserveStaging === true;
      throw error;
    }
    rmSync(stagingRoot, { recursive: true, force: true });
    if (!quiet) console.log(`wrote ${manifestChunks.length} deterministic chunks (${renderBytes + dataBytes} bytes), build ${buildId}`);
    return manifest;
  } catch (error) {
    if (!preserveStagingOnError) rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const scope = argument('scope', 'all');
  const output = argument('output', join(ROOT, 'public', 'maps'));
  await compileMelbourne({ scope, outputRoot: output });
}
