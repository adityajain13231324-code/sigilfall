# SIGILFALL design notes

## Spell table (starting values; source of truth is `packages/sim/src/balance.json`)

| Spell | Aether | Windup | Cooldown | Effect |
|---|---|---|---|---|
| Cinder Bolt | 10 | 0.35 s | 0.8 s | 9 dmg, 4 Poise, 0.7 s travel, Burn 2/s for 3 s |
| Stormfork | 22 | 0.5 s (+0.55 s telegraph) | 2.5 s | 16 dmg, 16 Poise, ignores 50% of Ward absorb |
| Glacier Ward | 18 | 0.4 s | 6 s | 30 absorb, 4 s, fire ×1.5, breaks into 3 shards (6 dmg) |
| Mirrorveil | 25 | 0.2 s | 2.5 s | 0.7 s veil, reflects first projectile at +20% speed; empty veil = 0.8 s exhaustion, −10 Aether |
| Gravewell | 30 | 0.7 s | 10 s | collapses enemy projectiles within 1 s, pops orbs, interrupts channel, 8 dmg; 1 s open (×1.25 damage taken) |
| Aurum Orb | 20 | 0.5 s | 1 s | orb for 14 s; `Q` fires Knockback Blast (14 dmg, 15 Poise, shoves a lane, cancels a draw) |
| Umbra Orb | 20 | 0.5 s | 1 s | orb for 14 s; `E` fires Pull Lance (10 dmg, drags enemy projectiles to another lane) |
| Eclipse Rend | 15 + 2 orbs | 2.5 s channel | 25 s | 55 dmg + Poise break, 2 s travel, slow lane tracking, not reflectable, annihilates Ward |
| Piercing Dart | 7 | 0.2 s | 0.6 s | 7 dmg, 0.4 s travel, pierces Ward |
| Riptide Lash | 11 | 0.35 s | 1.5 s | 9 dmg, Chill 3 s (casting 25% slower) |
| Mending Light | 24 | 0.6 s | 14 s | +16 Vitality over 2 s, cures Burn |
| Aegis | 20 | 0.3 s | 9 s | 4 s of −40% damage and −50% Poise damage |
| Moonblade | 14 | 0.4 s | 2 s | 12 dmg, 6 Poise, hits lane ±1 |
| Starfall | 30 | 0.7 s | 9 s | 3 meteors (12 dmg + short Burn) at 0.5 s, 0.8 s, 1.1 s, one per lane, absorbed by Ward |
| Twin Fangs | 15 | 0.4 s | 2.5 s | two 8 dmg projectiles in different lanes, 0.6 s and 0.85 s |

Resources: Vitality 100, Aether 100 (+8/s, paused 0.6 s after casting), Poise 50 (break = 2 s stagger, ×1.5 damage, resets to 25). Blink: 8 Aether, 0.15 s, 6 ticks of invulnerability, 1.2 s cooldown.

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

`npm run sim:ablate` plays an Adept that may not cast one spell against a full-kit Adept; `packages/sim/scripts/dmg.ts` attributes damage per source. Findings that shaped the numbers: a Stormfork telegraph of 0.35 s was effectively undodgeable for the AI (and tight for humans), which let it deal over half of all damage, so it is now 0.55 s; Cinder's Burn made it the most Aether-efficient spell, so Burn was trimmed; Mending Light was worth about 8 points of win rate and was reduced; the new spells were raised to roughly 0.8-1.1 damage per Aether. Cinder and Stormfork remain the backbone (as the cheap pressure and the punisher), every new spell now sits within about 5 points of neutral except Dart (slightly strong) and the orbs (slightly weak for the AI).

`npm run sim:balance` (1000 Adept-vs-Adept rounds): no spell above ~40% of casts, seat win rate ≈ 50/50; an Eclipse-only strategy wins 0 of 200 against a basic counter-playing AI. Both are asserted in `packages/sim/test/balance.test.ts`.

## Difficulty and pacing

Projectiles fly 30% slower than their listed travel times (`projectileSlow` in `balance.json`; Eclipse is unchanged), so spells read clearly and are easier to dodge. The third-person camera sits high and to the side so both wizards, the lanes and every projectile are on screen at once.

The draw window is 6 s (`drawWindow`), the recogniser accepts strokes up to 7 s, and your line stays on screen while you hold. The default opponent (Gentle) reacts in 0.5-0.8 s, dodges about a fifth of the time and waits 1.5-3.3 s between casts; Adept and Archmage tighten all of those (`PROFILES` in `packages/sim/src/ai.ts`).

## Recognizer accuracy

15 sigils (14 shapes; the circle is Aurum or Umbra by direction). `npm test` asserts at least 95% correct and under 1% wrong-spell casts on 200 noisy samples per spell, plus adversarial scribbles, tiny strokes, lines and double taps. Hard cases are separated with geometry the point cloud cannot see: tangent turning, closure, corner count, roundness, solidity (heart notch), and bounding-box corner proximity (square vs diamond).

## Known limits

- Particles use an in-repo point system, not three.quarks; mirror/gravity lensing is shader-faked rather than screen-space refraction.
- Spectators, ranked ladder, stretch spells (Emberwisp, Tide Surge, Hex of Echoes) and the other three opponents are design-only.
- Online snapshots are rendered with a short blend, not a full 100 ms interpolation buffer.
- Performance targets were not benchmarked on phones or an iGPU-only laptop in this build.
