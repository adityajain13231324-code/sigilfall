import { settings, onSettings } from './settings';

/**
 * Layer A (always available): everything here is synthesised with Web Audio, so the game sounds complete offline.
 * Layer B (optional): if /audio/manifest.json maps a sound name to a file, that sample is used instead.
 */

export interface PlayOpts {
  pan?: number;
  rate?: number;
  gain?: number;
  priority?: number;
}

export interface LoopHandle {
  set(v: { rate?: number; gain?: number; pan?: number }): void;
  stop(fade?: number): void;
}

export interface AudioManager {
  unlock(): void;
  play(name: string, o?: PlayOpts): void;
  loop(name: string, o?: PlayOpts): LoopHandle;
  music(mode: 'off' | 'menu' | 'duel'): void;
  tension(t: number): void;
  duck(depth?: number, ms?: number): void;
  onCaption: ((text: string) => void) | null;
}

const CAPTIONS: Record<string, string> = {
  fizzle: '[sigil fizzles]', recog_cinder: '[fire sigil hums]', recog_storm: '[lightning sigil crackles]', recog_ward: '[ice sigil chimes]',
  recog_mirror: '[mirror sigil rings]', recog_gravewell: '[gravity sigil swells]', recog_aurum: '[gold orb rings]', recog_umbra: '[dark orb tolls]',
  recog_eclipse: '[eclipse sigil roars]', windup_eclipse: '[eclipse gathers, rumbling]', impact_cinder: '[fire bolt burns]', impact_storm: '[thunder cracks]',
  impact_eclipse: '[eclipse detonates]', wardShatter: '[ward shatters]', wardAbsorb: '[ice rings]', mirrorReflect: '[mirror flares]', mirrorExhaust: '[mirror cracks]',
  gravCollapse: '[gravity well collapses]', poiseBreak: '[poise breaks]', blink: '[blink]', damage: '[hit]', heartbeat: '[heartbeat]', tide: '[tide pulses]',
  roundStart: '[round begins]', roundWin: '[round won]', roundLose: '[round lost]', weave: '[spellweave hums]', fatigueCrack: '[sigil strains]',
  orbCreate: '[orb forms]', orbPop: '[orb pops]', impact_blast: '[orb blast]', impact_lance: '[pull lance strikes]', impact_shard: '[ice shards hit]',
};

type Maker = (a: Synth, o: PlayOpts) => void;

class Synth {
  constructor(readonly ctx: AudioContext, readonly dest: AudioNode, readonly wet: AudioNode, private noiseBuf: AudioBuffer) {}

  now(): number {
    return this.ctx.currentTime;
  }

  gain(v: number, t0 = this.now()): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(v, t0);
    return g;
  }

  /** oscillator with exponential pitch glide and an attack/decay envelope */
  osc(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, o: { at?: number; attack?: number; lp?: number; pan?: number; wet?: number; rate?: number; drive?: number } = {}): void {
    const { ctx } = this;
    const t = this.now() + (o.at ?? 0);
    const r = o.rate ?? 1;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, f0 * r), t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * r), t + dur);
    const g = ctx.createGain();
    const a = o.attack ?? 0.008;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node: AudioNode = osc;
    if (o.drive) {
      const ws = ctx.createWaveShaper();
      const k = o.drive * 60;
      const curve = new Float32Array(256);
      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * 2 - 1;
        curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
      }
      ws.curve = curve;
      osc.connect(ws);
      node = ws;
    }
    if (o.lp) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.lp;
      node.connect(f);
      node = f;
    }
    node.connect(g);
    this.out(g, o.pan, o.wet);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  noise(dur: number, vol: number, o: { at?: number; type?: BiquadFilterType; f0?: number; f1?: number; q?: number; attack?: number; pan?: number; wet?: number } = {}): void {
    const { ctx } = this;
    const t = this.now() + (o.at ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = o.type ?? 'bandpass';
    f.frequency.setValueAtTime(o.f0 ?? 1000, t);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(Math.max(30, o.f1), t + dur);
    f.Q.value = o.q ?? 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + (o.attack ?? 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    this.out(g, o.pan, o.wet);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  /** low body hit: fast pitch drop plus a short click */
  thump(f0: number, vol: number, dur = 0.35, o: { at?: number; wet?: number; pan?: number } = {}): void {
    this.osc('sine', f0, Math.max(28, f0 * 0.28), dur, vol, { at: o.at, wet: o.wet ?? 0.15, pan: o.pan, attack: 0.003 });
    this.noise(0.04, vol * 0.7, { at: o.at, type: 'highpass', f0: 1800, attack: 0.001 });
  }

  /** long dark reverb tail */
  tail(dur: number, vol: number, o: { at?: number; f0?: number; f1?: number } = {}): void {
    this.noise(dur, vol, { at: o.at, type: 'lowpass', f0: o.f0 ?? 1800, f1: o.f1 ?? 120, wet: 0.9, attack: 0.04 });
  }

  /** FM bell */
  bell(freq: number, dur: number, vol: number, o: { at?: number; pan?: number; wet?: number; ratio?: number; idx?: number } = {}): void {
    const { ctx } = this;
    const t = this.now() + (o.at ?? 0);
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const mg = ctx.createGain();
    car.frequency.value = freq;
    mod.frequency.value = freq * (o.ratio ?? 2.76);
    mg.gain.setValueAtTime(freq * (o.idx ?? 1.6), t);
    mg.gain.exponentialRampToValueAtTime(1, t + dur);
    mod.connect(mg);
    mg.connect(car.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    car.connect(g);
    this.out(g, o.pan, o.wet ?? 0.5);
    car.start(t); mod.start(t);
    car.stop(t + dur + 0.05); mod.stop(t + dur + 0.05);
  }

  private out(node: AudioNode, pan = 0, wet = 0.18): void {
    let n: AudioNode = node;
    if (pan) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      n.connect(p);
      n = p;
    }
    n.connect(this.dest);
    if (wet > 0) {
      const w = this.ctx.createGain();
      w.gain.value = wet;
      n.connect(w);
      w.connect(this.wet);
    }
  }
}

const mk = (fn: Maker): Maker => fn;
const SFX: Record<string, Maker> = {
  uiHover: mk((a) => a.osc('sine', 900, 1200, 0.06, 0.05)),
  uiClick: mk((a) => { a.osc('triangle', 520, 900, 0.09, 0.12); a.bell(1560, 0.25, 0.05); }),
  drawStart: mk((a, o) => { a.osc('sine', 300, 620, 0.18, 0.1, { rate: o.rate }); a.noise(0.18, 0.04, { type: 'highpass', f0: 3000 }); }),
  recog_cinder: mk((a) => { [0, 4, 7].forEach((s, i) => a.osc('triangle', 330 * 2 ** (s / 12), 330 * 2 ** (s / 12), 0.4, 0.09, { at: i * 0.05, lp: 2500 })); a.noise(0.35, 0.08, { f0: 1800, f1: 600, q: 0.7 }); }),
  recog_storm: mk((a) => { a.osc('sawtooth', 1800, 300, 0.14, 0.09, { lp: 4000 }); a.noise(0.22, 0.12, { type: 'highpass', f0: 4000, f1: 1500 }); a.osc('square', 700, 2100, 0.1, 0.05, { at: 0.08 }); }),
  recog_ward: mk((a) => { [0, 7, 12].forEach((s, i) => a.bell(880 * 2 ** (s / 12), 0.9, 0.08, { at: i * 0.07 })); }),
  recog_mirror: mk((a) => { a.bell(1760, 1.2, 0.09, { ratio: 3.5 }); a.bell(2349, 1.0, 0.05, { at: 0.06, ratio: 3.5 }); }),
  recog_gravewell: mk((a) => { a.osc('sawtooth', 70, 38, 0.8, 0.14, { lp: 300, attack: 0.15 }); a.osc('sine', 160, 60, 0.7, 0.1, { attack: 0.2 }); }),
  recog_aurum: mk((a) => { a.bell(784, 1.1, 0.1); a.bell(1175, 0.9, 0.06, { at: 0.07 }); }),
  recog_umbra: mk((a) => { a.bell(392, 1.5, 0.1, { ratio: 1.41 }); a.osc('sine', 98, 90, 1.0, 0.1, { attack: 0.1 }); }),
  recog_eclipse: mk((a) => { a.osc('sawtooth', 55, 110, 1.2, 0.14, { lp: 400, attack: 0.3, wet: 0.5 }); a.bell(523, 1.6, 0.07, { at: 0.1 }); a.bell(784, 1.6, 0.06, { at: 0.2 }); }),
  recog_dart: mk((a) => { a.osc('sine', 1400, 2600, 0.12, 0.08); a.noise(0.1, 0.06, { type: 'highpass', f0: 6000 }); }),
  recog_riptide: mk((a) => { a.osc('sine', 300, 700, 0.3, 0.09, { attack: 0.1 }); a.noise(0.3, 0.05, { f0: 900, f1: 2200, q: 2 }); a.bell(880, 0.6, 0.05, { at: 0.1 }); }),
  recog_heal: mk((a) => { [0, 4, 7, 12].forEach((s, i) => a.bell(523 * 2 ** (s / 12), 1.2, 0.07, { at: i * 0.09 })); }),
  recog_aegis: mk((a) => { a.osc('triangle', 200, 330, 0.3, 0.12); a.bell(784, 0.9, 0.07, { at: 0.05 }); }),
  recog_crescent: mk((a) => { a.osc('sawtooth', 500, 1300, 0.2, 0.06, { lp: 3000 }); a.bell(1568, 0.8, 0.06); }),
  recog_starfall: mk((a) => { for (let i = 0; i < 5; i++) a.bell(1318 * 2 ** ([0, 2, 4, 7, 9][i]! / 12), 0.7, 0.05, { at: i * 0.05 }); }),
  recog_fangs: mk((a) => { a.osc('sawtooth', 180, 90, 0.2, 0.1, { lp: 900 }); a.osc('sawtooth', 240, 120, 0.2, 0.08, { at: 0.08, lp: 900 }); }),
  impact_dart: mk((a) => { a.bell(2800, 0.15, 0.06); a.noise(0.06, 0.1, { type: 'highpass', f0: 5000 }); }),
  impact_riptide: mk((a) => { a.noise(0.3, 0.14, { f0: 700, f1: 200, q: 1.5 }); a.osc('sine', 260, 90, 0.25, 0.14); }),
  impact_crescent: mk((a) => { a.noise(0.2, 0.14, { type: 'highpass', f0: 2500, f1: 800 }); a.osc('sine', 150, 55, 0.25, 0.18); a.bell(1400, 0.4, 0.05); }),
  impact_fang: mk((a) => { a.osc('sawtooth', 300, 70, 0.15, 0.14, { lp: 1200 }); a.noise(0.08, 0.1, { f0: 2000, f1: 500 }); }),
  impact_meteor: mk((a) => { a.osc('sine', 110, 32, 0.8, 0.28, { wet: 0.5 }); a.noise(0.7, 0.2, { type: 'lowpass', f0: 2500, f1: 100, wet: 0.5 }); }),
  heal: mk((a) => { [0, 7, 12, 16].forEach((s, i) => a.bell(659 * 2 ** (s / 12), 1.0, 0.04, { at: i * 0.05 })); }),
  aegis: mk((a) => { a.osc('triangle', 150, 300, 0.4, 0.14, { attack: 0.1 }); a.bell(988, 1.1, 0.07, { at: 0.1 }); }),
  tier_rough: mk((a) => a.osc('triangle', 180, 120, 0.14, 0.1, { lp: 700 })),
  tier_clean: mk((a) => a.bell(1046, 0.5, 0.06)),
  tier_perfect: mk((a) => { [0, 4, 7, 12].forEach((s, i) => a.bell(1046 * 2 ** (s / 12), 0.9, 0.07, { at: i * 0.05 })); }),
  fizzle: mk((a) => { a.noise(0.28, 0.12, { type: 'lowpass', f0: 1500, f1: 200 }); a.osc('sawtooth', 200, 70, 0.22, 0.06, { lp: 500 }); }),
  windup_fire: mk((a) => { a.noise(0.4, 0.07, { f0: 600, f1: 2200, q: 0.8, attack: 0.2 }); a.osc('sawtooth', 120, 260, 0.38, 0.06, { lp: 900, attack: 0.2 }); }),
  windup_storm: mk((a) => { a.osc('square', 300, 1400, 0.5, 0.04, { lp: 3000, attack: 0.3 }); a.noise(0.5, 0.05, { type: 'highpass', f0: 2500, attack: 0.3 }); }),
  windup_ice: mk((a) => { a.bell(1320, 0.7, 0.05); a.bell(1760, 0.7, 0.04, { at: 0.1 }); a.noise(0.5, 0.03, { type: 'highpass', f0: 6000, attack: 0.3 }); }),
  windup_mirror: mk((a) => a.bell(2093, 0.4, 0.06, { ratio: 3.5 })),
  windup_grav: mk((a) => { a.osc('sawtooth', 45, 90, 0.8, 0.12, { lp: 250, attack: 0.5 }); a.osc('sine', 300, 100, 0.8, 0.06, { attack: 0.5 }); }),
  windup_orb: mk((a) => { a.osc('sine', 400, 900, 0.45, 0.07, { attack: 0.25 }); a.bell(1200, 0.5, 0.04, { at: 0.2 }); }),
  windup_eclipse: mk((a) => { a.osc('sawtooth', 40, 120, 2.4, 0.16, { lp: 350, attack: 1.8, wet: 0.5 }); a.noise(2.4, 0.07, { type: 'lowpass', f0: 200, f1: 1800, attack: 1.8 }); a.osc('sine', 880, 1760, 2.2, 0.04, { attack: 1.9 }); }),
  release: mk((a, o) => { a.noise(0.25, 0.1, { f0: 400, f1: 3000, q: 0.6, pan: o.pan }); a.osc('sine', 500, 150, 0.2, 0.08); }),
  impact_cinder: mk((a, o) => { a.noise(0.35, 0.18, { type: 'lowpass', f0: 2500, f1: 200, pan: o.pan }); a.osc('sine', 140, 45, 0.3, 0.2); }),
  impact_storm: mk((a) => { a.noise(0.12, 0.25, { type: 'highpass', f0: 3000 }); a.noise(1.4, 0.16, { type: 'lowpass', f0: 600, f1: 70, wet: 0.7, attack: 0.05 }); a.osc('sine', 100, 38, 0.6, 0.2); }),
  impact_blast: mk((a) => { a.osc('sine', 220, 50, 0.3, 0.22); a.bell(660, 0.5, 0.08); a.noise(0.2, 0.15, { f0: 1500, f1: 300 }); }),
  impact_lance: mk((a) => { a.osc('sawtooth', 600, 120, 0.25, 0.1, { lp: 1500 }); a.osc('sine', 120, 50, 0.3, 0.14); }),
  impact_shard: mk((a) => { a.bell(2400, 0.2, 0.05); a.noise(0.1, 0.1, { type: 'highpass', f0: 5000 }); }),
  impact_eclipse: mk((a) => { a.osc('sine', 80, 24, 1.8, 0.35, { wet: 0.6 }); a.noise(1.8, 0.25, { type: 'lowpass', f0: 3000, f1: 60, wet: 0.7 }); a.bell(262, 2.5, 0.1, { ratio: 1.5 }); }),
  eclipseLaunch: mk((a) => { a.osc('sawtooth', 200, 40, 1.0, 0.2, { lp: 800, wet: 0.5 }); a.noise(0.9, 0.18, { f0: 300, f1: 4000 }); }),
  eclipseAfter: mk((a) => { a.bell(196, 4, 0.08, { ratio: 1.5, wet: 0.8 }); a.bell(294, 4, 0.05, { at: 0.2, ratio: 1.5, wet: 0.8 }); }),
  wardAbsorb: mk((a) => { a.bell(1400, 0.35, 0.09); a.noise(0.12, 0.08, { type: 'highpass', f0: 4000 }); }),
  wardCrack: mk((a) => { a.noise(0.15, 0.15, { type: 'highpass', f0: 2500, f1: 6000 }); a.bell(2200, 0.2, 0.05); }),
  wardShatter: mk((a) => { a.noise(0.5, 0.2, { type: 'highpass', f0: 2000, f1: 8000 }); for (let i = 0; i < 6; i++) a.bell(1800 + Math.random() * 2400, 0.4, 0.04, { at: i * 0.03 + Math.random() * 0.05 }); }),
  ward: mk((a) => { a.osc('sine', 120, 260, 0.4, 0.12); a.bell(660, 0.9, 0.07, { at: 0.1 }); a.noise(0.4, 0.06, { type: 'highpass', f0: 3000, attack: 0.2 }); }),
  mirrorOn: mk((a) => { a.bell(2349, 0.8, 0.08, { ratio: 3.5 }); a.noise(0.2, 0.05, { type: 'highpass', f0: 6000 }); }),
  mirrorReflect: mk((a) => { a.bell(3136, 0.6, 0.12, { ratio: 3.5 }); a.noise(0.25, 0.14, { type: 'highpass', f0: 3500, f1: 9000 }); a.osc('sawtooth', 400, 1600, 0.2, 0.08, { lp: 4000 }); }),
  mirrorExhaust: mk((a) => { a.osc('sawtooth', 300, 60, 0.6, 0.12, { lp: 800 }); a.noise(0.3, 0.1, { type: 'lowpass', f0: 1500, f1: 150 }); }),
  gravInhale: mk((a) => { a.noise(0.9, 0.12, { f0: 3000, f1: 100, q: 2 }); a.osc('sawtooth', 300, 40, 0.9, 0.1, { lp: 500 }); }),
  gravCollapse: mk((a) => { a.osc('sine', 90, 20, 0.9, 0.3, { wet: 0.5 }); a.noise(0.6, 0.15, { type: 'lowpass', f0: 1200, f1: 50 }); }),
  orbCreate: mk((a) => { a.bell(988, 0.7, 0.09); a.osc('sine', 300, 800, 0.2, 0.1); }),
  orbPop: mk((a) => { a.osc('sine', 800, 150, 0.15, 0.13); a.noise(0.1, 0.1, { type: 'highpass', f0: 2500 }); }),
  blink: mk((a, o) => { a.noise(0.16, 0.12, { f0: 800, f1: 4000, q: 0.5, pan: o.pan }); a.osc('sine', 900, 300, 0.13, 0.08); }),
  poiseBreak: mk((a) => { a.noise(0.4, 0.22, { type: 'highpass', f0: 1000, f1: 5000 }); a.osc('sine', 200, 45, 0.5, 0.25); a.bell(330, 1.2, 0.08, { ratio: 1.6 }); }),
  stagger: mk((a) => a.osc('triangle', 220, 90, 0.25, 0.12, { lp: 600 })),
  damage: mk((a) => { a.osc('sine', 160, 55, 0.22, 0.2); a.noise(0.15, 0.14, { type: 'lowpass', f0: 1800, f1: 300 }); }),
  heartbeat: mk((a) => { a.osc('sine', 62, 40, 0.18, 0.28); a.osc('sine', 58, 38, 0.2, 0.2, { at: 0.2 }); }),
  roundStart: mk((a) => { a.bell(392, 1.4, 0.1); a.bell(523, 1.4, 0.1, { at: 0.18 }); a.bell(784, 1.8, 0.1, { at: 0.36 }); }),
  roundWin: mk((a) => { [0, 4, 7, 12, 16].forEach((s, i) => a.bell(523 * 2 ** (s / 12), 1.4, 0.09, { at: i * 0.1 })); }),
  roundLose: mk((a) => { [0, -3, -7].forEach((s, i) => a.bell(392 * 2 ** (s / 12), 2.2, 0.09, { at: i * 0.22, ratio: 1.4 })); }),
  tide: mk((a) => { a.osc('sine', 60, 120, 1.2, 0.14, { attack: 0.5, wet: 0.5 }); a.bell(1046, 1.6, 0.05, { at: 0.2 }); }),
  fatigueCrack: mk((a) => { a.noise(0.08, 0.12, { type: 'highpass', f0: 3000 }); a.osc('square', 120, 80, 0.08, 0.06); }),
  weave: mk((a) => { [0, 7, 12, 19].forEach((s, i) => a.bell(659 * 2 ** (s / 12), 0.9, 0.05, { at: i * 0.06 })); }),
  stormMark: mk((a, o) => { a.osc('sawtooth', 90, 90, 0.35, 0.05, { lp: 500, pan: o.pan }); a.noise(0.35, 0.05, { type: 'highpass', f0: 5000, pan: o.pan }); }),
  hit: mk((a) => a.osc('sine', 120, 50, 0.2, 0.16)),
};

Object.assign(SFX, {
  // recognition stings: each school has its own timbre
  recog_cinder: mk((a) => { a.thump(180, 0.12, 0.2); [0, 4, 7, 12].forEach((s2, i) => a.osc('sawtooth', 330 * 2 ** (s2 / 12), 330 * 2 ** (s2 / 12), 0.4, 0.07, { at: i * 0.045, lp: 2200, drive: 0.4 })); a.noise(0.4, 0.1, { f0: 1800, f1: 500, q: 0.7 }); }),
  recog_storm: mk((a) => { a.osc('sawtooth', 2400, 220, 0.16, 0.1, { lp: 5000, drive: 0.7 }); a.noise(0.25, 0.16, { type: 'highpass', f0: 4500, f1: 1200 }); a.osc('square', 600, 2400, 0.12, 0.05, { at: 0.07 }); a.thump(120, 0.1, 0.25, { at: 0.1 }); }),
  recog_gravewell: mk((a) => { a.osc('sawtooth', 80, 34, 1.0, 0.16, { lp: 320, attack: 0.2, drive: 0.5 }); a.osc('sine', 200, 55, 0.9, 0.12, { attack: 0.25 }); a.tail(1.2, 0.08); }),
  recog_eclipse: mk((a) => { a.osc('sawtooth', 50, 120, 1.5, 0.18, { lp: 420, attack: 0.4, wet: 0.5, drive: 0.4 }); a.bell(523, 2.0, 0.08, { at: 0.1 }); a.bell(784, 2.0, 0.07, { at: 0.22 }); a.bell(1046, 2.0, 0.05, { at: 0.34 }); }),
  // wind-ups: longer, tremolo'd risers so the opponent's charge is audible
  windup_fire: mk((a) => { a.noise(0.5, 0.11, { f0: 400, f1: 2800, q: 0.9, attack: 0.3 }); a.osc('sawtooth', 90, 300, 0.5, 0.09, { lp: 1000, attack: 0.35, drive: 0.5 }); a.osc('sine', 60, 120, 0.5, 0.1, { attack: 0.3 }); }),
  windup_storm: mk((a) => { for (let i = 0; i < 6; i++) a.osc('square', 400 + i * 160, 1800 + i * 200, 0.5, 0.025, { at: i * 0.07, lp: 3500 }); a.noise(0.55, 0.09, { type: 'highpass', f0: 3000, attack: 0.4 }); }),
  windup_ice: mk((a) => { for (let i = 0; i < 5; i++) a.bell(1100 + i * 260, 0.7, 0.035, { at: i * 0.07 }); a.noise(0.6, 0.05, { type: 'highpass', f0: 6500, attack: 0.4 }); a.osc('sine', 200, 420, 0.5, 0.06, { attack: 0.3 }); }),
  windup_grav: mk((a) => { a.osc('sawtooth', 40, 95, 0.9, 0.16, { lp: 260, attack: 0.6, drive: 0.5 }); a.noise(0.9, 0.08, { f0: 2400, f1: 120, q: 2.2, attack: 0.6 }); }),
  // release / travel
  release: mk((a, o) => { a.noise(0.35, 0.16, { f0: 300, f1: 3800, q: 0.7, pan: o.pan }); a.osc('sawtooth', 700, 120, 0.25, 0.1, { lp: 2200, drive: 0.3 }); a.thump(220, 0.14, 0.25); }),
  // impacts: body hit + crack + tail
  impact_cinder: mk((a, o) => { a.thump(170, 0.34, 0.4, { pan: o.pan }); a.noise(0.5, 0.2, { type: 'lowpass', f0: 3200, f1: 180, pan: o.pan }); a.noise(0.12, 0.2, { type: 'highpass', f0: 2500, f1: 900 }); a.tail(0.9, 0.09); }),
  impact_storm: mk((a) => { a.noise(0.09, 0.4, { type: 'highpass', f0: 3500 }); a.thump(110, 0.36, 0.5); a.noise(1.6, 0.17, { type: 'lowpass', f0: 800, f1: 60, wet: 0.8, attack: 0.04 }); a.osc('sawtooth', 1800, 90, 0.35, 0.1, { lp: 3500, drive: 0.8 }); }),
  impact_meteor: mk((a) => { a.thump(95, 0.5, 0.9, { wet: 0.4 }); a.noise(0.9, 0.26, { type: 'lowpass', f0: 3000, f1: 80, wet: 0.5 }); a.tail(1.6, 0.14); a.osc('sine', 48, 28, 1.3, 0.3); }),
  impact_riptide: mk((a) => { a.noise(0.45, 0.2, { f0: 1600, f1: 220, q: 1.2 }); a.thump(240, 0.2, 0.3); for (let i = 0; i < 4; i++) a.bell(1600 + Math.random() * 900, 0.3, 0.04, { at: i * 0.03 }); }),
  impact_crescent: mk((a) => { a.noise(0.2, 0.26, { type: 'highpass', f0: 3000, f1: 700 }); a.thump(150, 0.3, 0.35); a.bell(1500, 0.5, 0.07); a.osc('sawtooth', 1500, 300, 0.2, 0.08, { lp: 3000 }); }),
  impact_dart: mk((a) => { a.noise(0.05, 0.22, { type: 'highpass', f0: 5500 }); a.bell(3000, 0.18, 0.08); a.thump(260, 0.14, 0.15); }),
  impact_fang: mk((a) => { a.osc('sawtooth', 380, 70, 0.2, 0.16, { lp: 1400, drive: 0.6 }); a.thump(200, 0.22, 0.25); a.noise(0.1, 0.16, { f0: 2400, f1: 500 }); }),
  impact_blast: mk((a) => { a.thump(200, 0.4, 0.4); a.bell(660, 0.7, 0.1); a.noise(0.25, 0.2, { f0: 1800, f1: 300 }); a.tail(0.7, 0.08); }),
  damage: mk((a) => { a.thump(140, 0.34, 0.3); a.noise(0.2, 0.2, { type: 'lowpass', f0: 2400, f1: 250 }); a.osc('sawtooth', 220, 80, 0.2, 0.08, { lp: 800 }); }),
  // arena + progression
  riftWarn: mk((a) => { for (let i = 0; i < 3; i++) a.osc('square', 440, 440, 0.12, 0.07, { at: i * 0.2, lp: 1800 }); a.osc('sawtooth', 70, 55, 0.7, 0.1, { lp: 300, attack: 0.1 }); }),
  riftOpen: mk((a) => { a.thump(70, 0.5, 0.8, { wet: 0.5 }); a.osc('sawtooth', 120, 40, 1.0, 0.16, { lp: 420, drive: 0.7, wet: 0.5 }); a.noise(1.0, 0.12, { type: 'lowpass', f0: 1800, f1: 120, wet: 0.6 }); }),
  crystalSpawn: mk((a) => { [0, 7, 12, 19].forEach((s2, i) => a.bell(784 * 2 ** (s2 / 12), 1.2, 0.05, { at: i * 0.08 })); }),
  crystal: mk((a) => { [0, 4, 7, 12, 16].forEach((s2, i) => a.bell(880 * 2 ** (s2 / 12), 0.9, 0.07, { at: i * 0.045 })); a.osc('sine', 300, 900, 0.3, 0.1); }),
  phaseUp: mk((a) => { a.thump(60, 0.6, 1.0, { wet: 0.5 }); a.osc('sawtooth', 55, 110, 1.4, 0.2, { lp: 500, drive: 0.8, attack: 0.3, wet: 0.5 }); a.bell(196, 2.5, 0.1, { ratio: 1.41 }); a.bell(233, 2.5, 0.08, { ratio: 1.41, at: 0.15 }); }),
  shatter: mk((a) => { a.noise(0.35, 0.3, { type: 'highpass', f0: 2500, f1: 9000 }); for (let i = 0; i < 8; i++) a.bell(2000 + Math.random() * 3200, 0.5, 0.05, { at: i * 0.025 }); a.thump(180, 0.3, 0.3); }),
  perfectDodge: mk((a) => { a.noise(0.18, 0.14, { f0: 600, f1: 6000, q: 0.5 }); [0, 7, 12].forEach((s2, i) => a.bell(1318 * 2 ** (s2 / 12), 0.7, 0.07, { at: 0.05 + i * 0.05 })); }),
  parry: mk((a) => { a.bell(3136, 0.8, 0.14, { ratio: 3.5 }); a.bell(2349, 0.8, 0.1, { ratio: 3.5, at: 0.04 }); a.noise(0.3, 0.18, { type: 'highpass', f0: 4000, f1: 10000 }); a.thump(200, 0.3, 0.3); }),
  overcharge: mk((a) => { a.osc('sawtooth', 110, 440, 0.6, 0.12, { lp: 2500, drive: 0.5, attack: 0.2 }); [0, 4, 7, 12, 16].forEach((s2, i) => a.bell(660 * 2 ** (s2 / 12), 1.2, 0.07, { at: 0.2 + i * 0.06 })); }),
  counterHit: mk((a) => { a.thump(160, 0.4, 0.35); a.noise(0.15, 0.3, { type: 'highpass', f0: 2500 }); a.bell(1200, 0.4, 0.09); }),
});

const LOOP_FACTORY: Record<string, (ctx: AudioContext, dest: AudioNode) => { rate: AudioParam | null; gain: GainNode; pan: StereoPannerNode; nodes: AudioScheduledSourceNode[] }> = {};

function loopGraph(ctx: AudioContext, dest: AudioNode, type: 'trail' | 'proj' | 'orb' | 'channel' | 'danger') {
  const g = ctx.createGain();
  g.gain.value = 0;
  const pan = ctx.createStereoPanner();
  const nodes: AudioScheduledSourceNode[] = [];
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  const o1 = ctx.createOscillator();
  const o2 = ctx.createOscillator();
  const spec = {
    trail: { t1: 'sine' as const, t2: 'triangle' as const, f: 520, cut: 2400, d: 1.005 },
    proj: { t1: 'sawtooth' as const, t2: 'square' as const, f: 220, cut: 1400, d: 1.01 },
    orb: { t1: 'sine' as const, t2: 'sine' as const, f: 330, cut: 1500, d: 1.007 },
    channel: { t1: 'sawtooth' as const, t2: 'sawtooth' as const, f: 55, cut: 350, d: 1.012 },
    danger: { t1: 'square' as const, t2: 'sine' as const, f: 440, cut: 2000, d: 1.0 },
  }[type];
  o1.type = spec.t1; o2.type = spec.t2;
  o1.frequency.value = spec.f; o2.frequency.value = spec.f * spec.d;
  f.frequency.value = spec.cut;
  o1.connect(f); o2.connect(f); f.connect(g); g.connect(pan); pan.connect(dest);
  o1.start(); o2.start();
  nodes.push(o1, o2);
  const base = spec.f;
  return { g, pan, nodes, setRate: (r: number) => { o1.frequency.setTargetAtTime(base * r, ctx.currentTime, 0.03); o2.frequency.setTargetAtTime(base * r * spec.d, ctx.currentTime, 0.03); f.frequency.setTargetAtTime(spec.cut * (0.6 + r * 0.5), ctx.currentTime, 0.05); } };
}
void LOOP_FACTORY;

export class SynthAudio implements AudioManager {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private comp!: DynamicsCompressorNode;
  private wet!: GainNode;
  private synth!: Synth;
  private active = 0;
  private samples = new Map<string, AudioBuffer>();
  private musicMode: 'off' | 'menu' | 'duel' = 'off';
  private musicNodes: { stop: () => void } | null = null;
  private musicTimer = 0;
  private beat = 0;
  private tens = 0;
  private lastPlay = new Map<string, number>();
  onCaption: ((text: string) => void) | null = null;

  constructor() {
    onSettings(() => this.applyVolumes());
  }

  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14; this.comp.ratio.value = 4; this.comp.attack.value = 0.004; this.comp.release.value = 0.2;
    this.master = ctx.createGain();
    this.sfxBus = ctx.createGain();
    this.musicBus = ctx.createGain();
    this.sfxBus.connect(this.master);
    this.musicBus.connect(this.master);
    this.master.connect(this.comp);
    this.comp.connect(ctx.destination);
    // arena reverb: generated impulse
    const conv = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 2.6);
    const imp = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = imp.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
    conv.buffer = imp;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.55;
    this.wet.connect(conv);
    conv.connect(this.sfxBus);
    const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    this.synth = new Synth(ctx, this.sfxBus, this.wet, nb);
    this.applyVolumes();
    void this.loadSamples();
    if (this.musicMode !== 'off') {
      const m = this.musicMode;
      this.musicMode = 'off';
      this.music(m);
    }
  }

  private async loadSamples(): Promise<void> {
    try {
      const res = await fetch('/audio/manifest.json');
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return;
      const man = (await res.json()) as Record<string, string>;
      for (const [name, file] of Object.entries(man)) {
        try {
          const buf = await (await fetch('/audio/' + file)).arrayBuffer();
          this.samples.set(name, await this.ctx!.decodeAudioData(buf));
        } catch {
          /* missing sample: procedural fallback stays */
        }
      }
    } catch {
      /* no manifest: Layer A only */
    }
  }

  private applyVolumes(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(settings.mute ? 0 : settings.master, t, 0.03);
    this.sfxBus.gain.setTargetAtTime(settings.sfx, t, 0.03);
    this.musicBus.gain.setTargetAtTime(settings.music * 0.55, t, 0.05);
  }

  play(name: string, o: PlayOpts = {}): void {
    const text = CAPTIONS[name];
    if (text && settings.captions && this.onCaption) this.onCaption(text);
    if (!this.ctx || settings.mute) return;
    const now = performance.now();
    if (now - (this.lastPlay.get(name) ?? 0) < 35) return; // same-sound flood guard
    this.lastPlay.set(name, now);
    if (this.active > 26 && (o.priority ?? 1) < 2) return; // hard polyphony cap
    const sample = this.samples.get(name);
    this.active++;
    setTimeout(() => this.active--, 1200);
    if (sample) {
      const src = this.ctx.createBufferSource();
      src.buffer = sample;
      src.playbackRate.value = o.rate ?? 1;
      const g = this.ctx.createGain();
      g.gain.value = o.gain ?? 1;
      src.connect(g);
      g.connect(this.sfxBus);
      src.start();
      return;
    }
    const mkr = SFX[name];
    if (mkr) mkr(this.synth, o);
  }

  loop(name: string, o: PlayOpts = {}): LoopHandle {
    const ctx = this.ctx;
    if (!ctx) return { set() {}, stop() {} };
    const type = name.startsWith('trail') ? 'trail' : name.startsWith('proj') ? 'proj' : name.startsWith('orb') ? 'orb' : name.startsWith('channel') ? 'channel' : 'danger';
    const g = loopGraph(ctx, this.sfxBus, type);
    const vol = (o.gain ?? 0.07);
    g.g.gain.setTargetAtTime(settings.mute ? 0 : vol, ctx.currentTime, 0.05);
    g.pan.pan.value = o.pan ?? 0;
    let stopped = false;
    return {
      set: (v) => {
        if (stopped) return;
        if (v.rate !== undefined) g.setRate(v.rate);
        if (v.gain !== undefined) g.g.gain.setTargetAtTime(v.gain, ctx.currentTime, 0.05);
        if (v.pan !== undefined) g.pan.pan.setTargetAtTime(v.pan, ctx.currentTime, 0.05);
      },
      stop: (fade = 0.08) => {
        if (stopped) return;
        stopped = true;
        g.g.gain.setTargetAtTime(0, ctx.currentTime, fade / 3);
        setTimeout(() => g.nodes.forEach((n) => { try { n.stop(); } catch { /* already stopped */ } }), fade * 1000 + 200);
      },
    };
  }

  duck(depth = 0.35, ms = 500): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const base = settings.music * 0.55;
    this.musicBus.gain.cancelScheduledValues(t);
    this.musicBus.gain.setValueAtTime(base * depth, t);
    this.musicBus.gain.linearRampToValueAtTime(base, t + ms / 1000);
  }

  tension(t: number): void {
    this.tens = Math.max(0, Math.min(1, t));
  }

  private padVoices: { o: OscillatorNode; idx: number }[] = [];
  private step = 0;
  private static CHORDS = [
    [110, 164.8, 220, 261.6, 329.6],
    [87.3, 130.8, 174.6, 220, 261.6],
    [130.8, 196, 261.6, 329.6, 392],
    [98, 146.8, 196, 246.9, 293.7],
  ];

  music(mode: 'off' | 'menu' | 'duel'): void {
    if (mode === this.musicMode) return;
    this.musicMode = mode;
    this.musicNodes?.stop();
    this.musicNodes = null;
    clearInterval(this.musicTimer);
    const ctx = this.ctx;
    if (!ctx || mode === 'off') return;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.gain.setTargetAtTime(1, ctx.currentTime, 1.2);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = mode === 'menu' ? 600 : 900;
    f.Q.value = 0.8;
    const lfo = ctx.createOscillator();
    const lfoG = ctx.createGain();
    lfo.frequency.value = 0.07;
    lfoG.gain.value = 380;
    lfo.connect(lfoG);
    lfoG.connect(f.frequency);
    f.connect(out);
    out.connect(this.musicBus);
    const oscs: OscillatorNode[] = [lfo];
    this.padVoices = [];
    SynthAudio.CHORDS[0]!.forEach((n, i) => {
      for (const det of [-6, 6]) {
        const o = ctx.createOscillator();
        o.type = i % 2 ? 'triangle' : 'sawtooth';
        o.frequency.value = n;
        o.detune.value = det;
        const g = ctx.createGain();
        g.gain.value = 0.04;
        o.connect(g);
        g.connect(f);
        o.start();
        oscs.push(o);
        this.padVoices.push({ o, idx: i });
      }
    });
    lfo.start();
    this.musicNodes = {
      stop: () => {
        out.gain.setTargetAtTime(0, ctx.currentTime, 0.4);
        setTimeout(() => oscs.forEach((o) => { try { o.stop(); } catch { /* stopped */ } }), 1800);
      },
    };
    this.step = 0;
    this.musicTimer = window.setInterval(() => this.tick16(), mode === 'duel' ? 150 : 260);
  }

  /** 16th-note sequencer: pad chord changes every bar, bass, arpeggio, and drums that fade in with tension */
  private tick16(): void {
    if (!this.ctx || settings.mute) return;
    const a = this.synth;
    const k = this.tens;
    const duel = this.musicMode === 'duel';
    const st = this.step++;
    const bar = Math.floor(st / 16) % 4;
    const chord = SynthAudio.CHORDS[bar]!;
    const pos = st % 16;
    if (pos === 0) {
      const t = this.ctx.currentTime;
      for (const v of this.padVoices) v.o.frequency.setTargetAtTime(chord[v.idx]!, t, 0.25);
    }
    // bass on the beat
    if (duel && pos % 4 === 0) a.osc('sawtooth', chord[0]! / 2, chord[0]! / 2, 0.4, 0.09 + k * 0.05, { lp: 380, drive: 0.3 });
    // arpeggio on the 8ths; faster and brighter with tension
    const arp = [0, 2, 4, 2, 3, 2, 4, 1];
    if (pos % 2 === 0 && (duel ? k > 0.12 || pos % 4 === 0 : pos % 4 === 0)) {
      const n = chord[arp[(pos / 2) % arp.length]!]! * 2;
      a.osc(duel ? 'square' : 'triangle', n, n, duel ? 0.22 : 0.9, duel ? 0.018 + k * 0.025 : 0.025, { lp: duel ? 1800 + k * 2200 : 1400, wet: 0.5 });
    }
    if (!duel) return;
    // drums
    if (pos % 8 === 0) a.thump(95, 0.1 + k * 0.1, 0.22, { wet: 0.08 });
    if (k > 0.25 && pos % 4 === 2) a.noise(0.05, 0.02 + k * 0.03, { type: 'highpass', f0: 7000 });
    if (k > 0.45 && pos % 8 === 4) {
      a.noise(0.14, 0.05 + k * 0.04, { type: 'bandpass', f0: 1800, q: 0.8 });
      a.osc('triangle', 220, 140, 0.08, 0.05);
    }
    if (k > 0.7 && pos % 8 === 6) a.thump(95, 0.08, 0.15);
  }
}
