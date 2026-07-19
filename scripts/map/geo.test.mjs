import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAP_SIZE,
  chunkBounds,
  clipPolygonToBounds,
  fillPolygon,
  markLine,
  orientedBounds,
  simplifyWorldRing,
  splitPolygonByChunks,
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

test('cross-boundary polygons are clipped into non-overlapping chunk pieces', () => {
  const polygon = [
    [108, -10],
    [120, -10],
    [120, 10],
    [108, 10],
  ];
  const parts = splitPolygonByChunks(polygon);
  assert.deepEqual(parts.map((part) => part.key).sort(), ['0,-1', '0,0', '1,-1', '1,0']);
  for (const part of parts) {
    const bounds = chunkBounds(part.kx, part.kz);
    assert.ok(part.polygon.every(([x, z]) =>
      x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ));
  }
  const left = clipPolygonToBounds(polygon, chunkBounds(0, 0));
  const right = clipPolygonToBounds(polygon, chunkBounds(1, 0));
  const width = (points) => Math.max(...points.map(([x]) => x)) - Math.min(...points.map(([x]) => x));
  assert.equal(width(left) + width(right), 12);
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
