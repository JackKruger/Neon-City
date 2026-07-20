import { describe, expect, it } from 'vitest';
import { CompiledRoadNetwork } from '../../src/world/RoadGraph';

describe('compiled transit navigation', () => {
  it('keeps train and tram nodes separate from ordinary road traffic', () => {
    const network = new CompiledRoadNetwork();
    network.registerChunk('0,0', [
      { x: 0, y: 3.2, z: 0, flags: 8, speed: 80 },
      { x: 10, y: 3.3, z: 0, flags: 8, speed: 80 },
      { x: 0, y: 3.2, z: 4, flags: 4, speed: 40 },
      { x: 10, y: 3.3, z: 4, flags: 4, speed: 40 },
    ], [
      { fromX: 0, fromZ: 0, toX: 10, toZ: 0, flags: 8 },
      { fromX: 0, fromZ: 4, toX: 10, toZ: 4, flags: 4 },
    ]);

    const train = network.nearest({ cx: 0, cz: 0, x: 0, z: 0 }, 'train');
    expect(train).toMatchObject({ x: 0, y: 3.2, z: 0, mode: 'train', speed: 80 });
    expect(network.neighbors(train!, 'train')).toHaveLength(1);
    expect(network.neighbors(train!, 'tram')).toEqual([]);
    expect(network.points('train')).toHaveLength(2);
  });

  it('removes transit paths with their streamed chunk', () => {
    const network = new CompiledRoadNetwork();
    network.registerChunk('0,0', [{ x: 0, y: 0, z: 0, flags: 8, speed: 60 }], []);
    network.unregisterChunk('0,0');
    expect(network.points('train')).toEqual([]);
  });
});
