import { TILE } from '../core/const';
import { cellAt, cellToWorld, roadMask } from './CityMap';

export interface StreetlightPlacement {
  x: number;
  z: number;
  rotation: number;
  /** Lamp head, slightly inboard from the pole over the carriageway. */
  bulbX: number;
  bulbZ: number;
}

/** True when a road cell belongs to a wide authored road or junction. */
function roadBlob(cx: number, cz: number): boolean {
  const road = (dx: number, dz: number) => (cellAt(cx + dx, cz + dz) === '#' ? 1 : 0);
  const n4 = road(0, -1) + road(1, 0) + road(0, 1) + road(-1, 0);
  if (n4 < 3) return false;
  const nd = road(-1, -1) + road(1, -1) + road(-1, 1) + road(1, 1);
  return n4 + nd >= 5;
}

/** Deterministic lamp positions used by the compiled world's dynamic lights. */
export function streetlightPlacements(cx: number, cz: number): StreetlightPlacement[] {
  if (((cx + cz) % 3 + 3) % 3 !== 0) return [];
  const edges: [number, number][] = [];
  const mask = roadMask(cx, cz);
  if (roadBlob(cx, cz)) {
    for (const [dx, dz] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
      if (cellAt(cx + dx, cz + dz) !== '#') edges.push([dx, dz]);
    }
  } else if (mask === 5 || mask === 10) {
    const side = ((cx + cz) / 3) % 2 === 0 ? 1 : -1;
    edges.push(mask === 5 ? [side, 0] : [0, side]);
  }
  const { x, z } = cellToWorld(cx, cz);
  return edges.map(([dx, dz]) => ({
    x: x + dx * TILE * 0.46,
    z: z + dz * TILE * 0.46,
    rotation: dx !== 0 ? (dx > 0 ? Math.PI / 2 : -Math.PI / 2) : dz > 0 ? 0 : Math.PI,
    bulbX: x + dx * (TILE * 0.46 - 1.35),
    bulbZ: z + dz * (TILE * 0.46 - 1.35),
  }));
}
