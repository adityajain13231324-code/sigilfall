import bal from './balance.json';
import type {
  Cmd, DuelState, Lane, Oath, PlayerId, ProjKind, Projectile, RejectReason, SimEvent, SpellId, Tier, Wizard, Windup,
} from './types';
import { TELL_FAMILY } from './types';

export const B = bal;
export const TICK_RATE = bal.tickRate;
export const T = (sec: number): number => Math.round(sec * bal.tickRate);
export const other = (p: PlayerId): PlayerId => (p === 0 ? 1 : 0);

interface Ctx {
  s: DuelState;
  ev: SimEvent[];
}

export const SPELLS: SpellId[] = ['cinder', 'storm', 'ward', 'mirror', 'gravewell', 'aurum', 'umbra', 'eclipse'];

function newWizard(): Wizard {
  return {
    vit: bal.vitality, aether: bal.aether, poise: bal.poise, lane: 1, state: 'idle', stateUntil: 0, oath: null,
    windup: null, draw: null, cooldowns: {}, blinkReady: 0, blinkFrom: 1, blinkTo: 1, invulnUntil: 0, regenFrom: 0,
    lastHit: -9999, brokenUntil: 0, openUntil: 0, orbs: { aurum: 0, umbra: 0 }, ward: null, mirror: null, burnUntil: 0,
    burnPhase: 0, chillUntil: 0, lastSpell: null, lastCastTick: -9999, fatigue: 0, recent: [], weaveUntil: 0,
    echoNext: false, casts: 0, stats: { damageDealt: 0, casts: {} },
  };
}

export function createDuel(seed = 1, oaths: [Oath | null, Oath | null] = [null, null]): DuelState {
  const s: DuelState = {
    tick: 0, seed, rng: seed >>> 0, nextId: 1, w: [newWizard(), newWizard()], projectiles: [], strikes: [], wells: [],
    tide: null, nextTide: T(bal.tide.everySeconds), over: null, roundTicks: T(bal.roundSeconds),
  };
  s.w[0].oath = oaths[0];
  s.w[1].oath = oaths[1];
  return s;
}

function rand(s: DuelState): number {
  s.rng = (s.rng + 0x6d2b79f5) >>> 0;
  let t = s.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const school = (sp: SpellId): string => (sp === 'aurum' || sp === 'umbra' ? 'orb' : sp);

// ---- queries (used by AI, HUD, recognizer context) -----------------------------------------------

export const holdsOrb = (s: DuelState, p: PlayerId, which: 'aurum' | 'umbra'): boolean => s.w[p].orbs[which] > s.tick;
export const hasBothOrbs = (s: DuelState, p: PlayerId): boolean => holdsOrb(s, p, 'aurum') && holdsOrb(s, p, 'umbra');
export const isBusy = (w: Wizard): boolean => w.state !== 'idle' && w.state !== 'drawing';
export const cooldownLeft = (s: DuelState, p: PlayerId, sp: SpellId): number => Math.max(0, (s.w[p].cooldowns[sp] ?? 0) - s.tick);
export const eta = (s: DuelState, pr: Projectile): number => Math.max(0, pr.arrive - s.tick);

/** Spells the recognizer should consider right now (context-aware recognition). */
export function candidateSpells(s: DuelState, p: PlayerId): SpellId[] {
  return SPELLS.filter((sp) => sp !== 'eclipse' || hasBothOrbs(s, p));
}

function fatigueStacks(s: DuelState, w: Wizard, spell: SpellId): number {
  return w.lastSpell === spell && s.tick - w.lastCastTick <= T(bal.fatigue.decaySeconds) ? w.fatigue + 1 : 0;
}

export function spellCost(s: DuelState, p: PlayerId, spell: SpellId, tier: Tier, quick = false): number {
  const w = s.w[p];
  const base = spell === 'eclipse' ? bal.spells.eclipse.aether : bal.spells[spell].aether;
  let c = base * (1 + bal.fatigue.costPerStack * fatigueStacks(s, w, spell)) * bal.tiers[tier].cost;
  if (s.tide && s.tick < s.tide.until && school(s.tide.spell) === school(spell)) c *= bal.tide.costMult;
  if (w.echoNext && w.oath === 'echoes') c *= bal.oaths.echoes.nextCostMult;
  if (quick) c *= bal.quickCastCostMult;
  return c;
}

// ---- stepping ---------------------------------------------------------------------------------

export function stepDuel(s: DuelState, cmds: [Cmd[], Cmd[]]): SimEvent[] {
  const ev: SimEvent[] = [];
  if (s.over) return ev;
  const ctx: Ctx = { s, ev };
  s.tick++;
  for (const p of [0, 1] as PlayerId[]) for (const c of cmds[p]) applyCmd(ctx, p, c);
  for (const p of [0, 1] as PlayerId[]) tickWizard(ctx, p);
  tickWells(ctx);
  tickStrikes(ctx);
  tickProjectiles(ctx);
  tickTide(ctx);
  checkOver(ctx);
  return ev;
}

function reject(ctx: Ctx, p: PlayerId, reason: RejectReason): void {
  ctx.ev.push({ type: 'reject', p, reason });
}

function applyCmd(ctx: Ctx, p: PlayerId, c: Cmd): void {
  const { s, ev } = ctx;
  const w = s.w[p];
  if (w.state === 'dead') return;
  switch (c.t) {
    case 'oath':
      if (s.tick <= 2 && w.oath === null) {
        w.oath = c.oath;
        ev.push({ type: 'oath', p, oath: c.oath });
      }
      break;
    case 'drawStart':
      if (w.state !== 'idle') return reject(ctx, p, 'busy');
      w.state = 'drawing';
      w.draw = { start: s.tick, family: null, spell: null };
      break;
    case 'tell':
      if (w.state === 'drawing' && w.draw) {
        if (c.stage === 1) w.draw.family = TELL_FAMILY[c.spell];
        else w.draw.spell = c.spell;
      }
      break;
    case 'drawCancel':
      if (w.state !== 'drawing') return;
      w.aether = Math.max(0, w.aether - bal.feintAether);
      w.draw = null;
      setState(w, 'recovery', s.tick + T(bal.feintRecovery));
      ev.push({ type: 'feint', p });
      break;
    case 'blink':
      doBlink(ctx, p, c.dir);
      break;
    case 'orb':
      releaseOrb(ctx, p, c.which, c.aim);
      break;
    case 'cast':
      doCast(ctx, p, c);
      break;
  }
}

function setState(w: Wizard, st: Wizard['state'], until: number): void {
  w.state = st;
  w.stateUntil = until;
}

function doBlink(ctx: Ctx, p: PlayerId, dir: -1 | 1): void {
  const { s, ev } = ctx;
  const w = s.w[p];
  if (w.state !== 'idle' && w.state !== 'drawing') return reject(ctx, p, 'busy');
  if (s.tick < w.blinkReady) return reject(ctx, p, 'cooldown');
  const to = w.lane + dir;
  if (to < 0 || to > 2) return reject(ctx, p, 'blink');
  if (w.aether < bal.blink.aether) return reject(ctx, p, 'aether');
  w.aether -= bal.blink.aether;
  w.draw = null;
  w.blinkFrom = w.lane;
  w.blinkTo = to as Lane;
  w.invulnUntil = s.tick + bal.blink.invulnTicks;
  w.blinkReady = s.tick + T(bal.blink.cooldown);
  setState(w, 'blinking', s.tick + Math.max(1, Math.ceil(bal.blink.travel * bal.tickRate)));
  ev.push({ type: 'blink', p, from: w.blinkFrom, to: w.blinkTo });
}

function doCast(ctx: Ctx, p: PlayerId, c: Extract<Cmd, { t: 'cast' }>): void {
  const { s, ev } = ctx;
  const w = s.w[p];
  const quick = !!c.quick;
  if (quick) {
    if (w.state !== 'idle') return reject(ctx, p, 'busy');
  } else if (w.state !== 'drawing' || !w.draw) {
    return reject(ctx, p, 'busy');
  }
  const late = !quick && w.draw !== null && s.tick - w.draw.start > T(bal.drawWindow) + bal.drawGraceTicks;
  if (c.spell === null || late) {
    w.draw = null;
    w.aether = Math.max(0, w.aether - bal.fizzleAether);
    setState(w, 'recovery', s.tick + T(bal.fizzleRecovery));
    ev.push({ type: 'fizzle', p });
    return;
  }
  const spell = c.spell;
  const tier: Tier = quick ? 'rough' : c.tier;
  const bail = (r: RejectReason) => {
    w.draw = null;
    setState(w, 'idle', 0);
    reject(ctx, p, r);
  };
  if ((w.cooldowns[spell] ?? 0) > s.tick) return bail('cooldown');
  if (spell === 'eclipse' && !hasBothOrbs(s, p)) return bail('orbs');
  if ((spell === 'aurum' || spell === 'umbra') && holdsOrb(s, p, spell)) return bail('held');
  const stacks = fatigueStacks(s, w, spell);
  const cost = spellCost(s, p, spell, tier, quick);
  if (w.aether < cost) return bail('aether');

  w.aether -= cost;
  w.regenFrom = s.tick + T(bal.aetherRegenPause);
  const hadEcho = w.echoNext;
  w.echoNext = false;
  if (w.oath === 'echoes' && tier === 'perfect' && !quick) w.echoNext = true;
  void hadEcho;
  w.fatigue = stacks;
  w.lastSpell = spell;
  w.lastCastTick = s.tick;
  w.casts++;
  w.stats.casts[spell] = (w.stats.casts[spell] ?? 0) + 1;
  const spec = bal.spells[spell] as { cooldown: number };
  w.cooldowns[spell] = s.tick + T(spec.cooldown);
  w.recent.push({ spell, tick: s.tick });
  w.recent = w.recent.filter((r) => s.tick - r.tick <= T(bal.weave.windowSeconds));
  if (new Set(w.recent.map((r) => r.spell)).size >= bal.weave.distinct && s.tick >= w.weaveUntil) {
    w.weaveUntil = s.tick + T(bal.weave.durationSeconds);
    ev.push({ type: 'weave', p });
  }
  const power =
    bal.tiers[tier].power * Math.max(bal.fatigue.minPower, 1 - bal.fatigue.powerPerStack * stacks) * (s.tick < w.weaveUntil ? bal.weave.damageMult : 1);
  let windSec = bal.spells[spell].windup + bal.tiers[tier].windupAdd;
  if (spell === 'cinder' && w.oath === 'embers') windSec -= bal.oaths.embers.cinderWindupLess;
  let windTicks = Math.max(2, Math.round(windSec * bal.tickRate));
  if (s.tick < w.chillUntil && spell !== 'eclipse') windTicks = Math.round(windTicks * 1.25);
  const wu: Windup = { spell, tier, start: s.tick, end: s.tick + windTicks, power, aim: c.aim, quick };
  w.windup = wu;
  w.draw = null;
  if (spell === 'eclipse') {
    w.orbs.aurum = 0;
    w.orbs.umbra = 0;
    ev.push({ type: 'orbPop', p, which: 'aurum', reason: 'fusion' }, { type: 'orbPop', p, which: 'umbra', reason: 'fusion' });
    ev.push({ type: 'eclipseStart', p });
    setState(w, 'channeling', wu.end);
  } else {
    setState(w, 'windup', wu.end);
  }
  ev.push({ type: 'cast', p, spell, tier, windup: windTicks, quick });
}

function newProj(ctx: Ctx, owner: PlayerId, kind: ProjKind, lane: Lane, travelTicks: number, dmg: number, poise: number, extra: Partial<Projectile> = {}): Projectile {
  const { s, ev } = ctx;
  const pr: Projectile = {
    id: s.nextId++, owner, kind, lane, born: s.tick, arrive: s.tick + Math.max(2, travelTicks), dmg, poise, burn: false,
    pierce: false, noReflect: false, reflected: false, ...extra,
  };
  s.projectiles.push(pr);
  ev.push({ type: 'projectile', p: owner, id: pr.id, kind, lane, eta: pr.arrive - s.tick });
  return pr;
}

function release(ctx: Ctx, p: PlayerId, wu: Windup): void {
  const { s, ev } = ctx;
  const w = s.w[p];
  const foe = other(p);
  const ew = s.w[foe];
  const lane: Lane = wu.aim ?? ew.lane;
  const sp = wu.spell;
  let recovery = 'recovery' in bal.spells[sp] ? (bal.spells[sp] as { recovery: number }).recovery : 0;
  ev.push({ type: 'release', p, spell: sp, lane });
  switch (sp) {
    case 'cinder': {
      const c = bal.spells.cinder;
      newProj(ctx, p, 'cinder', lane, T(c.travel), c.damage * wu.power, c.poise, { burn: true });
      break;
    }
    case 'storm': {
      const c = bal.spells.storm;
      const st = { id: s.nextId++, owner: p, lane, born: s.tick, hit: s.tick + T(c.telegraph), dmg: c.damage * wu.power, poise: c.poise };
      s.strikes.push(st);
      ev.push({ type: 'stormMark', p, lane, hit: st.hit });
      break;
    }
    case 'ward': {
      const c = bal.spells.ward;
      const max = c.absorb + (w.oath === 'stillness' ? bal.oaths.stillness.wardAbsorbExtra : 0);
      const wellspring = holdsOrb(s, p, 'umbra');
      if (wellspring) {
        w.orbs.umbra = 0;
        ev.push({ type: 'orbPop', p, which: 'umbra', reason: 'release' });
      }
      w.ward = { hp: max * Math.min(1.1, wu.power), max, until: s.tick + T(c.seconds), wellspring };
      ev.push({ type: 'ward', p });
      break;
    }
    case 'mirror': {
      const c = bal.spells.mirror;
      const until = s.tick + T(c.veilSeconds);
      w.mirror = { start: s.tick, until, hit: false, prism: false };
      recovery = c.veilSeconds;
      ev.push({ type: 'mirror', p });
      break;
    }
    case 'gravewell': {
      const c = bal.spells.gravewell;
      s.wells.push({ id: s.nextId++, owner: p, born: s.tick, until: s.tick + T(c.wellSeconds) });
      ev.push({ type: 'gravewell', p });
      for (const which of ['aurum', 'umbra'] as const) {
        if (ew.orbs[which] > s.tick) {
          ew.orbs[which] = 0;
          ev.push({ type: 'orbPop', p: foe, which, reason: 'gravewell' });
        }
      }
      if (ew.state === 'channeling') interrupt(ctx, foe, T(1.0));
      damage(ctx, foe, c.damage * wu.power, 0, 'gravewell', ew.lane, p);
      w.openUntil = s.tick + T(c.recovery);
      break;
    }
    case 'aurum':
    case 'umbra': {
      const c = bal.spells[sp];
      w.orbs[sp] = s.tick + T(c.orbSeconds);
      ev.push({ type: 'orbCreated', p, which: sp });
      break;
    }
    case 'eclipse': {
      const c = bal.spells.eclipse;
      newProj(ctx, p, 'eclipse', lane, T(c.travel), c.damage * wu.power, bal.poise, { noReflect: true });
      ev.push({ type: 'combo', p, name: 'ECLIPSE' });
      break;
    }
  }
  w.windup = null;
  if (recovery > 0) setState(w, 'recovery', s.tick + T(recovery));
  else setState(w, 'idle', 0);
}

function releaseOrb(ctx: Ctx, p: PlayerId, which: 'aurum' | 'umbra', aim?: Lane): void {
  const { s, ev } = ctx;
  const w = s.w[p];
  if (w.state !== 'idle') return reject(ctx, p, 'busy');
  if (!holdsOrb(s, p, which)) return reject(ctx, p, 'noOrb');
  const ew = s.w[other(p)];
  const lane: Lane = aim ?? ew.lane;
  const power = s.tick < w.weaveUntil ? bal.weave.damageMult : 1;
  w.orbs[which] = 0;
  ev.push({ type: 'orbPop', p, which, reason: 'release' });
  if (which === 'aurum') {
    const c = bal.spells.aurum;
    newProj(ctx, p, 'blast', lane, T(c.travel), c.damage * power, c.poise);
  } else {
    const c = bal.spells.umbra;
    const pull: Lane = aim ?? (w.lane >= 1 ? 0 : 2);
    for (const pr of s.projectiles) if (pr.owner !== p && pr.kind !== 'eclipse') pr.lane = pull;
    newProj(ctx, p, 'lance', lane, T(c.travel), c.damage * power, c.poise);
  }
  setState(w, 'recovery', s.tick + T(bal.spells.orbRelease.recovery));
}

// ---- per-tick wizard update --------------------------------------------------------------------

function tickWizard(ctx: Ctx, p: PlayerId): void {
  const { s, ev } = ctx;
  const w = s.w[p];
  if (w.state === 'dead') return;

  // orbs expire
  for (const which of ['aurum', 'umbra'] as const) {
    if (w.orbs[which] !== 0 && s.tick >= w.orbs[which]) {
      w.orbs[which] = 0;
      ev.push({ type: 'orbPop', p, which, reason: 'expire' });
    }
  }
  if (w.ward && s.tick >= w.ward.until) w.ward = null;
  if (w.mirror && s.tick >= w.mirror.until) {
    if (!w.mirror.hit) {
      const half = w.oath === 'stillness' ? bal.oaths.stillness.mirrorPenaltyMult : 1;
      w.aether = Math.max(0, w.aether - bal.spells.mirror.exhaustAether * half);
      setState(w, 'exhausted', s.tick + Math.round(T(bal.spells.mirror.exhaustSeconds) * half));
      ev.push({ type: 'exhausted', p });
    }
    w.mirror = null;
  }
  // burn
  if (s.tick < w.burnUntil && (s.tick - w.burnPhase) % 15 === 0 && s.tick !== w.burnPhase) {
    w.vit = Math.max(0, w.vit - bal.spells.cinder.burnDps / 2);
    ev.push({ type: 'hit', p, kind: 'burn', dmg: bal.spells.cinder.burnDps / 2, poise: 0, lane: w.lane });
    if (w.vit <= 0) w.state = 'dead';
  }
  // regen
  if (s.tick >= w.regenFrom && w.state !== 'dead') {
    const mult = s.tick < w.weaveUntil ? bal.weave.regenMult : 1;
    w.aether = Math.min(bal.aether, w.aether + (bal.aetherRegen * mult) / bal.tickRate);
  }
  if (w.brokenUntil > 0 && s.tick >= w.brokenUntil) {
    w.brokenUntil = 0;
    w.poise = bal.poiseAfterBreak;
  } else if (w.brokenUntil === 0 && s.tick - w.lastHit >= T(bal.poiseRegenDelay)) {
    w.poise = Math.min(bal.poise, w.poise + bal.poiseRegen / bal.tickRate);
  }
  if (s.tick - w.lastCastTick > T(bal.fatigue.decaySeconds)) w.fatigue = 0;

  // state machine
  switch (w.state) {
    case 'drawing':
      if (w.draw && s.tick - w.draw.start > T(bal.drawWindow) + bal.drawGraceTicks * 3) {
        w.draw = null;
        w.aether = Math.max(0, w.aether - bal.fizzleAether);
        setState(w, 'recovery', s.tick + T(bal.fizzleRecovery));
        ev.push({ type: 'fizzle', p });
      }
      break;
    case 'windup':
    case 'channeling':
      if (w.windup && s.tick >= w.windup.end) release(ctx, p, w.windup);
      break;
    case 'blinking':
      if (s.tick >= w.stateUntil) {
        w.lane = w.blinkTo;
        setState(w, 'idle', 0);
      }
      break;
    case 'recovery':
    case 'staggered':
    case 'exhausted':
      if (s.tick >= w.stateUntil) setState(w, 'idle', 0);
      break;
    default:
      break;
  }
}

function interrupt(ctx: Ctx, p: PlayerId, staggerTicks: number): void {
  const { s, ev } = ctx;
  const w = s.w[p];
  if (w.state === 'channeling') ev.push({ type: 'eclipseInterrupt', p });
  w.windup = null;
  w.draw = null;
  setState(w, 'staggered', s.tick + staggerTicks);
  ev.push({ type: 'interrupt', p }, { type: 'stagger', p, ticks: staggerTicks });
}

/** Apply damage + poise to `target`. `src` is the attacker (for stats). */
function damage(ctx: Ctx, target: PlayerId, amount: number, poiseDmg: number, kind: Extract<SimEvent, { type: 'hit' }>['kind'], lane: Lane, src: PlayerId): number {
  const { s, ev } = ctx;
  const w = s.w[target];
  if (w.state === 'dead') return 0;
  let dmg = amount;
  if (w.brokenUntil > s.tick) dmg *= bal.breakDamageMult;
  if (w.openUntil > s.tick) dmg *= bal.spells.gravewell.openDamageMult;
  w.vit = Math.max(0, w.vit - dmg);
  s.w[src].stats.damageDealt += dmg;
  w.lastHit = s.tick;
  ev.push({ type: 'hit', p: target, kind, dmg, poise: poiseDmg, lane });
  if (w.vit <= 0) {
    w.state = 'dead';
    w.windup = null;
    w.draw = null;
    return dmg;
  }
  if (poiseDmg > 0) {
    w.poise -= poiseDmg;
    if (w.poise <= 0 && w.brokenUntil === 0) {
      w.poise = 0;
      w.windup = null;
      w.draw = null;
      w.brokenUntil = s.tick + T(bal.breakSeconds);
      setState(w, 'staggered', w.brokenUntil);
      ev.push({ type: 'break', p: target }, { type: 'stagger', p: target, ticks: T(bal.breakSeconds) });
    } else if (poiseDmg >= bal.interruptPoise && (w.state === 'windup' || w.state === 'channeling')) {
      interrupt(ctx, target, T(w.state === 'channeling' ? 1.0 : 0.6));
    }
  }
  return dmg;
}

// ---- storms, wells, projectiles ----------------------------------------------------------------

function tickStrikes(ctx: Ctx): void {
  const { s, ev } = ctx;
  const keep: typeof s.strikes = [];
  for (const st of s.strikes) {
    if (st.hit > s.tick) {
      keep.push(st);
      continue;
    }
    const foe = other(st.owner);
    const ew = s.w[foe];
    const c = bal.spells.storm;
    const stands = ew.lane === st.lane && s.tick >= ew.invulnUntil && ew.state !== 'dead';
    ev.push({ type: 'stormStrike', p: st.owner, lane: st.lane, hit: stands });
    if (!stands) continue;
    let dmg = st.dmg;
    let combo = false;
    if (s.tick < ew.burnUntil) {
      dmg *= c.thunderburnMult;
      combo = true;
    }
    let through = dmg;
    if (ew.ward) {
      const absorbed = Math.min(ew.ward.hp, dmg * (1 - c.wardPassthrough));
      ew.ward.hp -= absorbed;
      through -= absorbed;
      ev.push({ type: 'wardAbsorb', p: foe, hp: ew.ward.hp, crit: true });
      if (ew.ward.hp <= 0) breakWard(ctx, foe);
    }
    if (through > 0.01) damage(ctx, foe, through, st.poise, 'storm', st.lane, st.owner);
    if (combo) {
      ev.push({ type: 'combo', p: st.owner, name: 'THUNDERBURN' });
      if (ew.state !== 'dead' && ew.state !== 'staggered') {
        ew.windup = null;
        ew.draw = null;
        setState(ew, 'staggered', s.tick + T(c.arcStun));
        ev.push({ type: 'stagger', p: foe, ticks: T(c.arcStun) });
      }
    }
  }
  s.strikes = keep;
}

function tickWells(ctx: Ctx): void {
  const { s, ev } = ctx;
  s.wells = s.wells.filter((wl) => s.tick <= wl.until);
  if (!s.wells.length) return;
  const reach = T(bal.spells.gravewell.radiusSeconds);
  s.projectiles = s.projectiles.filter((pr) => {
    const pulled = s.wells.some((wl) => wl.owner !== pr.owner && pr.arrive - s.tick <= reach);
    if (pulled) ev.push({ type: 'collapse', p: other(pr.owner), id: pr.id, kind: pr.kind, lane: pr.lane });
    return !pulled;
  });
}

function breakWard(ctx: Ctx, p: PlayerId): void {
  const { s, ev } = ctx;
  const w = s.w[p];
  const c = bal.spells.ward;
  w.ward = null;
  ev.push({ type: 'wardBreak', p });
  for (const lane of [0, 1, 2] as Lane[]) {
    newProj(ctx, p, 'shard', lane, T(c.shardTravel), c.shardDamage, c.shardPoise);
  }
}

function tickProjectiles(ctx: Ctx): void {
  const { s, ev } = ctx;
  const live: Projectile[] = [];
  const queue = s.projectiles;
  s.projectiles = [];
  for (const pr of queue) {
    if (pr.kind === 'eclipse') {
      const ew = s.w[other(pr.owner)];
      const every = Math.max(1, T(bal.spells.eclipse.trackEvery));
      if ((s.tick - pr.born) % every === 0 && pr.arrive - s.tick > bal.spells.eclipse.trackStopTicks && ew.lane !== pr.lane) {
        pr.lane = (pr.lane + (ew.lane > pr.lane ? 1 : -1)) as Lane;
      }
    }
    if (pr.arrive > s.tick) {
      live.push(pr);
      continue;
    }
    resolveImpact(ctx, pr, live);
  }
  s.projectiles = live.concat(s.projectiles);
}

function resolveImpact(ctx: Ctx, pr: Projectile, live: Projectile[]): void {
  const { s, ev } = ctx;
  const defId = other(pr.owner);
  const def = s.w[defId];
  if (def.state === 'dead') return;

  // Glacier Ward spans every lane
  if (def.ward && !pr.pierce) {
    if (pr.kind === 'eclipse') {
      def.ward = null;
      ev.push({ type: 'wardAnnihilated', p: defId });
    } else if (def.ward.wellspring) {
      def.ward.wellspring = false;
      ev.push({ type: 'combo', p: defId, name: 'WELLSPRING' });
      damage(ctx, pr.owner, 8, 0, 'wellspring', s.w[pr.owner].lane, defId);
      s.w[pr.owner].chillUntil = s.tick + T(3);
      ev.push({ type: 'chill', p: pr.owner });
      return;
    } else {
      const mult = pr.kind === 'cinder' ? bal.spells.cinder.wardMult : 1;
      def.ward.hp -= pr.dmg * mult;
      ev.push({ type: 'wardAbsorb', p: defId, hp: Math.max(0, def.ward.hp), crit: mult > 1 });
      if (def.ward.hp <= 0) breakWard(ctx, defId);
      return;
    }
  }
  if (def.lane !== pr.lane) {
    ev.push({ type: 'dodge', p: defId, id: pr.id });
    return;
  }
  if (s.tick < def.invulnUntil) {
    ev.push({ type: 'dodge', p: defId, id: pr.id });
    return;
  }
  if (def.mirror && !pr.noReflect && pr.kind !== 'eclipse') {
    const prism = def.orbs.aurum > s.tick;
    if (prism) {
      def.orbs.aurum = 0;
      ev.push({ type: 'orbPop', p: defId, which: 'aurum', reason: 'release' }, { type: 'combo', p: defId, name: 'PRISM RETURN' });
    }
    def.mirror.hit = true;
    const att = s.w[pr.owner];
    const back: Projectile = {
      ...pr,
      id: s.nextId++, owner: defId, lane: att.lane, born: s.tick,
      arrive: s.tick + Math.max(3, Math.round((pr.arrive - pr.born) / bal.spells.mirror.returnSpeed)),
      dmg: pr.dmg * (prism ? bal.spells.mirror.prismMult : 1), pierce: prism, noReflect: true, reflected: true,
    };
    s.projectiles.push(back);
    ev.push({ type: 'reflect', p: defId, prism, id: back.id });
    ev.push({ type: 'projectile', p: defId, id: back.id, kind: back.kind, lane: back.lane, eta: back.arrive - s.tick });
    return;
  }
  const pre = def.state;
  damage(ctx, defId, pr.dmg, pr.kind === 'eclipse' ? bal.poise : pr.poise, pr.kind, pr.lane, pr.owner);
  if ((def.state as string) === 'dead') return;
  if (pr.burn) {
    const extra = s.w[pr.owner].oath === 'embers' ? bal.oaths.embers.burnExtra : 0;
    def.burnUntil = s.tick + T(bal.spells.cinder.burnSeconds + extra);
    def.burnPhase = s.tick;
    ev.push({ type: 'burn', p: defId });
  }
  if (pr.kind === 'blast') {
    const from = def.lane;
    const to: Lane = from === 1 ? (rand(s) < 0.5 ? 0 : 2) : 1;
    def.lane = to;
    ev.push({ type: 'shove', p: defId, from, to });
    if (pre === 'drawing') {
      def.draw = null;
      setState(def, 'recovery', s.tick + T(0.3));
      ev.push({ type: 'drawCancelled', p: defId });
    }
  }
  void live;
}

function tickTide(ctx: Ctx): void {
  const { s, ev } = ctx;
  if (s.tide && s.tick >= s.tide.until) s.tide = null;
  if (s.tick >= s.nextTide) {
    const pool: SpellId[] = ['cinder', 'storm', 'ward', 'mirror', 'gravewell', 'aurum'];
    const spell = pool[Math.floor(rand(s) * pool.length)]!;
    s.tide = { spell, until: s.tick + T(bal.tide.durationSeconds) };
    s.nextTide = s.tick + T(bal.tide.everySeconds);
    ev.push({ type: 'tide', spell });
  }
}

function checkOver(ctx: Ctx): void {
  const { s, ev } = ctx;
  const d0 = s.w[0].vit <= 0;
  const d1 = s.w[1].vit <= 0;
  let res: DuelState['over'] = null;
  if (d0 && d1) res = { winner: null, reason: 'draw' };
  else if (d0) res = { winner: 1, reason: 'ko' };
  else if (d1) res = { winner: 0, reason: 'ko' };
  else if (s.tick >= s.roundTicks) {
    const a = s.w[0].vit;
    const b = s.w[1].vit;
    res = a === b ? { winner: null, reason: 'draw' } : { winner: a > b ? 0 : 1, reason: 'timeout' };
  }
  if (res) {
    s.over = res;
    ev.push({ type: 'over', winner: res.winner, reason: res.reason });
  }
}
