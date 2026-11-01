import { WizardAI, runDuel, SPELLS, SpellId } from '../src';

/** Win rate of an Adept that is forbidden one spell, against a full-kit Adept (50% = the spell adds nothing). */
const N = Number(process.argv[2] ?? 600);
const level = (process.argv[3] ?? 'adept') as 'adept';
console.log('spell       banned-side win rate  (lower = the spell matters more)');
for (const sp of SPELLS) {
  let w = 0, g = 0;
  for (let i = 0; i < N; i++) {
    const seat = (i % 2) as 0 | 1;
    const banned = new WizardAI(seat, level, i + 1);
    banned.banned.add(sp as SpellId);
    const full = new WizardAI(seat === 0 ? 1 : 0, level, i + 9000);
    const r = runDuel(seat === 0 ? [banned, full] : [full, banned], i + 1);
    if (r.winner !== null) { g++; if (r.winner === seat) w++; }
  }
  console.log(sp.padEnd(11), ((w / g) * 100).toFixed(1) + '%');
}
