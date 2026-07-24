import { describe, expect, it } from 'vitest';
import { NpcLaneFollower } from '../../src/entities/NpcLaneFollower';
import { policeSpawnPose } from '../../src/entities/PoliceCar';
import {
  CompiledRoadNetwork,
  findRoadRoute,
  nextVehicleRoadCell,
  setRoadNetwork,
  type CellRef,
  type RoadNetwork,
} from '../../src/world/RoadGraph';

const point = (x: number, z: number): CellRef => ({
  cx: Math.round(x / 12),
  cz: Math.round(z / 12),
  x,
  y: 0,
  z,
  mode: 'vehicle',
  speed: 50,
});

describe('NPC vehicle navigation', () => {
  it('distinguishes a streamed continuation from a real dead end', () => {
    const network = new CompiledRoadNetwork();
    network.registerChunk('0,0', [
      { x: 0, y: 0, z: 0, flags: 1, speed: 50 },
    ], [
      { fromX: 0, fromZ: 0, toX: 10, toZ: 0, flags: 1 },
    ]);
    const start = network.nearest(point(0, 0), 'vehicle')!;

    expect(network.neighbors(start, 'vehicle')).toEqual([]);
    expect(network.hasPendingContinuation(start, 'vehicle')).toBe(true);

    network.registerChunk('1,0', [
      { x: 10, y: 0, z: 0, flags: 1, speed: 50 },
    ], []);
    expect(network.neighbors(start, 'vehicle')).toHaveLength(1);
    expect(network.hasPendingContinuation(start, 'vehicle')).toBe(false);
  });

  it('rejects reversals and avoids an immediately terminal branch', () => {
    const from = point(0, 0);
    const current = point(0, 10);
    const reversal = point(1, 0);
    const terminal = point(-10, 10);
    const continuing = point(10, 10);
    const onward = point(20, 10);
    const network: RoadNetwork = {
      nearest: () => null,
      neighbors: (candidate) => {
        if (candidate === current) return [reversal, terminal, continuing];
        if (candidate === continuing) return [onward];
        return [];
      },
    };
    setRoadNetwork(network);
    try {
      expect(nextVehicleRoadCell(from, current, 0.95)).toBe(continuing);
    } finally {
      setRoadNetwork(null);
    }
  });

  it('finds a directed route and samples ahead through a corner', () => {
    const a = point(0, 0);
    const b = point(0, 10);
    const c = point(10, 10);
    const network: RoadNetwork = {
      nearest: () => null,
      neighbors: (candidate) => candidate === a ? [b] : candidate === b ? [c] : [],
    };
    setRoadNetwork(network);
    try {
      expect(findRoadRoute(a, c)).toEqual([a, b, c]);
      const follower = new NpcLaneFollower(a, b);
      follower.append(c);
      const sample = follower.sample(0, 8, 5);
      expect(sample.crossTrack).toBeCloseTo(0);
      expect(sample.progress).toBeCloseTo(0.8);
      expect(sample.target.x).toBeCloseTo(3);
      expect(sample.target.z).toBeCloseTo(10);
      expect(sample.turnCosine).toBeCloseTo(0);
    } finally {
      setRoadNetwork(null);
    }
  });

  it('aligns police spawns with a lane and roadblocks across it', () => {
    const from = point(4, 5);
    const to = point(4, 15);

    expect(policeSpawnPose(from, to)).toEqual({ x: 4, z: 5, heading: 0 });
    expect(policeSpawnPose(from, to, true).heading).toBeCloseTo(Math.PI / 2);
  });
});
