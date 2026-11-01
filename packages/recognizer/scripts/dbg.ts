import { recognize, canonical, jitter, makeRng, resample, spellToShape, SpellId, Pt, isClosedShape, features } from '../src';
function sample(spell: SpellId, rng: () => number, noise = 0.07): Pt[] {
  const shape = spellToShape(spell);
  const closed = isClosedShape(shape) && shape !== 'infinity';
  const base = canonical(shape, spell === 'umbra' ? 'ccw' : 'cw');
  const j = jitter(base, rng, { rotDeg: 10, scaleVar: 0.2, noise, trim: 0.08, round: 0.6 }, closed);
  const size = 180 + rng() * 520; const ox = 300 + rng() * 300; const oy = 300 + rng() * 300;
  const dense = resample(j, 70 + Math.floor(rng() * 50)); let t = 0;
  return dense.map((p) => { t += 8 + rng() * 14; return { x: Math.min(1000, Math.max(0, ox + p.x * size + (rng() - 0.5) * 3)), y: Math.min(1000, Math.max(0, oy + p.y * size + (rng() - 0.5) * 3)), t }; });
}
const rng = makeRng(+process.argv[3] || 11);
const sp = process.argv[2] as SpellId;
let n = 0;
for (let i = 0; i < 60 && n < 8; i++) {
  const s = sample(sp, rng); const r = recognize(s);
  if (r.spell === sp) continue; n++;
  const f = features(s);
  console.log(`${r.spell ?? r.reason} cl=${f.closure.toFixed(2)} turns=${f.turns.toFixed(2)} corners=${f.corners} cross=${f.crossings} rr=${f.radialRatio.toFixed(2)} sol=${f.solidity.toFixed(3)} rv=${f.radialVar.toFixed(3)} asp=${f.aspect.toFixed(2)} | ${r.ranked.slice(0,3).map(x=>x.shape+x.score.toFixed(2))}`);
}
