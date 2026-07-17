import { TILE } from '../core/const';

/**
 * Procedural, unbounded city layout. Every query is a pure function of the
 * cell coordinates, so any region can be built, thrown away, and rebuilt
 * identically — there is no stored map.
 *
 * Cell legend:
 *   '#' road   'C' commercial lot   'S' suburban lot
 *   'P' park   '.' plaza pavement
 */
export type Cell = '#' | 'C' | 'S' | 'P' | '.';

/** Roads form a grid every BLOCK cells; the interiors are 4x4 lots. */
export const BLOCK = 5;

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

export function isRoad(cx: number, cz: number): boolean {
  return mod(cx, BLOCK) === 0 || mod(cz, BLOCK) === 0;
}

export function cellAt(cx: number, cz: number): Cell {
  if (isRoad(cx, cz)) return '#';
  const bx = Math.floor(cx / BLOCK);
  const bz = Math.floor(cz / BLOCK);
  // Low-frequency "downtown-ness" gives coherent multi-block districts;
  // a per-block hash then picks the lot type within the district's flavor.
  const zone = cellHash(Math.floor(bx / 3), Math.floor(bz / 3), 101);
  const r = cellHash(bx, bz, 102);
  if (zone < 0.4) return r < 0.75 ? 'C' : r < 0.9 ? '.' : 'P'; // downtown
  if (zone < 0.75) return r < 0.7 ? 'S' : r < 0.85 ? 'P' : 'C'; // suburbs
  return r < 0.5 ? 'P' : r < 0.9 ? 'S' : '.'; // green belt
}

/** Center of a cell in world coordinates (cell centers sit on TILE multiples). */
export function cellToWorld(cx: number, cz: number): { x: number; z: number } {
  return { x: cx * TILE, z: cz * TILE };
}

export function worldToCell(x: number, z: number): { cx: number; cz: number } {
  return { cx: Math.round(x / TILE), cz: Math.round(z / TILE) };
}

/** Snap a cell to the nearest road cell (roads run every BLOCK cells). */
export function nearestRoadCell(cx: number, cz: number): { cx: number; cz: number } {
  const sx = Math.round(cx / BLOCK) * BLOCK;
  const sz = Math.round(cz / BLOCK) * BLOCK;
  return Math.abs(sx - cx) <= Math.abs(sz - cz) ? { cx: sx, cz } : { cx, cz: sz };
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
