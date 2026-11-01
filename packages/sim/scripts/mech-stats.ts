import { WizardAI, runDuel, Difficulty } from '../src';
import { stepDuel, createDuel } from '../src';

/** how often each skill mechanic fires per round in AI-vs-AI play */
for (const level of ['apprentice', 'adept', 'archmage'] as Difficulty[]) {
  const counts: Record<string, number> = {};
  const N = 300;
  let ticks = 0;
  for (let i = 0; i < N; i++) {
    const s = createDuel(i + 1);
    const a = new WizardAI(0, level, i + 1);
    const b = new WizardAI(1, level, i + 777);
    while (!s.over) {
      const ev = stepDuel(s, [a.act(s), b.act(s)]);
      a.observe(ev, s); b.observe(ev, s);
      for (const e of ev) {
        const k = e.type === 'combo' ? 'combo:' + e.name : e.type;
        if (['perfectDodge', 'overcharge', 'hazard', 'crystal', 'misfire', 'break', 'reflect'].includes(e.type) || k.startsWith('combo:')) counts[k] = (counts[k] ?? 0) + 1;
      }
    }
    ticks += s.tick;
  }
  console.log(level.padEnd(10), 'avg round', (ticks / N / 30).toFixed(1) + 's', Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, +(v / N).toFixed(2)])));
}
