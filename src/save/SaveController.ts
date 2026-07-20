import type { SaveResult } from './GameSave';

export const AUTOSAVE_INTERVAL_SECONDS = 60;

export async function restoreAtomically<T>(
  read: () => SaveResult<T>,
  prewarm: (value: T) => Promise<void>,
  apply: (value: T) => void
): Promise<SaveResult<T>> {
  const result = read();
  if (!result.ok) return result;
  try {
    await prewarm(result.value);
  } catch (error) {
    return {
      ok: false,
      error: { code: 'prewarm', message: `The saved region could not be loaded: ${error instanceof Error ? error.message : String(error)}` },
    };
  }
  apply(result.value);
  return result;
}

export class SaveController {
  private elapsed = 0;

  constructor(
    private safe: () => boolean,
    private save: () => void,
    private interval = AUTOSAVE_INTERVAL_SECONDS
  ) {}

  update(activeSeconds: number): void {
    if (activeSeconds <= 0) return;
    this.elapsed += activeSeconds;
    if (this.elapsed < this.interval || !this.safe()) return;
    this.elapsed %= this.interval;
    this.save();
  }

  saveForPageHide(): boolean {
    if (!this.safe()) return false;
    this.save();
    return true;
  }

  get pendingSeconds(): number {
    return this.elapsed;
  }
}
