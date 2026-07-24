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
  /** True when an authored outgoing edge currently ends in an unloaded chunk. */
  hasPendingContinuation?(point: CellRef, mode?: NavigationMode): boolean;
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
  private pendingContinuations = new Set<string>();

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

  hasPendingContinuation(point: CellRef, mode: NavigationMode = point.mode ?? 'vehicle'): boolean {
    const world = pointWorld(point);
    return this.pendingContinuations.has(adjacencyKey(mode, world.x, world.z));
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
    this.pendingContinuations.clear();
  }

  points(mode: NavigationMode): CellRef[] {
    return [...(this.nodes.get(mode)?.values() ?? [])];
  }

  private rebuild(): void {
    this.nodes = new Map([
      ['vehicle', new Map()], ['pedestrian', new Map()], ['tram', new Map()], ['train', new Map()],
    ]);
    this.adjacency.clear();
    this.pendingContinuations.clear();
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
          if (!from) continue;
          if (!to) {
            this.pendingContinuations.add(adjacencyKey(mode, from.x!, from.z!));
            continue;
          }
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

export interface RoadContinuation {
  neighbors: CellRef[];
  pending: boolean;
}

/** Loaded outgoing edges plus whether an authored edge is waiting on streaming. */
export function roadContinuation(
  point: CellRef,
  mode: NavigationMode = point.mode ?? 'vehicle'
): RoadContinuation {
  return {
    neighbors: roadNeighbors(point, mode),
    pending: activeRoadNetwork.hasPendingContinuation?.(point, mode) ?? false,
  };
}

/** Stable snapshot of currently streamed navigation points for ambient systems. */
export function roadPoints(mode: NavigationMode): CellRef[] {
  return activeRoadNetwork.points?.(mode) ?? [];
}

export interface RoadPose {
  x: number;
  z: number;
  heading: number;
}

/** Pick the nearest deterministic road pose in a distance band that passes a caller's clearance check. */
export function nearestClearRoadPose(
  x: number,
  z: number,
  minDistance: number,
  maxDistance: number,
  isClear: (x: number, z: number, heading: number) => boolean,
  mode: NavigationMode = 'vehicle'
): RoadPose | null {
  const candidates = roadPoints(mode)
    .map((point) => {
      const world = pointWorld(point);
      return { point, world, distance: Math.hypot(world.x - x, world.z - z) };
    })
    .filter(({ distance }) => distance >= minDistance && distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance || a.world.z - b.world.z || a.world.x - b.world.x);
  for (const candidate of candidates) {
    const next = roadNeighbors(candidate.point, mode)[0];
    const target = next ? pointWorld(next) : { x: candidate.world.x, z: candidate.world.z + 1 };
    const heading = Math.atan2(target.x - candidate.world.x, target.z - candidate.world.z);
    if (isClear(candidate.world.x, candidate.world.z, heading)) {
      return { ...candidate.world, heading };
    }
  }
  return null;
}

/** Find the nearest waypoint in the active navigation network. */
export function nearestRoadPoint(x: number, z: number, mode: NavigationMode = 'vehicle'): CellRef | null {
  return activeRoadNetwork.nearest({ ...worldToCell(x, z), x, z }, mode);
}

export interface RoadSegmentProjection {
  x: number;
  z: number;
  progress: number;
  crossTrack: number;
}

/** Project a world position onto a directed navigation segment. */
export function projectRoadSegment(
  x: number,
  z: number,
  from: CellRef,
  to: CellRef
): RoadSegmentProjection {
  const a = pointWorld(from);
  const b = pointWorld(to);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  const progress = lengthSq > 0.0001
    ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq))
    : 1;
  const projectedX = a.x + dx * progress;
  const projectedZ = a.z + dz * progress;
  return {
    x: projectedX,
    z: projectedZ,
    progress,
    crossTrack: Math.hypot(x - projectedX, z - projectedZ),
  };
}

export interface RoadRouteOptions {
  maxVisited?: number;
}

/** A bounded shortest route over the currently loaded directed graph. */
export function findRoadRoute(
  start: CellRef,
  goal: CellRef,
  mode: NavigationMode = start.mode ?? 'vehicle',
  options: RoadRouteOptions = {}
): CellRef[] | null {
  const startWorld = pointWorld(start);
  const goalWorld = pointWorld(goal);
  const startKey = positionKey(startWorld.x, startWorld.z);
  const goalKey = positionKey(goalWorld.x, goalWorld.z);
  if (startKey === goalKey) return [start];

  const maxVisited = options.maxVisited ?? 4096;
  const open: { key: string; point: CellRef; score: number }[] = [];
  const costs = new Map<string, number>([[startKey, 0]]);
  const previous = new Map<string, { key: string; point: CellRef }>();
  const closed = new Set<string>();
  const push = (entry: { key: string; point: CellRef; score: number }): void => {
    open.push(entry);
    let index = open.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (open[parent].score <= entry.score) break;
      open[index] = open[parent];
      index = parent;
    }
    open[index] = entry;
  };
  const pop = (): { key: string; point: CellRef; score: number } | null => {
    const first = open[0];
    const last = open.pop();
    if (!first || !last || open.length === 0) return first ?? null;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= open.length) break;
      const child = right < open.length && open[right].score < open[left].score ? right : left;
      if (open[child].score >= last.score) break;
      open[index] = open[child];
      index = child;
    }
    open[index] = last;
    return first;
  };
  push({
    key: startKey,
    point: start,
    score: Math.hypot(goalWorld.x - startWorld.x, goalWorld.z - startWorld.z),
  });

  let visited = 0;
  while (open.length > 0 && visited++ < maxVisited) {
    const current = pop();
    if (!current) break;
    const currentKey = current.key;
    if (closed.has(currentKey)) continue;
    closed.add(currentKey);
    if (currentKey === goalKey) {
      const route = [current.point];
      let key = currentKey;
      while (key !== startKey) {
        const step = previous.get(key);
        if (!step) return null;
        route.push(step.point);
        key = step.key;
      }
      route.reverse();
      return route;
    }

    const currentWorld = pointWorld(current.point);
    const currentCost = costs.get(currentKey) ?? Infinity;
    for (const neighbor of roadNeighbors(current.point, mode)) {
      const neighborWorld = pointWorld(neighbor);
      const neighborKey = positionKey(neighborWorld.x, neighborWorld.z);
      const edgeCost = Math.hypot(neighborWorld.x - currentWorld.x, neighborWorld.z - currentWorld.z);
      const nextCost = currentCost + edgeCost;
      if (nextCost >= (costs.get(neighborKey) ?? Infinity)) continue;
      costs.set(neighborKey, nextCost);
      previous.set(neighborKey, { key: currentKey, point: current.point });
      push({
        key: neighborKey,
        point: neighbor,
        score: nextCost + Math.hypot(goalWorld.x - neighborWorld.x, goalWorld.z - neighborWorld.z),
      });
    }
  }
  return null;
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

/** Directional continuity of a three-node route: 1 is straight, -1 is a reversal. */
export function roadTurnCosine(from: CellRef, current: CellRef, next: CellRef): number {
  const a = pointWorld(from);
  const b = pointWorld(current);
  const c = pointWorld(next);
  const incomingX = b.x - a.x;
  const incomingZ = b.z - a.z;
  const outgoingX = c.x - b.x;
  const outgoingZ = c.z - b.z;
  const incomingLength = Math.hypot(incomingX, incomingZ) || 1;
  const outgoingLength = Math.hypot(outgoingX, outgoingZ) || 1;
  return (incomingX * outgoingX + incomingZ * outgoingZ) / (incomingLength * outgoingLength);
}

/**
 * Choose a lane-safe vehicle continuation. Reversals are rejected, and an
 * immediately terminal branch loses to any branch with loaded or pending road.
 */
export function nextVehicleRoadCell(from: CellRef, current: CellRef, rng: number): CellRef | null {
  const fromWorld = pointWorld(from);
  const candidates = roadNeighbors(current, 'vehicle')
    .filter((candidate) => {
      const world = pointWorld(candidate);
      if (Math.hypot(world.x - fromWorld.x, world.z - fromWorld.z) <= 0.05) return false;
      return roadTurnCosine(from, current, candidate) > -0.25;
    })
    .map((point) => {
      const continuation = roadContinuation(point, 'vehicle');
      const pointWorldPosition = pointWorld(point);
      const onward = continuation.neighbors.some((neighbor) => {
        const world = pointWorld(neighbor);
        const currentWorld = pointWorld(current);
        return Math.hypot(world.x - currentWorld.x, world.z - currentWorld.z) > 0.05;
      });
      return {
        point,
        dot: roadTurnCosine(from, current, point),
        viable: onward || continuation.pending,
        x: pointWorldPosition.x,
        z: pointWorldPosition.z,
      };
    });
  if (candidates.length === 0) return null;
  const viable = candidates.some((candidate) => candidate.viable)
    ? candidates.filter((candidate) => candidate.viable)
    : candidates;
  viable.sort((left, right) => right.dot - left.dot || left.z - right.z || left.x - right.x);
  if (viable[0].dot > 0.75 && rng < 0.7) return viable[0].point;
  const alternatives = viable.slice(1);
  return alternatives.length > 0
    ? alternatives[Math.floor(rng * alternatives.length) % alternatives.length].point
    : viable[0].point;
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
