import { WizardAI, runDuel } from '../src';
const dmg: Record<string, number> = {}; const casts: Record<string, number> = {};
for (let i = 0; i < 800; i++) {
  const r = runDuel([new WizardAI(0, 'adept', i + 1), new WizardAI(1, 'adept', i + 9000)], i + 1);
  for (const w of r.state.w) {
    for (const [k, v] of Object.entries(w.stats.byKind ?? {})) dmg[k] = (dmg[k] ?? 0) + v;
    for (const [k, v] of Object.entries(w.stats.casts)) casts[k] = (casts[k] ?? 0) + (v ?? 0);
  }
}
const tot = Object.values(dmg).reduce((a, b) => a + b, 0);
for (const [k, v] of Object.entries(dmg).sort((a, b) => b[1] - a[1])) console.log(k.padEnd(10), (v / tot * 100).toFixed(1).padStart(5) + '% of damage');
console.log('casts', casts);
