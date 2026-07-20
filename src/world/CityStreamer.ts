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
