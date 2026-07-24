import { describe, expect, it } from 'vitest';
import {
  CharacterPlacementIndex,
  ON_FOOT_HEIGHT,
  ON_FOOT_RADIUS,
} from '../../src/world/CharacterPlacement';
import type { CompiledChunkData } from '../../src/world/CompiledFormat';

function chunkData(): CompiledChunkData {
  return {
    kx: 0,
    kz: 0,
    heights: new Int16Array(121),
    collisionFlags: 0,
    cuboids: [
      {
        x: 0,
        y: 5,
        z: 0,
        hx: 2,
        hy: 5,
        hz: 2,
        rotation: 0,
        sourceIndex: 0,
      },
      {
        x: 20,
        y: 1,
        z: 0,
        hx: 1,
        hy: 1,
        hz: 1,
        rotation: 0,
        sourceIndex: 2,
      },
    ],
    meshes: [{
      sourceIndex: 1,
      vertices: new Float32Array([
        8, 0, -2,
        12, 0, -2,
        12, 0, 2,
        8, 0, 2,
        8, 8, -2,
        12, 8, -2,
        12, 8, 2,
        8, 8, 2,
      ]),
      indices: new Uint32Array([
        0, 2, 1,
        0, 3, 2,
        4, 5, 6,
        4, 6, 7,
      ]),
    }],
    navNodes: [],
    navEdges: [],
    cells: new Uint8Array(100),
    parked: [],
    transitStops: [],
    sources: ['building:box', 'generated:building:polygon', 'tree:test'],
  };
}

describe('on-foot building clearance', () => {
  it('detects cuboid and polygon interiors without treating roofs or props as buildings', () => {
    const index = new CharacterPlacementIndex();
    index.registerChunk('0,0', chunkData());

    expect(index.blocks(0, 0, 0, ON_FOOT_RADIUS, ON_FOOT_HEIGHT)).toBe(true);
    expect(index.blocks(2.2, 0, 0, ON_FOOT_RADIUS, ON_FOOT_HEIGHT)).toBe(true);
    expect(index.blocks(2.5, 0, 0, ON_FOOT_RADIUS, ON_FOOT_HEIGHT)).toBe(false);
    expect(index.blocks(10, 0, 0, ON_FOOT_RADIUS, ON_FOOT_HEIGHT)).toBe(true);
    expect(index.blocks(0, 10.05, 0, ON_FOOT_RADIUS, ON_FOOT_HEIGHT)).toBe(false);
    expect(index.blocks(20, 0, 0, ON_FOOT_RADIUS, ON_FOOT_HEIGHT)).toBe(false);
  });

  it('removes only the pedestrian mode from enclosed navigation', () => {
    const index = new CharacterPlacementIndex();
    index.registerChunk('0,0', chunkData());
    const navigation = index.filterPedestrianNavigation(
      [
        { x: 0, y: 0, z: 0, flags: 2, speed: 5 },
        { x: 0, y: 0, z: 1, flags: 3, speed: 5 },
        { x: 4, y: 0, z: 0, flags: 2, speed: 5 },
      ],
      [
        { fromX: 0, fromZ: 0, toX: 4, toZ: 0, flags: 2 },
        { fromX: 0, fromZ: 1, toX: 4, toZ: 0, flags: 3 },
        { fromX: 4, fromZ: 0, toX: 5, toZ: 0, flags: 2 },
      ],
      ON_FOOT_RADIUS,
      ON_FOOT_HEIGHT
    );

    expect(navigation.nodes).toEqual([
      { x: 0, y: 0, z: 1, flags: 1, speed: 5 },
      { x: 4, y: 0, z: 0, flags: 2, speed: 5 },
    ]);
    expect(navigation.edges).toEqual([
      { fromX: 0, fromZ: 1, toX: 4, toZ: 0, flags: 1 },
      { fromX: 4, fromZ: 0, toX: 5, toZ: 0, flags: 2 },
    ]);
  });

  it('rejects pedestrian edges that cross a building between clear endpoints', () => {
    const index = new CharacterPlacementIndex();
    index.registerChunk('0,0', chunkData());
    const navigation = index.filterPedestrianNavigation(
      [
        { x: -4, y: 0, z: 0, flags: 2, speed: 5 },
        { x: 4, y: 0, z: 0, flags: 2, speed: 5 },
        { x: -4, y: 0, z: 2.2, flags: 3, speed: 5 },
        { x: 4, y: 0, z: 2.2, flags: 3, speed: 5 },
        { x: 6, y: 0, z: 0, flags: 2, speed: 5 },
        { x: 14, y: 0, z: 0, flags: 2, speed: 5 },
      ],
      [
        { fromX: -4, fromZ: 0, toX: 4, toZ: 0, flags: 2 },
        { fromX: -4, fromZ: 2.2, toX: 4, toZ: 2.2, flags: 3 },
        { fromX: 6, fromZ: 0, toX: 14, toZ: 0, flags: 2 },
      ],
      ON_FOOT_RADIUS,
      ON_FOOT_HEIGHT
    );

    expect(navigation.nodes).toHaveLength(6);
    expect(navigation.edges).toEqual([
      { fromX: -4, fromZ: 2.2, toX: 4, toZ: 2.2, flags: 1 },
    ]);
  });
});
