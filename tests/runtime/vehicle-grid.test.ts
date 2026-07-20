import { describe, expect, it, vi } from 'vitest';
import { Game, type Entity } from '../../src/core/Game';
import type { Drivable } from '../../src/entities/Drivable';

describe('vehicle spatial index lifecycle', () => {
  it('evicts a removed vehicle before its disposed body can be queried', () => {
    const removedTranslation = vi.fn(() => {
      throw new Error('disposed Rapier body queried');
    });
    const removed = {
      body: { translation: removedTranslation },
      dispose: vi.fn(),
    } as unknown as Drivable;
    const survivor = {
      body: { translation: vi.fn(() => ({ x: 2, y: 0, z: 3 })) },
    } as unknown as Drivable;
    const game = Object.create(Game.prototype) as Game;
    Object.assign(game, {
      vehicles: [removed, survivor],
      entities: [removed, survivor] as unknown as Entity[],
      vehicleGrid: new Map([[0, new Map([[0, [removed, survivor]]])]]),
      npcs: { prepareVehicleRemoval: vi.fn() },
    });

    game.removeVehicle(removed);

    expect(game.vehiclesNear(0, 0, 10, [])).toEqual([survivor]);
    expect(removedTranslation).not.toHaveBeenCalled();
    expect(removed.dispose).toHaveBeenCalledOnce();
  });
});
