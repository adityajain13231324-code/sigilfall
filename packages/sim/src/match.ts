import type { DuelState, Oath, PlayerId } from './types';
import { createDuel } from './sim';
import { B } from './sim';

/** Best-of-3 wrapper around single-round duels. Shared by the client (single-player) and the server (online). */
export interface MatchState {
  round: number;
  wins: [number, number];
  oaths: [Oath | null, Oath | null];
  seed: number;
  duel: DuelState;
  winner: PlayerId | null;
  done: boolean;
}

export function createMatch(seed = 1, oaths: [Oath | null, Oath | null] = [null, null]): MatchState {
  return { round: 1, wins: [0, 0], oaths, seed, duel: createDuel(seed, oaths), winner: null, done: false };
}

/** Call once `m.duel.over` is set. Returns true if another round follows. */
export function finishRound(m: MatchState): boolean {
  const o = m.duel.over;
  if (!o) return !m.done;
  if (o.winner !== null) m.wins[o.winner]++;
  const champ = m.wins.findIndex((w) => w >= B.roundsToWin);
  if (champ >= 0 || m.round >= 5) {
    m.done = true;
    m.winner = champ >= 0 ? (champ as PlayerId) : m.wins[0] === m.wins[1] ? null : m.wins[0] > m.wins[1] ? 0 : 1;
    return false;
  }
  return true;
}

export function nextRound(m: MatchState): void {
  m.round++;
  m.duel = createDuel(m.seed + m.round * 101, m.oaths);
}
