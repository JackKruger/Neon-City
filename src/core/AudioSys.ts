/**
 * Procedural audio: engine hum, tire skid, and police siren via Web Audio.
 * No samples needed; everything is oscillators and filtered noise.
 */
export class AudioSys {
  private ctx: AudioContext | null = null;
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

    // Skid: looped noise through a bandpass.
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
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
