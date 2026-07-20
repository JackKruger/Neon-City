/**
 * Procedural audio: engine hum, tire skid, and police siren via Web Audio.
 * No samples needed; everything is oscillators and filtered noise.
 */
export class AudioSys {
  private events = new AbortController();
  onCaption: ((text: string) => void) | null = null;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private engineOsc: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private skidGain: GainNode | null = null;
  private sirenGain: GainNode | null = null;
  private sirenOsc: OscillatorNode | null = null;
  private ambienceGain: GainNode | null = null;
  private rainGain: GainNode | null = null;
  private nightGain: GainNode | null = null;
  private sirenTime = 0;
  private footstepTime = 0;
  private raining = false;

  constructor() {
    const unlock = () => {
      if (!this.ctx) this.init();
      this.ctx?.resume();
    };
    window.addEventListener('keydown', unlock, { signal: this.events.signal });
    window.addEventListener('pointerdown', unlock, { signal: this.events.signal });
  }

  dispose(): void {
    this.events.abort();
    this.onCaption = null;
    if (this.ctx) void this.ctx.close();
    this.ctx = null;
    this.master = null;
  }

  private init(): void {
    const ctx = new AudioContext();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    this.master = master;

    // Engine: saw through a lowpass.
    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 50;
    const engineFilter = ctx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 300;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineOsc.connect(engineFilter).connect(this.engineGain).connect(master);
    this.engineOsc.start();

    // Skid: looped noise through a bandpass. The buffer is shared with
    // one-shot effects (gunshots, impacts).
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = noiseBuf;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    noise.loop = true;
    const skidFilter = ctx.createBiquadFilter();
    skidFilter.type = 'bandpass';
    skidFilter.frequency.value = 900;
    skidFilter.Q.value = 1.2;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    noise.connect(skidFilter).connect(this.skidGain).connect(master);
    noise.start();

    // A second pair of shared noise loops supplies distant city wash and rain.
    const ambience = ctx.createBufferSource();
    ambience.buffer = noiseBuf;
    ambience.loop = true;
    const ambienceFilter = ctx.createBiquadFilter();
    ambienceFilter.type = 'lowpass';
    ambienceFilter.frequency.value = 360;
    this.ambienceGain = ctx.createGain();
    this.ambienceGain.gain.value = 0.012;
    ambience.connect(ambienceFilter).connect(this.ambienceGain).connect(master);
    ambience.start();

    const rain = ctx.createBufferSource();
    rain.buffer = noiseBuf;
    rain.loop = true;
    const rainFilter = ctx.createBiquadFilter();
    rainFilter.type = 'highpass';
    rainFilter.frequency.value = 2200;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    rain.connect(rainFilter).connect(this.rainGain).connect(master);
    rain.start();

    const night = ctx.createOscillator();
    night.type = 'sine';
    night.frequency.value = 3650;
    this.nightGain = ctx.createGain();
    this.nightGain.gain.value = 0;
    night.connect(this.nightGain).connect(master);
    night.start();

    // Siren: two-tone triangle.
    this.sirenOsc = ctx.createOscillator();
    this.sirenOsc.type = 'triangle';
    this.sirenOsc.frequency.value = 550;
    this.sirenGain = ctx.createGain();
    this.sirenGain.gain.value = 0;
    this.sirenOsc.connect(this.sirenGain).connect(master);
    this.sirenOsc.start();
  }

  /** Short filtered-noise burst; the basis for one-shot impact effects. */
  private noiseBurst(
    duration: number,
    filterType: BiquadFilterType,
    freq: number,
    volume: number
  ): void {
    if (!this.ctx || this.ctx.state !== 'running' || !this.master || !this.noiseBuf) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    // Random start offset so rapid repeats don't sound identical.
    const offset = Math.random() * (this.noiseBuf.duration - duration - 0.01);
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t, offset, duration + 0.02);
    src.onended = () => {
      src.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }

  /** Low thump for a landed punch or bat hit. Volume falls off with distance. */
  thwack(dist = 0): void {
    this.onCaption?.('Impact');
    if (!this.ctx || this.ctx.state !== 'running' || !this.master) return;
    const vol = Math.min(0.5, 10 / Math.max(dist, 5));
    this.noiseBurst(0.07, 'lowpass', 480, vol);
    // Body: a quick low sine blip underneath the noise.
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(110, t);
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.09);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol * 0.8, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.1);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }

  /** One-shot sine/square blip helper for UI-ish feedback sounds. */
  private blip(
    type: OscillatorType,
    fromHz: number,
    toHz: number,
    duration: number,
    volume: number,
    delay = 0
  ): void {
    if (!this.ctx || this.ctx.state !== 'running' || !this.master) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(fromHz, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, toHz), t + duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.01);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }

  /** Synthesized gunshot; character varies per weapon. Falls off with distance. */
  gunshot(kind: 'pistol' | 'smg' | 'shotgun', dist = 0): void {
    this.onCaption?.(`${kind === 'smg' ? 'SMG' : kind[0].toUpperCase() + kind.slice(1)} shot`);
    const vol = Math.min(0.34, 9 / Math.max(dist, 6));
    switch (kind) {
      case 'pistol':
        this.noiseBurst(0.13, 'bandpass', 1400, vol);
        this.blip('sine', 160, 60, 0.09, vol * 0.7);
        break;
      case 'smg':
        this.noiseBurst(0.07, 'bandpass', 1900, vol * 0.8);
        break;
      case 'shotgun':
        this.noiseBurst(0.24, 'lowpass', 750, vol);
        this.blip('sine', 90, 40, 0.16, vol);
        break;
    }
  }

  reloadClick(): void {
    this.onCaption?.('Reloading');
    this.blip('square', 1500, 1100, 0.03, 0.05);
    this.blip('square', 1100, 1600, 0.03, 0.05, 0.13);
  }

  carDoor(dist = 0): void {
    if (dist < 32) this.onCaption?.('Car door');
    const volume = Math.min(0.16, 6 / Math.max(dist, 6));
    this.noiseBurst(0.09, 'lowpass', 620, volume);
    this.blip('sine', 92, 58, 0.08, volume * 0.5);
  }

  repairChime(): void {
    this.onCaption?.('Vehicle repaired');
    this.blip('sine', 440, 880, 0.12, 0.12);
    this.blip('sine', 660, 1320, 0.14, 0.1, 0.12);
  }

  busted(): void {
    this.onCaption?.('Busted');
    this.blip('sawtooth', 260, 82, 0.5, 0.18);
  }

  footstep(running: boolean): void {
    this.noiseBurst(running ? 0.045 : 0.035, 'lowpass', running ? 760 : 620, running ? 0.075 : 0.05);
  }

  vehicleCrash(dist = 0): void {
    if (dist < 45) this.onCaption?.('Vehicle collision');
    const volume = Math.min(0.52, 12 / Math.max(dist, 7));
    this.noiseBurst(0.18, 'bandpass', 820, volume);
    this.blip('square', 135, 48, 0.17, volume * 0.55);
  }

  thunder(): void {
    this.onCaption?.('Thunder');
    this.noiseBurst(0.9, 'lowpass', 260, 0.48);
    this.blip('sine', 72, 24, 0.75, 0.32);
  }

  pickupBlip(): void {
    this.onCaption?.('Pickup collected');
    this.blip('sine', 620, 1240, 0.09, 0.12);
  }

  /** Heavy layered blast for an exploding vehicle. */
  explosion(dist = 0): void {
    const volume = Math.min(0.65, 16 / Math.max(dist, 8));
    this.noiseBurst(0.55, 'lowpass', 520, volume);
    this.blip('sine', 105, 28, 0.48, volume * 0.85);
  }

  /** Fade everything out (used while paused). */
  duck(): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    this.engineGain!.gain.setTargetAtTime(0, t, 0.1);
    this.skidGain!.gain.setTargetAtTime(0, t, 0.08);
    this.sirenGain!.gain.setTargetAtTime(0, t, 0.15);
    this.ambienceGain!.gain.setTargetAtTime(0, t, 0.2);
    this.rainGain!.gain.setTargetAtTime(0, t, 0.2);
    this.nightGain!.gain.setTargetAtTime(0, t, 0.2);
  }

  /**
   * @param speed fastest player speed (m/s)
   * @param throttle max player throttle 0..1
   * @param skidding any player sliding
   * @param sirenDist distance of nearest active police car, Infinity if none
   */
  update(
    dt: number,
    speed: number,
    throttle: number,
    skidding: boolean,
    sirenDist: number,
    walking = false,
    running = false,
    darkness = 0,
    rain = 0,
    engineActive = false
  ): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;

    const rpm = 45 + speed * 3.5 + throttle * 25;
    this.engineOsc!.frequency.setTargetAtTime(rpm, t, 0.1);
    const engineVolume = engineActive ? 0.03 + Math.min(speed / 40, 1) * 0.05 : 0;
    this.engineGain!.gain.setTargetAtTime(engineVolume, t, 0.1);

    this.skidGain!.gain.setTargetAtTime(skidding ? 0.12 : 0, t, 0.08);

    this.sirenTime += dt;
    const tone = Math.floor(this.sirenTime * 1.4) % 2 === 0 ? 660 : 480;
    this.sirenOsc!.frequency.setTargetAtTime(tone, t, 0.03);
    const vol = sirenDist === Infinity ? 0 : Math.min(0.14, 6 / Math.max(sirenDist, 8));
    this.sirenGain!.gain.setTargetAtTime(vol, t, 0.15);

    this.ambienceGain!.gain.setTargetAtTime(0.008 + (1 - rain) * 0.008, t, 0.8);
    this.rainGain!.gain.setTargetAtTime(rain * 0.13, t, 0.6);
    // A restrained high nighttime bed reads as insects without becoming a UI beep.
    this.nightGain!.gain.setTargetAtTime(darkness * (1 - rain) * 0.006, t, 1.2);
    if (rain > 0.35 && !this.raining) this.onCaption?.('Rain falling');
    this.raining = rain > 0.2;

    if (walking) {
      this.footstepTime -= dt;
      if (this.footstepTime <= 0) {
        this.footstepTime = running ? 0.29 : 0.48;
        this.footstep(running);
      }
    } else {
      this.footstepTime = 0;
    }
  }
}
