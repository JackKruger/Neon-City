import { PLAYER_ARMOUR_MAX, PLAYER_HEALTH, WEAPONS, WEAPON_ORDER, type WeaponId } from '../gameplay/Weapons';
import { MAP_ID, inMapWorld } from '../world/MapContract';

export const SAVE_KEY = 'neon-bay.save.v1';

export interface InventorySaveState {
  current: WeaponId;
  weapons: { id: WeaponId; magazine: number; reserve: number }[];
}

export interface PlayerSaveState {
  position: { x: number; z: number; surfaceY: number };
  heading: number;
  health: number;
  armour: number;
  money: number;
  inventory: InventorySaveState;
}

export interface GameSaveV1 {
  version: 1;
  mapId: typeof MAP_ID;
  savedAt: number;
  player: PlayerSaveState;
}

export type SaveErrorCode = 'unavailable' | 'missing' | 'invalid' | 'storage' | 'unsafe' | 'prewarm';
export interface SaveError { code: SaveErrorCode; message: string }
export type SaveResult<T> = { ok: true; value: T } | { ok: false; error: SaveError };

function fail(message: string): SaveResult<GameSaveV1> {
  return { ok: false, error: { code: 'invalid', message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function validateGameSave(value: unknown): SaveResult<GameSaveV1> {
  if (!isRecord(value)) return fail('Save data is not an object.');
  if (value.version !== 1) return fail('This save version is not supported.');
  if (value.mapId !== MAP_ID) return fail('This save belongs to a different map.');
  if (!isInteger(value.savedAt)) return fail('The save timestamp is invalid.');
  if (!isRecord(value.player)) return fail('The player save is missing.');
  const player = value.player;
  if (!isRecord(player.position)) return fail('The saved position is missing.');
  const { x, z, surfaceY } = player.position;
  if (typeof x !== 'number' || typeof z !== 'number' || !inMapWorld(x, z)) {
    return fail('The saved position is outside Melbourne.');
  }
  if (typeof surfaceY !== 'number' || !Number.isFinite(surfaceY)) return fail('The saved surface height is invalid.');
  if (typeof player.heading !== 'number' || !Number.isFinite(player.heading)) return fail('The saved heading is invalid.');
  if (typeof player.health !== 'number' || !Number.isFinite(player.health) || player.health <= 0 || player.health > PLAYER_HEALTH) {
    return fail('The saved health is invalid.');
  }
  if (typeof player.armour !== 'number' || !Number.isFinite(player.armour) || player.armour < 0 || player.armour > PLAYER_ARMOUR_MAX) {
    return fail('The saved armour is invalid.');
  }
  if (!isInteger(player.money)) return fail('The saved money is invalid.');
  if (!isRecord(player.inventory) || !Array.isArray(player.inventory.weapons)) return fail('The saved inventory is invalid.');
  const current = player.inventory.current;
  if (typeof current !== 'string' || !WEAPON_ORDER.includes(current as WeaponId)) return fail('The equipped weapon is invalid.');
  const seen = new Set<WeaponId>();
  for (const entry of player.inventory.weapons) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !WEAPON_ORDER.includes(entry.id as WeaponId)) {
      return fail('The save contains an unknown weapon.');
    }
    const id = entry.id as WeaponId;
    if (seen.has(id)) return fail('The save contains a duplicate weapon.');
    seen.add(id);
    if (!isInteger(entry.magazine) || !isInteger(entry.reserve)) return fail('The saved ammunition is invalid.');
    const definition = WEAPONS[id];
    if (definition.kind === 'melee' && (entry.magazine !== 0 || entry.reserve !== 0)) {
      return fail('A melee weapon has invalid ammunition.');
    }
    if (definition.kind === 'gun' && entry.magazine > definition.magSize) return fail('A magazine exceeds its capacity.');
  }
  if (!seen.has('fists') || !seen.has(current as WeaponId)) return fail('The equipped weapon is not owned.');
  return { ok: true, value: value as unknown as GameSaveV1 };
}

export function createGameSave(player: PlayerSaveState, savedAt: number): GameSaveV1 {
  return { version: 1, mapId: MAP_ID, savedAt, player };
}
