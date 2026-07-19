export interface CityStreamer {
  prewarm(x: number, z: number): Promise<void>;
  update(positions: { x: number; z: number }[]): void;
  loadedChunkCount(): number;
  dispose(): void;
}
