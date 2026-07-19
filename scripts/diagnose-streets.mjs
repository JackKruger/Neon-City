#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const maps = join(ROOT, 'public', 'maps');
const objects = JSON.parse(readFileSync(join(maps, 'melbourne.objects.json'), 'utf8'));
const meta = JSON.parse(readFileSync(join(maps, 'melbourne.json'), 'utf8'));
const sources = JSON.parse(readFileSync(join(maps, 'melbourne.sources.json'), 'utf8'));
const spawnChunk = { kx: Math.floor(Math.round(meta.spawn.x / 12) / 10), kz: Math.floor(Math.round(meta.spawn.z / 12) / 10) };
const wanted = new Set();
for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) wanted.add(`${spawnChunk.kx + dx},${spawnChunk.kz + dz}`);

const records = Object.entries(objects.chunks)
  .filter(([key]) => wanted.has(key))
  .flatMap(([, values]) => values);
const unique = new Map();
for (const object of records) {
  const signature = `${object.sourceId ?? ''}:${object.kind}:${object.role ?? object.mode ?? ''}`;
  if (!unique.has(signature)) unique.set(signature, object);
}
const roles = {};
const modes = {};
let malformed = 0;
for (const object of unique.values()) {
  if (object.kind === 'road-surface') {
    roles[object.role ?? object.surface] = (roles[object.role ?? object.surface] ?? 0) + 1;
    if (!Array.isArray(object.outline) || object.outline.length < 3 || object.outline.flat().some((value) => !Number.isFinite(value))) malformed++;
  } else if (object.kind === 'nav-path') {
    modes[object.mode] = (modes[object.mode] ?? 0) + 1;
    if (!Array.isArray(object.points) || object.points.length < 2 || object.points.flat().some((value) => !Number.isFinite(value))) malformed++;
  }
}
const sourceStatus = Object.fromEntries(
  sources.sources
    .filter((source) => ['transport', 'footpaths', 'tramTracks', 'speeds'].includes(source.key))
    .map((source) => [source.key, source.status]),
);
const result = {
  pilot: { spawn: meta.spawn, centerChunk: spawnChunk, chunks: wanted.size },
  uniqueFeatures: unique.size,
  surfaceRoles: Object.fromEntries(Object.entries(roles).sort()),
  navigationModes: Object.fromEntries(Object.entries(modes).sort()),
  sourceStatus,
  malformed,
};
console.log(JSON.stringify(result, null, 2));
if (malformed > 0 || !modes.vehicle || !modes.pedestrian || !modes.tram) process.exitCode = 1;
