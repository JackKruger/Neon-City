import { TILE } from '../core/const';
import { cellToWorld, isRoad, nearestRoadCell, worldToCell } from './CityMap';
import type { CompiledNavEdge, CompiledNavNode } from './CompiledFormat';

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

export interface RoadNetwork {
  neighbors(cell: CellRef): CellRef[];
  nearest(cell: CellRef): CellRef | null;
}

class CellRoadNetwork implements RoadNetwork {
  neighbors(cell: CellRef): CellRef[] {
    const output: CellRef[] = [];
    for (const direction of DIRS) {
      const neighbor = { cx: cell.cx + direction.cx, cz: cell.cz + direction.cz };
      if (isRoad(neighbor.cx, neighbor.cz)) output.push(neighbor);
    }
    return output;
  }

  nearest(cell: CellRef): CellRef | null {
    return nearestRoadCell(cell.cx, cell.cz);
  }
}

const cellKey = (cell: CellRef): string => `${cell.cx},${cell.cz}`;

/** Navigation graph populated and removed with compiled chunks. */
export class CompiledRoadNetwork implements RoadNetwork {
  private chunks = new Map<string, { nodes: CompiledNavNode[]; edges: CompiledNavEdge[] }>();
  private nodes = new Set<string>();
  private adjacency = new Map<string, CellRef[]>();

  registerChunk(key: string, nodes: CompiledNavNode[], edges: CompiledNavEdge[]): void {
    this.chunks.set(key, { nodes, edges });
    this.rebuild();
  }

  unregisterChunk(key: string): void {
    this.chunks.delete(key);
    this.rebuild();
  }

  neighbors(cell: CellRef): CellRef[] {
    return this.adjacency.get(cellKey(cell)) ?? [];
  }

  nearest(cell: CellRef): CellRef | null {
    if (this.nodes.has(cellKey(cell))) return cell;
    for (let radius = 1; radius <= 24; radius++) {
      for (let offset = -radius; offset <= radius; offset++) {
        for (const candidate of [
          { cx: cell.cx + offset, cz: cell.cz - radius },
          { cx: cell.cx + offset, cz: cell.cz + radius },
          { cx: cell.cx - radius, cz: cell.cz + offset },
          { cx: cell.cx + radius, cz: cell.cz + offset },
        ]) if (this.nodes.has(cellKey(candidate))) return candidate;
      }
    }
    return null;
  }

  clear(): void {
    this.chunks.clear();
    this.nodes.clear();
    this.adjacency.clear();
  }

  private rebuild(): void {
    this.nodes.clear();
    this.adjacency.clear();
    for (const chunk of this.chunks.values()) {
      for (const node of chunk.nodes) this.nodes.add(cellKey(node));
    }
    for (const chunk of this.chunks.values()) {
      for (const edge of chunk.edges) {
        const from = { cx: edge.fromCx, cz: edge.fromCz };
        const to = { cx: edge.toCx, cz: edge.toCz };
        if (!this.nodes.has(cellKey(from)) || !this.nodes.has(cellKey(to))) continue;
        const key = cellKey(from);
        const neighbors = this.adjacency.get(key) ?? [];
        if (!neighbors.some((neighbor) => neighbor.cx === to.cx && neighbor.cz === to.cz)) neighbors.push(to);
        this.adjacency.set(key, neighbors);
      }
    }
    for (const neighbors of this.adjacency.values()) neighbors.sort((a, b) => a.cz - b.cz || a.cx - b.cx);
  }
}

const cellRoadNetwork = new CellRoadNetwork();
let activeRoadNetwork: RoadNetwork = cellRoadNetwork;

export function setRoadNetwork(network: RoadNetwork | null): void {
  activeRoadNetwork = network ?? cellRoadNetwork;
}

/** Road neighbors of a road cell. */
export function roadNeighbors(c: CellRef): CellRef[] {
  return activeRoadNetwork.neighbors(c);
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
  const cell = activeRoadNetwork.nearest(raw);
  if (!cell) return null; // sample landed in open water / off-map
  const w = cellToWorld(cell.cx, cell.cz);
  const d = Math.hypot(w.x - x, w.z - z);
  return d >= minDist && d <= maxDist ? cell : null;
}
