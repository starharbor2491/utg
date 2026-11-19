# AGENTS.md — untitled tank game

## Commands
- **Dev server**: `npm run dev` (starts Vite at `http://127.0.0.1:5173`; an active session may be on `:5174` — reuse it)
- **Typecheck**: `npx tsc --noEmit`
- **Production build**: `npm run build` (`tsc && vite build`, outputs `dist/`)
- **Single-file standalone HTML**: `npm run build:single` (`tsc && vite build && node scripts/pack-single-html.mjs` — packs everything into `untitled-tank-game.html`, runnable directly over `file://` with zero dependencies)
- **Damage-model unit tests**: `node scripts/damage-selftest.mjs` (pure `DamageModel`, no three.js)
- **Gameplay regression tests**: `node scripts/gameplay-selftest.mjs` against the dev server with Playwright available. Set `PLAYWRIGHT_MODULE` to the module path if installed outside the repo. Run `node scripts/duel-selftest.mjs` for two-client public signaling and gameplay.
- **Local preview**: `npm run preview` (`http://127.0.0.1:4173`) or `./PLAY.command`

## Architecture & Conventions
- **Coordinate system (`src/game/types.ts`)**:
  - Right-handed Y-up (`1 unit = 1 meter`).
  - `yaw = 0` points along `+Z`, `forwardXZ(yaw) = (Math.sin(yaw), 0, Math.cos(yaw))`, `rightXZ(yaw) = (-Math.cos(yaw), 0, sin(yaw))`.
  - Vehicle rigs are grounded at `min.y = 0` in rest pose. `littlebird` and `apache` are player-only. `Tank.stepFlight` integrates rotor thrust along the airframe's up vector. Shift/Ctrl alone change throttle; throttle, pitch and bank hold until changed; pitch and bank wrap at ±π.
  - In PlayCanvas right-handed space, `setLocalEulerRad(gunPivot, -gunPitch, 0, 0)` elevates the `+Z` barrel upward. Use `getPosition` / `setPosition` and `getWorldTransform`, not Three property names.
- **Damage model (`src/game/DamageModel.ts` + `Tank.takeDamage`)**: no HP — per-module integrity (engine/fuel/ammo/tracks/wheels/turret_ring/gun/launcher/crew), normalized module boxes measured from rig bounds, per-face armour zones with slope-tilted normals, penetration → slug path + spall cone, HE blast falloff, fires/cook-offs/crew-KO/field-repair. `integrityScale` is an *incoming-damage multiplier*, never a spawn handicap (modules always spawn at full integrity). Friendly fire is prevented in `Ballistics`/`DroneManager`; kills credit `lastAttacker` within 20 s.
- **Drone Carrier (`src/game/Drone.ts`)**: one airborne per carrier, with a shared launch cooldown. FPV is projectile-immune and detonates on contact. Gun drone takes projectile damage and crashes without a blast.
- **Performance & Thermal Discipline (`src/main.ts`)**:
  - Renders directly to the native WebGL2 backbuffer (`antialias: true`) so Apple Silicon uses zero-bandwidth on-chip tile MSAA rather than offscreen multi-pass `EffectComposer` resolves.
  - Frame pacing is capped at `60 FPS` during active play, `15 FPS` on the pause/start overlay, and `0 FPS` when `document.hidden` is true; directional shadow maps update at `30 Hz`.
  - Keep hot loops allocation-free (reuse PlayCanvas `Vec3` scratch, pooled projectiles/effects); dense active-index lists for effects; LOS scans throttled. Engine adapters live in `src/game/engine/`; custom GLSL uses `addShaderHooks` with explicit attribute semantics.

## Battle simulator (TDM) notes
- **Vehicle showroom (dev only)**: `http://127.0.0.1:5173/showroom.html?v=<normal|heavy|ifv|humvee|rocket|support|littlebird|apache>&team=<blue|red>&view=<front|side|34|top|rear|close-wheel|close-pod|close-gun>&pitch=<rad>` — runs `auditThreeObject` on every rig; not shipped by `npm run build`.
- **QA hooks** (`window.__tankQA`): `engageForTest()`, `fastForward(seconds)` (headless sim steps; returns `undefined` — read `getMatchState()` after), `getMatchState()` (score, `classKills`, `friendlyFireEvents` must stay 0, per-tank modules/crew/seeker, `drones` counters), `getKillReasonHistogram()`, `getClassKills()`, `killForTest(id, catastrophic)`, `setWreckFxVisible(bool)`, `setCameraForTest(...)`, `clearCameraForTest()`, `teleportForTest(x,z,yaw)`, `teleportRoamForTest(leg)`, `selectClassForTest(cls)`, `physicsSelfTest()`, `getRenderStats()`, `damageSelfTest()`, `damageShowcaseForTest()`, `probeHitForTest('ricochet'|'pen'|'nopen')`, `damageMatrix()` (shell × class × aspect trials), `guidedTest()`, `droneTest()` (autopilot runs vs MBT/humvee with hit/module histograms), `setupBigFight()`, `benchRender(n)`, `setBenchToggle(name,on)`, `setBenchDpr(x)`, `getQualityLevel()`, `forceQualityLevel(n|null)`, `getHitchLog()`, `getFrameTimes()`, `perfSample(frames)`, `getPerfResult()`, `firePlayerCannonForTest()`, `splashAtForTest`, `waterAtForTest`, `runThreeAudit()` (legacy QA name; the audit runs on PlayCanvas entities).
- **Verification rules**: all gameplay verification is **headless** (playwright + `--use-angle=metal --enable-gpu`); UI flows must **click Play for real** (`.fcs-engage-btn`) — never bypass the engage path; use `page.mouse`/`keyboard` for input (the controller supports a pointer-lock fallback). Watch for 0 console/page errors; a lone favicon 404 is benign.
- Screenshot harness lives outside the repo in `/tmp/shots` (playwright 1.63 + cached chromium-1243, flags `--use-angle=metal --enable-unsafe-swiftshader`; wiped on reboot): `ui.mjs <outdir>` (briefing/HUD/optic/respawn/feed), `wreck.mjs <outdir>` (burnt wrecks + `probeWreckClearance`), `bench.mjs` (idle/fight/toggle frame stats + hitch log), `file.mjs`-style standalone check over `file://`. If 5173 is taken by another project, run `npx vite --port 5174 --strictPort`.
- `probeWreckClearance()` reports per part `minGap`, `belowFrac`, `asleep`, `tiltDeg` (0 = resting on a face). `physicsSelfTest()` must return `ok:true` for both `drop` and `edge` cases.
- HUD primitives live in `src/game/hud.css`; `src/game/interface.css` owns deployment and presentation overrides. Keep the live vehicle backdrop legible and preserve visible keyboard focus.
- Drone Carrier and rocket artillery share the animated wheels in `SixWheelBase.ts`, not bodywork. In `src/game/models/SupportVehicle.ts`, keep both docked drone roots separately hideable: `DroneManager` uses their world positions at launch. Humvee/IFV are tevy.dev CC0 LOD1 GLBs.
