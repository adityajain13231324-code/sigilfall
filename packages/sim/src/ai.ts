import type { Cmd, DuelState, Lane, PlayerId, SimEvent, SpellId, Tier } from './types';
import { T, other, holdsOrb, hasBothOrbs, cooldownLeft, spellCost, B } from './sim';
import { makeRng } from '@sigilfall/recognizer';

export type Difficulty = 'apprentice' | 'adept' | 'archmage';

interface Profile {
  react: [number, number]; // reaction delay in ticks
  fizzle: number;
  feint: number;
  drawMult: number;
  adapt: number; // 0..1 how hard pattern memory counters repeats
  blinkSkill: number;
  counterSkill: number;
  eclipseAmbition: number;
  tiers: [number, number, number]; // rough/clean/perfect weights
  noise: number;
  /** ticks the AI waits after committing to a cast before thinking again (lower = more aggressive) */
  tempo: [number, number];
}

export const PROFILES: Record<Difficulty, Profile> = {
  apprentice: { react: [14, 24], fizzle: 0.24, feint: 0, drawMult: 1.8, adapt: 0, blinkSkill: 0.22, counterSkill: 0.04, eclipseAmbition: 0.04, tiers: [0.5, 0.45, 0.05], noise: 0.6, tempo: [45, 100] },
  adept: { react: [8, 13], fizzle: 0.08, feint: 0.03, drawMult: 1.1, adapt: 0.6, blinkSkill: 0.62, counterSkill: 0.4, eclipseAmbition: 0.4, tiers: [0.15, 0.6, 0.25], noise: 0.3, tempo: [18, 50] },
  archmage: { react: [4, 7], fizzle: 0.025, feint: 0.16, drawMult: 0.8, adapt: 1, blinkSkill: 0.93, counterSkill: 0.85, eclipseAmbition: 0.9, tiers: [0.05, 0.5, 0.45], noise: 0.18, tempo: [4, 18] },
};

const DRAW_TICKS: Record<SpellId, number> = { cinder: 13, storm: 15, ward: 13, mirror: 14, gravewell: 27, aurum: 17, umbra: 17, eclipse: 29, dart: 10, riptide: 14, heal: 20, aegis: 14, crescent: 16, starfall: 24, fangs: 20 };

interface Plan {
  spell: SpellId;
  tier: Tier;
  start: number;
  ticks: number;
  fizzle: boolean;
  feint: boolean;
  told1: boolean;
  told2: boolean;
}

export interface Bot {
  me: PlayerId;
  observe(events: SimEvent[], s: DuelState): void;
  act(s: DuelState): Cmd[];
}

export class WizardAI implements Bot {
  private rng: () => number;
  private plan: Plan | null = null;
  private seen = new Map<string, number>();
  private history: SpellId[] = [];
  private foeGravewellReady = 0;
  private foeMirrorReady = 0;
  private nextThink = 0;
  private p: Profile;
  private lastOffense: SpellId | null = null;
  /** boss phase 1-3, from remaining Vitality: later phases think faster and dodge better */
  phase = 1;
  /** spells this AI refuses to cast (used by balance experiments) */
  banned = new Set<SpellId>();

  constructor(public me: PlayerId, public difficulty: Difficulty = 'adept', seed = 1) {
    this.rng = makeRng(seed * 7919 + me);
    this.p = PROFILES[difficulty];
  }

  observe(events: SimEvent[], s: DuelState): void {
    for (const e of events) {
      if (e.type === 'cast' && e.p !== this.me) {
        this.history.push(e.spell);
        if (this.history.length > 12) this.history.shift();
        if (e.spell === 'gravewell') this.foeGravewellReady = s.tick + T(B.spells.gravewell.cooldown);
        if (e.spell === 'mirror') this.foeMirrorReady = s.tick + T(B.spells.mirror.cooldown);
      }
    }
  }

  private get bskill(): number {
    return Math.min(0.97, this.p.blinkSkill + (this.phase - 1) * 0.08);
  }

  private reactDelay(): number {
    return this.p.react[0] + Math.floor(this.rng() * (this.p.react[1] - this.p.react[0] + 1));
  }

  /** True once the AI has "noticed" a threat for long enough (human-like reaction time). */
  private noticed(key: string, s: DuelState): boolean {
    let at = this.seen.get(key);
    if (at === undefined) {
      at = s.tick + this.reactDelay();
      this.seen.set(key, at);
      if (this.seen.size > 64) this.seen.delete(this.seen.keys().next().value as string);
    }
    return s.tick >= at;
  }

  private repeated(): SpellId | null {
    const last = this.history.slice(-6);
    const counts = new Map<SpellId, number>();
    for (const h of last) counts.set(h, (counts.get(h) ?? 0) + 1);
    let best: SpellId | null = null;
    let n = 0;
    for (const [k, v] of counts) if (v > n) { best = k; n = v; }
    return n >= 3 ? best : null;
  }

  act(s: DuelState): Cmd[] {
    const me = this.me;
    const w = s.w[me];
    const cmds: Cmd[] = [];
    if (s.tick <= 1) {
      cmds.push({ t: 'oath', oath: (['embers', 'stillness', 'echoes'] as const)[Math.floor(this.rng() * 3)]! });
    }
    if (w.state === 'dead' || s.over) return cmds;
    this.phase = w.vit < 33 ? 3 : w.vit < 66 ? 2 : 1;

    // execute a drawing plan
    if (this.plan) {
      if (w.state !== 'drawing') {
        this.plan = null;
      } else {
        const pl = this.plan;
        const el = s.tick - pl.start;
        if (!pl.told1 && el >= pl.ticks * 0.4) {
          pl.told1 = true;
          cmds.push({ t: 'tell', stage: 1, spell: pl.spell });
        }
        if (!pl.told2 && el >= pl.ticks * 0.7) {
          pl.told2 = true;
          cmds.push({ t: 'tell', stage: 2, spell: pl.spell });
        }
        // imminent danger while drawing: blink out (cancels the draw)
        const danger = this.imminentDanger(s);
        if (danger && this.rng() < this.bskill) {
          const dir = this.blinkDir(s);
          if (dir && s.tick >= w.blinkReady && w.aether >= B.blink.aether) {
            cmds.push({ t: 'blink', dir });
            this.plan = null;
            return cmds;
          }
        }
        if (el >= pl.ticks) {
          if (pl.feint) cmds.push({ t: 'drawCancel' });
          else cmds.push({ t: 'cast', spell: pl.fizzle ? null : pl.spell, tier: pl.tier });
          this.plan = null;
          this.nextThink = s.tick + Math.round((this.p.tempo[0] + Math.floor(this.rng() * (this.p.tempo[1] - this.p.tempo[0] + 1))) * [1, 0.75, 0.55][this.phase - 1]!);
        }
        return cmds;
      }
    }
    if (w.state !== 'idle') return cmds;
    if (s.tick < this.nextThink) return cmds;
    this.nextThink = s.tick + 1;

    // 0. arena: leave a burning lane, drift toward a crystal
    const move = this.arenaMove(s);
    if (move) {
      cmds.push({ t: 'blink', dir: move });
      return cmds;
    }
    // 1. reactive dodges
    const danger = this.imminentDanger(s);
    if (danger && this.rng() < this.bskill && s.tick >= w.blinkReady && w.aether >= B.blink.aether) {
      const dir = this.blinkDir(s);
      if (dir) {
        cmds.push({ t: 'blink', dir });
        return cmds;
      }
    }
    // 2. counters
    const counter = this.pickCounter(s, cmds);
    if (counter) return cmds;
    // 3. offense
    this.pickOffense(s, cmds);
    return cmds;
  }

  private arenaMove(s: DuelState): -1 | 1 | 0 {
    const w = s.w[this.me];
    if (s.tick < w.blinkReady || w.aether < B.blink.aether + 6) return 0;
    const step = (target: number): -1 | 1 | 0 => (target > w.lane ? 1 : target < w.lane ? -1 : 0);
    const hz = s.hazard;
    if (hz && hz.lane === w.lane && this.noticed('hz' + hz.until, s)) {
      const safe = ([0, 1, 2] as const).filter((l) => l !== hz.lane && Math.abs(l - w.lane) === 1);
      if (safe.length && this.rng() < 0.5 + this.bskill / 2) return step(safe[Math.floor(this.rng() * safe.length)]!);
    }
    const cr = s.crystal;
    const chase = [0.25, 0.55, 0.85][['apprentice', 'adept', 'archmage'].indexOf(this.difficulty)]!;
    if (cr && cr.lane !== w.lane && (!hz || cr.lane !== hz.lane) && this.noticed('cr' + cr.until, s) && this.rng() < chase * 0.08 && !this.imminentDanger(s)) {
      return step(cr.lane);
    }
    return 0;
  }

  private imminentDanger(s: DuelState): boolean {
    const w = s.w[this.me];
    for (const pr of s.projectiles) {
      if (pr.owner === this.me || pr.lane !== w.lane) continue;
      if (w.ward && !pr.pierce && pr.kind !== 'eclipse') continue;
      const e = pr.arrive - s.tick;
      const lead = pr.kind === 'eclipse' ? 7 : 11;
      const aware = this.noticed('p' + pr.id, s); // reaction time starts when the threat appears, not when it is close
      if (e <= lead && e >= 2 && aware) return true;
    }
    for (const st of s.strikes) {
      if (st.owner === this.me || st.lane !== w.lane) continue;
      const aware = this.noticed('s' + st.id, s);
      if (st.hit - s.tick <= 10 && aware) return true;
    }
    return false;
  }

  private blinkDir(s: DuelState): -1 | 1 | 0 {
    const w = s.w[this.me];
    const bad = new Set<number>();
    for (const pr of s.projectiles) if (pr.owner !== this.me) bad.add(pr.lane);
    for (const st of s.strikes) if (st.owner !== this.me) bad.add(st.lane);
    const opts: (-1 | 1)[] = [];
    for (const d of [-1, 1] as const) {
      const to = w.lane + d;
      if (to >= 0 && to <= 2) opts.push(d);
    }
    const good = opts.filter((d) => !bad.has(w.lane + d));
    const pool = good.length ? good : opts;
    if (!pool.length) return 0;
    if (this.rng() > this.bskill + 0.1) return pool[Math.floor(this.rng() * pool.length)]!;
    pool.sort((a, b) => Math.abs(w.lane + a - 1) - Math.abs(w.lane + b - 1));
    return pool[0]!;
  }

  private ready(s: DuelState, sp: SpellId, tier: Tier = 'clean'): boolean {
    const w = s.w[this.me];
    if (this.banned.has(sp)) return false;
    if (cooldownLeft(s, this.me, sp)) return false;
    if (sp === 'eclipse' && !hasBothOrbs(s, this.me)) return false;
    if ((sp === 'aurum' || sp === 'umbra') && holdsOrb(s, this.me, sp)) return false;
    return w.aether >= spellCost(s, this.me, sp, tier) + (sp === 'eclipse' ? 0 : 0);
  }

  private start(s: DuelState, cmds: Cmd[], sp: SpellId, quick = false): void {
    const roll = this.rng();
    const [r, c] = this.p.tiers;
    const tier: Tier = roll < r ? 'rough' : roll < r + c ? 'clean' : 'perfect';
    const ticks = Math.max(6, Math.round(DRAW_TICKS[sp] * this.p.drawMult * (0.85 + this.rng() * 0.35)));
    const feint = !quick && this.rng() < this.p.feint && sp !== 'eclipse';
    this.plan = { spell: sp, tier, start: s.tick, ticks, fizzle: this.rng() < this.p.fizzle, feint, told1: false, told2: false };
    cmds.push({ t: 'drawStart' });
  }

  private pickCounter(s: DuelState, cmds: Cmd[]): boolean {
    const me = this.me;
    const foe = other(me);
    const w = s.w[me];
    const fw = s.w[foe];
    const skill = this.p.counterSkill;
    const rep = this.p.adapt > 0 ? this.repeated() : null;

    // enemy channeling Eclipse -> interrupt it
    if (fw.state === 'channeling' && this.noticed('chan', s)) {
      if (holdsOrb(s, me, 'aurum') && this.rng() < skill + 0.2) {
        cmds.push({ t: 'orb', which: 'aurum' });
        return true;
      }
      if (this.ready(s, 'storm') && this.rng() < skill + 0.3) return this.go(s, cmds, 'storm');
      if (this.ready(s, 'gravewell') && this.rng() < skill + 0.3) return this.go(s, cmds, 'gravewell');
    } else if (fw.state !== 'channeling') {
      this.seen.delete('chan');
    }
    // incoming Eclipse
    for (const pr of s.projectiles) {
      if (pr.owner === me || pr.kind !== 'eclipse') continue;
      if (this.noticed('p' + pr.id, s) && this.ready(s, 'gravewell') && pr.arrive - s.tick > 30 && this.rng() < skill + 0.3) {
        return this.go(s, cmds, 'gravewell');
      }
    }
    // enemy holds both orbs: pop them
    if (hasBothOrbs(s, foe) && this.noticed('orbs', s) && this.ready(s, 'gravewell') && this.rng() < skill * 0.5) {
      return this.go(s, cmds, 'gravewell');
    }
    if (!hasBothOrbs(s, foe)) this.seen.delete('orbs');
    // enemy winding up a bolt: bait/parry with Mirrorveil
    if (fw.state === 'windup' && fw.windup && (fw.windup.spell === 'cinder') && this.ready(s, 'mirror')) {
      const key = 'w' + fw.windup.start;
      const boost = rep === 'cinder' ? this.p.adapt * 0.5 : 0;
      if (this.noticed(key, s) && fw.windup.end - s.tick >= 1 && this.rng() < skill * 0.55 + boost && s.tick > this.foeMirrorReady - T(1)) {
        return this.go(s, cmds, 'mirror');
      }
    }
    // Gravewell-tempo: release a held orb about to expire
    for (const which of ['aurum', 'umbra'] as const) {
      const left = w.orbs[which] - s.tick;
      if (left > 0 && left < 45 && !(hasBothOrbs(s, me) && this.p.eclipseAmbition > 0.5)) {
        cmds.push({ t: 'orb', which });
        return true;
      }
    }
    // orb punish: foe drawing and I hold aurum
    if (fw.state === 'drawing' && holdsOrb(s, me, 'aurum') && this.rng() < 0.15 * skill && this.noticed('d' + (fw.draw?.start ?? 0), s)) {
      cmds.push({ t: 'orb', which: 'aurum' });
      return true;
    }
    return false;
  }

  private go(s: DuelState, cmds: Cmd[], sp: SpellId): boolean {
    this.start(s, cmds, sp);
    this.lastOffense = sp;
    return true;
  }

  private pickOffense(s: DuelState, cmds: Cmd[]): void {
    const me = this.me;
    const foe = other(me);
    const w = s.w[me];
    const fw = s.w[foe];
    const rep = this.p.adapt > 0 ? this.repeated() : null;

    // Eclipse when it is safe: both orbs and foe can't answer with Gravewell, or foe is staggered
    if (hasBothOrbs(s, me) && this.ready(s, 'eclipse')) {
      const foeCanWell = s.tick >= this.foeGravewellReady && fw.aether >= 30;
      const open = fw.state === 'staggered' || fw.state === 'exhausted' || fw.state === 'recovery';
      if ((!foeCanWell || open || this.rng() < 0.3) && this.rng() < this.p.eclipseAmbition + (this.phase - 1) * 0.1 + (open ? 0.3 : 0)) {
        this.go(s, cmds, 'eclipse');
        return;
      }
    }

    const score = new Map<SpellId, number>();
    const add = (sp: SpellId, v: number) => {
      if (!this.ready(s, sp)) return;
      score.set(sp, (score.get(sp) ?? 0) + v);
    };
    const recent = w.recent.map((r) => r.spell);
    const fatigue = (sp: SpellId) => (w.lastSpell === sp ? 0.45 : 0);
    const lowAether = w.aether < 35;
    const wardUp = !!fw.ward;
    const burning = s.tick < fw.burnUntil;

    const chilled = s.tick < fw.chillUntil;
    add('cinder', (chilled ? 0.9 : 0) + 0.8 - fatigue('cinder') - (wardUp ? 0.7 : 0) + (burning ? -0.2 : 0.1));
    add('storm', 0.55 + (wardUp ? 1.1 : 0) + (burning ? 0.9 : 0) + (fw.state === 'windup' || fw.state === 'channeling' ? 0.8 : 0) - fatigue('storm'));
    if (!w.ward) add('ward', (lowAether ? 0.8 : 0.15) + (rep === 'cinder' ? this.p.adapt * 0.7 : 0) + (w.vit < 40 ? 0.4 : 0));
    add('gravewell', 0.05 + (hasBothOrbs(s, foe) ? 0.8 : 0));
    add('mirror', rep === 'cinder' ? this.p.adapt * 0.3 : 0.1);
    const passive = fw.state === 'idle' && s.tick - fw.lastCastTick > T(3);
    if (!holdsOrb(s, me, 'aurum')) add('aurum', 0.35 + (passive ? 0.5 : 0) + (holdsOrb(s, me, 'umbra') ? 0.5 * this.p.eclipseAmbition : 0));
    if (!holdsOrb(s, me, 'umbra')) add('umbra', 0.3 + (passive ? 0.4 : 0) + (holdsOrb(s, me, 'aurum') ? 0.5 * this.p.eclipseAmbition : 0));

    const hurt = w.vit < 55;
    if (this.phase >= 2) add('starfall', 0.35 * (this.phase - 1));
    if (this.phase >= 3) add('crescent', 0.3);
    add('dart', 0.4 + (wardUp ? 0.9 : 0));
    add('riptide', 0.3 + (fw.state === 'idle' ? 0.1 : 0) + (!chilled && !cooldownLeft(s, me, 'cinder') ? 0.35 : 0));
    add('crescent', 0.4);
    add('fangs', 0.35);
    add('starfall', 0.3 + (fw.lane !== 1 ? 0.1 : 0));
    if (w.vit < 78) add('heal', hurt ? 1.5 : 0.5);
    if (!(s.tick < w.aegisUntil)) add('aegis', (hurt ? 0.5 : 0.05) + (fw.state === 'windup' ? 0.4 : 0));

    // variety: reward spells I have not cast lately (Spellweave)
    for (const sp of score.keys()) {
      if (!recent.includes(sp)) score.set(sp, score.get(sp)! + 0.25);
      if (recent.slice(-2).every((r) => r === sp) && recent.length >= 2) score.set(sp, score.get(sp)! - 0.5);
    }
    if (lowAether) for (const sp of score.keys()) if (sp !== 'ward') score.set(sp, score.get(sp)! * 0.6);

    let best: SpellId | null = null;
    let bv = 0.12;
    for (const [sp, v] of score) {
      const val = v * (1 + (this.rng() - 0.5) * 2 * this.p.noise);
      if (val > bv) { bv = val; best = sp; }
    }
    if (best) this.go(s, cmds, best);
  }
}

/** Scripted opponent that only chains orbs into Eclipse Rend and never reacts. Used by balance tests. */
export class EclipseSpammer implements Bot {
  private plan: { spell: SpellId; start: number; ticks: number } | null = null;
  constructor(public me: PlayerId) {}
  observe(): void {}
  act(s: DuelState): Cmd[] {
    const w = s.w[this.me];
    const cmds: Cmd[] = [];
    if (s.tick <= 1) cmds.push({ t: 'oath', oath: 'echoes' });
    if (w.state === 'dead' || s.over) return cmds;
    if (this.plan) {
      if (w.state !== 'drawing') this.plan = null;
      else if (s.tick - this.plan.start >= this.plan.ticks) {
        cmds.push({ t: 'cast', spell: this.plan.spell, tier: 'perfect' });
        this.plan = null;
      }
      return cmds;
    }
    if (w.state !== 'idle') return cmds;
    let sp: SpellId | null = null;
    if (hasBothOrbs(s, this.me)) sp = 'eclipse';
    else if (!holdsOrb(s, this.me, 'aurum') && cooldownLeft(s, this.me, 'aurum') === 0) sp = 'aurum';
    else if (!holdsOrb(s, this.me, 'umbra') && cooldownLeft(s, this.me, 'umbra') === 0) sp = 'umbra';
    if (sp && cooldownLeft(s, this.me, sp) === 0 && w.aether >= spellCost(s, this.me, sp, 'perfect')) {
      this.plan = { spell: sp, start: s.tick, ticks: DRAW_TICKS[sp] };
      cmds.push({ t: 'drawStart' });
    }
    return cmds;
  }
}

export type { Lane };
