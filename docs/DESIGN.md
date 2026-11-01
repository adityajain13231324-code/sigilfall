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

## Arena and skill mechanics

| Mechanic | Rule |
|---|---|
| Hollow Rift | first at 14 s, then every ~20 s: a random lane is marked for 1.4 s, then deals 4 dmg/s for 5 s to anyone standing in it (Aegis reduces it; a Blink in progress is safe) |
| Aether crystal | first at 7 s, then every ~12 s: appears in a lane (never the Rift's) for 8 s; the first wizard to stand in the lane gets +25 Aether and +6 Vitality |
| Perfect Dodge | an attack aimed at the lane you left arrives within 9 ticks (0.3 s) of starting your Blink: refunds the Blink cost, +14 Aether, Focus for 3 s (windups ×0.7). The reward can trigger at most every 4 s, so Blink-spamming is not a strategy |
| Perfect Parry | the Mirrorveil catches a projectile within its first 10 ticks (0.33 s): reflection ×1.4, +10 Aether |
| Overcharge | 3 consecutive Perfect-tier draws (any non-Perfect cast resets): the next drawn spell ×1.35 |
| Counter Hit | damage to a wizard in Windup or Channeling ×1.2 |
| Shatter | Cinder on a Chilled target ×1.3, consumes the Chill |
| Boss phases | the AI computes a phase from Vitality (<66, <33): think time ×0.75 / ×0.55, +8% dodge skill per phase, weights toward Starfall, Moonblade and Eclipse |

All of it lives in the deterministic sim (`arena`, `mechanics` blocks in `balance.json`), so online duels get it too.

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


## Mechanic tuning notes

`packages/sim/scripts/mech-stats.ts` counts how often each mechanic fires per round in AI-vs-AI play, and `packages/recognizer/scripts/tiers.ts` measures how often hand-drawn strokes score Perfect (about 60-68% for a careful hand, 39% for a shaky one, so a three-Perfect Overcharge is reachable but must be earned). Changes from the first playtest data: Perfect Dodge fired 12.7 times a round for the strongest AI because rewards chained with a Blink cooldown reset, so the reset was removed and rewards got a 4 s cooldown (now about 7); the dodge window was widened from 6 to 9 ticks and the parry window from 7 to 10 so a human can hit them; the Rift was trimmed to 4 dmg/s; the AI now actually plays the Riptide then Cinder Shatter combo (0.03 to roughly 0.3-1 per round).


## Pacing: deliberate, not frantic

Duels are meant to be read, not mashed. Rules that enforce it (all in `balance.json`):

- **Commit and wait**: after any cast you recover for at least `globalCooldown` (1.5 s; 0.8 s for Ward/Aegis) and cannot draw. The sigil plane dims while you wait.
- **Charges are longer**: windups are ×1.5 (`windupScale`); Eclipse's channel is unchanged.
- **Aether is the leash**: costs are ×1.7 and regeneration is 5/s, so a spell every second is impossible; blink costs 10, a fizzle 8.
- **Spam is punished**: stacked fatigue and misfire chance on top.
- **The boss is patient**: it waits 4-7 s between actions on Gentle (about 7 casts a minute), 2.3-4.5 s on Adept (about 14), 1.3-2.8 s on Archmage (about 17), draws slowly enough for you to read its tell, and dodges are instinct but casting is deliberate. Only a real threat (an Eclipse channel, held orbs, an incoming Eclipse) makes it react immediately.
- Rounds are 150 s; if time runs out the higher Vitality wins.

`packages/sim/scripts/pace.ts` prints casts per minute and round length per difficulty.
