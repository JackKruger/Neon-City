export interface GameSettingsData {
  cameraSensitivity: number;
  invertCameraY: boolean;
  reducedMotion: boolean;
  aimAssist: boolean;
  subtitles: boolean;
}

const STORAGE_KEY = 'neon-bay.settings.v1';

const DEFAULTS: GameSettingsData = {
  cameraSensitivity: 1,
  invertCameraY: false,
  reducedMotion: false,
  aimAssist: true,
  subtitles: true,
};

/** Small, versioned local settings store shared by input, cameras, and UI. */
export class Settings {
  private data: GameSettingsData = { ...DEFAULTS };
  private listeners = new Set<(settings: Readonly<GameSettingsData>) => void>();

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<GameSettingsData> | null;
      if (saved) {
        this.data.cameraSensitivity = this.clampSensitivity(saved.cameraSensitivity);
        if (typeof saved.invertCameraY === 'boolean') this.data.invertCameraY = saved.invertCameraY;
        if (typeof saved.reducedMotion === 'boolean') this.data.reducedMotion = saved.reducedMotion;
        if (typeof saved.aimAssist === 'boolean') this.data.aimAssist = saved.aimAssist;
        if (typeof saved.subtitles === 'boolean') this.data.subtitles = saved.subtitles;
      }
    } catch {
      // Corrupt or unavailable local storage falls back to safe defaults.
    }
  }

  get values(): Readonly<GameSettingsData> {
    return this.data;
  }

  set<K extends keyof GameSettingsData>(key: K, value: GameSettingsData[K]): void {
    this.data[key] = key === 'cameraSensitivity'
      ? this.clampSensitivity(value as number) as GameSettingsData[K]
      : value;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      // Settings still apply for this session when storage is unavailable.
    }
    for (const listener of this.listeners) listener(this.data);
  }

  subscribe(listener: (settings: Readonly<GameSettingsData>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private clampSensitivity(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0.25, Math.min(2, value))
      : DEFAULTS.cameraSensitivity;
  }
}
