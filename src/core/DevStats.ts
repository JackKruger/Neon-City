import type { WebGLRenderer } from 'three';
import type { CityStreamStats } from '../world/CityStreamer';

const SAMPLE_COUNT = 360;
const REFRESH_MS = 250;

class RollingMetric {
  private values = new Float64Array(SAMPLE_COUNT);
  private cursor = 0;
  private count = 0;

  add(value: number): void {
    this.values[this.cursor] = Number.isFinite(value) ? value : 0;
    this.cursor = (this.cursor + 1) % SAMPLE_COUNT;
    this.count = Math.min(this.count + 1, SAMPLE_COUNT);
  }

  summary(): { average: number; p50: number; p95: number; p99: number; max: number } {
    if (this.count === 0) return { average: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    const sorted = Array.from(this.values.slice(0, this.count)).sort((a, b) => a - b);
    const percentile = (amount: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * amount))];
    return {
      average: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: sorted[sorted.length - 1],
    };
  }
}

export interface FrameTiming {
  frameMs: number;
  cpuMs: number;
  simulationMs: number;
  npcMs: number;
  actorMs: number;
  physicsMs: number;
  postPhysicsMs: number;
  streamingMs: number;
  renderMs: number;
  fixedSteps: number;
}

export interface WorldStats {
  stream: CityStreamStats;
  pedestrians: number;
  traffic: number;
  vehicles: number;
  police: number;
  pickups: number;
  dynamicLights: number;
  weather: string;
  bodies: number;
  colliders: number;
}

export interface DevStatsSnapshot {
  frame: ReturnType<RollingMetric['summary']>;
  cpu: ReturnType<RollingMetric['summary']>;
  simulation: ReturnType<RollingMetric['summary']>;
  npc: ReturnType<RollingMetric['summary']>;
  actor: ReturnType<RollingMetric['summary']>;
  physics: ReturnType<RollingMetric['summary']>;
  postPhysics: ReturnType<RollingMetric['summary']>;
  streaming: ReturnType<RollingMetric['summary']>;
  render: ReturnType<RollingMetric['summary']>;
  fixedSteps: ReturnType<RollingMetric['summary']>;
  longFrames: number;
  renderer: {
    calls: number;
    triangles: number;
    geometries: number;
    textures: number;
  };
  world: WorldStats | null;
}

/** Low-overhead rolling performance display. F3 toggles it; dev builds start open. */
export class DevStats {
  private events = new AbortController();
  private root: HTMLPreElement;
  private frame = new RollingMetric();
  private cpu = new RollingMetric();
  private simulation = new RollingMetric();
  private npc = new RollingMetric();
  private actor = new RollingMetric();
  private physics = new RollingMetric();
  private postPhysics = new RollingMetric();
  private streaming = new RollingMetric();
  private render = new RollingMetric();
  private fixedSteps = new RollingMetric();
  private lastRefresh = 0;
  private longFrames = 0;
  private world: WorldStats | null = null;
  private visible: boolean;

  constructor(container: HTMLElement, private renderer: WebGLRenderer) {
    const params = new URLSearchParams(location.search);
    this.visible = params.get('dev') !== '0' && (import.meta.env.DEV || params.has('dev'));
    this.root = document.createElement('pre');
    this.root.dataset.devStats = 'true';
    Object.assign(this.root.style, {
      position: 'absolute',
      left: '12px',
      top: '48px',
      zIndex: '100',
      margin: '0',
      minWidth: '330px',
      padding: '10px 12px',
      border: '1px solid rgba(94,243,255,.55)',
      borderRadius: '7px',
      color: '#dffcff',
      background: 'rgba(5,8,18,.82)',
      boxShadow: '0 0 18px rgba(18,220,255,.18)',
      font: '12px/1.42 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontVariantNumeric: 'tabular-nums',
      pointerEvents: 'none',
      whiteSpace: 'pre',
    });
    this.root.style.display = this.visible ? 'block' : 'none';
    container.appendChild(this.root);
    window.addEventListener('keydown', (event) => {
      if (event.code !== 'F3') return;
      event.preventDefault();
      this.visible = !this.visible;
      this.root.style.display = this.visible ? 'block' : 'none';
      if (this.visible) this.refresh(performance.now());
    }, { signal: this.events.signal });
  }

  dispose(): void {
    this.events.abort();
    this.root.remove();
  }

  record(timing: FrameTiming, world: WorldStats): void {
    this.frame.add(timing.frameMs);
    this.cpu.add(timing.cpuMs);
    this.simulation.add(timing.simulationMs);
    this.npc.add(timing.npcMs);
    this.actor.add(timing.actorMs);
    this.physics.add(timing.physicsMs);
    this.postPhysics.add(timing.postPhysicsMs);
    this.streaming.add(timing.streamingMs);
    this.render.add(timing.renderMs);
    this.fixedSteps.add(timing.fixedSteps);
    if (timing.frameMs > 50) this.longFrames++;
    this.world = world;
    const now = performance.now();
    if (this.visible && now - this.lastRefresh >= REFRESH_MS) this.refresh(now);
  }

  snapshot(): DevStatsSnapshot {
    const info = this.renderer.info;
    return {
      frame: this.frame.summary(),
      cpu: this.cpu.summary(),
      simulation: this.simulation.summary(),
      npc: this.npc.summary(),
      actor: this.actor.summary(),
      physics: this.physics.summary(),
      postPhysics: this.postPhysics.summary(),
      streaming: this.streaming.summary(),
      render: this.render.summary(),
      fixedSteps: this.fixedSteps.summary(),
      longFrames: this.longFrames,
      renderer: {
        calls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
      },
      world: this.world,
    };
  }

  private refresh(now: number): void {
    this.lastRefresh = now;
    const snapshot = this.snapshot();
    const frame = snapshot.frame;
    const stream = snapshot.world?.stream;
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    const fps = frame.average > 0 ? 1000 / frame.average : 0;
    const fmt = (value: number) => value.toFixed(1).padStart(5);
    const count = (value: number) => Math.round(value).toLocaleString('en-AU');
    const lines = [
      `NEON BAY DEV  F3 hide`,
      `FPS ${fmt(fps)}   frame p50 ${fmt(frame.p50)}  p95 ${fmt(frame.p95)}  p99 ${fmt(frame.p99)} ms`,
      `CPU ${fmt(snapshot.cpu.p95)}   sim ${fmt(snapshot.simulation.p95)}  physics ${fmt(snapshot.physics.p95)} ms p95`,
      `sim p95  NPC ${fmt(snapshot.npc.p95)}  actors ${fmt(snapshot.actor.p95)}  post ${fmt(snapshot.postPhysics.p95)} ms`,
      `stream ${fmt(snapshot.streaming.p95)}   render submit ${fmt(snapshot.render.p95)} ms p95`,
      `fixed steps avg ${snapshot.fixedSteps.average.toFixed(2)}  max ${snapshot.fixedSteps.max.toFixed(0)}   >50ms frames ${snapshot.longFrames}`,
      `draw calls ${count(snapshot.renderer.calls)}   triangles ${count(snapshot.renderer.triangles)}`,
      `GPU resources  geometries ${count(snapshot.renderer.geometries)}  textures ${count(snapshot.renderer.textures)}`,
    ];
    if (snapshot.world && stream) {
      lines.push(
        `chunks ${stream.loadedChunks}/${stream.wantedChunks}  pending ${stream.pendingChunks}  missing ${stream.missingChunks}  ${(stream.loadedBytes / 1048576).toFixed(1)} MiB`,
        `chunk load last ${fmt(stream.lastLoadMs)}  avg ${fmt(stream.averageLoadMs)} ms  ${stream.scope}${stream.partial ? ' PARTIAL' : ''}`,
        `actors peds ${snapshot.world.pedestrians}  traffic ${snapshot.world.traffic}  vehicles ${snapshot.world.vehicles}  police ${snapshot.world.police}`,
        `physics bodies ${snapshot.world.bodies}  colliders ${snapshot.world.colliders}   lights ${snapshot.world.dynamicLights}`,
        `weather ${snapshot.world.weather}  pickups ${snapshot.world.pickups}${heap ? `  JS heap ${(heap / 1048576).toFixed(1)} MiB` : ''}`
      );
    }
    this.root.textContent = lines.join('\n');
    const severity = frame.p95 > 33.3 ? '#ff587d' : frame.p95 > 18 ? '#ffd166' : '#5effb1';
    this.root.style.borderColor = severity;
  }
}
