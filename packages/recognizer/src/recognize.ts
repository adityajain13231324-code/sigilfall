import { Pt, Features, features, resample, normalize, bounds, pathLength, squareness } from './geometry';
import { Shape, SHAPES, Template, generateTemplates } from './shapes';

export type SpellId =
  | 'cinder' | 'storm' | 'ward' | 'mirror' | 'gravewell' | 'aurum' | 'umbra' | 'eclipse'
  | 'dart' | 'riptide' | 'heal' | 'aegis' | 'crescent' | 'starfall' | 'fangs';
export type Tier = 'rough' | 'clean' | 'perfect';

export interface RecognizerConfig {
  /** score below this fizzles */
  minScore: number;
  cleanScore: number;
  perfectScore: number;
  /** two different spells within this margin are ambiguous */
  ambiguityMargin: number;
  /** point-cloud mean distance (fraction of stroke size) that maps to score 0 */
  distanceScale: number;
  /** shortest accepted stroke edge in plane units (plane is 0..1000) */
  minSize: number;
  minPoints: number;
  maxDurationMs: number;
}

export const DEFAULT_RECOGNIZER_CONFIG: RecognizerConfig = {
  minScore: 0.6,
  cleanScore: 0.75,
  perfectScore: 0.9,
  ambiguityMargin: 0.05,
  distanceScale: 0.3,
  minSize: 110,
  minPoints: 8,
  maxDurationMs: 7000,
};

export type FailReason = 'tooShort' | 'tooSmall' | 'tooSlow' | 'line' | 'scribble' | 'noMatch' | 'smudged' | 'notReady';

export interface RecognitionResult {
  spell: SpellId | null;
  shape: Shape | null;
  tier: Tier | null;
  score: number;
  /** sorted best→worst per-shape scores after geometric gates */
  ranked: { shape: Shape; score: number }[];
  reason?: FailReason;
  /** only set on circle matches */
  winding?: 'cw' | 'ccw';
}

export interface RecognizeOptions {
  /** restrict candidate shapes (context-aware recognition). default: all */
  allowed?: Shape[];
  /** extra templates (player-recorded variants) */
  custom?: Template[];
  /** multiplies minScore/cleanScore/perfectScore tolerance: >1 stricter, <1 more lenient */
  strictness?: number;
  config?: Partial<RecognizerConfig>;
}

let sharedTemplates: Template[] | null = null;
export function getTemplates(): Template[] {
  if (!sharedTemplates) sharedTemplates = generateTemplates();
  return sharedTemplates;
}
export function setTemplates(t: Template[]): void {
  sharedTemplates = t;
}

const N = 32;

function cloudDistance(a: Pt[], b: Pt[], start: number, cutoff: number): number {
  const n = a.length;
  const matched = new Uint8Array(n);
  let sum = 0;
  let i = start;
  let k = 0;
  do {
    let index = -1;
    let min = Infinity;
    const p = a[i]!;
    for (let j = 0; j < n; j++) {
      if (matched[j]) continue;
      const q = b[j]!;
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < min) {
        min = d;
        index = j;
      }
    }
    matched[index] = 1;
    const weight = 1 - k / n;
    sum += weight * min;
    if (sum > cutoff) return sum;
    i = (i + 1) % n;
    k++;
  } while (i !== start);
  return sum;
}

/** $P greedy point-cloud match; returns mean point distance in units of stroke size. */
export function cloudMatch(a: Pt[], b: Pt[]): number {
  const n = a.length;
  const step = Math.max(1, Math.floor(Math.pow(n, 0.5)));
  let min = Infinity;
  for (let i = 0; i < n; i += step) {
    min = Math.min(min, cloudDistance(a, b, i, min), cloudDistance(b, a, i, min));
  }
  return min / ((n + 1) / 2);
}

/** Geometric gates: shape-specific sanity checks the point cloud cannot see (direction, turns, closure). */
function gate(shape: Shape, f: Features): number {
  switch (shape) {
    case 'triangle':
      return f.closure < 0.45 && f.turns > 0.55 && f.turns < 1.5 && f.radialVar > 0.15 ? (f.corners >= 2 && f.corners <= 4 ? 1 : 0.9) : 0;
    case 'diamond':
      return f.closure < 0.45 && f.turns > 0.55 && f.turns < 1.5 ? (f.corners >= 3 && f.corners <= 5 ? 1 : 0.9) : 0;
    case 'square':
      return f.closure < 0.45 && f.turns > 0.6 && f.turns < 1.5 && f.crossings < 2 ? (f.corners >= 3 && f.corners <= 5 ? 1 : 0.9) : 0;
    case 'zigzag':
      return f.closure > 0.45 && f.corners >= 1 && f.turns < 0.65 ? (f.corners >= 2 ? 1 : 0.88) : 0;
    case 'arch':
      return f.closure > 0.58 && f.turns > 0.28 && f.turns < 0.75 ? 1 : 0;
    case 'crescent':
      return f.closure > 0.28 && f.closure < 0.62 && f.turns > 0.5 && f.turns < 1.1 ? 1 : 0;
    case 'vee':
      return f.closure > 0.4 && f.turns > 0.15 && f.turns < 0.55 && f.corners >= 1 ? 1 : 0;
    case 'wave':
      return f.closure > 0.4 && f.turns < 0.5 && f.corners <= 2 ? 1 : 0;
    case 'em':
      return f.closure < 0.95 && f.turns < 0.8 && f.corners >= 2 ? 1 : 0;
    case 'heart':
      return f.closure < 0.45 && f.corners >= 1 && f.crossings < 3 ? (f.solidity < 0.955 && f.radialVar > 0.19 ? 1 : 0) : 0;
    case 'star':
      return f.crossings >= 3 && f.corners >= 3 ? 1 : 0;
    case 'circle':
      if (f.closure > 0.3 || f.turns < 0.7 || f.turns > 1.75 || f.radialVar > 0.115) return 0;
      if (f.turns > 1.3 && (f.radialRatio > 1.7 || f.radialRatio < 0.5)) return 0;
      return f.corners > 4 ? 0.9 : 1;
    case 'spiral':
      return f.turns >= 1.05 && f.radialRatio >= 1.5 && f.closure > 0.2 ? 1 : 0;
    case 'infinity':
      if (f.turns > 0.55 || f.closure > 0.5 || f.aspect < 1.25) return 0;
      return f.crossings >= 1 ? 1 : 0.85;
  }
}

export function shapeToSpell(shape: Shape, winding: 'cw' | 'ccw'): SpellId {
  switch (shape) {
    case 'triangle': return 'cinder';
    case 'zigzag': return 'storm';
    case 'arch': return 'ward';
    case 'diamond': return 'mirror';
    case 'spiral': return 'gravewell';
    case 'circle': return winding === 'cw' ? 'aurum' : 'umbra';
    case 'infinity': return 'eclipse';
    case 'vee': return 'dart';
    case 'wave': return 'riptide';
    case 'heart': return 'heal';
    case 'square': return 'aegis';
    case 'crescent': return 'crescent';
    case 'star': return 'starfall';
    case 'em': return 'fangs';
  }
}

export function spellToShape(spell: SpellId): Shape {
  switch (spell) {
    case 'cinder': return 'triangle';
    case 'storm': return 'zigzag';
    case 'ward': return 'arch';
    case 'mirror': return 'diamond';
    case 'gravewell': return 'spiral';
    case 'aurum':
    case 'umbra': return 'circle';
    case 'eclipse': return 'infinity';
    case 'dart': return 'vee';
    case 'riptide': return 'wave';
    case 'heal': return 'heart';
    case 'aegis': return 'square';
    case 'crescent': return 'crescent';
    case 'starfall': return 'star';
    case 'fangs': return 'em';
  }
}

export function tierOf(score: number, cfg: RecognizerConfig = DEFAULT_RECOGNIZER_CONFIG, strictness = 1): Tier | null {
  if (score >= cfg.perfectScore * Math.min(1.05, strictness)) return 'perfect';
  if (score >= cfg.cleanScore * strictness) return 'clean';
  if (score >= cfg.minScore * strictness) return 'rough';
  return null;
}

function recognizeWinner(shape: Shape, f: Features, ranked: { shape: Shape; score: number }[], score: number): RecognitionResult {
  const winding = f.areaSign > 0 ? 'cw' : 'ccw';
  const tier = tierOf(score) ?? 'rough';
  return { spell: shapeToSpell(shape, winding), shape, tier, score, ranked, winding: shape === 'circle' ? winding : undefined };
}

const fail = (reason: FailReason, ranked: { shape: Shape; score: number }[] = [], score = 0): RecognitionResult => ({
  spell: null, shape: null, tier: null, score, ranked, reason,
});

/** Score a stroke against a single shape (used by the Practice Sanctum accuracy readout). */
export function scoreAgainst(stroke: Pt[], shape: Shape, opts: RecognizeOptions = {}): number {
  const cfg = { ...DEFAULT_RECOGNIZER_CONFIG, ...opts.config };
  const norm = normalize(resample(stroke, N));
  return shapeScores(norm, stroke, [shape], opts, cfg)[0]?.score ?? 0;
}

function shapeScores(norm: Pt[], raw: Pt[], shapes: Shape[], opts: RecognizeOptions, cfg: RecognizerConfig) {
  const f = features(raw);
  const templates = getTemplates().concat(opts.custom ?? []);
  const out: { shape: Shape; score: number }[] = [];
  for (const shape of shapes) {
    const g = gate(shape, f);
    if (g === 0) {
      out.push({ shape, score: 0 });
      continue;
    }
    let best = Infinity;
    for (const t of templates) {
      if (t.shape !== shape) continue;
      const d = cloudMatch(norm, t.pts);
      if (d < best) best = d;
    }
    const score = Math.max(0, 1 - best / cfg.distanceScale) * g;
    out.push({ shape, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

export function recognize(stroke: Pt[], opts: RecognizeOptions = {}): RecognitionResult {
  const cfg = { ...DEFAULT_RECOGNIZER_CONFIG, ...opts.config };
  const strict = opts.strictness ?? 1;
  if (stroke.length < cfg.minPoints) return fail('tooShort');
  const b = bounds(stroke);
  if (Math.max(b.w, b.h) < cfg.minSize) return fail('tooSmall');
  const t0 = stroke[0]!.t;
  const t1 = stroke[stroke.length - 1]!.t;
  if (t0 !== undefined && t1 !== undefined && t1 - t0 > cfg.maxDurationMs) return fail('tooSlow');
  const len = pathLength(stroke);
  const diag = Math.hypot(b.w, b.h);
  if (len / (diag || 1) > 7) return fail('scribble');
  const f = features(stroke);
  if (f.closure > 0.6 && f.straightness < 1.22) return fail('line');

  const allowed = opts.allowed ?? SHAPES;
  const norm = normalize(resample(stroke, N));
  const ranked = shapeScores(norm, stroke, allowed, opts, cfg);
  const top = ranked[0];
  if (!top || top.score < cfg.minScore * strict) return fail('noMatch', ranked, top?.score ?? 0);

  let winner = top;
  const second = ranked[1];
  if (second && top.score - second.score < cfg.ambiguityMargin && second.score >= cfg.minScore * strict) {
    // resolve ambiguity with structure: corner count separates triangle/diamond, everything else is smudged
    const pair = [top.shape, second.shape].sort().join('+');
    const expectCorners: Partial<Record<Shape, number>> = { circle: 0, triangle: 3, diamond: 4, square: 4 };
    const pairSet = new Set([top.shape, second.shape]);
    if (pairSet.has('heart')) {
      const other = top.shape === 'heart' ? second.shape : top.shape;
      winner = { shape: other === 'triangle' ? (f.radialVar > 0.27 ? 'heart' : 'triangle') : 'heart', score: top.score };
      const w2 = winner;
      void w2;
      const win = recognizeWinner(winner.shape, f, ranked, top.score);
      return win;
    }
    if (pairSet.has('diamond') && pairSet.has('square') && f.cornerPts.length >= 3) {
      const sq = squareness(f.cornerPts, stroke) > 0;
      winner = { shape: sq ? 'square' : 'diamond', score: top.score };
      return recognizeWinner(winner.shape, f, ranked, top.score);
    }
    if (pairSet.has('circle') && (pairSet.has('square') || pairSet.has('diamond') || pairSet.has('triangle'))) {
      const poly = top.shape === 'circle' ? second.shape : top.shape;
      return recognizeWinner(f.radialVar < 0.085 ? 'circle' : poly, f, ranked, top.score);
    }
    const a = expectCorners[top.shape];
    const b = expectCorners[second.shape];
    if (a !== undefined && b !== undefined) {
      const da = Math.abs(f.corners - a);
      const db = Math.abs(f.corners - b);
      if (da === db) return fail('smudged', ranked, top.score);
      winner = { shape: da < db ? top.shape : second.shape, score: top.score };
    } else if (pair === 'circle+spiral') {
      winner = f.turns >= 1.25 && f.radialRatio >= 1.5 ? { shape: 'spiral', score: top.score } : { shape: 'circle', score: top.score };
    } else if (pair === 'circle+infinity') {
      winner = f.crossings >= 1 ? { shape: 'infinity', score: top.score } : { shape: 'circle', score: top.score };
    } else {
      return fail('smudged', ranked, top.score);
    }
  }
  const winding = f.areaSign > 0 ? 'cw' : 'ccw';
  const tier = tierOf(winner.score, cfg, strict) ?? 'rough';
  return {
    spell: shapeToSpell(winner.shape, winding),
    shape: winner.shape,
    tier,
    score: winner.score,
    ranked,
    winding: winner.shape === 'circle' ? winding : undefined,
  };
}

// ---- wire format -----------------------------------------------------------------------------

export const MAX_STROKE_POINTS = 400;

/** Quantize a stroke (plane units 0..1000) into a flat int array [x,y,dt,...]. */
export function packStroke(stroke: Pt[]): number[] {
  const t0 = stroke[0]?.t ?? 0;
  const out: number[] = [];
  const step = Math.max(1, Math.ceil(stroke.length / MAX_STROKE_POINTS));
  for (let i = 0; i < stroke.length; i += step) {
    const p = stroke[i]!;
    out.push(clampInt(p.x, 0, 1000), clampInt(p.y, 0, 1000), clampInt((p.t ?? 0) - t0, 0, 65535));
  }
  return out;
}

/** Validate + unpack. Returns null for anything malformed (forged/oversized). */
export function unpackStroke(raw: unknown): Pt[] | null {
  if (!Array.isArray(raw) || raw.length % 3 !== 0 || raw.length < 3 * 4 || raw.length > MAX_STROKE_POINTS * 3) return null;
  const pts: Pt[] = [];
  for (let i = 0; i < raw.length; i += 3) {
    const x = raw[i];
    const y = raw[i + 1];
    const t = raw[i + 2];
    if (!isInt(x, 0, 1000) || !isInt(y, 0, 1000) || !isInt(t, 0, 65535)) return null;
    pts.push({ x, y, t });
  }
  return pts;
}

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));

// ---- custom templates ------------------------------------------------------------------------

export function makeTemplate(shape: Shape, stroke: Pt[]): Template {
  return { shape, pts: normalize(resample(stroke, N)), custom: true };
}

/** Accept only well-formed 32-point templates, max 3 per shape. */
export function validateTemplates(raw: unknown): Template[] {
  if (!Array.isArray(raw)) return [];
  const per: Record<string, number> = {};
  const out: Template[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const { shape, pts } = t as { shape?: unknown; pts?: unknown };
    if (typeof shape !== 'string' || !(SHAPES as string[]).includes(shape)) continue;
    if (!Array.isArray(pts) || pts.length !== N) continue;
    if (!pts.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) <= 2 && Math.abs(p.y) <= 2)) continue;
    per[shape] = (per[shape] ?? 0) + 1;
    if (per[shape]! > 3) continue;
    out.push({ shape: shape as Shape, pts: pts.map((p) => ({ x: p.x, y: p.y })), custom: true });
  }
  return out;
}

// ---- partial-stroke prediction (drives opponent "tells") ----------------------------------------

import { canonical } from './shapes';

function boxNormalize(pts: Pt[]): Pt[] {
  const b = bounds(pts);
  const s = Math.max(b.w, b.h) || 1;
  return pts.map((p) => ({ x: (p.x - b.minX) / s, y: (p.y - b.minY) / s }));
}

let prefixCache: { spell: SpellId; shape: Shape; full: Pt[] }[] | null = null;

/**
 * Guess which sigil an unfinished stroke is heading toward, and roughly how complete it is.
 * Deliberately coarse: it is allowed to be wrong, which is what makes feints work.
 */
export function predictPrefix(stroke: Pt[], allowed: Shape[] = SHAPES): { spell: SpellId; frac: number; dist: number } | null {
  if (stroke.length < 6) return null;
  const b = bounds(stroke);
  if (Math.max(b.w, b.h) < 60) return null;
  if (!prefixCache) {
    prefixCache = [];
    for (const shape of SHAPES) {
      const handed = shape === 'circle' || shape === 'spiral' || shape === 'infinity' || shape === 'crescent';
      for (const w of handed ? (['cw', 'ccw'] as const) : (['cw'] as const)) {
        prefixCache.push({ spell: shapeToSpell(shape, w), shape, full: canonical(shape, w) });
      }
    }
  }
  const part = boxNormalize(resample(stroke, 14));
  let best: { spell: SpellId; frac: number; dist: number } | null = null;
  for (const c of prefixCache) {
    if (!allowed.includes(c.shape)) continue;
    for (let f = 0.3; f <= 1.001; f += 0.1) {
      const n = Math.max(6, Math.ceil(c.full.length * f));
      const pre = boxNormalize(resample(c.full.slice(0, n), 14));
      let d = 0;
      for (let i = 0; i < 14; i++) d += Math.hypot(pre[i]!.x - part[i]!.x, pre[i]!.y - part[i]!.y);
      d /= 14;
      if (!best || d < best.dist) best = { spell: c.spell, frac: f, dist: d };
    }
  }
  return best && best.dist < 0.2 ? best : null;
}
