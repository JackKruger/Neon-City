import { TILE } from '../core/const';

/**
 * Cell legend:
 *   '#' road   'C' commercial lot   'S' suburban lot
 *   'P' park   '.' plaza pavement   'A' beach sand
 */
export type Cell = '#' | 'C' | 'S' | 'P' | '.' | 'A';

// prettier-ignore
export const MAP: string[] = [
  'AAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAA',
  'AA################AA',
  'AA#SSSS#SSSS#CCCC#AA',
  'AA#SSSS#SSSS#CCCC#AA',
  'AA#SSSS#SSSS#CCCC#AA',
  'AA#SSSS#SSSS#CCCC#AA',
  'AA################AA',
  'AA#CCCC#PPPP#CCCC#AA',
  'AA#CCCC#PPPP#CCCC#AA',
  'AA#CCCC#PPPP#CCCC#AA',
  'AA#CCCC#PPPP#CCCC#AA',
  'AA################AA',
  'AA#SSSS#CCCC#CC.C#AA',
  'AA#SSSS#CCCC#C..C#AA',
  'AA#SSSS#CCCC#.CC.#AA',
  'AA#SSSS#CCCC#CCCC#AA',
  'AA################AA',
  'AAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAA',
];

export const MAP_W = MAP[0].length;
export const MAP_H = MAP.length;

export function cellAt(cx: number, cz: number): Cell | null {
  if (cx < 0 || cz < 0 || cx >= MAP_W || cz >= MAP_H) return null;
  return MAP[cz][cx] as Cell;
}

export function isRoad(cx: number, cz: number): boolean {
  return cellAt(cx, cz) === '#';
}

/** Center of a cell in world coordinates. */
export function cellToWorld(cx: number, cz: number): { x: number; z: number } {
  return {
    x: (cx - MAP_W / 2 + 0.5) * TILE,
    z: (cz - MAP_H / 2 + 0.5) * TILE,
  };
}

export function worldToCell(x: number, z: number): { cx: number; cz: number } {
  return {
    cx: Math.floor(x / TILE + MAP_W / 2),
    cz: Math.floor(z / TILE + MAP_H / 2),
  };
}

/** Deterministic pseudo-random in [0,1) from cell coords and a salt. */
export function cellHash(cx: number, cz: number, salt = 0): number {
  let h = (cx * 374761393 + cz * 668265263 + salt * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Bitmask of road neighbors: N=1 (z-1), E=2 (x+1), S=4 (z+1), W=8 (x-1). */
export function roadMask(cx: number, cz: number): number {
  return (
    (isRoad(cx, cz - 1) ? 1 : 0) |
    (isRoad(cx + 1, cz) ? 2 : 0) |
    (isRoad(cx, cz + 1) ? 4 : 0) |
    (isRoad(cx - 1, cz) ? 8 : 0)
  );
}
