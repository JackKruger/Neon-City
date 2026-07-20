export interface CityStreamStats {
  loadedChunks: number;
  pendingChunks: number;
  wantedChunks: number;
  missingChunks: number;
  loadedBytes: number;
  lastLoadMs: number;
  averageLoadMs: number;
  scope: string;
  partial: boolean;
}

export interface CityStreamer {
  prewarm(x: number, z: number): Promise<void>;
  update(positions: { x: number; z: number }[]): void;
  loadedChunkCount(): number;
  stats(): CityStreamStats;
  dispose(): void;
}

/** Select the available 3x3 prewarm neighborhood around a spawn. Partial
 * manifests may omit edge neighbors, but the spawn's own chunk must exist. */
export function selectPrewarmChunkKeys(
  available: ReadonlySet<string>,
  center: { kx: number; kz: number },
  partial: boolean
): string[] {
  const centerKey = `${center.kx},${center.kz}`;
  if (!available.has(centerKey)) throw new Error(`compiled map is missing required spawn chunk ${centerKey}`);
  const required: string[] = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const key = `${center.kx + dx},${center.kz + dz}`;
      if (available.has(key)) required.push(key);
      else if (!partial) throw new Error(`compiled map is missing required spawn chunk ${key}`);
    }
  }
  return required;
}
