# Credits and licences

SIGILFALL's characters, spells, symbols, world, UI, models and sound are original. Models are built from primitives in code; audio is synthesised with the Web Audio API. **No third-party art or audio assets are bundled.**

## Libraries

| Package | Use | Licence |
|---|---|---|
| [three](https://github.com/mrdoob/three.js) 0.186.1 | 3D rendering | MIT |
| [postprocessing](https://github.com/pmndrs/postprocessing) 6.39.5 | bloom, vignette, chromatic aberration, grain | Zlib |
| [colyseus](https://github.com/colyseus/colyseus) core 0.16.24, ws-transport 0.16.5, colyseus.js 0.16.22 | multiplayer rooms | MIT |
| [Vite](https://vite.dev), [Vitest](https://vitest.dev), [TypeScript](https://www.typescriptlang.org), [tsx](https://github.com/privatenumber/tsx), [concurrently](https://github.com/open-cli-tools/concurrently) | tooling | MIT / Apache-2.0 |
| [Playwright](https://playwright.dev) | end-to-end test | Apache-2.0 |

## Algorithms

- **$P point-cloud recogniser** — Vatavu, Anthony, Wobbrock, *Gestures as point clouds* (ICMI 2012). Re-implemented in TypeScript (`packages/recognizer`); no code copied.

## Deviations from the original brief (documented, not hidden)

- Particles use a small in-repo GPU point system behind the `VfxManager` interface instead of three.quarks.
- Audio uses raw Web Audio instead of Howler/Tone/ZzFX; the same synthesis ideas (FM bells, filtered noise, glides) apply.

## Third-party assets

None. If you add samples (see `assets/audio/README.md`) list them here: title, author, URL, licence, modifications.
