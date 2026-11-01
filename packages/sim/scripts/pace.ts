import { WizardAI, runDuel, Difficulty } from '../src';
/** casts per minute and round length per difficulty (AI mirror matches) */
for (const level of ['apprentice', 'adept', 'archmage'] as Difficulty[]) {
  let casts = 0, secs = 0, timeouts = 0; const N = 150;
  for (let i = 0; i < N; i++) {
    const r = runDuel([new WizardAI(0, level, i + 1), new WizardAI(1, level, i + 500)], i + 1);
    casts += r.state.w[1].casts; secs += r.ticks / 30; if (r.reason === 'timeout') timeouts++;
  }
  console.log(level.padEnd(10), 'boss casts/min', ((casts / secs) * 60).toFixed(1), '| avg round', (secs / N).toFixed(0) + 's', '| timeouts', timeouts + '/' + N);
}
