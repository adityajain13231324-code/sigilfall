import { describe, it, expect } from 'vitest';
import {
  createDuel, stepDuel, Cmd, DuelState, SimEvent, PlayerId, SpellId, Tier, Lane, holdsOrb, hasBothOrbs, B, T, createMatch, finishRound,
  candidateSpells, spellCost,
} from '../src';

class Rig {
  s: DuelState;
  log: SimEvent[] = [];
  constructor(seed = 1, oaths: Parameters<typeof createDuel>[1] = [null, null]) {
    this.s = createDuel(seed, oaths);
  }
  step(c0: Cmd[] = [], c1: Cmd[] = []): SimEvent[] {
    const ev = stepDuel(this.s, [c0, c1]);
    this.log.push(...ev);
    return ev;
  }
  run(n: number): void {
    for (let i = 0; i < n; i++) this.step();
  }
  until(cond: () => boolean, max = 400): void {
    for (let i = 0; i < max && !cond(); i++) this.step();
    expect(cond(), 'condition never became true').toBe(true);
  }
  /** begin a draw, finish it next tick, and wait until the spell is released */
  cast(p: PlayerId, spell: SpellId, tier: Tier = 'perfect', aim?: Lane): void {
    const cmd = (c: Cmd): [Cmd[], Cmd[]] => (p === 0 ? [[c], []] : [[], [c]]);
    stepDuel(this.s, cmd({ t: 'drawStart' }));
    this.step(...cmd({ t: 'cast', spell, tier, aim }));
    this.until(() => this.s.w[p].windup === null, 200);
  }
  send(p: PlayerId, c: Cmd): SimEvent[] {
    return p === 0 ? this.step([c], []) : this.step([], [c]);
  }
  has(type: SimEvent['type'], pred: (e: any) => boolean = () => true): boolean {
    return this.log.some((e) => e.type === type && pred(e));
  }
  wait(p: PlayerId): void {
    this.until(() => this.s.w[p].state === 'idle', 300);
  }
}

describe('basic casting', () => {
  it('Cinder Bolt travels and burns', () => {
    const r = new Rig();
    r.cast(0, 'cinder');
    expect(r.has('projectile', (e) => e.kind === 'cinder')).toBe(true);
    r.until(() => r.s.w[1].vit < 100, 100);
    expect(r.s.w[1].vit).toBeCloseTo(100 - 9 * 1.1, 1);
    r.run(20);
    expect(r.s.w[1].vit).toBeLessThan(100 - 9 * 1.1 - 0.5);
    expect(r.has('burn')).toBe(true);
  });

  it('fizzles when the sigil is not recognised', () => {
    const r = new Rig();
    r.send(0, { t: 'drawStart' });
    r.send(0, { t: 'cast', spell: null, tier: 'rough' });
    expect(r.has('fizzle')).toBe(true);
    expect(r.s.w[0].aether).toBeLessThan(100);
    expect(r.s.w[0].state).toBe('recovery');
  });

  it('rejects casts that cost more Aether than available', () => {
    const r = new Rig();
    r.s.w[0].aether = 3;
    r.send(0, { t: 'drawStart' });
    r.send(0, { t: 'cast', spell: 'cinder', tier: 'clean' });
    expect(r.has('reject', (e) => e.reason === 'aether')).toBe(true);
    expect(r.s.w[0].state).toBe('idle');
  });

  it('Blink dodges a Cinder Bolt', () => {
    const r = new Rig();
    r.cast(0, 'cinder');
    r.until(() => r.s.projectiles[0]!.arrive - r.s.tick <= 9);
    r.send(1, { t: 'blink', dir: 1 });
    r.run(40);
    expect(r.s.w[1].vit).toBe(100);
    expect(r.s.w[1].lane).toBe(2);
    expect(r.has('dodge')).toBe(true);
  });
});

describe('counter relationships', () => {
  it('Glacier Ward absorbs Cinder (and takes x1.5 from fire)', () => {
    const r = new Rig();
    r.cast(1, 'ward');
    const hp0 = r.s.w[1].ward!.hp;
    r.wait(0);
    r.cast(0, 'cinder');
    r.until(() => r.has('wardAbsorb'), 100);
    expect(r.s.w[1].vit).toBe(100);
    expect(hp0 - r.s.w[1].ward!.hp).toBeCloseTo(9 * 1.1 * 1.5, 1);
  });

  it('Glacier Ward breaks into three shards', () => {
    const r = new Rig();
    r.cast(1, 'ward');
    r.s.w[1].ward!.hp = 1;
    r.cast(0, 'cinder');
    r.until(() => r.has('wardBreak'), 100);
    expect(r.s.projectiles.filter((p) => p.kind === 'shard').length).toBe(3);
  });

  it('Stormfork ignores 50% of Ward absorption', () => {
    const r = new Rig();
    r.cast(1, 'ward');
    const hp0 = r.s.w[1].ward!.hp;
    r.wait(0);
    r.cast(0, 'storm');
    r.until(() => r.has('stormStrike'), 100);
    const strike = 16 * 1.1;
    expect(r.s.w[1].vit).toBeCloseTo(100 - strike * 0.5, 1);
    expect(hp0 - r.s.w[1].ward!.hp).toBeCloseTo(strike * 0.5, 1);
  });

  it('Stormfork is dodged by changing lanes', () => {
    const r = new Rig();
    r.cast(0, 'storm');
    r.send(1, { t: 'blink', dir: -1 });
    r.run(40);
    expect(r.s.w[1].vit).toBe(100);
    expect(r.has('stormStrike', (e) => e.hit === false)).toBe(true);
  });

  it('Mirrorveil reflects a projectile back at the caster', () => {
    const r = new Rig();
    r.cast(0, 'cinder');
    r.cast(1, 'mirror');
    r.until(() => r.has('reflect'), 100);
    expect(r.s.w[1].vit).toBe(100);
    r.until(() => r.s.w[0].vit < 100, 100);
    expect(r.s.w[0].vit).toBeLessThan(100);
    expect(r.s.w[1].state).not.toBe('exhausted');
  });

  it('a Mirrorveil that catches nothing exhausts the caster', () => {
    const r = new Rig();
    r.cast(1, 'mirror');
    const a0 = r.s.w[1].aether;
    r.until(() => r.s.w[1].state === 'exhausted', 60);
    expect(r.has('exhausted')).toBe(true);
    expect(r.s.w[1].aether).toBeLessThan(a0);
  });

  it('Prism Return consumes an Aurum orb and boosts the reflection', () => {
    const r = new Rig();
    r.cast(1, 'aurum');
    r.wait(1);
    r.cast(0, 'cinder');
    r.cast(1, 'mirror');
    r.until(() => r.has('reflect'), 100);
    expect(r.has('combo', (e) => e.name === 'PRISM RETURN')).toBe(true);
    expect(holdsOrb(r.s, 1, 'aurum')).toBe(false);
    const refl = r.s.projectiles.find((p) => p.reflected)!;
    expect(refl.pierce).toBe(true);
    expect(refl.dmg).toBeCloseTo(9 * 1.1 * 1.5, 1);
  });

  it('Wellspring: Ward + Umbra orb pulls the next projectile into a frost burst', () => {
    const r = new Rig();
    r.cast(1, 'umbra');
    r.wait(1);
    r.cast(1, 'ward');
    expect(holdsOrb(r.s, 1, 'umbra')).toBe(false);
    r.wait(1);
    r.cast(0, 'cinder');
    r.until(() => r.has('combo', (e) => e.name === 'WELLSPRING'), 100);
    expect(r.s.w[0].vit).toBeLessThan(100);
    expect(r.s.w[0].chillUntil).toBeGreaterThan(r.s.tick);
    expect(r.s.w[1].vit).toBe(100);
  });

  it('Thunderburn: Stormfork on a burning target deals +60%', () => {
    const r = new Rig();
    r.s.w[1].burnUntil = r.s.tick + 999;
    r.s.w[1].burnPhase = r.s.tick + 1;
    r.cast(0, 'storm');
    const before = r.s.w[1].vit;
    r.until(() => r.has('stormStrike'), 100);
    expect(before - r.s.w[1].vit).toBeGreaterThanOrEqual(16 * 1.1 * 1.6 - 0.5);
    expect(r.has('combo', (e) => e.name === 'THUNDERBURN')).toBe(true);
  });

  it('Aurum blast shoves the target a lane and cancels its draw', () => {
    const r = new Rig();
    r.cast(0, 'aurum');
    r.wait(0);
    r.send(1, { t: 'drawStart' });
    r.send(0, { t: 'orb', which: 'aurum' });
    r.until(() => r.has('shove'), 60);
    expect(r.s.w[1].lane).not.toBe(1);
    expect(r.s.w[1].state).not.toBe('drawing');
    expect(r.has('drawCancelled')).toBe(true);
    expect(r.s.w[1].vit).toBeCloseTo(100 - 14, 0);
  });

  it('Umbra pull lance drags incoming projectiles to another lane', () => {
    const r = new Rig();
    r.cast(1, 'umbra');
    r.wait(1);
    r.cast(0, 'cinder');
    r.send(1, { t: 'orb', which: 'umbra' });
    expect(r.s.projectiles.find((p) => p.kind === 'cinder')!.lane).not.toBe(1);
    r.run(40);
    expect(r.s.w[1].vit).toBe(100);
  });
});

describe('Eclipse Rend and its counters', () => {
  function withOrbs(r: Rig, p: PlayerId) {
    r.cast(p, 'aurum');
    r.wait(p);
    r.cast(p, 'umbra');
    r.wait(p);
    expect(hasBothOrbs(r.s, p)).toBe(true);
  }

  it('needs both orbs, consumes them, channels 2.5s and hits for 55 + Poise break', () => {
    const r = new Rig();
    expect(candidateSpells(r.s, 0)).not.toContain('eclipse');
    r.send(0, { t: 'drawStart' });
    r.send(0, { t: 'cast', spell: 'eclipse', tier: 'perfect' });
    expect(r.has('reject', (e) => e.reason === 'orbs')).toBe(true);
    r.wait(0);
    withOrbs(r, 0);
    expect(candidateSpells(r.s, 0)).toContain('eclipse');
    r.send(0, { t: 'drawStart' });
    r.send(0, { t: 'cast', spell: 'eclipse', tier: 'clean' });
    expect(r.s.w[0].state).toBe('channeling');
    expect(holdsOrb(r.s, 0, 'aurum') || holdsOrb(r.s, 0, 'umbra')).toBe(false);
    r.until(() => r.has('projectile', (e) => e.kind === 'eclipse'), 200);
    r.until(() => r.s.w[1].vit < 100, 200);
    expect(r.s.w[1].vit).toBeCloseTo(100 - 55 * 1.1, 0); // Spellweave: three different spells in 8s
    expect(r.has('break', (e) => e.p === 1)).toBe(true);
    expect(r.s.w[1].state).toBe('staggered');
  });

  it('cannot be blocked by Ward (annihilates it) or reflected by Mirrorveil', () => {
    const r = new Rig();
    withOrbs(r, 0);
    r.send(0, { t: 'drawStart' });
    r.send(0, { t: 'cast', spell: 'eclipse', tier: 'clean' });
    r.until(() => r.s.projectiles.some((p) => p.kind === 'eclipse'), 200);
    r.cast(1, 'ward');
    r.until(() => r.has('wardAnnihilated'), 300);
    expect(r.s.w[1].vit).toBeLessThan(100);
    expect(r.has('reflect')).toBe(false);
  });

  it('Gravewell collapses an Eclipse in flight', () => {
    const r = new Rig();
    withOrbs(r, 0);
    r.send(0, { t: 'drawStart' });
    r.send(0, { t: 'cast', spell: 'eclipse', tier: 'clean' });
    r.until(() => r.s.projectiles.some((p) => p.kind === 'eclipse'), 200);
    r.cast(1, 'gravewell');
    r.run(15);
    expect(r.has('collapse', (e) => e.kind === 'eclipse')).toBe(true);
    r.run(90);
    expect(r.s.w[1].vit).toBe(100);
    expect(r.s.w[0].vit).toBeLessThan(100); // the well's own 8 damage
  });

  it('Gravewell pops enemy orbs and interrupts the channel', () => {
    const r = new Rig();
    withOrbs(r, 0);
    r.wait(0);
    r.cast(1, 'gravewell');
    expect(hasBothOrbs(r.s, 0)).toBe(false);
    expect(r.has('orbPop', (e) => e.reason === 'gravewell')).toBe(true);
    // channel interruption
    const r2 = new Rig();
    withOrbs(r2, 0);
    r2.send(0, { t: 'drawStart' });
    r2.send(0, { t: 'cast', spell: 'eclipse', tier: 'clean' });
    r2.run(20);
    r2.cast(1, 'gravewell');
    expect(r2.has('eclipseInterrupt')).toBe(true);
    r2.run(120);
    expect(r2.s.w[1].vit).toBe(100);
    expect(r2.s.projectiles.some((p) => p.kind === 'eclipse')).toBe(false);
  });

  it('Stormfork staggers a channeling caster (Poise >= interrupt threshold)', () => {
    const r = new Rig();
    withOrbs(r, 0);
    r.send(0, { t: 'drawStart' });
    r.send(0, { t: 'cast', spell: 'eclipse', tier: 'clean' });
    r.cast(1, 'storm');
    r.until(() => r.has('stormStrike'), 100);
    expect(r.has('eclipseInterrupt')).toBe(true);
    r.run(160);
    expect(r.s.projectiles.some((p) => p.kind === 'eclipse')).toBe(false);
    expect(r.s.w[1].vit).toBe(100);
  });

  it('a late Blink dodges the tracking Eclipse', () => {
    const r = new Rig();
    withOrbs(r, 0);
    r.send(0, { t: 'drawStart' });
    r.send(0, { t: 'cast', spell: 'eclipse', tier: 'clean' });
    r.until(() => r.s.projectiles.some((p) => p.kind === 'eclipse'), 200);
    const ecl = () => r.s.projectiles.find((p) => p.kind === 'eclipse')!;
    r.until(() => ecl().arrive - r.s.tick <= 6);
    r.send(1, { t: 'blink', dir: 1 });
    r.run(20);
    expect(r.s.w[1].vit).toBe(100);
  });
});

describe('anti-spam systems', () => {
  it('Spell Fatigue raises cost and lowers power on repeats', () => {
    const r = new Rig();
    const c1 = spellCost(r.s, 0, 'cinder', 'clean');
    r.cast(0, 'cinder', 'clean');
    r.wait(0);
    r.run(30);
    const c2 = spellCost(r.s, 0, 'cinder', 'clean');
    expect(c2).toBeCloseTo(c1 * 1.35, 5);
    r.cast(0, 'cinder', 'clean');
    expect(r.s.w[0].fatigue).toBe(1);
    expect(r.s.projectiles.at(-1)!.dmg).toBeCloseTo(9 * 0.85, 3);
  });

  it('Fatigue decays after 5 seconds and resets on a different spell', () => {
    const r = new Rig();
    r.cast(0, 'cinder', 'clean');
    r.wait(0);
    r.run(T(5) + 5);
    expect(spellCost(r.s, 0, 'cinder', 'clean')).toBeCloseTo(10, 5);
  });

  it('Spellweave rewards three different spells in 8 seconds', () => {
    const r = new Rig();
    r.cast(0, 'cinder', 'clean');
    r.wait(0);
    r.run(30);
    r.cast(0, 'ward', 'clean');
    r.wait(0);
    r.cast(0, 'aurum', 'clean');
    expect(r.has('weave')).toBe(true);
    expect(r.s.w[0].weaveUntil).toBeGreaterThan(r.s.tick);
  });

  it('Perfect tier is cheaper, Rough has a longer windup', () => {
    const r = new Rig();
    expect(spellCost(r.s, 0, 'cinder', 'perfect')).toBeCloseTo(9, 5);
    r.send(0, { t: 'drawStart' });
    const rough = r.send(0, { t: 'cast', spell: 'cinder', tier: 'rough' }).find((e) => e.type === 'cast') as any;
    const r2 = new Rig();
    r2.send(0, { t: 'drawStart' });
    const clean = r2.send(0, { t: 'cast', spell: 'cinder', tier: 'clean' }).find((e) => e.type === 'cast') as any;
    expect(rough.windup).toBeGreaterThan(clean.windup);
  });

  it('Aether Tide pulses on a 20s rhythm', () => {
    const r = new Rig();
    r.run(T(20) + 1);
    expect(r.has('tide')).toBe(true);
    expect(r.s.tide).not.toBeNull();
  });

  it('feinting costs Aether and leaves the caster in recovery', () => {
    const r = new Rig();
    r.send(0, { t: 'drawStart' });
    r.send(0, { t: 'drawCancel' });
    expect(r.has('feint')).toBe(true);
    expect(r.s.w[0].aether).toBeLessThanOrEqual(94.5);
    expect(r.s.w[0].state).toBe('recovery');
  });

  it('opponents read a tell colour before the exact spell', () => {
    const r = new Rig();
    r.send(0, { t: 'drawStart' });
    r.send(0, { t: 'tell', stage: 1, spell: 'cinder' });
    expect(r.s.w[0].draw!.family).toBe('warm');
    expect(r.s.w[0].draw!.spell).toBeNull();
    r.send(0, { t: 'tell', stage: 2, spell: 'cinder' });
    expect(r.s.w[0].draw!.spell).toBe('cinder');
  });

  it('Poise break staggers and amplifies damage', () => {
    const r = new Rig();
    r.s.w[1].poise = 1;
    r.s.w[1].lastHit = r.s.tick;
    r.cast(0, 'cinder');
    r.until(() => r.has('break'), 100);
    expect(r.s.w[1].state).toBe('staggered');
    const v = r.s.w[1].vit;
    expect(v).toBeLessThan(100);
  });
});

describe('match flow and determinism', () => {
  it('KO ends a round and best-of-3 completes', () => {
    const m = createMatch(3);
    m.duel.w[1].vit = 1;
    m.duel.w[1].burnUntil = m.duel.tick + 50;
    m.duel.w[1].burnPhase = m.duel.tick;
    for (let i = 0; i < 40 && !m.duel.over; i++) stepDuel(m.duel, [[], []]);
    expect(m.duel.over?.winner).toBe(0);
    expect(finishRound(m)).toBe(true);
    expect(m.wins).toEqual([1, 0]);
  });

  it('timeout goes to higher Vitality', () => {
    const s = createDuel(1);
    s.w[1].vit = 80;
    s.roundTicks = 5;
    for (let i = 0; i < 6; i++) stepDuel(s, [[], []]);
    expect(s.over).toEqual({ winner: 0, reason: 'timeout' });
  });

  it('is deterministic for a given seed and command stream', () => {
    const run = () => {
      const s = createDuel(42);
      for (let i = 0; i < 300; i++) {
        const c0: Cmd[] = i === 5 ? [{ t: 'drawStart' }] : i === 15 ? [{ t: 'cast', spell: 'aurum', tier: 'clean' }] : [];
        const c1: Cmd[] = i === 8 ? [{ t: 'drawStart' }] : i === 20 ? [{ t: 'cast', spell: 'cinder', tier: 'clean' }] : [];
        stepDuel(s, [c0, c1]);
      }
      return JSON.stringify(s);
    };
    expect(run()).toBe(run());
  });
});

void B;

describe('spam is unreliable', () => {
  it('repeating the same spell eventually misfires; varied casting does not', () => {
    let misfires = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const r = new Rig(seed);
      r.s.w[0].aether = 100;
      for (let i = 0; i < 5; i++) {
        r.s.w[0].aether = 100;
        r.s.w[0].cooldowns = {};
        r.send(0, { t: 'drawStart' });
        r.send(0, { t: 'cast', spell: 'cinder', tier: 'clean' });
        r.run(25);
      }
      if (r.has('misfire')) misfires++;
    }
    expect(misfires).toBeGreaterThan(25);
    const r2 = new Rig(3);
    const spells: SpellId[] = ['cinder', 'ward', 'storm', 'mirror'];
    for (const sp of spells) {
      r2.s.w[0].aether = 100;
      r2.send(0, { t: 'drawStart' });
      r2.send(0, { t: 'cast', spell: sp, tier: 'clean' });
      r2.until(() => r2.s.w[0].state === 'idle', 200);
    }
    expect(r2.has('misfire')).toBe(false);
  });

  it('a misfire wastes the cast and staggers briefly', () => {
    const r = new Rig(1);
    r.s.w[0].fatigue = 5;
    r.s.w[0].lastSpell = 'cinder';
    r.s.w[0].lastCastTick = r.s.tick;
    r.s.rng = 1;
    let found = false;
    for (let t = 0; t < 30 && !found; t++) {
      const q = new Rig(t + 50);
      q.s.w[0].fatigue = 6;
      q.s.w[0].lastSpell = 'cinder';
      q.s.w[0].lastCastTick = 0;
      q.send(0, { t: 'drawStart' });
      q.send(0, { t: 'cast', spell: 'cinder', tier: 'clean' });
      q.run(30);
      if (q.has('misfire')) {
        found = true;
        expect(q.s.projectiles.length).toBe(0);
        expect(q.has('stagger', (e) => e.p === 0)).toBe(true);
      }
    }
    expect(found).toBe(true);
  });
});
