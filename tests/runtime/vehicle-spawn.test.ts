import { describe, expect, it } from 'vitest';
import { vehicleFootprintsOverlap, type VehicleFootprint } from '../../src/entities/Vehicle';
import {
  nearestClearRoadPose,
  setRoadNetwork,
  type CellRef,
  type RoadNetwork,
} from '../../src/world/RoadGraph';

const car = (x: number, z: number, heading = 0): VehicleFootprint => ({
  x,
  z,
  heading,
  halfWidth: 1.15,
  halfLength: 2.45,
});

describe('vehicle spawn footprints', () => {
  it('rejects cars occupying the same road space', () => {
    expect(vehicleFootprintsOverlap(car(0, 0), car(0, 0), 0.65)).toBe(true);
    expect(vehicleFootprintsOverlap(car(0, 0), car(0, 4.8), 0.65)).toBe(true);
    expect(vehicleFootprintsOverlap(car(0, 0), car(0, 0, Math.PI / 2), 0.65)).toBe(true);
  });

  it('allows separated same-lane and adjacent-lane cars', () => {
    expect(vehicleFootprintsOverlap(car(0, 0), car(0, 6), 0.65)).toBe(false);
    expect(vehicleFootprintsOverlap(car(0, 0), car(3.5, 0), 0.65)).toBe(false);
  });

  it('selects the nearest clear lane pose deterministically', () => {
    const tooClose: CellRef = { cx: 0, cz: 0, x: 3, z: 0, mode: 'vehicle' };
    const blocked: CellRef = { cx: 1, cz: 0, x: 8, z: 0, mode: 'vehicle' };
    const clear: CellRef = { cx: 2, cz: 0, x: 10, z: 0, mode: 'vehicle' };
    const clearNext: CellRef = { cx: 2, cz: 1, x: 10, z: 10, mode: 'vehicle' };
    const network: RoadNetwork = {
      nearest: () => null,
      points: () => [clear, tooClose, blocked],
      neighbors: (point) => point === clear ? [clearNext] : [],
    };
    setRoadNetwork(network);
    try {
      const pose = nearestClearRoadPose(0, 0, 8, 24, (x) => x !== blocked.x);

      expect(pose).toEqual({ x: 10, z: 0, heading: 0 });
    } finally {
      setRoadNetwork(null);
    }
  });
});
