import { describe, it, expect } from 'vitest';
import {
  recognize, canonical, jitter, makeRng, resample, SpellId, Shape, Pt, packStroke, unpackStroke, validateTemplates,
  shapeToSpell, spellToShape, makeTemplate, generateTemplates,
} from '../src';

const SPELLS: SpellId[] = ['cinder', 'storm', 'ward', 'mirror', 'gravewell', 'aurum', 'umbra', 'eclipse'];

/** Synthesize a hand-drawn attempt: a different seed than the templates, 12%-class wobble, up to 10 deg skew. */
function sample(spell: SpellId, rng: () => number, noise = 0.07): Pt[] {
  const shape = spellToShape(spell);
  const winding = spell === 'umbra' ? 'ccw' : 'cw';
  const closed = shape === 'triangle' || shape === 'diamond' || shape === 'circle';
  const base = canonical(shape, winding);
  const j = jitter(base, rng, { rotDeg: 10, scaleVar: 0.2, noise, trim: 0.08, round: 0.6 }, closed);
  const size = 180 + rng() * 520;
  const ox = 300 + rng() * 300;
  const oy = 300 + rng() * 300;
  const dense = resample(j, 70 + Math.floor(rng() * 50));
  let t = 0;
  return dense.map((p) => {
    t += 8 + rng() * 14;
    return { x: Math.min(1000, Math.max(0, ox + p.x * size + (rng() - 0.5) * 3)), y: Math.min(1000, Math.max(0, oy + p.y * size + (rng() - 0.5) * 3)), t };
  });
}

describe('recognizer confusion matrix', () => {
  it('recognizes noisy synthetic sigils >=95% correct with <1% wrong-spell casts', () => {
    const rng = makeRng(2024);
    const per = 200;
    let correct = 0;
    let wrong = 0;
    let total = 0;
    const rows: string[] = [];
    for (const spell of SPELLS) {
      let c = 0;
      let w = 0;
      const confused: Record<string, number> = {};
      for (let i = 0; i < per; i++) {
        const r = recognize(sample(spell, rng));
        total++;
        if (r.spell === spell) {
          c++;
        } else if (r.spell) {
          w++;
          confused[r.spell] = (confused[r.spell] ?? 0) + 1;
        }
      }
      correct += c;
      wrong += w;
      rows.push(`${spell.padEnd(10)} correct ${(c / per * 100).toFixed(1)}%  wrong ${w}  ${JSON.stringify(confused)}`);
    }
    console.log('\n' + rows.join('\n'));
    expect(correct / total).toBeGreaterThanOrEqual(0.95);
    expect(wrong / total).toBeLessThan(0.01);
  });

  it('assigns clockwise circles to Aurum and counter-clockwise to Umbra', () => {
    const rng = makeRng(5);
    for (let i = 0; i < 30; i++) {
      expect(recognize(sample('aurum', rng, 0.03)).spell).toBe('aurum');
      expect(recognize(sample('umbra', rng, 0.03)).spell).toBe('umbra');
    }
  });

  it('gives a clean canonical symbol a Perfect tier', () => {
    for (const spell of SPELLS) {
      const shape = spellToShape(spell);
      const c = canonical(shape, spell === 'umbra' ? 'ccw' : 'cw').map((p) => ({ x: 200 + p.x * 500, y: 200 + p.y * 500 }));
      const r = recognize(c);
      expect(r.spell, spell).toBe(spell);
      expect(r.tier, spell).toBe('perfect');
    }
  });

  it('honours context-aware candidates (infinity only when allowed)', () => {
    const rng = makeRng(9);
    const shapes: Shape[] = ['triangle', 'zigzag', 'arch', 'diamond', 'spiral', 'circle'];
    let wrongCasts = 0;
    for (let i = 0; i < 40; i++) {
      const r = recognize(sample('eclipse', rng, 0.04), { allowed: shapes });
      if (r.spell === 'eclipse') wrongCasts++;
    }
    expect(wrongCasts).toBe(0);
  });
});

describe('adversarial input never casts', () => {
  const rng = makeRng(77);
  it('scribbles', () => {
    for (let k = 0; k < 100; k++) {
      let x = 500, y = 500, t = 0;
      const pts: Pt[] = [];
      for (let i = 0; i < 150; i++) {
        x = Math.min(1000, Math.max(0, x + (rng() - 0.5) * 260));
        y = Math.min(1000, Math.max(0, y + (rng() - 0.5) * 260));
        pts.push({ x, y, t: (t += 10) });
      }
      expect(recognize(pts).spell).toBeNull();
    }
  });
  it('tiny strokes and double taps', () => {
    const tiny = canonical('triangle').map((p) => ({ x: 500 + p.x * 40, y: 500 + p.y * 40, t: 0 }));
    expect(recognize(tiny).spell).toBeNull();
    expect(recognize([{ x: 500, y: 500, t: 0 }, { x: 501, y: 500, t: 40 }]).spell).toBeNull();
    const dbl = [{ x: 400, y: 400, t: 0 }, { x: 402, y: 401, t: 20 }, { x: 600, y: 600, t: 400 }, { x: 601, y: 600, t: 420 }];
    expect(recognize(dbl).spell).toBeNull();
  });
  it('straight lines', () => {
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [-1, 0.4]]) {
      const pts = Array.from({ length: 40 }, (_, i) => ({ x: 500 + dx * i * 12, y: 500 + dy * i * 12, t: i * 10 }));
      expect(recognize(pts).spell).toBeNull();
    }
  });
  it('strokes drawn too slowly', () => {
    const slow = canonical('triangle').map((p, i) => ({ x: 200 + p.x * 500, y: 200 + p.y * 500, t: i * 80 }));
    expect(recognize(slow).reason).toBe('tooSlow');
  });
});

describe('wire format & custom templates', () => {
  it('round-trips a stroke through pack/unpack', () => {
    const s = sample('cinder', makeRng(1));
    const u = unpackStroke(packStroke(s));
    expect(u).not.toBeNull();
    expect(recognize(u!).spell).toBe('cinder');
  });
  it('rejects forged payloads', () => {
    expect(unpackStroke('hi')).toBeNull();
    expect(unpackStroke([1, 2])).toBeNull();
    expect(unpackStroke(new Array(3 * 5000).fill(1))).toBeNull();
    expect(unpackStroke([0, 0, 0, 5000, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
    expect(unpackStroke([0.5, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3])).toBeNull();
  });
  it('validates custom templates (size, shape, max 3 each)', () => {
    const good = makeTemplate('triangle', canonical('triangle'));
    expect(validateTemplates([good, good, good, good]).length).toBe(3);
    expect(validateTemplates([{ shape: 'nope', pts: good.pts }]).length).toBe(0);
    expect(validateTemplates([{ shape: 'triangle', pts: good.pts.slice(1) }]).length).toBe(0);
    expect(validateTemplates([{ shape: 'triangle', pts: good.pts.map(() => ({ x: 99, y: 0 })) }]).length).toBe(0);
  });
  it('maps shapes to spells and generates 10 templates per shape', () => {
    expect(shapeToSpell('circle', 'cw')).toBe('aurum');
    expect(generateTemplates().length).toBe(70 + 10);
  });
});
