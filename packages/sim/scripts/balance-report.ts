import { WizardAI, EclipseSpammer, runDuel, usageShare, HeadlessResult } from '../src';

const N = Number(process.argv[2] ?? 1000);
const res: HeadlessResult[] = [];
const t0 = Date.now();
for (let i = 0; i < N; i++) res.push(runDuel([new WizardAI(0, 'adept', i + 1), new WizardAI(1, 'adept', i + 7777)], i + 1));
const share = usageShare(res);
console.log(`AI(adept) vs AI(adept), ${N} rounds in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const [k, v] of Object.entries(share).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(10)} ${(v * 100).toFixed(1)}%`);
const wins = [0, 0, 0];
for (const r of res) wins[r.winner === null ? 2 : r.winner]++;
console.log(`  seat0 wins ${wins[0]}, seat1 wins ${wins[1]}, draws ${wins[2]}`);
console.log(`  avg length ${(res.reduce((a, r) => a + r.ticks, 0) / N / 30).toFixed(1)}s`);

let spamWins = 0;
const M = Math.min(N, 200);
for (let i = 0; i < M; i++) {
  const r = runDuel([new EclipseSpammer(0), new WizardAI(1, 'adept', i + 3)], 5000 + i);
  if (r.winner === 0) spamWins++;
}
console.log(`Eclipse spammer vs adept: spammer wins ${spamWins}/${M}`);
