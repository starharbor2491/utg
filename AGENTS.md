# AGENTS.md — untitled tank game

## Commands
- **Dev server**: `npm run dev` (starts Vite at `http://127.0.0.1:5173`)
- **Typecheck**: `npx tsc --noEmit`
- **Production build**: `npm run build` (`tsc && vite build`, outputs `dist/`)
- **Single-file standalone HTML**: `npm run build:single` (`tsc && vite build && node scripts/pack-single-html.mjs` — packs everything into `untitled-tank-game.html`, runnable directly over `file://` with zero dependencies)
- **Local preview**: `npm run preview` (`http://127.0.0.1:4173`) or `./PLAY.command`

## Architecture & Conventions
- **Coordinate system (`src/game/types.ts`)**:
  - Right-handed Y-up (`1 unit = 1 meter`).
  - `yaw = 0` points along `+Z`, `forwardXZ(yaw) = (Math.sin(yaw), 0, Math.cos(yaw))`, `rightXZ(yaw) = (-Math.cos(yaw), 0, sin(yaw))`.
  - All 5 vehicle classes (`normal`, `heavy`, `ifv`, `humvee`, `rocket`) are grounded at `min.y = 0` in rest pose inside `src/game/AssetLoader.ts`.
  - In Three.js right-handed space, `gunPivot.rotation.x = -gunPitch` elevates the `+Z` barrel upward.
- **Performance & Thermal Discipline (`src/main.ts`)**:
  - Renders directly to the native WebGL2 backbuffer (`antialias: true`) so Apple Silicon uses zero-bandwidth on-chip tile MSAA rather than offscreen multi-pass `EffectComposer` resolves.
  - Frame pacing is capped at `60 FPS` during active play, `15 FPS` on the pause/start overlay, and `0 FPS` when `document.hidden` is true; directional shadow maps update at `30 Hz`.

## Battle simulator (TDM) notes
- **Vehicle showroom (dev only)**: `http://127.0.0.1:5173/showroom.html?v=<normal|heavy|ifv|humvee|rocket>&team=<blue|red>&view=<front|side|34|top|rear|close-wheel|close-pod|close-gun>&pitch=<rad>` — runs `auditThreeObject` on every rig; not shipped by `npm run build`.
- **QA hooks** (`window.__tankQA`): `engageForTest()`, `fastForward(seconds)` (headless sim steps), `getMatchState()` (score, `friendlyFireEvents` must stay 0), `killForTest(id, catastrophic)`, `setWreckFxVisible(bool)`, `setCameraForTest(...)`, `physicsSelfTest()`, `getRenderStats()`.
- Screenshot harness lives outside the repo in `/tmp/shots` (playwright 1.63 + cached chromium-1243, flags `--use-angle=metal --enable-unsafe-swiftshader`; wiped on reboot): `ui.mjs <outdir>` (briefing/HUD/optic/respawn/feed), `wreck.mjs <outdir>` (burnt wrecks + `probeWreckClearance`), `perf.mjs` (120 s TDM, `perfSample`, `physicsSelfTest`), `file.mjs` (standalone HTML over file://). If 5173 is taken by another project, run `npx vite --port 5174 --strictPort`.
- `probeWreckClearance()` reports per part `minGap`, `belowFrac`, `asleep`, `tiltDeg` (0 = resting on a face). `physicsSelfTest()` must return `ok:true` for both `drop` and `edge` cases.
- HUD tokens live in `:root` of `src/game/hud.css` (`--fcs-*`). Amber accent is reserved for the reticle, ready state, selected shell and selected vehicle; sentence case, no letter-spacing, no `backdrop-filter`.
- Rocket launcher is procedural three.js (`src/game/models/RocketLauncher.ts`); Humvee/IFV are tevy.dev CC0 LOD1 GLBs.
