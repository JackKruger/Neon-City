import { SAVE_KEY, type GameSaveV1, type SaveResult, validateGameSave } from './GameSave';

export interface SaveClock { now(): number }

const systemClock: SaveClock = { now: () => Date.now() };

export class SaveStorage {
  constructor(
    private storage: Storage | null,
    readonly clock: SaveClock = systemClock
  ) {}

  static browser(): SaveStorage {
    try {
      return new SaveStorage(window.localStorage);
    } catch {
      return new SaveStorage(null);
    }
  }

  read(): SaveResult<GameSaveV1> {
    if (!this.storage) return { ok: false, error: { code: 'unavailable', message: 'Browser storage is unavailable.' } };
    let raw: string | null;
    try {
      raw = this.storage.getItem(SAVE_KEY);
    } catch {
      return { ok: false, error: { code: 'storage', message: 'The save slot could not be read.' } };
    }
    if (raw === null) return { ok: false, error: { code: 'missing', message: 'No saved game is available.' } };
    try {
      return validateGameSave(JSON.parse(raw));
    } catch {
      return { ok: false, error: { code: 'invalid', message: 'The save slot contains malformed data.' } };
    }
  }

  write(save: GameSaveV1): SaveResult<GameSaveV1> {
    if (!this.storage) return { ok: false, error: { code: 'unavailable', message: 'Browser storage is unavailable.' } };
    const checked = validateGameSave(save);
    if (!checked.ok) return checked;
    try {
      this.storage.setItem(SAVE_KEY, JSON.stringify(checked.value));
      return checked;
    } catch {
      return { ok: false, error: { code: 'storage', message: 'The save could not be written. Browser storage may be full.' } };
    }
  }

  delete(): SaveResult<undefined> {
    if (!this.storage) return { ok: false, error: { code: 'unavailable', message: 'Browser storage is unavailable.' } };
    try {
      this.storage.removeItem(SAVE_KEY);
      return { ok: true, value: undefined };
    } catch {
      return { ok: false, error: { code: 'storage', message: 'The save slot could not be deleted.' } };
    }
  }
}
