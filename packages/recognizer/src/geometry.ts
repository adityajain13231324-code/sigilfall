export interface Pt {
  x: number;
  y: number;
  t?: number;
}

/** Tiny seeded RNG (mulberry32). Deterministic, used by template generation and tests. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

export function pathLength(pts: Pt[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += dist(pts[i - 1]!, pts[i]!);
  return d;
}

export function bounds(pts: Pt[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

export function centroid(pts: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

/** Resample a polyline to n points equally spaced along its length. */
export function resample(pts: Pt[], n: number): Pt[] {
  if (pts.length === 0) return [];
  const total = pathLength(pts);
  if (total === 0) return Array.from({ length: n }, () => ({ x: pts[0]!.x, y: pts[0]!.y }));
  const step = total / (n - 1);
  const out: Pt[] = [{ x: pts[0]!.x, y: pts[0]!.y }];
  let acc = 0;
  const src = pts.map((p) => ({ x: p.x, y: p.y }));
  for (let i = 1; i < src.length; i++) {
    let a = src[i - 1]!;
    const b = src[i]!;
    let d = dist(a, b);
    while (acc + d >= step && d > 0) {
      const f = (step - acc) / d;
      const q = { x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) };
      out.push(q);
      a = q;
      d = dist(a, b);
      acc = 0;
    }
    acc += d;
  }
  while (out.length < n) out.push({ x: src[src.length - 1]!.x, y: src[src.length - 1]!.y });
  if (out.length > n) out.length = n;
  return out;
}

/** Scale (uniform, by largest side) and translate centroid to origin. Orientation is preserved on purpose. */
export function normalize(pts: Pt[]): Pt[] {
  const b = bounds(pts);
  const s = Math.max(b.w, b.h) || 1;
  const scaled = pts.map((p) => ({ x: (p.x - b.minX) / s, y: (p.y - b.minY) / s }));
  const c = centroid(scaled);
  return scaled.map((p) => ({ x: p.x - c.x, y: p.y - c.y }));
}

/** Signed polygon area (shoelace) of the closed path. With y pointing DOWN, positive = clockwise on screen. */
export function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function segIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(a, b, c);
  const d2 = o(a, b, d);
  const d3 = o(c, d, a);
  const d4 = o(c, d, b);
  return d1 * d2 <= 0 && d3 * d4 <= 0 && !(d1 === 0 && d2 === 0);
}

export function selfCrossings(pts: Pt[]): number {
  let n = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    for (let j = i + 2; j < pts.length - 1; j++) {
      if (segIntersect(pts[i]!, pts[i + 1]!, pts[j]!, pts[j + 1]!)) n++;
    }
  }
  return n;
}

/** Number of sharp corners (turning peaks above `minDeg`) along a resampled path. */
export function cornerCount(pts: Pt[], closed: boolean, minDeg = 65): number {
  const n = pts.length;
  const k = Math.max(2, Math.round(n / 10));
  const turn: number[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[closed ? (i - k + n) % n : Math.max(0, i - k)]!;
    const p1 = pts[i]!;
    const p2 = pts[closed ? (i + k) % n : Math.min(n - 1, i + k)]!;
    const a1 = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    const a2 = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    let d = a2 - a1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    turn.push(Math.abs(d) * (180 / Math.PI));
  }
  let count = 0;
  const w = Math.max(2, k);
  for (let i = 0; i < n; i++) {
    if (!closed && (i < w || i >= n - w)) continue;
    const v = turn[i]!;
    if (v < minDeg) continue;
    let peak = true;
    for (let j = -w; j <= w; j++) {
      const idx = closed ? (i + j + n) % n : i + j;
      if (idx < 0 || idx >= n || j === 0) continue;
      const u = turn[idx]!;
      if (u > v || (u === v && j < 0)) {
        peak = false;
        break;
      }
    }
    if (peak) count++;
  }
  return count;
}

export interface Features {
  closure: number; // endpoint gap / bbox diagonal
  straightness: number; // path length / chord
  lengthRatio: number; // path length / bbox diagonal
  turns: number; // |total tangent turning| in full turns
  sweepSign: number; // +1 clockwise on screen (y-down)
  radialRatio: number; // curvature of last third / first third of the stroke (>1 = winding tighter)
  crossings: number;
  corners: number;
  areaSign: number; // +1 clockwise (y-down), from shoelace area
  size: number; // longest bbox side
}

export function features(raw: Pt[]): Features {
  const pts = resample(raw, 64);
  const b = bounds(pts);
  const diag = Math.hypot(b.w, b.h) || 1;
  const len = pathLength(pts);
  const chord = dist(pts[0]!, pts[pts.length - 1]!);
  // total tangent turning (robust against off-centre spirals): sample every 2nd point to damp jitter
  const step = 2;
  let turnSum = 0;
  const turns64: number[] = [];
  for (let i = step; i < pts.length - step; i++) {
    const p0 = pts[i - step]!;
    const p1 = pts[i]!;
    const p2 = pts[i + step]!;
    let d = Math.atan2(p2.y - p1.y, p2.x - p1.x) - Math.atan2(p1.y - p0.y, p1.x - p0.x);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    turnSum += d;
    turns64.push(d);
  }
  const sgn = turnSum >= 0 ? 1 : -1;
  const third = Math.floor(turns64.length / 3);
  const sumPart = (arr: number[]) => arr.reduce((s, v) => s + Math.max(0, v * sgn), 0);
  const firstTurn = sumPart(turns64.slice(0, third));
  const lastTurn = sumPart(turns64.slice(turns64.length - third));
  const coarse = resample(raw, 32);
  const closure = chord / diag;
  return {
    closure,
    straightness: chord > 0 ? len / chord : Infinity,
    lengthRatio: len / diag,
    turns: Math.abs(turnSum) / (2 * Math.PI * step),
    sweepSign: sgn,
    radialRatio: firstTurn > 1e-6 ? lastTurn / firstTurn : lastTurn > 0 ? Infinity : 1,
    crossings: selfCrossings(coarse),
    corners: cornerCount(coarse, closure < 0.3),
    areaSign: signedArea(pts) >= 0 ? 1 : -1,
    size: Math.max(b.w, b.h),
  };
}
