import { describe, expect, it } from 'vitest';
import { BULLDOZER_MODEL } from '../../src/core/const';
import { vehicleTuningFor } from '../../src/entities/Vehicle';

describe('vehicle model tuning', () => {
  it('makes the bulldozer much heavier, tougher, and slower than a normal car', () => {
    const car = vehicleTuningFor('cars/sedan');
    const bulldozer = vehicleTuningFor(BULLDOZER_MODEL);

    expect(bulldozer.massMultiplier).toBeGreaterThanOrEqual(3);
    expect(bulldozer.maxHealth).toBeGreaterThanOrEqual(car.maxHealth * 3);
    expect(bulldozer.crashDamageMultiplier).toBeLessThanOrEqual(0.3);
    expect(bulldozer.maxForwardSpeed).toBeLessThan(car.maxForwardSpeed / 2);
    expect(bulldozer.showDoors).toBe(false);
  });

  it('leaves ordinary vehicle tuning unchanged', () => {
    const car = vehicleTuningFor('cars/sedan');

    expect(car.massMultiplier).toBe(1);
    expect(car.maxHealth).toBe(200);
    expect(car.maxForwardSpeed).toBe(36);
    expect(car.crashDamageMultiplier).toBe(1);
    expect(car.showDoors).toBe(true);
  });
});
