import { TILE } from '../core/const';
import { cellToWorld, isRoad, nearestRoadCell, worldToCell } from './CityMap';

export interface CellRef {
  cx: number;
  cz: number;
}

const DIRS: CellRef[] = [
  { cx: 0, cz: -1 }, // N
  { cx: 1, cz: 0 }, // E
  { cx: 0, cz: 1 }, // S
  { cx: -1, cz: 0 }, // W
];

/** Road neighbors of a road cell. */
export function roadNeighbors(c: CellRef): CellRef[] {
  const out: CellRef[] = [];
  for (const d of DIRS) {
    const n = { cx: c.cx + d.cx, cz: c.cz + d.cz };
    if (isRoad(n.cx, n.cz)) out.push(n);
  }
  return out;
}

/**
 * Pick the next cell for a lane-following agent: prefer continuing straight,
 * otherwise a random turn; only reverse at dead ends.
 */
export function nextRoadCell(from: CellRef, current: CellRef, rng: number): CellRef {
  const options = roadNeighbors(current).filter(
    (n) => !(n.cx === from.cx && n.cz === from.cz)
  );
  if (options.length === 0) return from; // dead end: U-turn
  const straight = options.find(
    (n) => n.cx - current.cx === current.cx - from.cx && n.cz - current.cz === current.cz - from.cz
  );
  if (straight && rng < 0.65) return straight;
  // Rescale the roll so failing the go-straight check still covers [0,1).
  const r = straight ? (rng - 0.65) / 0.35 : rng;
  return options[Math.floor(r * options.length) % options.length];
}

/**
 * Waypoint at a cell for travel direction from->to, offset to the right-hand
 * lane (laneFrac ~0.18 for cars) or the sidewalk (~0.40 for pedestrians).
 */
export function lanePoint(
  from: CellRef,
  to: CellRef,
  laneFrac: number
): { x: number; z: number } {
  const { x, z } = cellToWorld(to.cx, to.cz);
  const dx = Math.sign(to.cx - from.cx);
  const dz = Math.sign(to.cz - from.cz);
  // Right-hand side of travel: right = (-dz, dx) in (x,z)... using screen
  // convention right-of-forward(f) = (-f.z, f.x) would be left; verified in
  // Player: right = (-cos, sin) for forward (sin, cos) => right = (-dz, dx).
  return { x: x + -dz * laneFrac * TILE, z: z + dx * laneFrac * TILE };
}

/**
 * Random road cell in a distance ring around a world position, or null if
 * the sample lands outside the ring after snapping to the road grid.
 */
export function randomRoadCellNear(
  x: number,
  z: number,
  minDist: number,
  maxDist: number
): CellRef | null {
  const ang = Math.random() * Math.PI * 2;
  const r = minDist + Math.random() * (maxDist - minDist);
  const raw = worldToCell(x + Math.sin(ang) * r, z + Math.cos(ang) * r);
  const cell = nearestRoadCell(raw.cx, raw.cz);
  if (!cell) return null; // sample landed in open water / off-map
  const w = cellToWorld(cell.cx, cell.cz);
  const d = Math.hypot(w.x - x, w.z - z);
  return d >= minDist && d <= maxDist ? cell : null;
}
