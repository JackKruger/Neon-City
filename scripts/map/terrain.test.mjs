import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import RAPIER from '@dimforge/rapier3d-compat';
import { MAP_SIZE } from './geo.mjs';
import { readObjectIndex } from './object-index.mjs';
import {
  applyTerrainCuttings,
  hgtTileNamesForBounds,
  normalizeInfrastructureElevations,
  placeBuildingsOnTerrain,
  removeUrbanSurfaceSpikes,
} from './terrain.mjs';

test('infrastructure AHD levels normalize to the game sea datum', () => {
  const bridge = { kind: 'transport-structure', minAhd: 2.05, maxAhd: 4.95 };
  const duplicatePiece = { kind: 'transport-structure', minAhd: 2.05, maxAhd: 4.95 };
  const cutting = { kind: 'terrain-cutting', floorAhd: 4.1 };
  const canopy = { kind: 'station-canopy', floorAhd: 4.1, roofAhd: 10.4 };
  const railTunnel = { kind: 'rail-structure', structure: 'tunnel', railBedAhd: 4.1, roofAhd: 10.4 };
  const railOpenCut = { kind: 'rail-structure', structure: 'open-cut', floorAhd: 4.1, parapetAhd: 6.05 };
  const platform = { kind: 'station-platform', platformAhd: 4.1, concourseAhd: 12.05 };
  const count = normalizeInfrastructureElevations(
    { '0,0': [bridge, cutting, canopy, railTunnel, railOpenCut, platform], '1,0': [duplicatePiece] }, 1.05);
  assert.equal(count, 7);
  assert.deepEqual({ baseY: bridge.baseY, topY: bridge.topY }, { baseY: 1, topY: 3.9 });
  assert.deepEqual({ baseY: duplicatePiece.baseY, topY: duplicatePiece.topY }, { baseY: 1, topY: 3.9 });
  assert.equal(cutting.floorY, 3.1);
  assert.deepEqual({ floorY: canopy.floorY, roofY: canopy.roofY }, { floorY: 3.1, roofY: 9.4 });
  assert.deepEqual({ railBedY: railTunnel.railBedY, roofY: railTunnel.roofY }, { railBedY: 3.1, roofY: 9.4 });
  assert.deepEqual({ railBedY: railOpenCut.railBedY, parapetY: railOpenCut.parapetY }, { railBedY: 3.1, parapetY: 5 });
  assert.deepEqual({ platformY: platform.platformY, concourseY: platform.concourseY }, { platformY: 3.1, concourseY: 11 });
});

test('reviewed cutting pins only covered corners and preserves natural samples', () => {
  const mapSize = 4;
  const quantized = Int16Array.from({ length: (mapSize + 1) ** 2 }, (_, index) => 80 + index);
  const cutting = {
    kind: 'terrain-cutting', sourceId: 'terrain-cutting:test', x: 0, z: 0, floorY: 4.1,
    outline: [[-6, -6], [6, -6], [6, 6], [-6, 6]],
  };
  const duplicate = structuredClone(cutting);
  const original = quantized.slice();
  const result = applyTerrainCuttings(quantized, { '0,0': [cutting], '1,0': [duplicate] }, { mapSize, tile: 10 });
  assert.deepEqual(result, { cuttings: 1, changedCorners: 4 });
  assert.equal(cutting.terrainCorners.length, 4);
  assert.deepEqual(duplicate.terrainCorners, cutting.terrainCorners);
  for (const [ix, iz, raw] of cutting.terrainCorners) {
    const index = ix + mapSize / 2 + (iz + mapSize / 2) * (mapSize + 1);
    assert.equal(raw, original[index]);
    assert.equal(quantized[index], 41);
  }
  assert.equal(quantized[0], original[0], 'surrounding terrain changed');
});

function readHeights() {
  const bytes = readFileSync(new URL('../../public/maps/melbourne-height.bin', import.meta.url));
  const expected = (MAP_SIZE + 1) ** 2;
  assert.equal(bytes.length, expected * 2);
  const heights = new Float64Array(expected);
  for (let i = 0; i < expected; i++) heights[i] = bytes.readInt16LE(i * 2) * 0.1;
  return heights;
}

test('baked Melbourne terrain pins water and caps urban surface spikes', () => {
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
  assert.ok(maxDryHeight <= 65, `urban surface spike remains in terrain: ${maxDryHeight}m`);
});

test('committed Flinders override is a rail structure over intact natural terrain', () => {
  const objects = readObjectIndex(new URL('../../public/maps', import.meta.url).pathname, 'melbourne');
  const authored = Object.values(objects.chunks).flat();
  const unique = (kind) => [...new Map(authored.filter((object) => object.kind === kind)
    .map((object) => [object.sourceId, object])).values()];
  const [rail] = unique('rail-structure');
  const [canopy] = unique('station-canopy');
  // The station is an independent open-cut rail structure, not a terrain carve.
  assert.equal(rail.sourceId, 'rail-structure:flinders-street-station');
  assert.equal(rail.structure, 'open-cut');
  assert.equal(rail.railBedAhd, 4.1);
  // The baked SRTM water datum resolves the 4.1 m AHD bed to 3.0 m game Y.
  assert.equal(rail.railBedY, 3);
  assert.ok(authored.some((object) => object.kind === 'rail-portal' && object.structureId === rail.structureId),
    'rail portals no longer reference the structure');
  assert.equal(canopy.sourceId, 'building:804817:1139');
  assert.deepEqual({ floorY: canopy.floorY, roofY: canopy.roofY }, { floorY: 3, roofY: 9.3 });
  assert.ok(!authored.some((object) => object.kind === 'building' && object.sourceId === canopy.sourceId),
    'station canopy still compiles as a solid generic building');
  // No terrain carve survives. (That the ground now reads natural, not rail
  // grade, is enforced by the terrainHeightAt invariant in compiled.test.mjs.)
  assert.ok(!authored.some((object) => object.kind === 'terrain-cutting'), 'a terrain carve still exists');
  assert.ok(!authored.some((object) => object.kind === 'terrain-portal'), 'a legacy terrain portal still exists');
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
