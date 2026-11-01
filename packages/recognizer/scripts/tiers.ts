import { recognize, canonical, jitter, makeRng, resample, spellToShape, SpellId, Pt, isClosedShape } from '../src';
const SP: SpellId[] = ['cinder','storm','ward','mirror','gravewell','aurum','umbra','eclipse','dart','riptide','heal','aegis','crescent','starfall','fangs'];
function sample(spell: SpellId, rng: () => number, noise: number): Pt[] {
  const shape = spellToShape(spell);
  const closed = isClosedShape(shape) && shape !== 'infinity';
  const j = jitter(canonical(shape, spell === 'umbra' ? 'ccw' : 'cw'), rng, { rotDeg: 6, scaleVar: 0.12, noise, trim: 0.04, round: 0.3 }, closed);
  const size = 200 + rng() * 400;
  return resample(j, 90).map((p, i) => ({ x: 500 + p.x * size, y: 500 + p.y * size, t: i * 12 }));
}
for (const noise of [0.015, 0.03, 0.05]) {
  const rng = makeRng(5); const c = { perfect: 0, clean: 0, rough: 0, none: 0 }; let n = 0;
  for (const sp of SP) for (let i = 0; i < 60; i++) { const r = recognize(sample(sp, rng, noise)); n++; if (r.spell === sp && r.tier) c[r.tier]++; else c.none++; }
  console.log('hand wobble', noise, Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round((v / n) * 100) + '%'])));
}
