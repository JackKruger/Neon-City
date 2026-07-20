import type { AuthoredMap } from '../world/CityMap';
import type { InputMethod } from '../core/Input';
import { Settings } from '../core/Settings';
import { Minimap } from './Minimap';

export interface HudState {
  speedKmh?: number;
  stars?: number;
  wantedSearching?: boolean;
  money?: number;
  prompt?: string;
  message?: string;
  pos?: { x: number; z: number };
  heading?: number;
  suburb?: string | null;
  roadName?: string | null;
  speedLimitKmh?: number;
  cops?: { x: number; z: number }[];
  /** 0..1 fractions; bars hide when undefined. */
  health?: number;
  armour?: number;
  weapon?: string;
  ammoMag?: number;
  ammoReserve?: number;
  vehicleHealth?: number;
}

/** DOM overlay HUD. */
export class Hud {
  private panels: {
    root: HTMLDivElement;
    speed: HTMLDivElement;
    stars: HTMLDivElement;
    money: HTMLDivElement;
    prompt: HTMLDivElement;
    message: HTMLDivElement;
    weapon: HTMLDivElement;
    vitals: HTMLDivElement;
    healthBar: HTMLElement;
    armourBar: HTMLElement;
    minimap: Minimap | null;
  }[] = [];
  private hint: HTMLDivElement;
  private mapCanvas: HTMLCanvasElement | null = null;
  private map: AuthoredMap | null = null;
  private inputMethods: InputMethod[] = ['keyboard'];
  private caption: HTMLDivElement;
  private captionTimer = 0;

  constructor(private container: HTMLElement, private settings: Settings) {
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
      .hud-stars .status { display:block; margin-top:2px; font-size:10px; letter-spacing:1px;
        color:#fff; text-align:right; opacity:.9; }
      .hud-money { position:absolute; left:18px; top:12px; font-size:23px; font-weight:800;
        color:#74ffd1; font-variant-numeric:tabular-nums;
        text-shadow:0 0 9px rgba(30,255,188,.65), 0 2px 2px rgba(0,0,0,.7); }
      .hud-prompt { position:absolute; left:50%; bottom:72px; transform:translateX(-50%);
        font-size:16px; background:rgba(20,8,40,.55); padding:6px 14px; border-radius:8px; }
      .hud-message { position:absolute; left:50%; top:18%; transform:translateX(-50%);
        font-size:30px; font-weight:800; letter-spacing:1px; }
      .hud-minimap { position:absolute; left:14px; bottom:14px; width:238px; aspect-ratio:1; }
      .hud-panel.is-split .hud-minimap { width:min(210px, calc(100% - 28px)); }
      .hud-minimap-canvas { width:100%; height:100%; border-radius:12px; box-sizing:border-box;
        border:2px solid rgba(94,243,255,.85); background:#151326;
        box-shadow:0 0 0 3px rgba(12,8,28,.72), 0 0 18px rgba(94,243,255,.32); }
      .hud-north { position:absolute; top:9px; right:9px; width:34px; height:42px;
        display:flex; flex-direction:column; align-items:center; justify-content:center;
        border-radius:8px; color:#fff; background:rgba(9,8,24,.78); border:1px solid rgba(255,255,255,.32);
        box-shadow:0 2px 8px rgba(0,0,0,.5); font:800 11px/1 sans-serif; }
      .hud-north-arrow { display:block; color:#ff5db1; font-size:21px; line-height:18px;
        transform-origin:50% 55%; text-shadow:0 0 7px rgba(255,60,180,.9); }
      .hud-road-info { position:absolute; left:9px; right:9px; bottom:9px; display:flex;
        align-items:center; gap:8px; min-width:0; }
      .hud-road-name { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        padding:7px 9px; border-radius:7px; background:rgba(9,8,24,.82); border:1px solid rgba(255,255,255,.2);
        font-size:13px; font-weight:800; text-transform:uppercase; }
      .hud-road-limit { flex:0 0 39px; width:39px; height:39px; display:flex; align-items:center;
        justify-content:center; box-sizing:border-box; border-radius:50%; border:3px solid #f0445f;
        color:#151326; background:#fff; font-size:16px; font-weight:900; line-height:1;
        text-shadow:none; box-shadow:0 2px 8px rgba(0,0,0,.55); font-variant-numeric:tabular-nums; }
      .hud-weapon { position:absolute; right:18px; bottom:52px; font-size:15px; font-weight:700;
        text-align:right; color:#cfe6ff; font-variant-numeric:tabular-nums;
        text-shadow:0 0 8px rgba(94,163,255,.8), 0 2px 2px rgba(0,0,0,.6); }
      .hud-weapon .ammo { display:block; font-size:13px; opacity:.85; }
      .hud-vitals { position:absolute; right:18px; top:50px; display:flex; flex-direction:column;
        gap:5px; align-items:flex-end; }
      .hud-bar { width:130px; height:9px; border-radius:5px; background:rgba(10,6,24,.66);
        box-shadow:0 0 0 1px rgba(255,255,255,.2), 0 0 8px rgba(0,0,0,.35); overflow:hidden; }
      .hud-bar i { display:block; height:100%; border-radius:5px; transition:width .15s; }
      .hud-bar.health i { background:#5eff8a; box-shadow:0 0 9px rgba(94,255,138,.85); }
      .hud-bar.armour i { background:#5ef3ff; box-shadow:0 0 9px rgba(94,243,255,.85); }
      .hud-suburb { position:absolute; left:-18px; right:-18px; bottom:calc(100% + 8px);
        color:#fff; font-size:14px; font-weight:700; text-align:center; text-transform:uppercase;
        text-shadow:0 0 8px rgba(255,60,180,.95), 0 2px 3px rgba(0,0,0,.9); }
      .hud-hint { position:absolute; left:50%; bottom:10px; transform:translateX(-50%);
        color:#fff; opacity:.55; font-size:12px; pointer-events:none; text-align:center; }
      .hud-caption { position:absolute; left:50%; bottom:42px; transform:translateX(-50%);
        min-width:120px; padding:5px 10px; border-radius:6px; color:#fff; background:rgba(8,5,20,.76);
        font-size:14px; text-align:center; pointer-events:none; z-index:15; }
      .hud-pause { position:absolute; inset:0; background:rgba(12,4,28,.72); color:#fff;
        display:flex; flex-direction:column; align-items:center; justify-content:center;
        gap:.4em; pointer-events:auto; overflow:auto; padding:20px; box-sizing:border-box; z-index:30; }
      .hud-pause h1 { font-size:clamp(34px,7vw,52px); margin:0 0 .3em; letter-spacing:2px;
        color:#ff5db1; text-shadow:0 0 18px rgba(255,60,180,.8); }
      .hud-pause p { margin:.1em; font-size:16px; opacity:.9; }
      .hud-settings { display:grid; grid-template-columns:auto minmax(130px,220px); gap:8px 14px;
        align-items:center; margin:14px 0 8px; padding:13px 16px; border-radius:10px;
        background:rgba(28,14,53,.78); border:1px solid rgba(94,243,255,.26); }
      .hud-settings h2 { grid-column:1/-1; margin:0 0 3px; font-size:16px; color:#74ffd1; }
      .hud-settings label { font-size:13px; opacity:.9; }
      .hud-settings input[type="range"] { accent-color:#ff5db1; }
      .hud-settings input[type="checkbox"] { justify-self:start; width:17px; height:17px; accent-color:#5ef3ff; }
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
        .hud-minimap, .hud-panel.is-split .hud-minimap { width:176px; }
        .hud-panel.is-split .hud-speed { bottom:194px; }
        .hud-panel.is-split .hud-weapon { bottom:232px; }
        .hud-hint { display:none; }
        .hud-map-title { font-size:19px; }
        .hud-map-footer { white-space:normal; }
        .hud-pause { justify-content:flex-start; }
        .hud-pause p { font-size:13px; text-align:center; }
      }
    `;
    document.head.appendChild(style);
    this.hint = document.createElement('div');
    this.hint.className = 'hud-hint';
    this.updateHint();
    container.appendChild(this.hint);
    this.caption = document.createElement('div');
    this.caption.className = 'hud-caption';
    this.caption.setAttribute('aria-live', 'polite');
    this.caption.style.display = 'none';
    container.appendChild(this.caption);
  }

  showCaption(text: string): void {
    if (!this.settings.values.subtitles) return;
    this.caption.textContent = `[${text}]`;
    this.caption.style.display = 'block';
    window.clearTimeout(this.captionTimer);
    this.captionTimer = window.setTimeout(() => {
      this.caption.style.display = 'none';
    }, 1200);
  }

  setInputMethods(methods: InputMethod[]): void {
    if (methods.length === this.inputMethods.length && methods.every((method, i) => method === this.inputMethods[i])) {
      return;
    }
    this.inputMethods = [...methods];
    this.updateHint();
  }

  private updateHint(): void {
    this.hint.textContent = this.inputMethods[0] === 'gamepad'
      ? 'Left stick move · Right stick camera · R3 recenter · RT attack · Y enter · Back map'
      : 'WASD move · Mouse camera · V recenter · LMB attack · E enter · M map · click game to capture mouse';
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
      const weapon = document.createElement('div');
      weapon.className = 'hud-weapon';
      const vitals = document.createElement('div');
      vitals.className = 'hud-vitals';
      vitals.style.display = 'none';
      const mkBar = (cls: string) => {
        const bar = document.createElement('div');
        bar.className = `hud-bar ${cls}`;
        const fill = document.createElement('i');
        bar.appendChild(fill);
        vitals.appendChild(bar);
        return fill;
      };
      const healthBar = mkBar('health');
      const armourBar = mkBar('armour');
      root.append(speed, stars, money, prompt, message, weapon, vitals);
      this.container.appendChild(root);
      const minimap = this.mapCanvas && this.map ? new Minimap(root, this.mapCanvas, this.map) : null;
      this.panels.push({
        root,
        speed,
        stars,
        money,
        prompt,
        message,
        weapon,
        vitals,
        healthBar,
        armourBar,
        minimap,
      });
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
        <p><b>Keyboard:</b> WASD drive/walk/fly · mouse orbit · V recenter · Space jump/handbrake/ascend · Shift sprint/descend · E enter/exit</p>
        <p><b>Combat:</b> LMB / F attack · RMB aim · Q / C (Tab) switch weapon · R reload</p>
        <p><b>Gamepad:</b> left stick steer/walk · right stick orbit · R3 recenter · RT gas/fire · LT brake/aim · A jump/ascend · B descend · Y enter/exit · LB/RB weapon · X reload</p>
        <p><b>Map:</b> M / Back opens the city map</p>
        <div class="hud-settings">
          <h2>CAMERA &amp; ACCESSIBILITY</h2>
          <label for="hud-camera-sensitivity">Camera sensitivity</label><input id="hud-camera-sensitivity" type="range" min="0.25" max="2" step="0.05">
          <label for="hud-invert-camera">Invert vertical camera</label><input id="hud-invert-camera" type="checkbox">
          <label for="hud-reduced-motion">Reduced camera motion</label><input id="hud-reduced-motion" type="checkbox">
          <label for="hud-aim-assist">Aim assistance</label><input id="hud-aim-assist" type="checkbox">
          <label for="hud-subtitles">Subtitles</label><input id="hud-subtitles" type="checkbox">
        </div>
        <p style="margin-top:1em; opacity:.6">Esc / Start to resume</p>
        <p style="margin-top:1.5em; opacity:.45; font-size:12px">Map data © OpenStreetMap contributors (ODbL)</p>`;
      const values = this.settings.values;
      const sensitivity = el.querySelector<HTMLInputElement>('#hud-camera-sensitivity')!;
      const invert = el.querySelector<HTMLInputElement>('#hud-invert-camera')!;
      const reduced = el.querySelector<HTMLInputElement>('#hud-reduced-motion')!;
      const aimAssist = el.querySelector<HTMLInputElement>('#hud-aim-assist')!;
      const subtitles = el.querySelector<HTMLInputElement>('#hud-subtitles')!;
      sensitivity.value = String(values.cameraSensitivity);
      invert.checked = values.invertCameraY;
      reduced.checked = values.reducedMotion;
      aimAssist.checked = values.aimAssist;
      subtitles.checked = values.subtitles;
      sensitivity.addEventListener('input', () => this.settings.set('cameraSensitivity', Number(sensitivity.value)));
      invert.addEventListener('change', () => this.settings.set('invertCameraY', invert.checked));
      reduced.addEventListener('change', () => this.settings.set('reducedMotion', reduced.checked));
      aimAssist.addEventListener('change', () => this.settings.set('aimAssist', aimAssist.checked));
      subtitles.addEventListener('change', () => this.settings.set('subtitles', subtitles.checked));
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
        '★'.repeat(state.stars) + `<span class="off">${'★'.repeat(3 - state.stars)}</span>` +
        (state.wantedSearching ? '<span class="status">SEARCHING</span>' : '<span class="status">PURSUIT</span>');
    } else {
      p.stars.innerHTML = '';
    }
    p.money.textContent = state.money !== undefined ? `$${Math.floor(state.money).toLocaleString()}` : '';
    p.prompt.style.display = state.prompt ? 'block' : 'none';
    p.prompt.textContent = state.prompt ?? '';
    p.message.textContent = state.message ?? '';
    if (state.vehicleHealth !== undefined) {
      const condition = Math.round(Math.max(0, Math.min(1, state.vehicleHealth)) * 100);
      p.weapon.innerHTML = `VEHICLE <span class="ammo">${condition}% condition</span>`;
    } else if (state.weapon) {
      const ammo =
        state.ammoMag !== undefined ? `<span class="ammo">${state.ammoMag} / ${state.ammoReserve ?? 0}</span>` : '';
      p.weapon.innerHTML = `${state.weapon}${ammo}`;
    } else {
      p.weapon.innerHTML = '';
    }
    if (state.health !== undefined) {
      p.vitals.style.display = 'flex';
      p.healthBar.style.width = `${Math.round(Math.max(0, Math.min(1, state.health)) * 100)}%`;
      const armour = Math.max(0, Math.min(1, state.armour ?? 0));
      p.armourBar.style.width = `${Math.round(armour * 100)}%`;
      (p.armourBar.parentElement as HTMLElement).style.display = armour > 0 ? 'block' : 'none';
    } else {
      p.vitals.style.display = 'none';
    }
    if (p.minimap && state.pos && state.heading !== undefined) {
      p.minimap.update({
        x: state.pos.x,
        z: state.pos.z,
        heading: state.heading,
        suburb: state.suburb ?? null,
        roadName: state.roadName ?? null,
        speedLimitKmh: state.speedLimitKmh,
        cops: state.cops ?? [],
      });
    }
  }
}
