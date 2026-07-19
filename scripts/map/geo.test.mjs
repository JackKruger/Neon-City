import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAP_SIZE,
  fillPolygon,
  markLine,
  orientedBounds,
  simplifyWorldRing,
  toGrid,
  toWorld,
} from './geo.mjs';

test('Melbourne projection round-trips the map centre', () => {
  const world = toWorld(-37.835, 144.96);
  assert.deepEqual(world, { x: 0, z: 0 });
  assert.deepEqual(toGrid(world.x, world.z), {
    gx: MAP_SIZE / 2,
    gz: MAP_SIZE / 2,
    index: MAP_SIZE / 2 + (MAP_SIZE / 2) * MAP_SIZE,
  });
});

test('line rasterisation stays four-connected', () => {
  const mask = new Uint8Array(MAP_SIZE * MAP_SIZE);
  markLine(mask, [[144.9595, -37.8345], [144.9605, -37.8355]]);
  const cells = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) cells.push([i % MAP_SIZE, Math.floor(i / MAP_SIZE)]);
  assert.ok(cells.length > 5);
  for (let i = 1; i < cells.length; i++) {
    const hasNeighbor = cells.some(([x, z], j) => j < i && Math.abs(x - cells[i][0]) + Math.abs(z - cells[i][1]) === 1);
    assert.ok(hasNeighbor);
  }
});

test('polygon bounds and raster fill cover the centre', () => {
  const ring = [
    [144.9598, -37.8348],
    [144.9602, -37.8348],
    [144.9602, -37.8352],
    [144.9598, -37.8352],
    [144.9598, -37.8348],
  ];
  const bounds = orientedBounds(ring);
  assert.ok(bounds && bounds.width > 30 && bounds.depth > 30);
  const mask = new Uint8Array(MAP_SIZE * MAP_SIZE);
  fillPolygon(mask, ring, 7);
  assert.equal(mask[MAP_SIZE / 2 + (MAP_SIZE / 2) * MAP_SIZE], 7);
});

test('building rings retain corners while shedding redundant points', () => {
  const ring = [
    [144.9598, -37.8348],
    [144.96, -37.8348],
    [144.9602, -37.8348],
    [144.9602, -37.8352],
    [144.9598, -37.8352],
    [144.9598, -37.8348],
  ];
  const outline = simplifyWorldRing(ring);
  assert.equal(outline.length, 4);
  assert.ok(outline.every((point) => Number.isFinite(point.x) && Number.isFinite(point.z)));
});
