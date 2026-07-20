import type { WeatherKind } from '../world/WorldLighting';

export interface CheatMenuState {
  time: number;
  timeLocked: boolean;
  weather: WeatherKind;
  weatherLock: WeatherKind | null;
  invincible: boolean;
  wantedLock: 0 | 1 | 2 | 3 | null;
  hasRepairableVehicle: boolean;
}

export interface CheatMenuActions {
  inspect(): CheatMenuState;
  setTime(time: number): void;
  setTimeLocked(locked: boolean): void;
  setWeatherLock(weather: WeatherKind | null): void;
  setInvincible(enabled: boolean): void;
  setWantedLock(stars: 0 | 1 | 2 | 3 | null): void;
  restoreVitals(): void;
  giveArsenal(): void;
  repairVehicle(): void;
  setOpen(open: boolean): void;
}

/** Developer-only test controls. F4 toggles the panel. */
export class CheatMenu {
  private events = new AbortController();
  private style = document.createElement('style');
  private root = document.createElement('section');
  private time: HTMLInputElement;
  private timeValue: HTMLOutputElement;
  private timeLock: HTMLInputElement;
  private weather: HTMLSelectElement;
  private weatherNow: HTMLSpanElement;
  private invincible: HTMLInputElement;
  private wanted: HTMLSelectElement;
  private repairButton: HTMLButtonElement;
  private status: HTMLDivElement;
  private open = false;

  constructor(container: HTMLElement, private actions: CheatMenuActions) {
    this.style.textContent = `
      .cheat-menu { position:absolute; top:14px; right:14px; z-index:130; width:min(340px,calc(100% - 28px));
        max-height:calc(100% - 28px); overflow:auto; box-sizing:border-box; padding:14px;
        color:#eefcff; background:rgba(8,7,24,.96); border:1px solid rgba(94,243,255,.72);
        border-radius:10px; box-shadow:0 0 24px rgba(27,222,255,.24); font:13px/1.35 sans-serif; }
      .cheat-menu[hidden] { display:none; }
      .cheat-menu header { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:12px; }
      .cheat-menu h2 { margin:0; color:#ff70b9; font-size:19px; letter-spacing:.06em;
        text-shadow:0 0 10px rgba(255,60,180,.65); }
      .cheat-menu .cheat-key { color:#9af7ff; font:11px ui-monospace,monospace; opacity:.78; }
      .cheat-menu-grid { display:grid; grid-template-columns:minmax(92px,auto) minmax(0,1fr); gap:9px 12px;
        align-items:center; padding:11px; border-radius:8px; background:rgba(35,20,62,.72); }
      .cheat-menu label { color:#dce8ef; }
      .cheat-menu input[type="range"] { width:100%; accent-color:#ff5db1; }
      .cheat-menu input[type="checkbox"] { width:18px; height:18px; margin:0; accent-color:#5ef3ff; }
      .cheat-time-control { display:grid; grid-template-columns:minmax(0,1fr) 44px; align-items:center; gap:7px; }
      .cheat-time-control output { color:#74ffd1; font:12px ui-monospace,monospace; text-align:right; }
      .cheat-menu select, .cheat-menu button { min-height:32px; box-sizing:border-box; border:1px solid rgba(94,243,255,.62);
        border-radius:6px; color:#fff; background:#21153d; font:700 12px sans-serif; }
      .cheat-menu select { width:100%; padding:5px 7px; }
      .cheat-menu button { padding:7px 10px; cursor:pointer; }
      .cheat-menu button:hover, .cheat-menu button:focus-visible, .cheat-menu select:focus-visible {
        outline:none; border-color:#ff70b9; box-shadow:0 0 10px rgba(255,93,177,.4); }
      .cheat-actions { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:10px; }
      .cheat-actions button:last-child { grid-column:1/-1; }
      .cheat-status { min-height:18px; margin-top:8px; color:#74ffd1; font-size:12px; text-align:center; }
      .cheat-weather-now { display:block; color:#aabac5; font-size:10px; margin-top:2px; text-transform:uppercase; }
    `;
    document.head.appendChild(this.style);
    this.root.className = 'cheat-menu';
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Developer cheat menu');
    this.root.innerHTML = `
      <header><h2>TEST LAB</h2><span class="cheat-key">F4 close</span></header>
      <div class="cheat-menu-grid">
        <label for="cheat-time">Time of day</label>
        <div class="cheat-time-control"><input id="cheat-time" type="range" min="0" max="23.75" step="0.25"><output></output></div>
        <label for="cheat-time-lock">Lock time</label><input id="cheat-time-lock" type="checkbox">
        <label for="cheat-weather">Weather</label>
        <div><select id="cheat-weather">
          <option value="cycle">Natural cycle</option><option value="clear">Clear</option>
          <option value="rain">Rain</option><option value="fog">Fog</option><option value="storm">Storm</option>
        </select><span class="cheat-weather-now"></span></div>
        <label for="cheat-invincible">Invincible</label><input id="cheat-invincible" type="checkbox">
        <label for="cheat-wanted">Wanted level</label><select id="cheat-wanted">
          <option value="normal">Normal</option><option value="0">Lock: none</option>
          <option value="1">Lock: 1 star</option><option value="2">Lock: 2 stars</option><option value="3">Lock: 3 stars</option>
        </select>
      </div>
      <div class="cheat-actions">
        <button type="button" data-action="vitals">Full health + armour</button>
        <button type="button" data-action="arsenal">Give arsenal</button>
        <button type="button" data-action="repair">Repair current vehicle</button>
      </div>
      <div class="cheat-status" role="status" aria-live="polite"></div>`;
    container.appendChild(this.root);

    this.time = this.root.querySelector<HTMLInputElement>('#cheat-time')!;
    this.timeValue = this.root.querySelector<HTMLOutputElement>('output')!;
    this.timeLock = this.root.querySelector<HTMLInputElement>('#cheat-time-lock')!;
    this.weather = this.root.querySelector<HTMLSelectElement>('#cheat-weather')!;
    this.weatherNow = this.root.querySelector<HTMLSpanElement>('.cheat-weather-now')!;
    this.invincible = this.root.querySelector<HTMLInputElement>('#cheat-invincible')!;
    this.wanted = this.root.querySelector<HTMLSelectElement>('#cheat-wanted')!;
    this.repairButton = this.root.querySelector<HTMLButtonElement>('[data-action="repair"]')!;
    this.status = this.root.querySelector<HTMLDivElement>('.cheat-status')!;

    this.time.addEventListener('input', () => {
      const value = Number(this.time.value);
      this.actions.setTime(value);
      this.timeValue.value = this.formatTime(value);
    });
    this.timeLock.addEventListener('change', () => this.actions.setTimeLocked(this.timeLock.checked));
    this.weather.addEventListener('change', () => {
      const value = this.weather.value;
      this.actions.setWeatherLock(value === 'cycle' ? null : value as WeatherKind);
      this.sync();
    });
    this.invincible.addEventListener('change', () => this.actions.setInvincible(this.invincible.checked));
    this.wanted.addEventListener('change', () => {
      const value = this.wanted.value;
      this.actions.setWantedLock(value === 'normal' ? null : Number(value) as 0 | 1 | 2 | 3);
    });
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-action]')) {
      button.addEventListener('click', () => {
        const action = button.dataset.action;
        if (action === 'vitals') this.actions.restoreVitals();
        else if (action === 'arsenal') this.actions.giveArsenal();
        else this.actions.repairVehicle();
        this.status.textContent = action === 'vitals' ? 'Vitals restored.'
          : action === 'arsenal' ? 'Arsenal granted.' : 'Vehicle repaired.';
        this.sync();
      });
    }
    window.addEventListener('keydown', (event) => {
      if (event.code !== 'F4' || event.repeat) return;
      event.preventDefault();
      this.setOpen(!this.open);
    }, { signal: this.events.signal });
  }

  get isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.root.hidden = !open;
    this.status.textContent = '';
    if (open) {
      this.sync();
      this.time.focus();
    }
    this.actions.setOpen(open);
  }

  dispose(): void {
    this.events.abort();
    this.root.remove();
    this.style.remove();
  }

  private sync(): void {
    const state = this.actions.inspect();
    this.time.value = String(state.time);
    this.timeValue.value = this.formatTime(state.time);
    this.timeLock.checked = state.timeLocked;
    this.weather.value = state.weatherLock ?? 'cycle';
    this.weatherNow.textContent = state.weatherLock ? 'locked' : `now: ${state.weather}`;
    this.invincible.checked = state.invincible;
    this.wanted.value = state.wantedLock === null ? 'normal' : String(state.wantedLock);
    this.repairButton.disabled = !state.hasRepairableVehicle;
  }

  private formatTime(time: number): string {
    const totalMinutes = Math.round(time * 60) % (24 * 60);
    const hours = Math.floor(totalMinutes / 60).toString().padStart(2, '0');
    const minutes = (totalMinutes % 60).toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  }
}
