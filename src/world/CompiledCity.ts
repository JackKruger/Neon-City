import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { Game } from '../core/Game';
import { CIVILIAN_CARS } from '../core/const';
import { Vehicle } from '../entities/Vehicle';
import { selectPrewarmChunkKeys, type CityStreamer, type CityStreamStats } from './CityStreamer';
import {
  hashBuffer,
  parseCompiledChunk,
  type CompiledChunkData,
  type CompiledChunkManifest,
  type CompiledManifest,
  validateCompiledManifest,
} from './CompiledFormat';
import { CompiledRoadNetwork, setRoadNetwork } from './RoadGraph';
import { CHUNK_SIZE, CHUNK_TILES, TILE_SIZE as TILE } from './MapContract';

const LOAD_RADIUS = 2;
const UNLOAD_RADIUS = 3;
const MAX_CONCURRENT_LOADS = 2;

interface LoadedChunk {
  kx: number;
  kz: number;
  root: THREE.Group;
  body: RAPIER.RigidBody;
  renderBytes: number;
  dataBytes: number;
}

interface PendingChunk {
  controller: AbortController;
  promise: Promise<void>;
}

const chunkKey = (kx: number, kz: number): string => `${kx},${kz}`;

function chunkOfWorld(x: number, z: number): { kx: number; kz: number } {
  return {
    kx: Math.floor(Math.round(x / TILE) / CHUNK_TILES),
    kz: Math.floor(Math.round(z / TILE) / CHUNK_TILES),
  };
}

/** Streams deterministic GLB/NBCH pairs without invoking Melbourne builders. */
export class CompiledCity implements CityStreamer {
  private loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private manifest: CompiledManifest | null = null;
  private entries = new Map<string, CompiledChunkManifest>();
  private chunks = new Map<string, LoadedChunk>();
  /** Compiled parked cars follow their current chunk after being moved. */
  private managedVehicles = new Map<Vehicle, string>();
  private pending = new Map<string, PendingChunk>();
  private wanted = new Set<string>();
  private centers: { kx: number; kz: number }[] = [];
  private roadNetwork = new CompiledRoadNetwork();
  private disposed = false;
  private failure: Error | null = null;
  private safetyBody: RAPIER.RigidBody;
  private recentLoadMs: number[] = [];

  constructor(private game: Game, private mapName = 'melbourne') {
    setRoadNetwork(this.roadNetwork);
    this.safetyBody = game.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    game.world.createCollider(
      RAPIER.ColliderDesc.cuboid(1e5, 0.5, 1e5).setTranslation(0, -30.5, 0),
      this.safetyBody
    );
  }

  loadedChunkCount(): number {
    return this.chunks.size;
  }

  stats(): CityStreamStats {
    let loadedBytes = 0;
    for (const chunk of this.chunks.values()) loadedBytes += chunk.renderBytes + chunk.dataBytes;
    const missingChunks = [...this.wanted].filter((key) => !this.entries.has(key)).length;
    const lastLoadMs = this.recentLoadMs.at(-1) ?? 0;
    return {
      loadedChunks: this.chunks.size,
      pendingChunks: this.pending.size,
      wantedChunks: this.wanted.size,
      missingChunks,
      loadedBytes,
      lastLoadMs,
      averageLoadMs: this.recentLoadMs.length > 0
        ? this.recentLoadMs.reduce((sum, value) => sum + value, 0) / this.recentLoadMs.length
        : 0,
      scope: this.manifest?.scope ?? 'loading',
      partial: this.manifest?.partial ?? true,
    };
  }

  async prewarm(x: number, z: number): Promise<void> {
    await this.loadManifest();
    const center = chunkOfWorld(x, z);
    const keys = selectPrewarmChunkKeys(new Set(this.entries.keys()), center, this.manifest!.partial);
    const required = keys.map((key) => this.entries.get(key)!);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(MAX_CONCURRENT_LOADS, required.length) }, async () => {
      while (cursor < required.length) {
        const entry = required[cursor++];
        await this.loadChunk(entry);
      }
    });
    await Promise.all(workers);
  }

  update(positions: { x: number; z: number }[]): void {
    if (this.disposed || this.failure || positions.length === 0) return;
    this.centers = positions.map((position) => chunkOfWorld(position.x, position.z));
    const distanceTo = (kx: number, kz: number) => Math.min(...this.centers.map((center) => Math.max(Math.abs(kx - center.kx), Math.abs(kz - center.kz))));
    this.wanted.clear();
    for (const center of this.centers) {
      for (let dz = -LOAD_RADIUS; dz <= LOAD_RADIUS; dz++) {
        for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) this.wanted.add(chunkKey(center.kx + dx, center.kz + dz));
      }
    }
    this.reconcileManagedVehicles(positions);
    for (const chunk of [...this.chunks.values()]) if (distanceTo(chunk.kx, chunk.kz) > UNLOAD_RADIUS) this.unloadChunk(chunk);
    for (const [key, pending] of this.pending) {
      if (!this.wanted.has(key)) pending.controller.abort();
    }
    this.pumpLoads();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pending.values()) pending.controller.abort();
    this.pending.clear();
    for (const chunk of [...this.chunks.values()]) this.unloadChunk(chunk);
    for (const vehicle of [...this.managedVehicles.keys()]) this.game.removeVehicle(vehicle);
    this.managedVehicles.clear();
    this.roadNetwork.clear();
    setRoadNetwork(null);
    this.game.world.removeRigidBody(this.safetyBody);
  }

  private async loadManifest(): Promise<void> {
    if (this.manifest) return;
    const response = await fetch(`/maps/${this.mapName}.compiled.json`);
    if (!response.ok) throw new Error(`compiled map manifest failed to load (${response.status})`);
    this.manifest = validateCompiledManifest(await response.json());
    this.entries = new Map(this.manifest.chunks.map((chunk) => [chunkKey(chunk.kx, chunk.kz), chunk]));
    console.info(`[map] compiled ${this.manifest.mapId} build ${this.manifest.buildId} (${this.manifest.scope}, ${this.manifest.chunks.length} chunks)`);
  }

  private pumpLoads(): void {
    if (!this.manifest) return;
    const distanceTo = (entry: CompiledChunkManifest) => Math.min(...this.centers.map((center) => Math.max(Math.abs(entry.kx - center.kx), Math.abs(entry.kz - center.kz))));
    const candidates = [...this.wanted]
      .filter((key) => !this.chunks.has(key) && !this.pending.has(key))
      .map((key) => this.entries.get(key) ?? null)
      .sort((a, b) => {
        if (!a) return 1;
        if (!b) return -1;
        return distanceTo(a) - distanceTo(b) || a.kz - b.kz || a.kx - b.kx;
      });
    while (this.pending.size < MAX_CONCURRENT_LOADS && candidates.length > 0) {
      const entry = candidates.shift();
      if (!entry) {
        if (this.manifest.partial) return;
        const missing = [...this.wanted].find((key) => !this.entries.has(key));
        if (missing) this.reportFailure(new Error(`compiled map has no chunk ${missing}; scope=${this.manifest.scope}`));
        return;
      }
      const key = chunkKey(entry.kx, entry.kz);
      const controller = new AbortController();
      const promise = this.loadChunk(entry, controller.signal)
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === 'AbortError')) this.reportFailure(error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => {
          this.pending.delete(key);
          this.pumpLoads();
        });
      this.pending.set(key, { controller, promise });
    }
  }

  private async loadChunk(entry: CompiledChunkManifest, signal?: AbortSignal): Promise<void> {
    const key = chunkKey(entry.kx, entry.kz);
    if (this.chunks.has(key) || this.disposed) return;
    const started = performance.now();
    const [renderResponse, dataResponse] = await Promise.all([
      fetch(entry.renderUrl, { signal }),
      fetch(entry.dataUrl, { signal }),
    ]);
    if (!renderResponse.ok || !dataResponse.ok) throw new Error(`compiled chunk ${key} failed to load (${renderResponse.status}/${dataResponse.status})`);
    const [renderBuffer, dataBuffer] = await Promise.all([renderResponse.arrayBuffer(), dataResponse.arrayBuffer()]);
    if (renderBuffer.byteLength !== entry.renderBytes || dataBuffer.byteLength !== entry.dataBytes) throw new Error(`compiled chunk ${key} byte size mismatch`);
    const [renderHash, dataHash] = await Promise.all([hashBuffer(renderBuffer), hashBuffer(dataBuffer)]);
    if (renderHash !== entry.renderHash || dataHash !== entry.dataHash) throw new Error(`compiled chunk ${key} content hash mismatch`);
    const data = parseCompiledChunk(dataBuffer, entry.kx, entry.kz);
    const gltf = await this.loader.parseAsync(renderBuffer, '');
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (this.disposed || this.chunks.has(key)) {
      this.disposeObject(gltf.scene);
      return;
    }
    const body = this.createPhysics(data);
    const root = gltf.scene;
    this.game.scene.add(root);
    this.game.fx.registerSurfaceRoot(root);
    this.game.lighting.registerWetSurfaces(root);
    this.spawnVehicles(data);
    this.roadNetwork.registerChunk(key, data.navNodes, data.navEdges);
    this.chunks.set(key, { kx: entry.kx, kz: entry.kz, root, body, renderBytes: entry.renderBytes, dataBytes: entry.dataBytes });
    const elapsed = performance.now() - started;
    this.recentLoadMs.push(elapsed);
    if (this.recentLoadMs.length > 32) this.recentLoadMs.shift();
    console.info(`[map] chunk ${key}: ${Math.round(entry.renderBytes / 1024)} KiB GLB + ${Math.round(entry.dataBytes / 1024)} KiB data in ${elapsed.toFixed(1)} ms`);
  }

  private createPhysics(data: CompiledChunkData): RAPIER.RigidBody {
    const body = this.game.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const heights = Float32Array.from(data.heights, (height) => height * 0.1);
    const c0x = data.kx * CHUNK_TILES;
    const c0z = data.kz * CHUNK_TILES;
    const midpoint = (CHUNK_TILES - 1) / 2;
    this.game.world.createCollider(
      RAPIER.ColliderDesc.heightfield(CHUNK_TILES, CHUNK_TILES, heights, { x: CHUNK_SIZE, y: 1, z: CHUNK_SIZE }, RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES)
        .setTranslation((c0x + midpoint) * TILE, 0, (c0z + midpoint) * TILE),
      body
    );
    for (const collider of data.cuboids) {
      this.game.world.createCollider(
        RAPIER.ColliderDesc.cuboid(collider.hx, collider.hy, collider.hz)
          .setTranslation(collider.x, collider.y, collider.z)
          .setRotation({ x: 0, y: Math.sin(collider.rotation / 2), z: 0, w: Math.cos(collider.rotation / 2) }),
        body
      );
    }
    for (const mesh of data.meshes) this.game.world.createCollider(RAPIER.ColliderDesc.trimesh(mesh.vertices, mesh.indices), body);
    return body;
  }

  private spawnVehicles(data: CompiledChunkData): void {
    const owner = chunkKey(data.kx, data.kz);
    for (const spawn of data.parked) {
      if (!this.game.vehicleSpawnIsClear(spawn.x, spawn.z, spawn.rotation)) continue;
      const model = CIVILIAN_CARS[spawn.seed % CIVILIAN_CARS.length];
      const vehicle = new Vehicle(this.game, model, spawn.x, spawn.z, spawn.rotation);
      this.game.addVehicle(vehicle);
      this.managedVehicles.set(vehicle, owner);
    }
  }

  /** Called before a vehicle's Rapier body is freed by another subsystem. */
  forgetVehicle(vehicle: Vehicle): void {
    this.managedVehicles.delete(vehicle);
  }

  /** Transfer moved cars to their current chunk and retire abandoned cars once
   * both their chunk and every player are outside the streaming hysteresis. */
  private reconcileManagedVehicles(positions: { x: number; z: number }[]): void {
    for (const [vehicle] of [...this.managedVehicles]) {
      const position = vehicle.body.translation();
      const owner = chunkOfWorld(position.x, position.z);
      const key = chunkKey(owner.kx, owner.kz);
      this.managedVehicles.set(vehicle, key);
      const nearPlayer = positions.some((player) =>
        Math.hypot(player.x - position.x, player.z - position.z) <= UNLOAD_RADIUS * CHUNK_SIZE
      );
      if (!this.chunks.has(key) && vehicle.driver === null && !nearPlayer) this.game.removeVehicle(vehicle);
    }
  }

  private unloadChunk(chunk: LoadedChunk): void {
    const key = chunkKey(chunk.kx, chunk.kz);
    this.roadNetwork.unregisterChunk(key);
    this.game.lighting.unregisterWetSurfaces(chunk.root);
    this.game.fx.unregisterSurfaceRoot(chunk.root);
    this.game.scene.remove(chunk.root);
    this.disposeObject(chunk.root);
    this.game.world.removeRigidBody(chunk.body);
    for (const [vehicle, owner] of [...this.managedVehicles]) {
      if (owner === key && vehicle.driver === null) this.game.removeVehicle(vehicle);
    }
    this.chunks.delete(key);
  }

  private disposeObject(root: THREE.Object3D): void {
    const materials = new Set<THREE.Material>();
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
    });
    for (const material of materials) material.dispose();
  }

  private reportFailure(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    console.error('[map] compiled streaming failed', error);
    const diagnostic = document.createElement('div');
    diagnostic.dataset.compiledMapFailure = 'true';
    diagnostic.textContent = `Compiled Melbourne failed to load: ${error.message}`;
    Object.assign(diagnostic.style, {
      position: 'fixed', inset: '16px 16px auto 16px', zIndex: '10000', padding: '12px 16px',
      background: '#420b21', color: '#fff', border: '1px solid #ff5f9e', font: '14px monospace',
    });
    document.body.appendChild(diagnostic);
  }
}
