import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import RAPIER from '@dimforge/rapier3d-compat';
import { MAP_SIZE } from './geo.mjs';
import {
  MAX_GRADE,
  flattenBuildingPads,
  hgtTileNamesForBounds,
  maxRoadGrade,
} from './terrain.mjs';

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
  const cell = (x, z) => x < 0 || z < 0 || x >= MAP_SIZE || z >= MAP_SIZE
    ? 5
    : grid[x + z * MAP_SIZE];
  for (let z = 0; z < width; z++) {
    for (let x = 0; x < width; x++) {
      const value = heights[x + z * width];
      const water = cell(x - 1, z - 1) === 5 && cell(x, z - 1) === 5 &&
        cell(x - 1, z) === 5 && cell(x, z) === 5;
      if (water) assert.equal(value, -1.6);
      else assert.ok(value >= 0.3, `dry corner ${x},${z} is below the water plane: ${value}`);
    }
  }
  assert.ok(maxRoadGrade(heights, grid) <= MAX_GRADE, 'road grade exceeds terrain contract');
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

test('authored footprint pads flatten every covered terrain cell', () => {
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
  const [group] = flattenBuildingPads(
    heights,
    new Uint8Array(heights.length),
    { '0,0': [building] },
    { mapSize, tile: 10 }
  );
  assert.ok(group.corners.size > 4);
  const padHeights = [...group.corners].map((index) => heights[index]);
  assert.ok(padHeights.every((height) => height === padHeights[0]));
  assert.equal(building.baseY, padHeights[0]);
});

test('compiled map manifest and object index declare compatible formats', () => {
  const meta = JSON.parse(readFileSync(new URL('../../public/maps/melbourne.json', import.meta.url), 'utf8'));
  const objects = JSON.parse(readFileSync(new URL('../../public/maps/melbourne.objects.json', import.meta.url), 'utf8'));
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
  assert.equal(meta.objectIndex.version, 2);
  assert.equal(objects.version, 2);
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
