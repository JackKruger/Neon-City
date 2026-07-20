import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import RAPIER from '@dimforge/rapier3d-compat';
import { MAP_SIZE } from './geo.mjs';
import { readObjectIndex } from './object-index.mjs';
import {
  MAX_GRADE,
  hgtTileNamesForBounds,
  maxRoadGrade,
  normalizeInfrastructureElevations,
  placeBuildingsOnTerrain,
  removeUrbanSurfaceSpikes,
} from './terrain.mjs';

test('infrastructure AHD levels normalize to the game sea datum', () => {
  const bridge = { kind: 'transport-structure', minAhd: 2.05, maxAhd: 4.95 };
  const duplicatePiece = { kind: 'transport-structure', minAhd: 2.05, maxAhd: 4.95 };
  const count = normalizeInfrastructureElevations({ '0,0': [bridge], '1,0': [duplicatePiece] }, 1.05);
  assert.equal(count, 2);
  assert.deepEqual({ baseY: bridge.baseY, topY: bridge.topY }, { baseY: 1, topY: 3.9 });
  assert.deepEqual({ baseY: duplicatePiece.baseY, topY: duplicatePiece.topY }, { baseY: 1, topY: 3.9 });
});

function readHeights() {
  const bytes = readFileSync(new URL('../../public/maps/melbourne-height.bin', import.meta.url));
  const expected = (MAP_SIZE + 1) ** 2;
  assert.equal(bytes.length, expected * 2);
  const heights = new Float64Array(expected);
  for (let i = 0; i < expected; i++) heights[i] = bytes.readInt16LE(i * 2) * 0.1;
  return heights;
}

test('baked Melbourne terrain pins water and keeps roads drivable', () => {
  const grid = new Uint8Array(readFileSync(new URL('../../public/maps/melbourne.bin', import.meta.url)));
  const heights = readHeights();
  const width = MAP_SIZE + 1;
  let maxDryHeight = -Infinity;
  const cell = (x, z) => x < 0 || z < 0 || x >= MAP_SIZE || z >= MAP_SIZE
    ? 5
    : grid[x + z * MAP_SIZE];
  for (let z = 0; z < width; z++) {
    for (let x = 0; x < width; x++) {
      const value = heights[x + z * width];
      const water = cell(x - 1, z - 1) === 5 && cell(x, z - 1) === 5 &&
        cell(x - 1, z) === 5 && cell(x, z) === 5;
      if (water) assert.equal(value, -1.6);
      else {
        assert.ok(value >= 0.3, `dry corner ${x},${z} is below the water plane: ${value}`);
        maxDryHeight = Math.max(maxDryHeight, value);
      }
    }
  }
  assert.ok(maxRoadGrade(heights, grid) <= MAX_GRADE, 'road grade exceeds terrain contract');
  assert.ok(maxDryHeight <= 65, `urban surface spike remains in terrain: ${maxDryHeight}m`);
});

test('HGT source selection includes every crossed one-degree tile', () => {
  assert.deepEqual(hgtTileNamesForBounds({
    south: -38.2,
    north: -36.8,
    west: 144.4,
    east: 146.2,
  }), [
    'S37E144', 'S37E145', 'S37E146',
    'S38E144', 'S38E145', 'S38E146',
    'S39E144', 'S39E145', 'S39E146',
  ]);
  assert.deepEqual(hgtTileNamesForBounds({
    south: -38,
    north: -37,
    west: 144,
    east: 145,
  }), ['S38E144']);
});

test('urban surface filter removes narrow towers without flattening broad terrain', () => {
  const width = 15;
  const broad = Float64Array.from({ length: width * width }, (_, index) => {
    const x = index % width;
    return x * 0.5;
  });
  const tower = 7 + 7 * width;
  broad[tower] += 70;
  const result = removeUrbanSurfaceSpikes(broad, width, { radius: 3, clearance: 2 });
  assert.ok(result.count > 0);
  assert.ok(result.maxReduction > 60);
  assert.ok(broad[tower] < 8, `tower remains too high: ${broad[tower]}`);
  assert.equal(broad[2 + 7 * width], 1);
  assert.equal(broad[12 + 7 * width], 6);
});

test('authored buildings derive their base without changing terrain', () => {
  const mapSize = 4;
  const width = mapSize + 1;
  const heights = Float64Array.from({ length: width * width }, (_, index) => {
    const x = index % width;
    const z = Math.floor(index / width);
    return x * 2 + z * 5;
  });
  const building = {
    kind: 'building',
    sourceId: 'building:test',
    x: 0,
    z: 0,
    outline: [[-2, -2], [12, -2], [12, 12], [-2, 12]],
  };
  const original = heights.slice();
  const [group] = placeBuildingsOnTerrain(
    heights,
    new Uint8Array(heights.length),
    { '0,0': [building] },
    { mapSize, tile: 10 }
  );
  assert.ok(group.corners.size > 4);
  const padHeights = [...group.corners].map((index) => heights[index]);
  assert.deepEqual(heights, original);
  assert.equal(building.baseY, Math.min(...padHeights));
});

test('multi-level building components retain source-relative elevation offsets', () => {
  const mapSize = 4;
  const width = mapSize + 1;
  const heights = new Float64Array(width * width).fill(7.2);
  const lower = {
    kind: 'building', sourceId: 'building:station:lower', structureId: 'building:station',
    baseOffset: 0, x: 0, z: 0, outline: [[-4, -4], [4, -4], [4, 4], [-4, 4]],
  };
  const tower = {
    kind: 'building', sourceId: 'building:station:tower', structureId: 'building:station',
    baseOffset: 18.5, x: 0, z: 0, outline: [[-2, -2], [2, -2], [2, 2], [-2, 2]],
  };
  placeBuildingsOnTerrain(
    heights,
    new Uint8Array(heights.length),
    { '0,0': [lower, tower] },
    { mapSize, tile: 10 }
  );
  assert.equal(lower.baseY, 7.2);
  assert.equal(tower.baseY, 25.7);
});

test('compiled map manifest and object index declare compatible formats', () => {
  const meta = JSON.parse(readFileSync(new URL('../../public/maps/melbourne.json', import.meta.url), 'utf8'));
  const objects = readObjectIndex(new URL('../../public/maps', import.meta.url).pathname, 'melbourne');
  assert.equal(meta.formatVersion, 4);
  assert.deepEqual(meta.heightGrid, {
    version: 1,
    file: 'melbourne-height.bin',
    encoding: 'int16le',
    scale: 0.1,
    width: MAP_SIZE + 1,
    height: MAP_SIZE + 1,
  });
  assert.equal(meta.chunkGrid.tiles, 10);
  assert.equal(meta.chunkGrid.size, 120);
  assert.equal(meta.objectIndex.version, 3);
  assert.equal(meta.objectIndex.shardChunks, 12);
  assert.equal(objects.version, 3);
  assert.equal(objects.chunkTiles, 10);
  assert.equal(objects.ownership, 'clipped-polygons');
  const buildingPieces = Object.values(objects.chunks).flat()
    .filter((object) => object.kind === 'building');
  assert.ok(buildingPieces.length > 0);
  assert.ok(buildingPieces.every((object) => typeof object.sourceId === 'string'));
  assert.ok(buildingPieces.every((object) => Number.isFinite(object.baseY)));
  const bases = new Map();
  for (const object of buildingPieces) {
    const previous = bases.get(object.sourceId);
    if (previous !== undefined) assert.equal(object.baseY, previous);
    else bases.set(object.sourceId, object.baseY);
  }
});

test('Rapier heightfield column-major order matches the global XZ corner lattice', async () => {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.8, z: 0 });
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  // h(x,z) = 10*x + 20*z at normalized corners, in Rapier column-major order.
  world.createCollider(
    RAPIER.ColliderDesc.heightfield(1, 1, new Float32Array([0, 20, 10, 30]), { x: 2, y: 1, z: 2 }),
    body
  );
  world.step();
  const samples = [
    [-0.8, -0.8, 3],
    [0.8, -0.8, 11],
    [-0.8, 0.8, 19],
    [0.8, 0.8, 27],
  ];
  for (const [x, z, expected] of samples) {
    const ray = new RAPIER.Ray({ x, y: 50, z }, { x: 0, y: -1, z: 0 });
    const hit = world.castRay(ray, 100, false);
    assert.ok(hit);
    assert.ok(Math.abs(50 - hit.timeOfImpact - expected) < 0.01);
  }
  world.free();
});
