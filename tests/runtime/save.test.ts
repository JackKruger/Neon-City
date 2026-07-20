import { describe, expect, it } from 'vitest';
import { Inventory } from '../../src/gameplay/Inventory';
import { createGameSave, validateGameSave, type GameSaveV1 } from '../../src/save/GameSave';
import { SaveStorage } from '../../src/save/SaveStorage';

function validSave(): GameSaveV1 {
  return createGameSave({
    position: { x: 564, z: -1908, surfaceY: 3.2 },
    heading: 1.4,
    health: 80,
    armour: 25,
    money: 1200,
    inventory: {
      current: 'pistol',
      weapons: [
        { id: 'fists', magazine: 0, reserve: 0 },
        { id: 'pistol', magazine: 7, reserve: 24 },
      ],
    },
  }, 123456);
}

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  failRead = false;
  failWrite = false;
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { if (this.failRead) throw new Error('blocked'); return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { if (this.failWrite) throw new Error('quota'); this.values.set(key, value); }
}

describe('save codec', () => {
  it('round-trips a valid save', () => {
    const save = validSave();
    expect(validateGameSave(JSON.parse(JSON.stringify(save)))).toEqual({ ok: true, value: save });
  });

  it.each([
    ['future version', (save: any) => { save.version = 2; }],
    ['wrong map', (save: any) => { save.mapId = 'sydney'; }],
    ['non-finite position', (save: any) => { save.player.position.x = Infinity; }],
    ['out-of-bounds position', (save: any) => { save.player.position.z = 9000; }],
    ['duplicate weapon', (save: any) => { save.player.inventory.weapons.push({ id: 'pistol', magazine: 1, reserve: 0 }); }],
    ['unknown weapon', (save: any) => { save.player.inventory.weapons[1].id = 'laser'; }],
    ['negative ammo', (save: any) => { save.player.inventory.weapons[1].reserve = -1; }],
    ['oversized magazine', (save: any) => { save.player.inventory.weapons[1].magazine = 13; }],
    ['unowned current weapon', (save: any) => { save.player.inventory.current = 'smg'; }],
  ])('rejects %s', (_name, mutate) => {
    const save: any = validSave();
    mutate(save);
    expect(validateGameSave(save).ok).toBe(false);
  });
});

describe('save storage', () => {
  it('handles missing, write, read, and delete', () => {
    const backing = new MemoryStorage();
    const storage = new SaveStorage(backing, { now: () => 9 });
    expect(storage.read()).toMatchObject({ ok: false, error: { code: 'missing' } });
    expect(storage.write(validSave()).ok).toBe(true);
    expect(storage.read()).toEqual({ ok: true, value: validSave() });
    expect(storage.delete().ok).toBe(true);
    expect(storage.read()).toMatchObject({ ok: false, error: { code: 'missing' } });
  });

  it('reports malformed, unavailable, read, and quota failures', () => {
    const backing = new MemoryStorage();
    backing.setItem('neon-bay.save.v1', '{nope');
    expect(new SaveStorage(backing).read()).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(new SaveStorage(null).read()).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    backing.failRead = true;
    expect(new SaveStorage(backing).read()).toMatchObject({ ok: false, error: { code: 'storage' } });
    backing.failRead = false;
    backing.failWrite = true;
    expect(new SaveStorage(backing).write(validSave())).toMatchObject({ ok: false, error: { code: 'storage' } });
  });
});

describe('inventory snapshots', () => {
  it('uses weapon order and restores ammo/current while cancelling reload', () => {
    const inventory = new Inventory();
    inventory.give('shotgun', 15);
    inventory.give('pistol', 30);
    inventory.current = 'shotgun';
    inventory.startReload();
    const snapshot = inventory.snapshot();
    expect(snapshot.weapons.map((weapon) => weapon.id)).toEqual(['fists', 'pistol', 'shotgun']);
    const restored = new Inventory();
    restored.restore(snapshot);
    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.current).toBe('shotgun');
    expect(restored.reloading).toBe(0);
  });
});
