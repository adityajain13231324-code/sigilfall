import { describe, it, expect } from 'vitest';
import { canonical, packStroke } from '@sigilfall/recognizer';
import { DuelHost } from '../src/duelcore';

function triangle() {
  return packStroke(canonical('triangle').map((p, i) => ({ x: 250 + p.x * 500, y: 250 + p.y * 500, t: i * 12 })));
}

function started(): DuelHost {
  const h = new DuelHost(5);
  h.join(0, {});
  h.join(1, {});
  h.message(0, 'pickOath', { oath: 'embers' });
  h.message(1, 'pickOath', { oath: 'echoes' });
  for (let i = 0; i < 100; i++) h.tick();
  expect(h.phase).toBe('fight');
  return h;
}

describe('authoritative duel host', () => {
  it('waits for two players, then drafts oaths, counts down and fights', () => {
    const h = new DuelHost(1);
    h.join(0);
    expect(h.phase).toBe('waiting');
    h.join(1);
    expect(h.phase).toBe('draft');
    expect(h.message(0, 'pickOath', { oath: 'nonsense' })).toBe(false);
    h.message(0, 'pickOath', { oath: 'embers' });
    h.message(1, 'pickOath', { oath: 'stillness' });
    expect(h.phase).toBe('countdown');
    for (let i = 0; i < 100; i++) h.tick();
    expect(h.phase).toBe('fight');
  });

  it('recognises a real stroke server-side and casts', () => {
    const h = started();
    h.message(0, 'cmd', { t: 'drawStart' });
    h.tick();
    expect(h.message(0, 'cast', { stroke: triangle() })).toBe(true);
    const snap = h.tick();
    expect(snap.events.some((e) => e.type === 'cast' && e.p === 0 && e.spell === 'cinder')).toBe(true);
  });

  it('ignores a spell the client claims: the stroke decides', () => {
    const h = started();
    h.message(0, 'cmd', { t: 'drawStart' });
    h.tick();
    h.message(0, 'cast', { stroke: triangle(), spell: 'eclipse', tier: 'perfect' });
    const snap = h.tick();
    const cast = snap.events.find((e) => e.type === 'cast') as any;
    expect(cast.spell).toBe('cinder');
  });

  it('rejects forged, malformed and oversized casts', () => {
    const h = started();
    h.message(0, 'cmd', { t: 'drawStart' });
    h.tick();
    expect(h.message(0, 'cast', { spell: 'eclipse', tier: 'perfect' })).toBe(false);
    expect(h.message(0, 'cast', { stroke: 'AAAA' })).toBe(false);
    expect(h.message(0, 'cast', { stroke: new Array(9000).fill(5) })).toBe(false);
    expect(h.message(0, 'cast', { stroke: [1, 2, 3, 99999, 1, 1, 1, 1, 1, 1, 1, 1] })).toBe(false);
    expect(h.message(0, 'cmd', { t: 'cast', spell: 'eclipse', tier: 'perfect' })).toBe(false);
    expect(h.message(0, 'cmd', { t: 'blink', dir: 5 })).toBe(false);
    expect(h.message(0, 'cmd', { t: 'orb', which: 'nope' })).toBe(false);
    expect(h.message(0, 'bogus', {})).toBe(false);
    expect(h.message(0, 'cast', null)).toBe(false);
  });

  it('cannot cast Eclipse without two orbs even with a perfect infinity stroke', () => {
    const h = started();
    h.message(0, 'cmd', { t: 'drawStart' });
    h.tick();
    const inf = packStroke(canonical('infinity').map((p, i) => ({ x: 200 + p.x * 600, y: 300 + p.y * 400, t: i * 12 })));
    h.message(0, 'cast', { stroke: inf });
    const snap = h.tick();
    expect(snap.events.some((e) => e.type === 'cast' && e.spell === 'eclipse')).toBe(false);
  });

  it('rejects quick-cast unless both players enabled it', () => {
    const h = started();
    expect(h.message(0, 'cast', { quick: 'cinder' })).toBe(false);
    const h2 = new DuelHost(2);
    h2.join(0, { quick: true });
    h2.join(1, { quick: true });
    h2.message(0, 'pickOath', { oath: 'embers' });
    h2.message(1, 'pickOath', { oath: 'embers' });
    for (let i = 0; i < 100; i++) h2.tick();
    expect(h2.message(0, 'cast', { quick: 'cinder' })).toBe(true);
  });

  it('rate-limits message floods', () => {
    const h = started();
    let rejected = 0;
    for (let i = 0; i < 400; i++) if (!h.message(0, 'cmd', { t: 'blink', dir: 1 })) rejected++;
    expect(rejected).toBeGreaterThan(250);
  });

  it('does not accept commands outside the fight phase', () => {
    const h = new DuelHost(3);
    h.join(0);
    h.join(1);
    expect(h.message(0, 'cmd', { t: 'drawStart' })).toBe(false);
  });

  it('runs a best-of-3 to completion, then supports rematch', () => {
    const h = started();
    let guard = 0;
    while (h.phase !== 'matchEnd' && guard++ < 20000) {
      if (h.phase === 'fight') h.match!.duel.w[1].vit = 0;
      h.tick();
    }
    expect(h.phase).toBe('matchEnd');
    expect(h.match!.winner).toBe(0);
    h.message(0, 'rematch', {});
    h.message(1, 'rematch', {});
    expect(h.phase).toBe('draft');
  });

  it('a player who never returns forfeits the match', () => {
    const h = started();
    h.forfeit(1);
    expect(h.phase).toBe('matchEnd');
    expect(h.match!.winner).toBe(0);
  });
});
