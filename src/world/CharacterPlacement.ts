import type {
  CompiledChunkData,
  CompiledCollisionMesh,
  CompiledCuboid,
  CompiledNavEdge,
  CompiledNavNode,
} from './CompiledFormat';
import { CHUNK_TILES, TILE_SIZE as TILE } from './MapContract';

const NAV_PEDESTRIAN = 2;
const HEIGHT_EPSILON = 0.04;
const AREA_EPSILON = 1e-6;

export const ON_FOOT_HEIGHT = 1.8;
export const ON_FOOT_RADIUS = 0.35;

interface ObstacleBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

interface CuboidObstacle extends ObstacleBounds {
  kind: 'cuboid';
  x: number;
  z: number;
  hx: number;
  hz: number;
  rotation: number;
}

interface MeshObstacle extends ObstacleBounds {
  kind: 'mesh';
  vertices: Float32Array;
  indices: Uint32Array;
}

type CharacterObstacle = CuboidObstacle | MeshObstacle;

export interface FilteredNavigation {
  nodes: CompiledNavNode[];
  edges: CompiledNavEdge[];
}

function isBuildingSource(source: string | undefined): boolean {
  return source?.startsWith('building:') === true ||
    source?.startsWith('generated:building:') === true;
}

function cuboidObstacle(cuboid: CompiledCuboid): CuboidObstacle {
  const cos = Math.abs(Math.cos(cuboid.rotation));
  const sin = Math.abs(Math.sin(cuboid.rotation));
  const extentX = cuboid.hx * cos + cuboid.hz * sin;
  const extentZ = cuboid.hx * sin + cuboid.hz * cos;
  return {
    kind: 'cuboid',
    x: cuboid.x,
    z: cuboid.z,
    hx: cuboid.hx,
    hz: cuboid.hz,
    rotation: cuboid.rotation,
    minX: cuboid.x - extentX,
    maxX: cuboid.x + extentX,
    minY: cuboid.y - cuboid.hy,
    maxY: cuboid.y + cuboid.hy,
    minZ: cuboid.z - extentZ,
    maxZ: cuboid.z + extentZ,
  };
}

function meshObstacle(mesh: CompiledCollisionMesh): MeshObstacle | null {
  if (mesh.vertices.length < 9 || mesh.indices.length < 3) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let offset = 0; offset < mesh.vertices.length; offset += 3) {
    const x = mesh.vertices[offset];
    const y = mesh.vertices[offset + 1];
    const z = mesh.vertices[offset + 2];
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return {
    kind: 'mesh',
    vertices: mesh.vertices,
    indices: mesh.indices,
    minX,
    maxX,
    minY,
    maxY,
    minZ,
    maxZ,
  };
}

function pointSegmentDistanceSquared(
  x: number,
  z: number,
  ax: number,
  az: number,
  bx: number,
  bz: number
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared <= AREA_EPSILON
    ? 0
    : Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSquared));
  const nearestX = ax + dx * t;
  const nearestZ = az + dz * t;
  return (x - nearestX) ** 2 + (z - nearestZ) ** 2;
}

function cross(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number
): number {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}

function pointOnSegment(
  x: number,
  z: number,
  ax: number,
  az: number,
  bx: number,
  bz: number
): boolean {
  return Math.abs(cross(ax, az, bx, bz, x, z)) <= AREA_EPSILON &&
    x >= Math.min(ax, bx) - AREA_EPSILON &&
    x <= Math.max(ax, bx) + AREA_EPSILON &&
    z >= Math.min(az, bz) - AREA_EPSILON &&
    z <= Math.max(az, bz) + AREA_EPSILON;
}

function segmentsIntersect(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number
): boolean {
  const abC = cross(ax, az, bx, bz, cx, cz);
  const abD = cross(ax, az, bx, bz, dx, dz);
  const cdA = cross(cx, cz, dx, dz, ax, az);
  const cdB = cross(cx, cz, dx, dz, bx, bz);
  if (((abC > AREA_EPSILON && abD < -AREA_EPSILON) ||
       (abC < -AREA_EPSILON && abD > AREA_EPSILON)) &&
      ((cdA > AREA_EPSILON && cdB < -AREA_EPSILON) ||
       (cdA < -AREA_EPSILON && cdB > AREA_EPSILON))) {
    return true;
  }
  return (Math.abs(abC) <= AREA_EPSILON && pointOnSegment(cx, cz, ax, az, bx, bz)) ||
    (Math.abs(abD) <= AREA_EPSILON && pointOnSegment(dx, dz, ax, az, bx, bz)) ||
    (Math.abs(cdA) <= AREA_EPSILON && pointOnSegment(ax, az, cx, cz, dx, dz)) ||
    (Math.abs(cdB) <= AREA_EPSILON && pointOnSegment(bx, bz, cx, cz, dx, dz));
}

function segmentDistanceSquared(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number
): number {
  if (segmentsIntersect(ax, az, bx, bz, cx, cz, dx, dz)) return 0;
  return Math.min(
    pointSegmentDistanceSquared(ax, az, cx, cz, dx, dz),
    pointSegmentDistanceSquared(bx, bz, cx, cz, dx, dz),
    pointSegmentDistanceSquared(cx, cz, ax, az, bx, bz),
    pointSegmentDistanceSquared(dx, dz, ax, az, bx, bz)
  );
}

function pointInTriangle(
  x: number,
  z: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number
): boolean {
  const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  if (Math.abs(area) <= AREA_EPSILON) return false;
  const ab = ((bx - ax) * (z - az) - (bz - az) * (x - ax)) / area;
  const bc = ((cx - bx) * (z - bz) - (cz - bz) * (x - bx)) / area;
  const ca = ((ax - cx) * (z - cz) - (az - cz) * (x - cx)) / area;
  return ab >= -AREA_EPSILON && bc >= -AREA_EPSILON && ca >= -AREA_EPSILON;
}

function meshContains(mesh: MeshObstacle, x: number, z: number, radius: number): boolean {
  const radiusSquared = radius * radius;
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const ai = mesh.indices[offset] * 3;
    const bi = mesh.indices[offset + 1] * 3;
    const ci = mesh.indices[offset + 2] * 3;
    const ax = mesh.vertices[ai];
    const az = mesh.vertices[ai + 2];
    const bx = mesh.vertices[bi];
    const bz = mesh.vertices[bi + 2];
    const cx = mesh.vertices[ci];
    const cz = mesh.vertices[ci + 2];
    if (pointInTriangle(x, z, ax, az, bx, bz, cx, cz)) return true;
    if (radius <= 0) continue;
    if (pointSegmentDistanceSquared(x, z, ax, az, bx, bz) <= radiusSquared ||
        pointSegmentDistanceSquared(x, z, bx, bz, cx, cz) <= radiusSquared ||
        pointSegmentDistanceSquared(x, z, cx, cz, ax, az) <= radiusSquared) {
      return true;
    }
  }
  return false;
}

function segmentIntersectsRectangle(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  hx: number,
  hz: number
): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  let minimum = 0;
  let maximum = 1;
  const clipAxis = (origin: number, delta: number, extent: number): boolean => {
    if (Math.abs(delta) <= AREA_EPSILON) return Math.abs(origin) <= extent;
    let near = (-extent - origin) / delta;
    let far = (extent - origin) / delta;
    if (near > far) [near, far] = [far, near];
    minimum = Math.max(minimum, near);
    maximum = Math.min(maximum, far);
    return minimum <= maximum;
  };
  return clipAxis(ax, dx, hx) && clipAxis(az, dz, hz);
}

function meshBlocksSegment(
  mesh: MeshObstacle,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  radius: number
): boolean {
  const radiusSquared = radius * radius;
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const ai = mesh.indices[offset] * 3;
    const bi = mesh.indices[offset + 1] * 3;
    const ci = mesh.indices[offset + 2] * 3;
    const triangle = [
      mesh.vertices[ai], mesh.vertices[ai + 2],
      mesh.vertices[bi], mesh.vertices[bi + 2],
      mesh.vertices[ci], mesh.vertices[ci + 2],
    ];
    if (pointInTriangle(
      ax, az, triangle[0], triangle[1], triangle[2], triangle[3], triangle[4], triangle[5]
    ) || pointInTriangle(
      bx, bz, triangle[0], triangle[1], triangle[2], triangle[3], triangle[4], triangle[5]
    )) {
      return true;
    }
    if (segmentDistanceSquared(ax, az, bx, bz, triangle[0], triangle[1], triangle[2], triangle[3]) <= radiusSquared ||
        segmentDistanceSquared(ax, az, bx, bz, triangle[2], triangle[3], triangle[4], triangle[5]) <= radiusSquared ||
        segmentDistanceSquared(ax, az, bx, bz, triangle[4], triangle[5], triangle[0], triangle[1]) <= radiusSquared) {
      return true;
    }
  }
  return false;
}

function obstacleBlocksSegment(
  obstacle: CharacterObstacle,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  radius: number,
  height: number
): boolean {
  if (Math.min(ay, by) >= obstacle.maxY - HEIGHT_EPSILON ||
      Math.max(ay, by) + height <= obstacle.minY + HEIGHT_EPSILON ||
      Math.max(ax, bx) < obstacle.minX - radius ||
      Math.min(ax, bx) > obstacle.maxX + radius ||
      Math.max(az, bz) < obstacle.minZ - radius ||
      Math.min(az, bz) > obstacle.maxZ + radius) {
    return false;
  }
  if (obstacle.kind === 'mesh') {
    return meshBlocksSegment(obstacle, ax, az, bx, bz, radius);
  }
  const cos = Math.cos(obstacle.rotation);
  const sin = Math.sin(obstacle.rotation);
  const local = (x: number, z: number) => {
    const dx = x - obstacle.x;
    const dz = z - obstacle.z;
    return {
      x: dx * cos - dz * sin,
      z: dx * sin + dz * cos,
    };
  };
  const a = local(ax, az);
  const b = local(bx, bz);
  return segmentIntersectsRectangle(
    a.x,
    a.z,
    b.x,
    b.z,
    obstacle.hx + radius,
    obstacle.hz + radius
  );
}

function obstacleContains(
  obstacle: CharacterObstacle,
  x: number,
  feetY: number,
  z: number,
  radius: number,
  height: number
): boolean {
  if (feetY >= obstacle.maxY - HEIGHT_EPSILON ||
      feetY + height <= obstacle.minY + HEIGHT_EPSILON ||
      x < obstacle.minX - radius ||
      x > obstacle.maxX + radius ||
      z < obstacle.minZ - radius ||
      z > obstacle.maxZ + radius) {
    return false;
  }
  if (obstacle.kind === 'mesh') return meshContains(obstacle, x, z, radius);
  const dx = x - obstacle.x;
  const dz = z - obstacle.z;
  const cos = Math.cos(obstacle.rotation);
  const sin = Math.sin(obstacle.rotation);
  const localX = dx * cos - dz * sin;
  const localZ = dx * sin + dz * cos;
  return Math.abs(localX) <= obstacle.hx + radius &&
    Math.abs(localZ) <= obstacle.hz + radius;
}

function chunkOfWorld(x: number, z: number): { kx: number; kz: number } {
  return {
    kx: Math.floor(Math.round(x / TILE) / CHUNK_TILES),
    kz: Math.floor(Math.round(z / TILE) / CHUNK_TILES),
  };
}

function positionKey(x: number, z: number): string {
  return `${Math.round(x * 100)},${Math.round(z * 100)}`;
}

/**
 * Runtime index of closed building volumes. Rapier triangle meshes correctly
 * stop an actor approaching a wall, but a capsule created inside a closed mesh
 * cannot infer that it is already enclosed. This index supplies that missing
 * inside/outside test for spawns, teleports, and navigation.
 */
export class CharacterPlacementIndex {
  private chunks = new Map<string, CharacterObstacle[]>();

  registerChunk(key: string, data: CompiledChunkData): void {
    const obstacles: CharacterObstacle[] = [];
    for (const cuboid of data.cuboids) {
      if (isBuildingSource(data.sources[cuboid.sourceIndex])) {
        obstacles.push(cuboidObstacle(cuboid));
      }
    }
    for (const mesh of data.meshes) {
      if (!isBuildingSource(data.sources[mesh.sourceIndex])) continue;
      const obstacle = meshObstacle(mesh);
      if (obstacle) obstacles.push(obstacle);
    }
    this.chunks.set(key, obstacles);
  }

  unregisterChunk(key: string): void {
    this.chunks.delete(key);
  }

  clear(): void {
    this.chunks.clear();
  }

  blocks(x: number, feetY: number, z: number, radius: number, height: number): boolean {
    const center = chunkOfWorld(x, z);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const obstacle of this.chunks.get(`${center.kx + dx},${center.kz + dz}`) ?? []) {
          if (obstacleContains(obstacle, x, feetY, z, radius, height)) return true;
        }
      }
    }
    return false;
  }

  blocksSegment(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    radius: number,
    height: number
  ): boolean {
    const minimum = chunkOfWorld(Math.min(ax, bx) - radius, Math.min(az, bz) - radius);
    const maximum = chunkOfWorld(Math.max(ax, bx) + radius, Math.max(az, bz) + radius);
    for (let kz = minimum.kz; kz <= maximum.kz; kz++) {
      for (let kx = minimum.kx; kx <= maximum.kx; kx++) {
        for (const obstacle of this.chunks.get(`${kx},${kz}`) ?? []) {
          if (obstacleBlocksSegment(obstacle, ax, ay, az, bx, by, bz, radius, height)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Strip only the pedestrian bit from enclosed nodes and from edges whose
   * swept capsule crosses a building. Multi-mode navigation remains available
   * to road and transit actors.
   */
  filterPedestrianNavigation(
    nodes: CompiledNavNode[],
    edges: CompiledNavEdge[],
    radius: number,
    height: number
  ): FilteredNavigation {
    const blocked = new Set<string>();
    const nodeHeights = new Map(nodes.map((node) => [
      positionKey(node.x, node.z),
      node.y,
    ]));
    const filteredNodes = nodes
      .map((node) => {
        if ((node.flags & NAV_PEDESTRIAN) === 0 ||
            !this.blocks(node.x, node.y, node.z, radius, height)) {
          return node;
        }
        blocked.add(positionKey(node.x, node.z));
        return { ...node, flags: node.flags & ~NAV_PEDESTRIAN };
      })
      .filter((node) => node.flags !== 0);
    const filteredEdges = edges
      .map((edge) => {
        if ((edge.flags & NAV_PEDESTRIAN) === 0) {
          return edge;
        }
        const fromKey = positionKey(edge.fromX, edge.fromZ);
        const toKey = positionKey(edge.toX, edge.toZ);
        const fromY = nodeHeights.get(fromKey) ?? nodeHeights.get(toKey) ?? 0;
        const toY = nodeHeights.get(toKey) ?? fromY;
        if (!blocked.has(fromKey) &&
            !blocked.has(toKey) &&
            !this.blocksSegment(
              edge.fromX,
              fromY,
              edge.fromZ,
              edge.toX,
              toY,
              edge.toZ,
              radius,
              height
            )) {
          return edge;
        }
        return { ...edge, flags: edge.flags & ~NAV_PEDESTRIAN };
      })
      .filter((edge) => edge.flags !== 0);
    return { nodes: filteredNodes, edges: filteredEdges };
  }
}
