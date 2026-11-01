import {
  Bot, Cmd, DuelState, MatchState, Oath, OATHS, PlayerId, SimEvent, WizardAI, createMatch, finishRound, nextRound, stepDuel, TICK_RATE,
} from '@sigilfall/sim';
import type { Difficulty } from './settings';

/** What the renderer needs from whoever runs the simulation: the browser (single-player) or the server (online). */
export interface Driver {
  readonly seat: PlayerId;
  readonly state: DuelState;
  /** 0..1 progress between the last two ticks, for smooth rendering */
  readonly alpha: number;
  readonly match: MatchState | null;
  readonly ping: number | null;
  /** advance by dt real seconds; returns events produced */
  update(dt: number): SimEvent[];
  send(c: Cmd): void;
  /** raw stroke for server-side recognition (online) */
  sendStroke?(packed: number[], lane?: number): void;
  timeScale: number;
  dispose(): void;
}

export class DummyBot implements Bot {
  private cue: Cmd[] = [];
  private plan: { spell: 'cinder' | 'storm' | 'aurum'; at: number } | null = null;
  constructor(public me: PlayerId, public mode: 'static' | 'scripted' | 'aggressive', private ai?: WizardAI) {}
  observe(e: SimEvent[], s: DuelState): void {
    this.ai?.observe(e, s);
  }
  private cast(spell: 'cinder' | 'storm' | 'aurum'): Cmd[] {
    return [{ t: 'drawStart' }, { t: 'cast', spell, tier: 'clean' }];
  }
  /** scripted mode: cast on cue (button / N key) */
  cueCast(spell: 'cinder' | 'storm' | 'aurum'): void {
    this.plan = { spell, at: 0 };
  }
  act(s: DuelState): Cmd[] {
    if (this.mode === 'aggressive' && this.ai) return this.ai.act(s);
    if (this.mode === 'scripted' && this.plan && s.w[this.me].state === 'idle') {
      const pl = this.plan;
      this.plan = null;
      this.cue = this.cast(pl.spell);
    }
    if (this.cue.length && s.w[this.me].state === 'idle') return [this.cue.shift()!];
    if (this.cue.length && s.w[this.me].state === 'drawing') return [this.cue.shift()!];
    return [];
  }
}

export interface LocalOpts {
  difficulty: Difficulty;
  oath: Oath | null;
  seed?: number;
  bot?: (s: DuelState) => Bot;
  /** practice: the dummy never wins; rounds reset */
  endless?: boolean;
}

export class LocalDriver implements Driver {
  readonly seat: PlayerId = 0;
  match: MatchState;
  bot: Bot;
  timeScale = 1;
  private acc = 0;
  private pending: Cmd[] = [];
  private _alpha = 0;
  readonly ping = null;
  private endlessAt = 0;
  paused = false;

  constructor(private opts: LocalOpts) {
    const seed = opts.seed ?? (Math.random() * 1e9) | 0;
    const aiOath = OATHS[Math.floor(Math.random() * OATHS.length)]!;
    this.match = createMatch(seed, [opts.oath, aiOath]);
    this.bot = opts.bot ? opts.bot(this.match.duel) : new WizardAI(1, opts.difficulty, seed);
  }

  get state(): DuelState {
    return this.match.duel;
  }
  get alpha(): number {
    return this._alpha;
  }

  send(c: Cmd): void {
    this.pending.push(c);
  }

  update(dt: number): SimEvent[] {
    const out: SimEvent[] = [];
    if (this.paused) return out;
    const step = 1 / TICK_RATE;
    this.acc += Math.min(dt, 0.1) * this.timeScale;
    let n = 0;
    while (this.acc >= step && n++ < 6) {
      this.acc -= step;
      const d = this.match.duel;
      if (d.over) {
        if (this.opts.endless) {
          this.endlessAt += step;
          if (this.endlessAt > 1.5) {
            this.endlessAt = 0;
            nextRound(this.match);
            this.bot = this.opts.bot ? this.opts.bot(this.match.duel) : this.bot;
          }
        }
        break;
      }
      const mine = this.pending;
      this.pending = [];
      const theirs = this.bot.act(d);
      const ev = stepDuel(d, [mine, theirs]);
      this.bot.observe(ev, d);
      out.push(...ev);
    }
    this._alpha = this.state.over ? 1 : Math.min(1, this.acc / step);
    return out;
  }

  /** call when a round ends: tallies the win and reports whether the match continues */
  endRound(): 'next' | 'done' {
    return finishRound(this.match) ? 'next' : 'done';
  }

  /** begin the next round after the result screen */
  startNext(): void {
    nextRound(this.match);
    this.bot = this.opts.bot ? this.opts.bot(this.match.duel) : new WizardAI(1, this.opts.difficulty, this.match.seed + this.match.round);
    this.pending = [];
    this.acc = 0;
  }

  dispose(): void {
    /* nothing to release */
  }
}
