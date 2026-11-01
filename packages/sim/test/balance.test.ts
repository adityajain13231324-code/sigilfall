import { describe, it, expect } from 'vitest';
import { WizardAI, EclipseSpammer, runDuel, usageShare, HeadlessResult } from '../src';

describe('headless AI-vs-AI balance', () => {
  it('no single spell exceeds 45% of casts over 1000 rounds', () => {
    const res: HeadlessResult[] = [];
    for (let i = 0; i < 1000; i++) res.push(runDuel([new WizardAI(0, 'adept', i + 1), new WizardAI(1, 'adept', i + 7777)], i + 1));
    const share = usageShare(res);
    for (const [k, v] of Object.entries(share)) expect(v, `${k} usage`).toBeLessThan(0.45);
    expect(Object.keys(share).length).toBeGreaterThanOrEqual(7); // every spell is actually used
    const seat0 = res.filter((r) => r.winner === 0).length / res.length;
    expect(seat0).toBeGreaterThan(0.4);
    expect(seat0).toBeLessThan(0.6);
  });

  it('an Eclipse-spam strategy loses to a basic counter strategy', () => {
    let spamWins = 0;
    const n = 200;
    for (let i = 0; i < n; i++) {
      if (runDuel([new EclipseSpammer(0), new WizardAI(1, 'adept', i + 3)], 9000 + i).winner === 0) spamWins++;
    }
    expect(spamWins / n).toBeLessThan(0.1);
  });

  it('difficulty ladder holds: Archmage > Adept > Apprentice', () => {
    const rate = (a: 'apprentice' | 'adept' | 'archmage', b: 'apprentice' | 'adept' | 'archmage') => {
      let w = 0;
      let games = 0;
      for (let i = 0; i < 200; i++) {
        const r = runDuel([new WizardAI(0, a, i + 1), new WizardAI(1, b, i + 5000)], 300 + i);
        if (r.winner !== null) { games++; if (r.winner === 0) w++; }
      }
      return w / games;
    };
    expect(rate('adept', 'apprentice')).toBeGreaterThan(0.55);
    expect(rate('archmage', 'adept')).toBeGreaterThan(0.52);
  });
});
