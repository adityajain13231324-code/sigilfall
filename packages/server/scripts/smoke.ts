import { Client } from 'colyseus.js';
import { canonical, packStroke } from '@sigilfall/recognizer';

/** Two real WebSocket clients play a few seconds against a running server: `npm run dev:server` then `tsx packages/server/scripts/smoke.ts` */
const url = process.argv[2] ?? 'ws://localhost:2567';
const stroke = packStroke(canonical('triangle').map((p, i) => ({ x: 250 + p.x * 500, y: 250 + p.y * 500, t: i * 12 })));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const a = await new Client(url).create('duel', { private: true });
const code = a.roomId;
const b = await new Client(url).joinById(code, {});
console.log('room code', code);
let phaseA = '';
let casts = 0;
let last: any = null;
for (const [room, name] of [[a, 'A'], [b, 'B']] as const) {
  room.onMessage('seat', () => {});
  room.onMessage('snap', (s: any) => {
    if (name !== 'A') return;
    last = s;
    if (s.phase !== phaseA) {
      console.log('phase ->', s.phase);
      phaseA = s.phase;
    }
    for (const e of s.events) if (e.type === 'cast') {
      casts++;
      console.log('cast event: player', e.p, e.spell);
    }
  });
}
await wait(300);
a.send('pickOath', { oath: 'embers' });
b.send('pickOath', { oath: 'echoes' });
await wait(3500);
a.send('cmd', { t: 'drawStart' });
await wait(100);
a.send('cast', { stroke });
await wait(2500);
console.log('A state', last?.state?.w?.[0]?.state, 'tick', last?.state?.tick); console.log('B vitality', last?.state?.w?.[1]?.vit, '| A aether', last?.state?.w?.[0]?.aether?.toFixed(1), '| casts seen', casts);
await a.leave();
await b.leave();
process.exit(casts > 0 ? 0 : 1);
