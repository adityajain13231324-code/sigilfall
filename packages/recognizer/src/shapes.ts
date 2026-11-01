import { Pt, makeRng, resample, normalize } from './geometry';

export type Shape = 'triangle' | 'zigzag' | 'arch' | 'diamond' | 'spiral' | 'circle' | 'infinity';
export const SHAPES: Shape[] = ['triangle', 'zigzag', 'arch', 'diamond', 'spiral', 'circle', 'infinity'];

export type Winding = 'cw' | 'ccw';

/** Unit-square canonical symbols, y points DOWN (screen space). Each starts where a player would naturally start. */
function poly(corners: [number, number][], closed: boolean): Pt[] {
  const pts = corners.map(([x, y]) => ({ x, y }));
  if (closed) pts.push({ ...pts[0]! });
  return pts;
}

function densify(pts: Pt[], n = 96): Pt[] {
  return resample(pts, n);
}

export function canonical(shape: Shape, winding: Winding = 'cw'): Pt[] {
  let pts: Pt[];
  switch (shape) {
    case 'triangle':
      pts = densify(poly([[0.5, 0], [1, 1], [0, 1]], true));
      break;
    case 'zigzag':
      pts = densify(poly([[0.05, 0], [0.95, 0.02], [0.05, 0.98], [0.95, 1]], false));
      break;
    case 'arch':
      pts = Array.from({ length: 64 }, (_, i) => {
        const a = Math.PI * (i / 63);
        return { x: 0.5 - 0.5 * Math.cos(a), y: 1 - Math.sin(a) };
      });
      pts = pts.map((p) => ({ x: p.x, y: 0.15 + 0.85 * p.y }));
      break;
    case 'diamond':
      pts = densify(poly([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]], true));
      break;
    case 'circle':
      pts = Array.from({ length: 65 }, (_, i) => {
        const a = -Math.PI / 2 + (2 * Math.PI * i) / 64;
        return { x: 0.5 + 0.5 * Math.cos(a), y: 0.5 + 0.5 * Math.sin(a) };
      });
      break;
    case 'spiral': {
      const turns = 1.6;
      pts = Array.from({ length: 96 }, (_, i) => {
        const u = i / 95;
        const a = -Math.PI / 2 + u * turns * 2 * Math.PI;
        const r = 0.5 * (1 - 0.88 * u);
        return { x: 0.5 + r * Math.cos(a), y: 0.5 + r * Math.sin(a) };
      });
      break;
    }
    case 'infinity':
      // lemniscate on its side, starting at the left tip and sweeping up-and-right through the crossing
      pts = Array.from({ length: 97 }, (_, i) => {
        const t = (2 * Math.PI * i) / 96;
        return { x: 0.5 - 0.5 * Math.cos(t), y: 0.5 - 0.22 * Math.sin(2 * t) };
      });
      break;
  }
  // The generators above are clockwise on screen (y-down) where direction exists. Mirror for ccw.
  if (winding === 'ccw') pts = pts.map((p) => ({ x: 1 - p.x, y: p.y }));
  return pts;
}

/** Number each canonical symbol's natural stroke-start for the ghost tutor. */
export function ghostStroke(shape: Shape, winding: Winding = 'cw'): Pt[] {
  return canonical(shape, winding);
}

export interface Template {
  shape: Shape;
  pts: Pt[]; // 32 normalized points
  custom?: boolean;
}

export interface JitterOpts {
  rotDeg: number; // max rotation
  scaleVar: number; // anisotropic scale range, e.g. 0.2 = 0.8..1.2
  noise: number; // smooth positional noise amplitude (fraction of size)
  trim: number; // fraction of the path that may be left open at the end
  round: number; // 0..1 probability of corner rounding
}

export const TEMPLATE_JITTER: JitterOpts = { rotDeg: 8, scaleVar: 0.22, noise: 0.035, trim: 0.06, round: 0.5 };

function smoothNoiseField(rng: () => number, amp: number) {
  const comps = Array.from({ length: 3 }, (_, k) => ({
    f: (k + 1) * (0.8 + rng() * 0.8),
    px: rng() * Math.PI * 2,
    py: rng() * Math.PI * 2,
    a: (amp / (k + 1)) * (0.5 + rng() * 0.5),
  }));
  return (u: number): [number, number] => {
    let dx = 0;
    let dy = 0;
    for (const c of comps) {
      dx += c.a * Math.sin(u * c.f * Math.PI * 2 + c.px);
      dy += c.a * Math.sin(u * c.f * Math.PI * 2 + c.py);
    }
    return [dx, dy];
  };
}

function chaikin(pts: Pt[], rounds: number): Pt[] {
  let p = pts;
  for (let r = 0; r < rounds; r++) {
    const out: Pt[] = [p[0]!];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i]!;
      const b = p[i + 1]!;
      out.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
      out.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    out.push(p[p.length - 1]!);
    p = out;
  }
  return p;
}

/** Produce one hand-drawn-like variant of a canonical stroke. */
export function jitter(pts: Pt[], rng: () => number, o: JitterOpts = TEMPLATE_JITTER, closed = false): Pt[] {
  let p = pts.map((q) => ({ x: q.x, y: q.y }));
  if (rng() < o.round) p = chaikin(p, 1 + Math.floor(rng() * 2));
  if (closed) {
    const shift = Math.floor(rng() * p.length * 0.9);
    const body = p.slice(0, p.length - 1);
    p = body.slice(shift).concat(body.slice(0, shift));
    p.push({ ...p[0]! });
  }
  const keep = Math.max(8, Math.floor(p.length * (1 - rng() * o.trim)));
  p = p.slice(0, keep);
  const n = noiseWrap(rng, o.noise);
  const rot = ((rng() * 2 - 1) * o.rotDeg * Math.PI) / 180;
  const sx = 1 + (rng() * 2 - 1) * o.scaleVar;
  const sy = 1 + (rng() * 2 - 1) * o.scaleVar;
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  return p.map((q, i) => {
    const [dx, dy] = n(i / (p.length - 1));
    const x = (q.x - 0.5 + dx) * sx;
    const y = (q.y - 0.5 + dy) * sy;
    return { x: x * cr - y * sr, y: x * sr + y * cr };
  });
}

function noiseWrap(rng: () => number, amp: number) {
  return smoothNoiseField(rng, amp);
}

const CLOSED: Shape[] = ['triangle', 'diamond', 'circle', 'infinity'];
export const isClosedShape = (s: Shape) => CLOSED.includes(s);

export const TEMPLATES_PER_SHAPE = 10;

/** Deterministically generate the shared template set (also exported to JSON by scripts/gen-templates.ts). */
export function generateTemplates(seed = 1337, perShape = TEMPLATES_PER_SHAPE): Template[] {
  const rng = makeRng(seed);
  const out: Template[] = [];
  for (const shape of SHAPES) {
    out.push({ shape, pts: normalize(resample(canonical(shape), 32)) });
    if (shape === 'circle' || shape === 'spiral' || shape === 'infinity') out.push({ shape, pts: normalize(resample(canonical(shape, 'ccw'), 32)) });
    for (let i = 0; i < perShape; i++) {
      const handed = shape === 'spiral' || shape === 'circle' || shape === 'infinity';
      const winding: Winding = handed && i % 2 === 1 ? 'ccw' : 'cw';
      const base = canonical(shape, winding);
      const v = jitter(base, rng, TEMPLATE_JITTER, isClosedShape(shape) && shape !== 'infinity');
      out.push({ shape, pts: normalize(resample(v, 32)) });
    }
  }
  return out;
}
