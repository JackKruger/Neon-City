import type { CellRef } from '../world/RoadGraph';
import {
  pointWorld,
  projectRoadSegment,
  roadTurnCosine,
} from '../world/RoadGraph';

export interface NpcVehicleNavigationStats {
  routeReplans: number;
  routeFailures: number;
  recoveryAttempts: number;
  laneDepartures: number;
  terminalStops: number;
}

/** Session-level counters shown in the F3 diagnostics panel. */
export const npcVehicleNavigationStats: NpcVehicleNavigationStats = {
  routeReplans: 0,
  routeFailures: 0,
  recoveryAttempts: 0,
  laneDepartures: 0,
  terminalStops: 0,
};

export interface LaneFollowSample {
  target: { x: number; z: number };
  crossTrack: number;
  progress: number;
  distanceToRouteEnd: number;
  turnCosine: number;
}

/**
 * Shared geometric route cursor for physics-driven NPC cars. Policy (random
 * traffic versus goal-directed police routing) remains with the caller.
 */
export class NpcLaneFollower {
  private future: CellRef[] = [];

  constructor(public from: CellRef, public to: CellRef) {}

  replaceRoute(route: CellRef[]): boolean {
    if (route.length < 2) return false;
    this.from = route[0];
    this.to = route[1];
    this.future = route.slice(2);
    return true;
  }

  append(point: CellRef): void {
    this.future.push(point);
  }

  futureLength(): number {
    return this.future.length;
  }

  routeEnd(): CellRef {
    return this.future.at(-1) ?? this.to;
  }

  lastEdge(): { from: CellRef; to: CellRef } {
    if (this.future.length === 0) return { from: this.from, to: this.to };
    return {
      from: this.future.length === 1 ? this.to : this.future[this.future.length - 2],
      to: this.future[this.future.length - 1],
    };
  }

  /** Advance after crossing the end plane, with a distance fallback for tight curves. */
  advanceIfNeeded(x: number, z: number): boolean {
    const projection = projectRoadSegment(x, z, this.from, this.to);
    const end = pointWorld(this.to);
    const closeToEnd = Math.hypot(end.x - x, end.z - z) < 2.6;
    if (projection.progress < 0.92 && !(projection.progress > 0.62 && closeToEnd)) return false;
    const next = this.future.shift();
    if (!next) return false;
    this.from = this.to;
    this.to = next;
    return true;
  }

  sample(x: number, z: number, lookahead: number): LaneFollowSample {
    const projection = projectRoadSegment(x, z, this.from, this.to);
    const points = [
      { x: projection.x, z: projection.z },
      pointWorld(this.to),
      ...this.future.map(pointWorld),
    ];
    let target = points.at(-1)!;
    let remainingLookahead = lookahead;
    let distanceToRouteEnd = 0;
    for (let index = 0; index + 1 < points.length; index++) {
      distanceToRouteEnd += Math.hypot(
        points[index + 1].x - points[index].x,
        points[index + 1].z - points[index].z
      );
    }
    for (let index = 0; index + 1 < points.length; index++) {
      const a = points[index];
      const b = points[index + 1];
      const distance = Math.hypot(b.x - a.x, b.z - a.z);
      if (remainingLookahead <= distance) {
        const amount = distance > 0.001 ? remainingLookahead / distance : 1;
        target = {
          x: a.x + (b.x - a.x) * amount,
          z: a.z + (b.z - a.z) * amount,
        };
        remainingLookahead = -1;
        break;
      }
      remainingLookahead -= distance;
    }
    return {
      target,
      crossTrack: projection.crossTrack,
      progress: projection.progress,
      distanceToRouteEnd,
      turnCosine: this.future.length > 0
        ? roadTurnCosine(this.from, this.to, this.future[0])
        : 1,
    };
  }

  points(): CellRef[] {
    return [this.from, this.to, ...this.future];
  }
}
