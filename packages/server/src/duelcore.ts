import {
  Cmd, DuelState, MatchState, Oath, OATHS, PlayerId, SimEvent, SpellId, candidateSpells, createMatch, finishRound, nextRound, stepDuel, TICK_RATE,
} from '@sigilfall/sim';
import { recognize, spellToShape, unpackStroke, validateTemplates, Template, Shape } from '@sigilfall/recognizer';

export type Phase = 'waiting' | 'draft' | 'countdown' | 'fight' | 'roundEnd' | 'matchEnd';

export interface Snapshot {
  phase: Phase;
  countdown: number;
  round: number;
  wins: [number, number];
  oaths: [Oath | null, Oath | null];
  state: DuelState;
  events: SimEvent[];
  winner: PlayerId | null;
  rematch: [boolean, boolean];
  connected: [boolean, boolean];
}

const MAX_MSGS_PER_SEC = 90;
const COUNTDOWN_TICKS = 3 * TICK_RATE;
const ROUND_END_TICKS = 5 * TICK_RATE;
const NET_CMDS = new Set(['drawStart', 'drawCancel', 'tell', 'blink', 'orb']);
const SPELL_IDS: SpellId[] = ['cinder', 'storm', 'ward', 'mirror', 'gravewell', 'aurum', 'umbra', 'eclipse'];

/** Transport-free authoritative duel host. The Colyseus room is a thin wrapper around this so it can be unit-tested. */
export class DuelHost {
  phase: Phase = 'waiting';
  match: MatchState | null = null;
  seats: [boolean, boolean] = [false, false];
  oaths: [Oath | null, Oath | null] = [null, null];
  rematch: [boolean, boolean] = [false, false];
  private queue: [Cmd[], Cmd[]] = [[], []];
  private custom: [Template[], Template[]] = [[], []];
  private quickOk: [boolean, boolean] = [false, false];
  private counts: [number, number] = [0, 0];
  private countWindow = 0;
  private timer = 0;
  private lastEvents: SimEvent[] = [];
  rejected = 0;
  private seed: number;
  tickNo = 0;

  constructor(seed = (Math.random() * 1e9) | 0) {
    this.seed = seed;
  }

  join(seat: PlayerId, opts: { custom?: unknown; quick?: boolean } = {}): void {
    this.seats[seat] = true;
    this.custom[seat] = validateTemplates(opts.custom);
    this.quickOk[seat] = !!opts.quick;
    if (this.seats[0] && this.seats[1] && this.phase === 'waiting') this.phase = 'draft';
  }

  leave(seat: PlayerId): void {
    this.seats[seat] = false;
  }

  /** a player did not come back: the other wins the match */
  forfeit(seat: PlayerId): void {
    if (!this.match || this.phase === 'matchEnd') return;
    this.match.done = true;
    this.match.winner = seat === 0 ? 1 : 0;
    this.phase = 'matchEnd';
  }

  /** Handle one inbound message. Returns false if it was rejected (forged, malformed, rate-limited). */
  message(seat: PlayerId, type: string, payload: unknown): boolean {
    const nowSec = Math.floor(this.tickNo / TICK_RATE);
    if (nowSec !== this.countWindow) {
      this.countWindow = nowSec;
      this.counts = [0, 0];
    }
    if (++this.counts[seat] > MAX_MSGS_PER_SEC) return this.reject();
    switch (type) {
      case 'pickOath': {
        const o = (payload as { oath?: unknown } | null)?.oath;
        if (this.phase !== 'draft' || this.oaths[seat] || typeof o !== 'string' || !(OATHS as string[]).includes(o)) return this.reject();
        this.oaths[seat] = o as Oath;
        if (this.oaths[0] && this.oaths[1]) this.startMatch();
        return true;
      }
      case 'rematch':
        if (this.phase !== 'matchEnd') return this.reject();
        this.rematch[seat] = true;
        if (this.rematch[0] && this.rematch[1] && this.seats[0] && this.seats[1]) {
          this.oaths = [null, null];
          this.rematch = [false, false];
          this.match = null;
          this.phase = 'draft';
        }
        return true;
      case 'cmd':
        return this.command(seat, payload);
      case 'cast':
        return this.cast(seat, payload);
      default:
        return this.reject();
    }
  }

  private reject(): false {
    this.rejected++;
    return false;
  }

  private command(seat: PlayerId, p: unknown): boolean {
    if (this.phase !== 'fight' || !p || typeof p !== 'object') return this.reject();
    const c = p as Record<string, unknown>;
    if (typeof c.t !== 'string' || !NET_CMDS.has(c.t)) return this.reject();
    switch (c.t) {
      case 'drawStart':
      case 'drawCancel':
        this.queue[seat].push({ t: c.t });
        return true;
      case 'tell':
        if ((c.stage !== 1 && c.stage !== 2) || !SPELL_IDS.includes(c.spell as SpellId)) return this.reject();
        this.queue[seat].push({ t: 'tell', stage: c.stage, spell: c.spell as SpellId });
        return true;
      case 'blink':
        if (c.dir !== -1 && c.dir !== 1) return this.reject();
        this.queue[seat].push({ t: 'blink', dir: c.dir });
        return true;
      case 'orb':
        if (c.which !== 'aurum' && c.which !== 'umbra') return this.reject();
        this.queue[seat].push({ t: 'orb', which: c.which });
        return true;
    }
    return this.reject();
  }

  /**
   * The server decides what was cast: it recognises the raw stroke itself. Any spell/tier the client claims is ignored.
   * `quick` casts (no drawing) only work if both players enabled them when joining.
   */
  private cast(seat: PlayerId, p: unknown): boolean {
    if (this.phase !== 'fight' || !this.match || !p || typeof p !== 'object') return this.reject();
    const c = p as { stroke?: unknown; quick?: unknown; fizzle?: unknown };
    if (c.fizzle === true) {
      this.queue[seat].push({ t: 'cast', spell: null, tier: 'rough' });
      return true;
    }
    if (c.quick !== undefined) {
      if (!(this.quickOk[0] && this.quickOk[1]) || !SPELL_IDS.includes(c.quick as SpellId)) return this.reject();
      this.queue[seat].push({ t: 'cast', spell: c.quick as SpellId, tier: 'rough', quick: true });
      return true;
    }
    const stroke = unpackStroke(c.stroke);
    if (!stroke) return this.reject();
    const s = this.match.duel;
    const allowed = [...new Set(candidateSpells(s, seat).map(spellToShape))] as Shape[];
    const r = recognize(stroke, { allowed, custom: this.custom[seat] });
    this.queue[seat].push({ t: 'cast', spell: r.spell, tier: r.tier ?? 'rough' });
    return true;
  }

  private startMatch(): void {
    this.match = createMatch(this.seed, [this.oaths[0], this.oaths[1]]);
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    this.phase = 'countdown';
    this.timer = COUNTDOWN_TICKS;
  }

  /** advance one server tick (30 Hz) and return the snapshot to broadcast */
  tick(): Snapshot {
    this.tickNo++;
    let events: SimEvent[] = [];
    const m = this.match;
    if (m) {
      if (this.phase === 'countdown') {
        if (--this.timer <= 0) this.phase = 'fight';
      } else if (this.phase === 'fight') {
        const cmds = this.queue;
        this.queue = [[], []];
        events = stepDuel(m.duel, cmds);
        if (m.duel.over) {
          const more = finishRound(m);
          if (more) {
            this.phase = 'roundEnd';
            this.timer = ROUND_END_TICKS;
          } else {
            this.phase = 'matchEnd';
          }
        }
      } else if (this.phase === 'roundEnd') {
        if (--this.timer <= 0) {
          nextRound(m);
          this.queue = [[], []];
          this.phase = 'countdown';
          this.timer = COUNTDOWN_TICKS;
        }
      }
    }
    this.lastEvents = events;
    return this.snapshot();
  }

  snapshot(): Snapshot {
    const m = this.match;
    return {
      phase: this.phase,
      countdown: this.phase === 'countdown' ? this.timer : 0,
      round: m?.round ?? 0,
      wins: m ? m.wins : [0, 0],
      oaths: this.oaths,
      state: (m?.duel ?? EMPTY) as DuelState,
      events: this.lastEvents,
      winner: m?.winner ?? null,
      rematch: this.rematch,
      connected: this.seats,
    };
  }
}

const EMPTY = createMatch(1).duel;
