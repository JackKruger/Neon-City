import { TILE } from '../core/const';
import { cellToWorld, isRoad, nearestRoadCell, worldToCell } from './CityMap';
import type { CompiledNavEdge, CompiledNavNode } from './CompiledFormat';

export type NavigationMode = 'vehicle' | 'pedestrian' | 'tram' | 'train';

export interface CellRef {
  cx: number;
  cz: number;
  /** Exact world position for compiled lane/footpath graphs. */
  x?: number;
  y?: number;
  z?: number;
  mode?: NavigationMode;
  speed?: number;
}

const DIRS: CellRef[] = [
  { cx: 0, cz: -1 }, { cx: 1, cz: 0 }, { cx: 0, cz: 1 }, { cx: -1, cz: 0 },
];

export interface RoadNetwork {
  neighbors(point: CellRef, mode?: NavigationMode): CellRef[];
  nearest(point: CellRef, mode?: NavigationMode): CellRef | null;
  /** A legal continuation when a node has no outgoing edge (e.g. the opposing
   *  lane of a two-way street truncated at the loaded edge). Optional; the grid
   *  network has no lane concept and leaves the caller to retrace. */
  uTurn?(point: CellRef, mode?: NavigationMode): CellRef | null;
  points?(mode: NavigationMode): CellRef[];
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

const modeFlag = (mode: NavigationMode): number => mode === 'pedestrian' ? 2 : mode === 'tram' ? 4 : mode === 'train' ? 8 : 1;
const positionKey = (x: number, z: number): string => `${Math.round(x * 100)},${Math.round(z * 100)}`;
const adjacencyKey = (mode: NavigationMode, x: number, z: number): string => `${mode}:${positionKey(x, z)}`;

/** Navigation graphs populated and removed with compiled chunks. */
export class CompiledRoadNetwork implements RoadNetwork {
  private chunks = new Map<string, { nodes: CompiledNavNode[]; edges: CompiledNavEdge[] }>();
  private nodes = new Map<NavigationMode, Map<string, CellRef>>();
  private adjacency = new Map<string, CellRef[]>();

  registerChunk(key: string, nodes: CompiledNavNode[], edges: CompiledNavEdge[]): void {
    this.chunks.set(key, { nodes, edges });
    this.rebuild();
  }

  unregisterChunk(key: string): void {
    this.chunks.delete(key);
    this.rebuild();
  }

  neighbors(point: CellRef, mode: NavigationMode = point.mode ?? 'vehicle'): CellRef[] {
    const world = pointWorld(point);
    return this.adjacency.get(adjacencyKey(mode, world.x, world.z)) ?? [];
  }

  nearest(point: CellRef, mode: NavigationMode = 'vehicle'): CellRef | null {
    const candidates = this.nodes.get(mode);
    if (!candidates || candidates.size === 0) return null;
    const target = point.x === undefined || point.z === undefined ? cellToWorld(point.cx, point.cz) : point;
    let best: CellRef | null = null;
    let bestDistance = (24 * TILE) ** 2;
    for (const candidate of candidates.values()) {
      const dx = candidate.x! - target.x!;
      const dz = candidate.z! - target.z!;
      const distance = dx * dx + dz * dz;
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** Nearest node (in a narrow band around the point) that still has somewhere
   *  to go — used to turn a car around at a dead-end onto the opposing lane
   *  rather than retracing its own one-way lane backwards. */
  uTurn(point: CellRef, mode: NavigationMode = 'vehicle'): CellRef | null {
    const candidates = this.nodes.get(mode);
    if (!candidates) return null;
    const world = pointWorld(point);
    let best: CellRef | null = null;
    let bestDistance = Infinity;
    for (const candidate of candidates.values()) {
      const dx = candidate.x! - world.x;
      const dz = candidate.z! - world.z;
      const distance = Math.hypot(dx, dz);
      // Skip the dead-end node itself; stay within the width of a small junction
      // so we snap to a neighbouring lane, not a parallel street.
      if (distance < 1.5 || distance > 9) continue;
      if (!(this.adjacency.get(adjacencyKey(mode, candidate.x!, candidate.z!))?.length)) continue;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    return best;
  }

  clear(): void {
    this.chunks.clear();
    this.nodes.clear();
    this.adjacency.clear();
  }

  points(mode: NavigationMode): CellRef[] {
    return [...(this.nodes.get(mode)?.values() ?? [])];
  }

  private rebuild(): void {
    this.nodes = new Map([
      ['vehicle', new Map()], ['pedestrian', new Map()], ['tram', new Map()], ['train', new Map()],
    ]);
    this.adjacency.clear();
    for (const chunk of this.chunks.values()) {
      for (const node of chunk.nodes) {
        for (const mode of ['vehicle', 'pedestrian', 'tram', 'train'] as const) {
          if ((node.flags & modeFlag(mode)) === 0) continue;
          const point: CellRef = {
            ...worldToCell(node.x, node.z), x: node.x, y: node.y, z: node.z, mode, speed: node.speed,
          };
          this.nodes.get(mode)!.set(positionKey(node.x, node.z), point);
        }
      }
    }
    const link = (mode: NavigationMode, from: CellRef, to: CellRef): void => {
      const key = adjacencyKey(mode, from.x!, from.z!);
      const neighbors = this.adjacency.get(key) ?? [];
      if (!neighbors.some((neighbor) => positionKey(neighbor.x!, neighbor.z!) === positionKey(to.x!, to.z!))) neighbors.push(to);
      this.adjacency.set(key, neighbors);
    };
    for (const chunk of this.chunks.values()) {
      for (const edge of chunk.edges) {
        for (const mode of ['vehicle', 'pedestrian', 'tram', 'train'] as const) {
          if ((edge.flags & modeFlag(mode)) === 0) continue;
          const from = this.nodes.get(mode)!.get(positionKey(edge.fromX, edge.fromZ));
          const to = this.nodes.get(mode)!.get(positionKey(edge.toX, edge.toZ));
          if (!from || !to) continue;
          link(mode, from, to);
          // Lanes and tram tracks are one-way as authored; footpaths carry
          // people in both directions, so mirror pedestrian edges.
          if (mode === 'pedestrian') link(mode, to, from);
        }
      }
    }
    for (const neighbors of this.adjacency.values()) neighbors.sort((a, b) => a.z! - b.z! || a.x! - b.x!);
  }
}

const cellRoadNetwork = new CellRoadNetwork();
let activeRoadNetwork: RoadNetwork = cellRoadNetwork;

export function setRoadNetwork(network: RoadNetwork | null): void {
  activeRoadNetwork = network ?? cellRoadNetwork;
}

export function pointWorld(point: CellRef): { x: number; z: number } {
  return point.x !== undefined && point.z !== undefined ? { x: point.x, z: point.z } : cellToWorld(point.cx, point.cz);
}

export function roadNeighbors(point: CellRef, mode: NavigationMode = point.mode ?? 'vehicle'): CellRef[] {
  return activeRoadNetwork.neighbors(point, mode);
}

/** Stable snapshot of currently streamed navigation points for ambient systems. */
export function roadPoints(mode: NavigationMode): CellRef[] {
  return activeRoadNetwork.points?.(mode) ?? [];
}

/** Find the nearest waypoint in the active navigation network. */
export function nearestRoadPoint(x: number, z: number, mode: NavigationMode = 'vehicle'): CellRef | null {
  return activeRoadNetwork.nearest({ ...worldToCell(x, z), x, z }, mode);
}

/** A legal continuation from a dead-end node, if the active network offers one. */
export function uTurnRoadCell(current: CellRef, mode: NavigationMode = current.mode ?? 'vehicle'): CellRef | null {
  return activeRoadNetwork.uTurn?.(current, mode) ?? null;
}

/** Prefer continuing along the current lane/path, otherwise select a legal outgoing edge. */
export function nextRoadCell(from: CellRef, current: CellRef, rng: number, mode: NavigationMode = current.mode ?? 'vehicle'): CellRef {
  const options = roadNeighbors(current, mode).filter((candidate) => {
    const a = pointWorld(candidate);
    const b = pointWorld(from);
    return Math.hypot(a.x - b.x, a.z - b.z) > 0.05;
  });
  // Dead-end: turn around onto a nearby legal lane if one exists, otherwise
  // retrace the way we came.
  if (options.length === 0) return uTurnRoadCell(current, mode) ?? from;
  const a = pointWorld(from);
  const b = pointWorld(current);
  const incoming = { x: b.x - a.x, z: b.z - a.z };
  const incomingLength = Math.hypot(incoming.x, incoming.z) || 1;
  const straight = options
    .map((point) => {
      const world = pointWorld(point);
      const dx = world.x - b.x;
      const dz = world.z - b.z;
      const length = Math.hypot(dx, dz) || 1;
      return { point, dot: (incoming.x * dx + incoming.z * dz) / (incomingLength * length) };
    })
    .sort((left, right) => right.dot - left.dot)[0];
  if (straight && straight.dot > 0.75 && rng < 0.65) return straight.point;
  const alternatives = options.filter((point) => point !== straight?.point);
  return alternatives.length > 0 ? alternatives[Math.floor(rng * alternatives.length) % alternatives.length] : straight.point;
}

/** Exact compiled waypoint, or a legacy lane/sidewalk offset for grid maps. */
export function lanePoint(from: CellRef, to: CellRef, laneFrac: number): { x: number; z: number } {
  if (to.x !== undefined && to.z !== undefined) return { x: to.x, z: to.z };
  const { x, z } = cellToWorld(to.cx, to.cz);
  const dx = Math.sign(to.cx - from.cx);
  const dz = Math.sign(to.cz - from.cz);
  return { x: x + -dz * laneFrac * TILE, z: z + dx * laneFrac * TILE };
}

export function randomRoadCellNear(
  x: number, z: number, minDist: number, maxDist: number, mode: NavigationMode = 'vehicle'
): CellRef | null {
  const angle = Math.random() * Math.PI * 2;
  const distance = minDist + Math.random() * (maxDist - minDist);
  const world = { x: x + Math.sin(angle) * distance, z: z + Math.cos(angle) * distance };
  const raw = { ...worldToCell(world.x, world.z), ...world };
  const point = activeRoadNetwork.nearest(raw, mode);
  if (!point) return null;
  const snapped = pointWorld(point);
  const actual = Math.hypot(snapped.x - x, snapped.z - z);
  return actual >= minDist && actual <= maxDist ? point : null;
}
