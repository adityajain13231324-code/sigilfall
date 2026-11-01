import { canonical, jitter, makeRng, resample, spellToShape, SpellId, Pt, isClosedShape, features } from '../src';
function sample(spell: SpellId, rng: () => number, noise = 0.07): Pt[] {
  const shape = spellToShape(spell);
  const closed = isClosedShape(shape) && shape !== 'infinity';
  const j = jitter(canonical(shape, spell === 'umbra' ? 'ccw' : 'cw'), rng, { rotDeg: 10, scaleVar: 0.2, noise, trim: 0.08, round: 0.6 }, closed);
  const size = 180 + rng() * 520;
  return resample(j, 90).map((p, i) => ({ x: 500 + p.x * size, y: 500 + p.y * size, t: i * 10 }));
}
const rng = makeRng(3);
for (const sp of ['heal', 'mirror', 'aegis', 'aurum', 'cinder'] as SpellId[]) {
  const sol: number[] = []; const rv: number[] = [];
  for (let i = 0; i < 200; i++) { const f = features(sample(sp, rng)); sol.push(f.solidity); rv.push(f.radialVar); }
  const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)]!.toFixed(3);
  console.log(sp.padEnd(8), 'solidity p5/p50/p95', q(sol, .05), q(sol, .5), q(sol, .95), '| radialVar p5/p50/p95', q(rv, .05), q(rv, .5), q(rv, .95));
}
