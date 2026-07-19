import type { AuthoredMap } from '../world/CityMap';
import { Minimap } from './Minimap';

export interface HudState {
  speedKmh?: number;
  stars?: number;
  money?: number;
  prompt?: string;
  message?: string;
  pos?: { x: number; z: number };
  heading?: number;
  suburb?: string | null;
  cops?: { x: number; z: number }[];
}

/** DOM overlay HUD, one panel per viewport (left/right half in split screen). */
export class Hud {
  private panels: {
    root: HTMLDivElement;
    speed: HTMLDivElement;
    stars: HTMLDivElement;
    money: HTMLDivElement;
    prompt: HTMLDivElement;
    message: HTMLDivElement;
    minimap: Minimap | null;
  }[] = [];
  private hint: HTMLDivElement;
  private mapCanvas: HTMLCanvasElement | null = null;
  private map: AuthoredMap | null = null;

  constructor(private container: HTMLElement) {
    const style = document.createElement('style');
    style.textContent = `
      .hud-panel { position:absolute; top:0; height:100%; pointer-events:none; color:#fff;
        text-shadow: 0 0 6px rgba(255,60,180,.9), 0 2px 2px rgba(0,0,0,.5); }
      .hud-speed { position:absolute; right:18px; bottom:14px; font-size:26px; font-weight:700;
        font-variant-numeric: tabular-nums; }
      .hud-speed span { font-size:14px; font-weight:400; opacity:.8; }
      .hud-stars { position:absolute; right:18px; top:12px; font-size:24px; letter-spacing:3px;
        color:#ffd84d; text-shadow: 0 0 8px rgba(255,170,0,.9), 0 2px 2px rgba(0,0,0,.5); }
      .hud-stars .off { opacity:.22; }
      .hud-money { position:absolute; left:18px; top:12px; font-size:23px; font-weight:800;
        color:#74ffd1; font-variant-numeric:tabular-nums;
        text-shadow:0 0 9px rgba(30,255,188,.65), 0 2px 2px rgba(0,0,0,.7); }
      .hud-prompt { position:absolute; left:50%; bottom:72px; transform:translateX(-50%);
        font-size:16px; background:rgba(20,8,40,.55); padding:6px 14px; border-radius:8px; }
      .hud-message { position:absolute; left:50%; top:18%; transform:translateX(-50%);
        font-size:30px; font-weight:800; letter-spacing:1px; }
      .hud-minimap { position:absolute; left:14px; bottom:14px; width:166px; aspect-ratio:1; }
      .hud-minimap-canvas { width:100%; height:100%; border-radius:50%; box-sizing:border-box;
        border:2px solid rgba(94,243,255,.85); background:#151326;
        box-shadow:0 0 0 3px rgba(12,8,28,.72), 0 0 18px rgba(94,243,255,.32); }
      .hud-suburb { position:absolute; left:-18px; right:-18px; bottom:calc(100% + 8px);
        color:#fff; font-size:14px; font-weight:700; text-align:center; text-transform:uppercase;
        text-shadow:0 0 8px rgba(255,60,180,.95), 0 2px 3px rgba(0,0,0,.9); }
      .hud-hint { position:absolute; left:50%; bottom:10px; transform:translateX(-50%);
        color:#fff; opacity:.55; font-size:12px; pointer-events:none; text-align:center; }
      .hud-pause { position:absolute; inset:0; background:rgba(12,4,28,.72); color:#fff;
        display:flex; flex-direction:column; align-items:center; justify-content:center;
        gap:.4em; pointer-events:none; }
      .hud-pause h1 { font-size:52px; margin:0 0 .3em; letter-spacing:2px;
        color:#ff5db1; text-shadow:0 0 18px rgba(255,60,180,.8); }
      .hud-pause p { margin:.1em; font-size:16px; opacity:.9; }
      .hud-map { position:absolute; inset:0; display:none; overflow:hidden; color:#fff;
        background:rgba(12,4,28,.6); pointer-events:auto; cursor:grab; z-index:20; }
      .hud-map-open .hud-panel, .hud-map-open .hud-hint { visibility:hidden; }
      .hud-map.is-dragging { cursor:grabbing; }
      .hud-map-canvas { position:absolute; inset:0; width:100%; height:100%; }
      .hud-map-title { position:absolute; left:22px; top:16px; font-size:24px; font-weight:800;
        letter-spacing:0; color:#ff70b9; pointer-events:none;
        text-shadow:0 0 14px rgba(255,60,180,.8), 0 2px 3px rgba(0,0,0,.8); }
      .hud-map-footer { position:absolute; left:50%; bottom:15px; transform:translateX(-50%);
        max-width:calc(100% - 32px); color:#fff; font-size:12px; text-align:center;
        white-space:nowrap; opacity:.78; pointer-events:none; text-shadow:0 2px 3px #000; }
      @media (max-width:700px) {
        .hud-minimap { width:128px; }
        .hud-panel.is-split .hud-speed { bottom:146px; }
        .hud-hint { display:none; }
        .hud-map-title { font-size:19px; }
        .hud-map-footer { white-space:normal; }
      }
    `;
    document.head.appendChild(style);
    this.hint = document.createElement('div');
    this.hint.className = 'hud-hint';
    this.hint.textContent =
      'P1: WASD drive/walk · Space jump/handbrake · E enter/exit · Shift sprint · M map — P2: press Start on a gamepad to join';
    container.appendChild(this.hint);
  }

  setPlayerCount(n: 1 | 2): void {
    for (const p of this.panels) {
      p.minimap?.dispose();
      p.root.remove();
    }
    this.panels = [];
    for (let i = 0; i < n; i++) {
      const root = document.createElement('div');
      root.className = 'hud-panel';
      root.classList.toggle('is-split', n === 2);
      root.style.left = n === 2 && i === 1 ? '50%' : '0';
      root.style.width = n === 2 ? '50%' : '100%';
      const speed = document.createElement('div');
      speed.className = 'hud-speed';
      const stars = document.createElement('div');
      stars.className = 'hud-stars';
      const money = document.createElement('div');
      money.className = 'hud-money';
      const prompt = document.createElement('div');
      prompt.className = 'hud-prompt';
      prompt.style.display = 'none';
      const message = document.createElement('div');
      message.className = 'hud-message';
      root.append(speed, stars, money, prompt, message);
      this.container.appendChild(root);
      const minimap = this.mapCanvas && this.map ? new Minimap(root, this.mapCanvas, this.map) : null;
      this.panels.push({ root, speed, stars, money, prompt, message, minimap });
    }
    if (n === 2) this.hint.style.display = 'none';
  }

  setMapCanvas(canvas: HTMLCanvasElement, map: AuthoredMap): void {
    this.mapCanvas = canvas;
    this.map = map;
    for (const panel of this.panels) {
      panel.minimap?.dispose();
      panel.minimap = new Minimap(panel.root, canvas, map);
    }
  }

  private pauseEl: HTMLDivElement | null = null;

  setPaused(paused: boolean): void {
    if (paused && !this.pauseEl) {
      const el = document.createElement('div');
      el.className = 'hud-pause';
      el.innerHTML = `
        <h1>PAUSED</h1>
        <p><b>P1 — keyboard:</b> WASD drive/walk · Space jump/handbrake · Shift sprint · E enter/exit car</p>
        <p><b>Gamepad:</b> left stick steer/walk · RT gas · LT brake · A jump/handbrake/sprint · Y enter/exit</p>
        <p><b>P2:</b> press Start on a second gamepad to join split-screen</p>
        <p><b>Map:</b> M / Back opens the city map</p>
        <p>Run over pedestrians or ram cars and the police will come for you…</p>
        <p style="margin-top:1em; opacity:.6">Esc / Start to resume</p>
        <p style="margin-top:1.5em; opacity:.45; font-size:12px">Map data © OpenStreetMap contributors (ODbL)</p>`;
      this.container.appendChild(el);
      this.pauseEl = el;
    } else if (!paused && this.pauseEl) {
      this.pauseEl.remove();
      this.pauseEl = null;
    }
  }

  update(i: number, state: HudState): void {
    const p = this.panels[i];
    if (!p) return;
    p.speed.innerHTML =
      state.speedKmh !== undefined
        ? `${Math.round(state.speedKmh)} <span>km/h</span>`
        : '';
    if (state.stars !== undefined && state.stars > 0) {
      p.stars.innerHTML =
        '★'.repeat(state.stars) + `<span class="off">${'★'.repeat(3 - state.stars)}</span>`;
    } else {
      p.stars.innerHTML = '';
    }
    p.money.textContent = state.money !== undefined ? `$${Math.floor(state.money).toLocaleString()}` : '';
    p.prompt.style.display = state.prompt ? 'block' : 'none';
    p.prompt.textContent = state.prompt ?? '';
    p.message.textContent = state.message ?? '';
    if (p.minimap && state.pos && state.heading !== undefined) {
      p.minimap.update({
        x: state.pos.x,
        z: state.pos.z,
        heading: state.heading,
        suburb: state.suburb ?? null,
        cops: state.cops ?? [],
      });
    }
  }
}
