import { MAP_CONTRACT, MAP_ID } from './MapContract';

export const COMPILED_MANIFEST_VERSION = MAP_CONTRACT.versions.compiledManifest;
export const COMPILED_CONTAINER_VERSION = MAP_CONTRACT.versions.container;
export const COMPILED_RUNTIME_VERSION = MAP_CONTRACT.versions.runtime;

export interface CompiledChunkManifest {
  kx: number;
  kz: number;
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  renderUrl: string;
  dataUrl: string;
  renderBytes: number;
  dataBytes: number;
  renderHash: string;
  dataHash: string;
  inputHash: string;
  empty: { render: boolean; collision: boolean; navigation: boolean; gameplay: boolean };
}

export interface CompiledManifest {
  version: number;
  mapId: string;
  buildId: string;
  compilerVersion: number;
  coordinateConvention: string;
  tileSize: number;
  chunkTiles: number;
  chunkSize: number;
  validChunkBounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  spawn: { x: number; z: number };
  scope: string;
  partial: boolean;
  required: {
    runtimeVersion: number;
    containerVersion: number;
    gltfVersion: string;
    gltfExtensions: string[];
  };
  chunks: CompiledChunkManifest[];
}

export interface CompiledCuboid {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  rotation: number;
  sourceIndex: number;
}

export interface CompiledCollisionMesh {
  sourceIndex: number;
  vertices: Float32Array;
  indices: Uint32Array;
}

export interface CompiledNavNode {
  x: number;
  y: number;
  z: number;
  flags: number;
  speed: number;
}

export interface CompiledNavEdge {
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  flags: number;
}

export interface CompiledParkedSpawn {
  x: number;
  z: number;
  rotation: number;
  seed: number;
  sourceIndex: number;
}

export interface CompiledTransitStop {
  x: number;
  y: number;
  z: number;
  mode: 'tram' | 'train';
  sourceIndex: number;
  name: string;
}

export interface CompiledChunkData {
  kx: number;
  kz: number;
  heights: Int16Array;
  cuboids: CompiledCuboid[];
  meshes: CompiledCollisionMesh[];
  navNodes: CompiledNavNode[];
  navEdges: CompiledNavEdge[];
  cells: Uint8Array;
  parked: CompiledParkedSpawn[];
  transitStops: CompiledTransitStop[];
  sources: string[];
}

function ensure(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function validateCompiledManifest(value: unknown): CompiledManifest {
  ensure(typeof value === 'object' && value !== null, 'compiled manifest is not an object');
  const manifest = value as CompiledManifest;
  ensure(manifest.version === COMPILED_MANIFEST_VERSION, `unsupported compiled manifest version ${manifest.version}`);
  ensure(manifest.mapId === MAP_ID, `unexpected compiled map ${manifest.mapId}`);
  ensure(manifest.coordinateConvention === MAP_CONTRACT.coordinateConvention, 'unsupported compiled coordinate convention');
  ensure(manifest.tileSize === MAP_CONTRACT.tileSize && manifest.chunkTiles === MAP_CONTRACT.chunkTiles && manifest.chunkSize === MAP_CONTRACT.chunkSize, 'unsupported compiled chunk dimensions');
  ensure(manifest.required?.runtimeVersion === COMPILED_RUNTIME_VERSION, `unsupported compiled runtime version ${manifest.required?.runtimeVersion}`);
  ensure(manifest.required.containerVersion === COMPILED_CONTAINER_VERSION, `unsupported compiled container version ${manifest.required.containerVersion}`);
  ensure(manifest.required.gltfVersion === '2.0', `unsupported compiled glTF version ${manifest.required.gltfVersion}`);
  ensure(Array.isArray(manifest.required.gltfExtensions), 'compiled glTF extension list is invalid');
  ensure(Array.isArray(manifest.chunks), 'compiled chunk list is invalid');
  const seen = new Set<string>();
  for (const chunk of manifest.chunks) {
    ensure(Number.isInteger(chunk.kx) && Number.isInteger(chunk.kz), 'compiled chunk coordinates are invalid');
    ensure(chunk.kx >= manifest.validChunkBounds.minX && chunk.kx <= manifest.validChunkBounds.maxX && chunk.kz >= manifest.validChunkBounds.minZ && chunk.kz <= manifest.validChunkBounds.maxZ, `compiled chunk ${chunk.kx},${chunk.kz} is out of bounds`);
    const key = `${chunk.kx},${chunk.kz}`;
    ensure(!seen.has(key), `duplicate compiled chunk ${key}`);
    seen.add(key);
    ensure(chunk.renderUrl.endsWith(`${chunk.kx}_${chunk.kz}.glb`) && chunk.dataUrl.endsWith(`${chunk.kx}_${chunk.kz}.bin`), `compiled chunk ${key} has mismatched URLs`);
    ensure(/^[0-9a-f]{64}$/.test(chunk.renderHash) && /^[0-9a-f]{64}$/.test(chunk.dataHash), `compiled chunk ${key} has invalid hashes`);
  }
  return manifest;
}

export async function hashBuffer(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

class Reader {
  private offset = 0;
  private view: DataView;

  constructor(private bytes: Uint8Array, offset = 0) {
    this.offset = offset;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private require(length: number): void {
    ensure(this.offset + length <= this.bytes.length, 'compiled section is truncated');
  }

  u8(): number { this.require(1); return this.view.getUint8(this.offset++); }
  u16(): number { this.require(2); const value = this.view.getUint16(this.offset, true); this.offset += 2; return value; }
  i16(): number { this.require(2); const value = this.view.getInt16(this.offset, true); this.offset += 2; return value; }
  i32(): number { this.require(4); const value = this.view.getInt32(this.offset, true); this.offset += 4; return value; }
  u32(): number { this.require(4); const value = this.view.getUint32(this.offset, true); this.offset += 4; return value; }
  f32(): number { this.require(4); const value = this.view.getFloat32(this.offset, true); this.offset += 4; return value; }
  take(length: number): Uint8Array { this.require(length); const value = this.bytes.slice(this.offset, this.offset + length); this.offset += length; return value; }
  remaining(): number { return this.bytes.length - this.offset; }
}

export function parseCompiledChunk(buffer: ArrayBuffer, expectedKx: number, expectedKz: number): CompiledChunkData {
  const bytes = new Uint8Array(buffer);
  ensure(bytes.byteLength >= 16, 'compiled chunk header is truncated');
  const header = new DataView(buffer);
  ensure(new TextDecoder().decode(bytes.slice(0, 4)) === 'NBCH', 'invalid compiled chunk magic');
  ensure(header.getUint16(4, true) === COMPILED_CONTAINER_VERSION, `unsupported compiled container version ${header.getUint16(4, true)}`);
  const headerSize = header.getUint16(6, true);
  const kx = header.getInt16(8, true);
  const kz = header.getInt16(10, true);
  ensure(kx === expectedKx && kz === expectedKz, 'compiled chunk coordinate mismatch');
  const count = header.getUint16(12, true);
  ensure(headerSize === 16 + count * 16 && headerSize <= bytes.length, 'malformed compiled section table');
  const sections = new Map<string, Uint8Array>();
  let previousEnd = headerSize;
  for (let i = 0; i < count; i++) {
    const offset = 16 + i * 16;
    const type = new TextDecoder().decode(bytes.slice(offset, offset + 4));
    const sectionOffset = header.getUint32(offset + 4, true);
    const sectionLength = header.getUint32(offset + 8, true);
    ensure(type in MAP_CONTRACT.nbchSections && !sections.has(type), `invalid compiled section ${type}`);
    ensure(sectionOffset >= headerSize && sectionOffset % 4 === 0 && sectionOffset >= previousEnd && sectionOffset + sectionLength <= bytes.length, `malformed compiled section ${type}`);
    sections.set(type, bytes.slice(sectionOffset, sectionOffset + sectionLength));
    previousEnd = sectionOffset + sectionLength;
  }
  for (const type of Object.keys(MAP_CONTRACT.nbchSections)) ensure(sections.has(type), `missing compiled section ${type}`);

  const heightReader = new Reader(sections.get('HGT1')!);
  const heights = new Int16Array(121);
  for (let i = 0; i < heights.length; i++) heights[i] = heightReader.i16();
  ensure(heightReader.remaining() === 0, 'invalid HGT1 length');

  const collisionReader = new Reader(sections.get('COL1')!);
  ensure(collisionReader.u16() === MAP_CONTRACT.nbchSections.COL1, 'unsupported COL1 version');
  collisionReader.u16();
  const cuboidCount = collisionReader.u32();
  const meshCount = collisionReader.u32();
  ensure(cuboidCount <= 10000 && meshCount <= 10000, 'COL1 record count is unreasonable');
  const cuboids: CompiledCuboid[] = [];
  for (let i = 0; i < cuboidCount; i++) cuboids.push({
    x: collisionReader.f32(), y: collisionReader.f32(), z: collisionReader.f32(),
    hx: collisionReader.f32(), hy: collisionReader.f32(), hz: collisionReader.f32(),
    rotation: collisionReader.f32(), sourceIndex: collisionReader.u32(),
  });
  const meshes: CompiledCollisionMesh[] = [];
  for (let i = 0; i < meshCount; i++) {
    const sourceIndex = collisionReader.u32();
    const vertexCount = collisionReader.u32();
    const indexCount = collisionReader.u32();
    ensure(vertexCount <= 2_000_000 && indexCount <= 6_000_000, 'COL1 mesh is unreasonable');
    const vertices = new Float32Array(vertexCount * 3);
    const indices = new Uint32Array(indexCount);
    for (let j = 0; j < vertices.length; j++) vertices[j] = collisionReader.f32();
    for (let j = 0; j < indices.length; j++) indices[j] = collisionReader.u32();
    ensure(indices.every((index) => index < vertexCount), 'COL1 mesh index is out of range');
    meshes.push({ sourceIndex, vertices, indices });
  }
  ensure(collisionReader.remaining() === 0, 'trailing COL1 data');

  const navReader = new Reader(sections.get('NAV3')!);
  ensure(navReader.u16() === MAP_CONTRACT.nbchSections.NAV3, 'unsupported NAV3 version');
  const nodeCount = navReader.u16();
  const edgeCount = navReader.u32();
  const navNodes: CompiledNavNode[] = [];
  for (let i = 0; i < nodeCount; i++) navNodes.push({
    x: navReader.i32() / 100, y: navReader.i32() / 100, z: navReader.i32() / 100,
    flags: navReader.u16(), speed: navReader.u16(),
  });
  const navEdges: CompiledNavEdge[] = [];
  for (let i = 0; i < edgeCount; i++) {
    navEdges.push({
      fromX: navReader.i32() / 100, fromZ: navReader.i32() / 100,
      toX: navReader.i32() / 100, toZ: navReader.i32() / 100,
      flags: navReader.u16(),
    });
    navReader.u16();
  }
  ensure(navReader.remaining() === 0, 'trailing NAV3 data');

  const gameReader = new Reader(sections.get('GME1')!);
  ensure(gameReader.u16() === MAP_CONTRACT.nbchSections.GME1, 'unsupported GME1 version');
  const cellCount = gameReader.u16();
  const parkedCount = gameReader.u16();
  const sourceCount = gameReader.u16();
  ensure(cellCount === 100, 'invalid GME1 semantic cell count');
  const cells = gameReader.take(cellCount);
  const parked: CompiledParkedSpawn[] = [];
  for (let i = 0; i < parkedCount; i++) parked.push({ x: gameReader.f32(), z: gameReader.f32(), rotation: gameReader.f32(), seed: gameReader.u32(), sourceIndex: gameReader.u32() });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const sources: string[] = [];
  for (let i = 0; i < sourceCount; i++) sources.push(decoder.decode(gameReader.take(gameReader.u16())));
  ensure(gameReader.remaining() === 0, 'trailing GME1 data');
  const transitReader = new Reader(sections.get('TRN1')!);
  ensure(transitReader.u16() === MAP_CONTRACT.nbchSections.TRN1, 'unsupported TRN1 version');
  const transitCount = transitReader.u16();
  ensure(transitCount <= 4096, 'TRN1 record count is unreasonable');
  const transitStops: CompiledTransitStop[] = [];
  for (let i = 0; i < transitCount; i++) {
    const x = transitReader.f32(); const y = transitReader.f32(); const z = transitReader.f32();
    const modeCode = transitReader.u8(); transitReader.u8(); transitReader.u16();
    ensure(modeCode === 1 || modeCode === 2, 'invalid TRN1 transit mode');
    const sourceIndex = transitReader.u32();
    const name = decoder.decode(transitReader.take(transitReader.u16()));
    transitStops.push({ x, y, z, mode: modeCode === 2 ? 'train' : 'tram', sourceIndex, name });
  }
  ensure(transitReader.remaining() === 0, 'trailing TRN1 data');
  ensure(cuboids.every((item) => item.sourceIndex < sources.length) && meshes.every((item) => item.sourceIndex < sources.length) && parked.every((item) => item.sourceIndex < sources.length) && transitStops.every((item) => item.sourceIndex < sources.length), 'compiled source index is out of range');
  return { kx, kz, heights, cuboids, meshes, navNodes, navEdges, cells, parked, transitStops, sources };
}
