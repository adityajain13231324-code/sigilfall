# Optional audio samples (Layer B)

SIGILFALL ships with **no third-party audio**: every sound is synthesised at runtime (Layer A, `packages/client/src/audio.ts`).

To upgrade a sound with a licensed sample, drop an `.ogg`/`.mp3` into this folder and list it in `manifest.json`:

```json
{ "impact_cinder": "cinder-hit.ogg", "recog_ward": "ice-chime.ogg" }
```

Keys are the sound-event names used in `audio.ts` (`SFX` table: `drawStart`, `recog_<spell>`, `tier_rough|clean|perfect`, `fizzle`, `windup_<school>`, `release`, `impact_<kind>`, `wardAbsorb`, `wardCrack`, `wardShatter`, `mirrorOn`, `mirrorReflect`, `mirrorExhaust`, `gravInhale`, `gravCollapse`, `orbCreate`, `orbPop`, `blink`, `poiseBreak`, `stagger`, `damage`, `heartbeat`, `roundStart`, `roundWin`, `roundLose`, `tide`, `fatigueCrack`, `weave`, ...). A sample that fails to load silently falls back to the procedural sound.

Sourcing rules: prefer **CC0** (Kenney, OpenGameArt CC0 items, Freesound CC0), then CC-BY with attribution, nothing else. Normalise to about -16 LUFS for effects (-20 LUFS for music). **Record every file in `/CREDITS.md`** (title, author, URL, licence, modifications). Never use audio from other games, films or anime.
