import type { Bot } from './ai';
import type { DuelState, Oath, SpellId } from './types';
import { createDuel, stepDuel } from './sim';

export interface HeadlessResult {
  winner: 0 | 1 | null;
  reason: string;
  ticks: number;
  casts: [Partial<Record<SpellId, number>>, Partial<Record<SpellId, number>>];
  state: DuelState;
}

/** Run one round with two bots, no renderer. Deterministic for a given seed. */
export function runDuel(bots: [Bot, Bot], seed: number, oaths: [Oath | null, Oath | null] = [null, null]): HeadlessResult {
  const s = createDuel(seed, oaths);
  let events: ReturnType<typeof stepDuel> = [];
  while (!s.over) {
    const c0 = bots[0].act(s);
    const c1 = bots[1].act(s);
    events = stepDuel(s, [c0, c1]);
    bots[0].observe(events, s);
    bots[1].observe(events, s);
  }
  return { winner: s.over.winner, reason: s.over.reason, ticks: s.tick, casts: [s.w[0].stats.casts, s.w[1].stats.casts], state: s };
}

/** Aggregate spell usage across many AI-vs-AI rounds. */
export function usageShare(results: HeadlessResult[]): Record<string, number> {
  const tot: Record<string, number> = {};
  let n = 0;
  for (const r of results) {
    for (const c of r.casts) {
      for (const [k, v] of Object.entries(c)) {
        tot[k] = (tot[k] ?? 0) + (v ?? 0);
        n += v ?? 0;
      }
    }
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(tot)) out[k] = v / (n || 1);
  return out;
}
