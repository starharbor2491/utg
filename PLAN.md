# untitled tank game — PlayCanvas architecture

## Runtime

- **Engine**: PlayCanvas 2.24, WebGL2 and GLSL only, TypeScript and Vite.
- **Rendering**: native WebGL2 backbuffer with MSAA. No Three.js renderer, EffectComposer, bloom chain, or WebGPU path.
- **Loop**: `src/main.ts` owns manual frame submission, 60 FPS active / 15 FPS paused / hidden-tab suspension, shadow cadence, adaptive quality, UI, and QA hooks.
- **Assets**: textured GLBs loaded by PlayCanvas container assets. See `CREDITS.md` for licenses. Meshopt and the PlayCanvas Basis decoder are vendored locally. `src/game/engine/hdr.ts` decodes the Radiance sky into the engine environment pipeline.
- **Engine adapters**: `src/game/engine/` owns geometry construction and normalized GLB readback, scene entities, materials and shader hooks, instancing, math, HDR, and app access.

## Gameplay

- `Match`, `Tank`, `PlayerController`, `BotAI`, `Ballistics`, `Drone`, and `DamageModel` implement the TDM, part-based damage, vehicles, guided weapons, FPV behavior, and flight model.
- `World` owns terrain, rivers, cover, scenery, grass streaming, lighting, and collision queries.
- `Effects` uses fixed-capacity instanced pools. `Destruction` owns cached wreck geometry, terrain-contact rigid bodies, debris, burning materials, and wreck obstacles.
- Rigs live in `src/game/models/`: Apache and Little Bird GLBs with procedural mounts, shared 6×6 chassis, rocket cassette, Support radar/drone equipment, FPV drone, and animated track links. Heavy ERA and the Humvee M2 are assembled in `AssetLoader`.

## Offline packaging

`npm run build:single` creates `untitled-tank-game.html`. The packer embeds the JavaScript, CSS, GLBs, terrain textures, HDR sky, and both Basis decoder files. The document runs directly over `file://` without network requests or a local server.

## Verification

- `npx tsc --noEmit` — whole-project typecheck.
- `node scripts/damage-selftest.mjs` — 26 pure damage-model checks.
- `node scripts/gameplay-selftest.mjs` — real UI engagement, camera/input isolation, FPV lifecycle, vehicle mechanics, track animation, chip damage, destruction, and river checks. Set `PLAYWRIGHT_MODULE` when Playwright is installed outside the repo.
- `showroom.html` — class/team/view model inspection with grounding, connectivity, vertex, and depth audits.
- `npm run build` and `npm run build:single` — production and offline packaging gates.
- Browser smoke must finish with zero console/page errors. Wreck `drop` and `edge` physics checks must both return `ok: true`.

Deployment targets static GitHub Pages from `dist/`. See `PLAY.md` for controls and the public URL.
