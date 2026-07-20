import { describe, expect, it } from 'vitest';
import { vehicleFootprintsOverlap, type VehicleFootprint } from '../../src/entities/Vehicle';

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
});
