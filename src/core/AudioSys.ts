/**
 * Procedural audio: engine hum, tire skid, and police siren via Web Audio.
 * No samples needed; everything is oscillators and filtered noise.
 */
export class AudioSys {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private engineOsc: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private skidGain: GainNode | null = null;
  private sirenGain: GainNode | null = null;
  private sirenOsc: OscillatorNode | null = null;
  private sirenTime = 0;

  constructor() {
    const unlock = () => {
      if (!this.ctx) this.init();
      this.ctx?.resume();
    };
    window.addEventListener('keydown', unlock);
    window.addEventListener('pointerdown', unlock);
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
    this.blip('square', 1500, 1100, 0.03, 0.05);
    this.blip('square', 1100, 1600, 0.03, 0.05, 0.13);
  }

  pickupBlip(): void {
    this.blip('sine', 620, 1240, 0.09, 0.12);
  }

  /** Fade everything out (used while paused). */
  duck(): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    this.engineGain!.gain.setTargetAtTime(0, t, 0.1);
    this.skidGain!.gain.setTargetAtTime(0, t, 0.08);
    this.sirenGain!.gain.setTargetAtTime(0, t, 0.15);
  }

  /**
   * @param speed fastest player speed (m/s)
   * @param throttle max player throttle 0..1
   * @param skidding any player sliding
   * @param sirenDist distance of nearest active police car, Infinity if none
   */
  update(dt: number, speed: number, throttle: number, skidding: boolean, sirenDist: number): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;

    const rpm = 45 + speed * 3.5 + throttle * 25;
    this.engineOsc!.frequency.setTargetAtTime(rpm, t, 0.1);
    this.engineGain!.gain.setTargetAtTime(0.03 + Math.min(speed / 40, 1) * 0.05, t, 0.1);

    this.skidGain!.gain.setTargetAtTime(skidding ? 0.12 : 0, t, 0.08);

    this.sirenTime += dt;
    const tone = Math.floor(this.sirenTime * 1.4) % 2 === 0 ? 660 : 480;
    this.sirenOsc!.frequency.setTargetAtTime(tone, t, 0.03);
    const vol = sirenDist === Infinity ? 0 : Math.min(0.14, 6 / Math.max(sirenDist, 8));
    this.sirenGain!.gain.setTargetAtTime(vol, t, 0.15);
  }
}
