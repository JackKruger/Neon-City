import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHUNK_TILES, VERSIONS } from './contract.mjs';

export const OBJECT_SHARD_CHUNKS = 12;

function parseChunkKey(key) {
  const [kx, kz] = key.split(',').map(Number);
  if (!Number.isInteger(kx) || !Number.isInteger(kz)) throw new Error(`invalid object chunk key ${key}`);
  return { kx, kz };
}

function shardKey(kx, kz, shardChunks = OBJECT_SHARD_CHUNKS) {
  return `${Math.floor(kx / shardChunks)},${Math.floor(kz / shardChunks)}`;
}

function validateManifest(index) {
  if (!index || index.version !== VERSIONS.objectIndex || index.chunkTiles !== CHUNK_TILES ||
      index.ownership !== 'clipped-polygons' || !Number.isInteger(index.shardChunks) ||
      typeof index.shards !== 'object') {
    throw new Error(`object index requires sharded clipped-polygons version ${VERSIONS.objectIndex}`);
  }
}

function wantedShardKeys(manifest, wantedChunkKeys) {
  return wantedChunkKeys === null
    ? new Set(Object.keys(manifest.shards))
    : new Set([...wantedChunkKeys].map((key) => {
      const { kx, kz } = parseChunkKey(key);
      return shardKey(kx, kz, manifest.shardChunks);
    }));
}

export function objectIndexFiles(directory, mapName = 'melbourne', wantedChunkKeys = null) {
  const manifest = join(directory, `${mapName}.objects.json`);
  if (!existsSync(manifest)) return [];
  const index = JSON.parse(readFileSync(manifest, 'utf8'));
  if (index.version === 2 && index.chunks) return [manifest];
  validateManifest(index);
  const shards = [...wantedShardKeys(index, wantedChunkKeys)]
    .sort()
    .map((key) => index.shards[key])
    .filter(Boolean)
    .map((file) => join(directory, file));
  return [manifest, ...shards];
}

export function readObjectIndex(directory, mapName = 'melbourne', wantedChunkKeys = null) {
  const manifest = JSON.parse(readFileSync(join(directory, `${mapName}.objects.json`), 'utf8'));
  // Permit one migration read so --roads-only and --heights-only can convert
  // the previously committed monolith without a separate manual step.
  if (manifest.version === 2 && manifest.ownership === 'clipped-polygons' && manifest.chunks) return manifest;
  validateManifest(manifest);
  const wantedShards = wantedShardKeys(manifest, wantedChunkKeys);
  const chunks = {};
  for (const key of [...wantedShards].sort()) {
    const file = manifest.shards[key];
    if (!file) continue;
    const shard = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    if (!shard || shard.version !== VERSIONS.objectIndex || shard.shard !== key || typeof shard.chunks !== 'object') {
      throw new Error(`invalid object shard ${key}`);
    }
    Object.assign(chunks, shard.chunks);
  }
  return {
    version: manifest.version,
    chunkTiles: manifest.chunkTiles,
    ownership: manifest.ownership,
    roadSurfaces: manifest.roadSurfaces === true,
    chunks,
  };
}

export function writeObjectIndex(directory, mapName, chunks, roadSurfaces) {
  const shardDirectoryName = `${mapName}.objects`;
  const shardDirectory = join(directory, shardDirectoryName);
  rmSync(shardDirectory, { recursive: true, force: true });
  mkdirSync(shardDirectory, { recursive: true });
  const grouped = new Map();
  for (const key of Object.keys(chunks).sort()) {
    const { kx, kz } = parseChunkKey(key);
    const group = shardKey(kx, kz);
    if (!grouped.has(group)) grouped.set(group, {});
    grouped.get(group)[key] = chunks[key];
  }
  const shards = {};
  for (const [key, shardChunks] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    const filename = `${key.replace(',', '_')}.json`;
    const relative = `${shardDirectoryName}/${filename}`;
    writeFileSync(join(directory, relative), JSON.stringify({
      version: VERSIONS.objectIndex,
      shard: key,
      chunks: shardChunks,
    }));
    shards[key] = relative;
  }
  writeFileSync(join(directory, `${mapName}.objects.json`), JSON.stringify({
    version: VERSIONS.objectIndex,
    chunkTiles: CHUNK_TILES,
    ownership: 'clipped-polygons',
    roadSurfaces,
    shardChunks: OBJECT_SHARD_CHUNKS,
    shards,
  }));
}
