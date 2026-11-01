# SIGILFALL

A browser wizard-duel game where you **draw glowing sigils** to cast. Trace a rune, watch the charge gather at your wand, release it at the Hollow Magister, and read your rival's own gestures to survive. Single-player, a Practice Sanctum, and online 1v1.

Everything is original: characters, spells, symbols, world, models, UI and audio (procedural, no samples shipped). See [CREDITS.md](CREDITS.md).

## Run it

```bash
npm install
npm run dev:all      # client on http://localhost:5173 + multiplayer server on :2567
```

`npm run dev` runs the client only (single-player and Practice need no server). `npm run build` makes a production client in `packages/client/dist`.

```bash
npm test             # recognizer, sim, balance and server tests (Vitest)
npm run typecheck
PW_CHANNEL=chrome npm run test:e2e   # Playwright smoke test (uses installed Chrome; or run `npx playwright install chromium`)
npm run sim:balance  # 1000 headless AI-vs-AI rounds: spell usage, win rates
```

## Controls

| Action | Desktop | Touch |
|---|---|---|
| Draw a sigil | hold the mouse inside the glass sigil plane, release to cast | drag |
| Feint (cancel) | release the pointer **outside** the plane | same |
| Blink one lane | `A` / `D` or arrow keys | swipe from the screen edges, or the on-screen arrows |
| Fire held orb | `Q` Aurum, `E` Umbra | tap the orb slots |
| Quick-cast (accessibility, off by default) | `1`–`8`, +30% Aether, always Rough | — |
| Pause | `Esc` | Pause button |

## The sigils

| Spell | Draw | Notes |
|---|---|---|
| Cinder Bolt | ▲ upward triangle | fast fire bolt, burns |
| Stormfork | ϟ zigzag (Z) | marks a lane, then strikes; half ignores Ward; staggers casters |
| Glacier Ward | ∩ arch | wall across all lanes, 30 absorb, fire ×1.5 |
| Mirrorveil | ◇ diamond | reflects the first projectile; catch nothing and you are exhausted |
| Gravewell | inward spiral | collapses projectiles and Eclipse, pops orbs, interrupts channels |
| Aurum / Umbra Orb | circle: **clockwise** / **counter-clockwise** | hold one of each; `Q`/`E` fire Knockback Blast / Pull Lance |
| Eclipse Rend | ∞ with both orbs held | 2.5 s channel, 55 damage + Poise break |

Combos: **Thunderburn**, **Prism Return**, **Wellspring**. Full table, counters and rationale: [docs/DESIGN.md](docs/DESIGN.md).

Spam is deliberately unreliable: repeating a spell raises its cost, lowers its power and gives a growing chance that the charge **misfires**; frantic bursts add more risk. Mix your spells (Spellweave) instead.

## Architecture

```
packages/
  recognizer/  $P point-cloud sigil recognizer, parametric templates, packing for the wire
  sim/         deterministic 30 Hz combat simulation + AI (pure TS, no DOM, no three.js)
  client/      three.js renderer, input, HUD, procedural audio, Practice Sanctum, net client
  server/      authoritative DuelHost + thin Colyseus room (runs the same sim)
```

`packages/sim` is the single source of truth. Single-player runs it in the browser with the AI as seat 1; online runs the very same code on the server, which also runs the recognizer on raw strokes (a client can never claim a spell). The renderer only reads sim state and reacts to sim events.

## Multiplayer

- **Quick Match** pairs two waiting players; **Private room** shows a 6-character code.
- Server-authoritative: recognition, damage, cooldowns, rate limits. Clients predict locally (trail, caption, windup) and render 30 Hz snapshots.
- 20 s reconnect window, rematch, ping indicator. Designed for ~150 ms RTT (windups ≥ 0.2 s, travel 0.7–2 s).
- Set the server URL in the Multiplayer screen if it is not on the same host.

Deploy: `docker build -t sigilfall-server . && docker run -p 2567:2567 sigilfall-server`, or on any Node 20+ host `npm ci && npm run start -w @sigilfall/server` (set `PORT`). Serve `packages/client/dist` from any static host and point the client at your `wss://` URL. `/health` returns `ok`.

## Tuning

All numbers live in [`packages/sim/src/balance.json`](packages/sim/src/balance.json) (resources, windups, costs, fatigue, misfire, tide, oaths). Recognition thresholds are in `packages/recognizer/src/recognize.ts` (`DEFAULT_RECOGNIZER_CONFIG`), also adjustable in-game (strictness) and with personal templates in the Practice Sanctum. After changing numbers run `npm test` and `npm run sim:balance`.

## Accessibility and performance

Clarity mode (less bloom, shake, particles), reduced motion (also follows the OS setting), colour-blind shape icons, UI and sigil-plane scaling, click-to-draw, sound captions, volume sliders. The renderer lowers resolution, bloom and particle caps automatically when frames run long.

## Status

Playable end to end. See [docs/DESIGN.md](docs/DESIGN.md) for known limits and what is stubbed (stretch spells, spectators, ranked ladder).
