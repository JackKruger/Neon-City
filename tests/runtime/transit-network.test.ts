import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Game } from '../../src/core/Game';
import { TransitVehicle } from '../../src/world/Transit';
import {
  CompiledRoadNetwork,
  setRoadNetwork,
  type CellRef,
} from '../../src/world/RoadGraph';

beforeAll(async () => {
  await RAPIER.init();
});

describe('compiled transit navigation', () => {
  it('keeps train and tram nodes separate from ordinary road traffic', () => {
    const network = new CompiledRoadNetwork();
    network.registerChunk('0,0', [
      { x: 0, y: 3.2, z: 0, flags: 8, speed: 80 },
      { x: 10, y: 3.3, z: 0, flags: 8, speed: 80 },
      { x: 0, y: 3.2, z: 4, flags: 4, speed: 40 },
      { x: 10, y: 3.3, z: 4, flags: 4, speed: 40 },
    ], [
      { fromX: 0, fromZ: 0, toX: 10, toZ: 0, flags: 8 },
      { fromX: 0, fromZ: 4, toX: 10, toZ: 4, flags: 4 },
    ]);

    const train = network.nearest({ cx: 0, cz: 0, x: 0, z: 0 }, 'train');
    expect(train).toMatchObject({ x: 0, y: 3.2, z: 0, mode: 'train', speed: 80 });
    expect(network.neighbors(train!, 'train')).toHaveLength(1);
    expect(network.neighbors(train!, 'tram')).toEqual([]);
    expect(network.points('train')).toHaveLength(2);
  });

  it('removes transit paths with their streamed chunk', () => {
    const network = new CompiledRoadNetwork();
    network.registerChunk('0,0', [{ x: 0, y: 0, z: 0, flags: 8, speed: 60 }], []);
    network.unregisterChunk('0,0');
    expect(network.points('train')).toEqual([]);
  });

  it('carries movement across nodes without cutting the corner or lagging below the grade', () => {
    const network = new CompiledRoadNetwork();
    const a = { x: 0, y: 0, z: 0, flags: 4, speed: 40 };
    const b = { x: 0, y: 1, z: 10, flags: 4, speed: 40 };
    const c = { x: 10, y: 2, z: 10, flags: 4, speed: 40 };
    network.registerChunk('0,0', [a, b, c], [
      { fromX: 0, fromZ: 0, toX: 0, toZ: 10, flags: 4 },
      { fromX: 0, fromZ: 10, toX: 10, toZ: 10, flags: 4 },
    ]);
    setRoadNetwork(network);
    try {
      const vehicle = Object.create(TransitVehicle.prototype) as TransitVehicle;
      Object.assign(vehicle, {
        mode: 'tram',
        from: { ...a, cx: 0, cz: 0, mode: 'tram' } satisfies CellRef,
        to: { ...b, cx: 0, cz: 1, mode: 'tram' } satisfies CellRef,
        fromWorld: { x: a.x, y: a.y, z: a.z },
        waypoint: { x: b.x, y: b.y, z: b.z },
        trackPosition: { x: a.x, y: a.y, z: a.z },
        game: { roadSurfaceHeightAt: () => 0 },
      });

      (vehicle as unknown as { moveAlongTrack(distance: number): void }).moveAlongTrack(12);
      const position = (vehicle as unknown as {
        trackPosition: { x: number; y: number; z: number };
      }).trackPosition;
      expect(position).toEqual({ x: 2, y: 1.2, z: 10 });
    } finally {
      setRoadNetwork(null);
    }
  });

  it('poses each car from separated bogies on the recorded 3D track', () => {
    const vehicle = Object.create(TransitVehicle.prototype) as TransitVehicle;
    const group = new THREE.Group();
    Object.assign(vehicle, {
      heading: 0,
      trail: Array.from({ length: 12 }, (_, index) => ({
        x: 0,
        y: 2 - index * 0.1,
        z: 10 - index,
      })),
      cars: [{ group, arc: 3, halfWheelbase: 1 }],
    });

    (vehicle as unknown as { layoutCars(): void }).layoutCars();

    expect(group.position.x).toBeCloseTo(0);
    expect(group.position.y).toBeCloseTo(1.7);
    expect(group.position.z).toBeCloseTo(7, 1);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(group.quaternion);
    expect(forward.y).toBeGreaterThan(0.09);
    expect(forward.z).toBeGreaterThan(0.99);
  });

  it('keeps a live tram on the exact graded centreline after its seeded trail clears', () => {
    const network = new CompiledRoadNetwork();
    const nodes = [
      { x: 0, y: 0, z: 0, flags: 4, speed: 50 },
      { x: 0, y: 5, z: 50, flags: 4, speed: 50 },
      { x: 0, y: 0, z: 100, flags: 4, speed: 50 },
    ];
    network.registerChunk('0,0', nodes, [
      { fromX: 0, fromZ: 0, toX: 0, toZ: 50, flags: 4 },
      { fromX: 0, fromZ: 50, toX: 0, toZ: 100, flags: 4 },
    ]);
    setRoadNetwork(network);
    const world = new RAPIER.World({ x: 0, y: -20, z: 0 });
    const game = {
      scene: new THREE.Scene(),
      world,
      vehicles: [],
      roadSurfaceHeightAt: () => 0,
    } as unknown as Game;
    const from = { ...nodes[0], cx: 0, cz: 0, mode: 'tram' } satisfies CellRef;
    const to = { ...nodes[1], cx: 0, cz: 4, mode: 'tram' } satisfies CellRef;
    const tram = new TransitVehicle(game, 'tram', from, to);
    try {
      for (let frame = 0; frame < 900; frame++) {
        tram.update(1 / 60, []);
        world.step();
      }

      for (const group of tram.root.children) {
        expect(group.position.x).toBeCloseTo(0, 5);
        expect(group.position.z).toBeGreaterThan(0);
        expect(group.position.z).toBeLessThan(100);
        const trackY = group.position.z <= 50
          ? group.position.z * 0.1
          : (100 - group.position.z) * 0.1;
        expect(group.position.y - trackY).toBeCloseTo(1.47, 1);
      }
    } finally {
      tram.dispose();
      world.free();
      setRoadNetwork(null);
    }
  });
});
