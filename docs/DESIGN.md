# SIGILFALL design notes

## Spell table (starting values; source of truth is `packages/sim/src/balance.json`)

| Spell | Aether | Windup | Cooldown | Effect |
|---|---|---|---|---|
| Cinder Bolt | 10 | 0.35 s | 0.8 s | 9 dmg, 4 Poise, 0.7 s travel, Burn 2/s for 3 s |
| Stormfork | 22 | 0.5 s (+0.35 s telegraph) | 2 s | 16 dmg, 20 Poise, ignores 50% of Ward absorb |
| Glacier Ward | 18 | 0.4 s | 6 s | 30 absorb, 4 s, fire ×1.5, breaks into 3 shards (6 dmg) |
| Mirrorveil | 25 | 0.2 s | 2.5 s | 0.7 s veil, reflects first projectile at +20% speed; empty veil = 0.8 s exhaustion, −10 Aether |
| Gravewell | 30 | 0.7 s | 10 s | collapses enemy projectiles within 1 s, pops orbs, interrupts channel, 8 dmg; 1 s open (×1.25 damage taken) |
| Aurum Orb | 20 | 0.5 s | 1 s | orb for 14 s; `Q` fires Knockback Blast (14 dmg, 15 Poise, shoves a lane, cancels a draw) |
| Umbra Orb | 20 | 0.5 s | 1 s | orb for 14 s; `E` fires Pull Lance (10 dmg, drags enemy projectiles to another lane) |
| Eclipse Rend | 15 + 2 orbs | 2.5 s channel | 25 s | 55 dmg + Poise break, 2 s travel, slow lane tracking, not reflectable, annihilates Ward |

Resources: Vitality 100, Aether 100 (+8/s, paused 0.6 s after casting), Poise 40 (break = 2 s stagger, ×1.5 damage, resets to 25). Blink: 8 Aether, 0.15 s, 6 ticks of invulnerability, 1.2 s cooldown.

## Counter matrix (row beats / pressures column)

| | Cinder | Storm | Ward | Mirror | Gravewell | Orbs | Eclipse |
|---|---|---|---|---|---|---|---|
| Cinder | – | | loses (×1.5 to Ward helps) | reflected | | | |
| Storm | dodge by lane | – | **beats** | cannot be reflected | | stagger channel | interrupts |
| Ward | **beats** | loses | – | | | Wellspring w/ Umbra | annihilated |
| Mirror | **beats** (if timed) | no effect | | – | | Prism Return w/ Aurum | cannot reflect |
| Gravewell | collapses | | | | – | **pops** | **collapses / interrupts** |
| Blink | dodge | dodge | | | | | late Blink dodges |

## Anti-spam systems

- **Spell Fatigue**: same spell repeatedly within 5 s: +35% Aether and −15% power per stack.
- **Misfire (chance-based)**: from the 2nd stacked repeat, each cast has a growing chance (18% per stack, capped 60%) that the charge is unstable: the orb visibly shakes, then collapses with a 0.5 s stagger and no effect. Four or more casts inside 4 s add 15%. Decided by the seeded sim RNG, so online and replay agree.
- **Spellweave**: three different spells in 8 s: +10% damage, +25% Aether regen for 4 s.
- **Aether Tide** every 20 s: one school costs −30% for 6 s. **Oaths**: Embers, Stillness, Echoes.
- **Charge-up**: every cast visibly gathers at the wand tip for its windup, then the projectile is born at the tip and grows as it leaves. That gathering is the opponent's reading window.

## Tell fidelity

While drawing, the opponent sees a colour family at ≈40% of your stroke (warm: Cinder/Aurum, cold: Storm/Ward, silver: Mirror, dark: Gravewell/Umbra/Eclipse) and the exact blurred shape at ≈70%. The client predicts this from the partial stroke (`predictPrefix`), so it can be wrong, which is what makes feints work. The AI uses the same information.

## Public interfaces

**Recognizer** (`@sigilfall/recognizer`)
`recognize(stroke: Pt[], opts?) → { spell, shape, tier, score, ranked, reason?, winding? }` where `Pt = {x,y,t?}` in plane units 0–1000 (y down). Options: `allowed` shapes (context-aware), `custom` templates, `strictness`. Also `packStroke / unpackStroke` (flat int array `[x,y,dt,…]`, ≤400 points), `makeTemplate`, `validateTemplates` (≤3 per shape), `scoreAgainst`, `predictPrefix`, `canonical`.

**Sim** (`@sigilfall/sim`)
`createDuel(seed, oaths) → DuelState`, `stepDuel(state, [cmds0, cmds1]) → SimEvent[]` at 30 Hz, no wall clock, seeded RNG, state is plain JSON. Commands: `drawStart`, `drawCancel`, `tell`, `cast {spell|null, tier, quick?}`, `blink {dir}`, `orb {which}`, `oath`. `createMatch / finishRound / nextRound` for best-of-3. `WizardAI(seat, difficulty, seed)` and `runDuel` for headless play.

**Network** (Colyseus room `duel`)
Client → server: `pickOath {oath}`, `cmd {t: drawStart|drawCancel|tell|blink|orb, …}`, `cast {stroke}` | `{fizzle:true}` | `{quick: spell}`, `rematch`, `ping {t}`.
Server → client: `seat {seat, code}`, `snap {phase, countdown, round, wins, oaths, state, events, winner, rematch, connected}` at 30 Hz, `pong`.
The server ignores any spell or tier a client claims: it recognises the stroke itself.

## Balance evidence

`npm run sim:balance` (1000 Adept-vs-Adept rounds): no spell above ~40% of casts, seat win rate ≈ 50/50; an Eclipse-only strategy wins 0 of 200 against a basic counter-playing AI. Both are asserted in `packages/sim/test/balance.test.ts`.

## Known limits

- Particles use an in-repo point system, not three.quarks; mirror/gravity lensing is shader-faked rather than screen-space refraction.
- Spectators, ranked ladder, stretch spells (Emberwisp, Tide Surge, Hex of Echoes) and the other three opponents are design-only.
- Online snapshots are rendered with a short blend, not a full 100 ms interpolation buffer.
- Performance targets were not benchmarked on phones or an iGPU-only laptop in this build.
