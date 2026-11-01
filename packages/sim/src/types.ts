import type { SpellId, Tier } from '@sigilfall/recognizer';
export type { SpellId, Tier };

export type Lane = 0 | 1 | 2;
export type PlayerId = 0 | 1;
export type Oath = 'embers' | 'stillness' | 'echoes';
export const OATHS: Oath[] = ['embers', 'stillness', 'echoes'];

export type WizState = 'idle' | 'drawing' | 'windup' | 'recovery' | 'channeling' | 'staggered' | 'exhausted' | 'blinking' | 'dead';

/** Colour family an opponent can read ~40% into your stroke. The exact spell shows at ~70%. */
export type TellFamily = 'warm' | 'cold' | 'silver' | 'dark';
export const TELL_FAMILY: Record<SpellId, TellFamily> = {
  cinder: 'warm', aurum: 'warm', storm: 'cold', ward: 'cold', mirror: 'silver', gravewell: 'dark', umbra: 'dark', eclipse: 'dark',
};

export type Cmd =
  | { t: 'drawStart' }
  | { t: 'drawCancel' }
  | { t: 'tell'; stage: 1 | 2; spell: SpellId }
  | { t: 'cast'; spell: SpellId | null; tier: Tier; aim?: Lane; quick?: boolean }
  | { t: 'blink'; dir: -1 | 1 }
  | { t: 'orb'; which: 'aurum' | 'umbra'; aim?: Lane }
  | { t: 'oath'; oath: Oath };

export type RejectReason = 'busy' | 'cooldown' | 'aether' | 'orbs' | 'held' | 'noOrb' | 'blink' | 'dead' | 'late';

export type ProjKind = 'cinder' | 'blast' | 'lance' | 'shard' | 'eclipse';

export interface Projectile {
  id: number;
  owner: PlayerId;
  kind: ProjKind;
  lane: Lane;
  born: number;
  arrive: number;
  dmg: number;
  poise: number;
  burn: boolean;
  pierce: boolean;
  noReflect: boolean;
  reflected: boolean;
}

export interface StormStrike {
  id: number;
  owner: PlayerId;
  lane: Lane;
  born: number;
  hit: number;
  dmg: number;
  poise: number;
}

export interface Well {
  id: number;
  owner: PlayerId;
  born: number;
  until: number;
}

export interface Windup {
  spell: SpellId;
  tier: Tier;
  start: number;
  end: number;
  power: number;
  aim?: Lane;
  quick: boolean;
}

export interface Wizard {
  vit: number;
  aether: number;
  poise: number;
  lane: Lane;
  state: WizState;
  stateUntil: number;
  oath: Oath | null;
  windup: Windup | null;
  draw: { start: number; family: TellFamily | null; spell: SpellId | null } | null;
  cooldowns: Partial<Record<SpellId, number>>;
  blinkReady: number;
  blinkFrom: Lane;
  blinkTo: Lane;
  invulnUntil: number;
  regenFrom: number;
  lastHit: number;
  brokenUntil: number;
  openUntil: number;
  orbs: { aurum: number; umbra: number }; // expiry tick, 0 = none
  ward: { hp: number; max: number; until: number; wellspring: boolean } | null;
  mirror: { start: number; until: number; hit: boolean; prism: boolean } | null;
  burnUntil: number;
  burnPhase: number;
  chillUntil: number;
  lastSpell: SpellId | null;
  lastCastTick: number;
  fatigue: number;
  recent: { spell: SpellId; tick: number }[];
  weaveUntil: number;
  echoNext: boolean;
  casts: number;
  stats: { damageDealt: number; casts: Partial<Record<SpellId, number>> };
}

export interface DuelState {
  tick: number;
  seed: number;
  rng: number;
  nextId: number;
  w: [Wizard, Wizard];
  projectiles: Projectile[];
  strikes: StormStrike[];
  wells: Well[];
  tide: { spell: SpellId; until: number } | null;
  nextTide: number;
  over: { winner: PlayerId | null; reason: 'ko' | 'timeout' | 'draw' } | null;
  roundTicks: number;
}

export type SimEvent =
  | { type: 'cast'; p: PlayerId; spell: SpellId; tier: Tier; windup: number; quick: boolean }
  | { type: 'fizzle'; p: PlayerId }
  | { type: 'feint'; p: PlayerId }
  | { type: 'reject'; p: PlayerId; reason: RejectReason }
  | { type: 'release'; p: PlayerId; spell: SpellId; lane: Lane }
  | { type: 'projectile'; p: PlayerId; id: number; kind: ProjKind; lane: Lane; eta: number }
  | { type: 'stormMark'; p: PlayerId; lane: Lane; hit: number }
  | { type: 'stormStrike'; p: PlayerId; lane: Lane; hit: boolean }
  | { type: 'ward'; p: PlayerId }
  | { type: 'wardAbsorb'; p: PlayerId; hp: number; crit: boolean }
  | { type: 'wardBreak'; p: PlayerId }
  | { type: 'wardAnnihilated'; p: PlayerId }
  | { type: 'mirror'; p: PlayerId }
  | { type: 'reflect'; p: PlayerId; prism: boolean; id: number }
  | { type: 'exhausted'; p: PlayerId }
  | { type: 'gravewell'; p: PlayerId }
  | { type: 'collapse'; p: PlayerId; id: number; kind: ProjKind; lane: Lane }
  | { type: 'orbCreated'; p: PlayerId; which: 'aurum' | 'umbra' }
  | { type: 'orbPop'; p: PlayerId; which: 'aurum' | 'umbra'; reason: 'gravewell' | 'expire' | 'release' | 'fusion' }
  | { type: 'eclipseStart'; p: PlayerId }
  | { type: 'eclipseInterrupt'; p: PlayerId }
  | { type: 'blink'; p: PlayerId; from: Lane; to: Lane }
  | { type: 'dodge'; p: PlayerId; id: number }
  | { type: 'hit'; p: PlayerId; kind: ProjKind | 'storm' | 'burn' | 'wellspring' | 'gravewell'; dmg: number; poise: number; lane: Lane }
  | { type: 'shove'; p: PlayerId; from: Lane; to: Lane }
  | { type: 'drawCancelled'; p: PlayerId }
  | { type: 'break'; p: PlayerId }
  | { type: 'interrupt'; p: PlayerId }
  | { type: 'stagger'; p: PlayerId; ticks: number }
  | { type: 'combo'; p: PlayerId; name: 'THUNDERBURN' | 'PRISM RETURN' | 'WELLSPRING' | 'ECLIPSE' }
  | { type: 'weave'; p: PlayerId }
  | { type: 'tide'; spell: SpellId }
  | { type: 'burn'; p: PlayerId }
  | { type: 'chill'; p: PlayerId }
  | { type: 'oath'; p: PlayerId; oath: Oath }
  | { type: 'over'; winner: PlayerId | null; reason: 'ko' | 'timeout' | 'draw' };
