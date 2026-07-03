export interface HudState {
  speedKmh?: number;
  stars?: number;
  prompt?: string;
  message?: string;
}

/** DOM overlay HUD, one panel per viewport (left/right half in split screen). */
export class Hud {
  private panels: {
    root: HTMLDivElement;
    speed: HTMLDivElement;
    stars: HTMLDivElement;
    prompt: HTMLDivElement;
    message: HTMLDivElement;
  }[] = [];
  private hint: HTMLDivElement;

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
      .hud-prompt { position:absolute; left:50%; bottom:72px; transform:translateX(-50%);
        font-size:16px; background:rgba(20,8,40,.55); padding:6px 14px; border-radius:8px; }
      .hud-message { position:absolute; left:50%; top:18%; transform:translateX(-50%);
        font-size:30px; font-weight:800; letter-spacing:1px; }
      .hud-hint { position:absolute; left:50%; bottom:10px; transform:translateX(-50%);
        color:#fff; opacity:.55; font-size:12px; pointer-events:none; text-align:center; }
      .hud-pause { position:absolute; inset:0; background:rgba(12,4,28,.72); color:#fff;
        display:flex; flex-direction:column; align-items:center; justify-content:center;
        gap:.4em; pointer-events:none; }
      .hud-pause h1 { font-size:52px; margin:0 0 .3em; letter-spacing:2px;
        color:#ff5db1; text-shadow:0 0 18px rgba(255,60,180,.8); }
      .hud-pause p { margin:.1em; font-size:16px; opacity:.9; }
    `;
    document.head.appendChild(style);
    this.hint = document.createElement('div');
    this.hint.className = 'hud-hint';
    this.hint.textContent =
      'P1: WASD drive/walk · Space handbrake · E enter/exit · Shift sprint — P2: press Start on a gamepad to join';
    container.appendChild(this.hint);
  }

  setPlayerCount(n: 1 | 2): void {
    for (const p of this.panels) p.root.remove();
    this.panels = [];
    for (let i = 0; i < n; i++) {
      const root = document.createElement('div');
      root.className = 'hud-panel';
      root.style.left = n === 2 && i === 1 ? '50%' : '0';
      root.style.width = n === 2 ? '50%' : '100%';
      const speed = document.createElement('div');
      speed.className = 'hud-speed';
      const stars = document.createElement('div');
      stars.className = 'hud-stars';
      const prompt = document.createElement('div');
      prompt.className = 'hud-prompt';
      prompt.style.display = 'none';
      const message = document.createElement('div');
      message.className = 'hud-message';
      root.append(speed, stars, prompt, message);
      this.container.appendChild(root);
      this.panels.push({ root, speed, stars, prompt, message });
    }
    if (n === 2) this.hint.style.display = 'none';
  }

  private pauseEl: HTMLDivElement | null = null;

  setPaused(paused: boolean): void {
    if (paused && !this.pauseEl) {
      const el = document.createElement('div');
      el.className = 'hud-pause';
      el.innerHTML = `
        <h1>PAUSED</h1>
        <p><b>P1 — keyboard:</b> WASD drive/walk · Space handbrake · Shift sprint · E enter/exit car</p>
        <p><b>Gamepad:</b> left stick steer/walk · RT gas · LT brake · A handbrake/sprint · Y enter/exit</p>
        <p><b>P2:</b> press Start on a second gamepad to join split-screen</p>
        <p>Run over pedestrians or ram cars and the police will come for you…</p>
        <p style="margin-top:1em; opacity:.6">Esc / Start to resume</p>`;
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
    p.prompt.style.display = state.prompt ? 'block' : 'none';
    p.prompt.textContent = state.prompt ?? '';
    p.message.textContent = state.message ?? '';
  }
}
