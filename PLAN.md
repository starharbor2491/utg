# Browser Tank Game — Plan

Commissioned build. Budget ~20 CNY. Target: **under 20 hours** of dev time.
Deliverable: a local-folder static build the client opens in a browser.

## Agreed scope

- **Genre**: single-player 3D tank game, **free sandbox** (no win condition, no score)
- **Player**: drive a tank, man a cannon + coaxial machine gun, fight roaming enemy AI
- **Enemies**: ~4–6 active at once, respawn on death to keep the world populated
- **AI**: strafe/orbit the player, vary speed, lead shots, fire when roughly facing player. **No cover-pathing / navmesh** — explicitly cut
- **Camera**: third-person chase cam, smoothed follow, mouse orbits
- **Controls**: WASD — W/S throttle, A/D hull turn; mouse aims turret independently
- **Player death**: explosion → respawn after ~3 s
- **Audio**: **none** (cut to protect budget)
- **Minimap**: yes — 2D canvas, dots for player/enemies/structures
- **Deploy**: local folder (static build; needs a tiny static server — see below)

## Tech stack

- **Three.js** (latest stable) + **Vite** + **TypeScript**
- **Custom arcade physics** — tanks are kinematic (no rigid-body sim needed): hull = pos + heading + speed, turret = separate yaw, terrain height sampled from heightmap, obstacle collision = circle-vs-proxy checks. Cannon-es/rapier deliberately skipped.
- **Assets vendored locally** in `public/assets/` so the build works offline
- **Post-processing**: `EffectComposer` + `UnrealBloomPass` + `SMAAPass` + `OutputPass`, `ACESFilmicToneMapping`. SSAO via `n8ao` only if time permits.

## Art direction: "realistic-ish PBR"

Honest ceiling: stylized-realistic, not photoreal. Achieved via PBR materials, good lighting (HDRI sky), bloom, and decent free models.

### Assets (all verified free)

| Asset | Source | License | Use |
|---|---|---|---|
| Main Battle Tank (63k tris, named `turret`/`gun` nodes, LODs) | tevy.dev/models/main-battle-tank | CC0 | **Player tank** |
| Armoured Column pack (74 GLBs: light tank, APC, guns, tents, walls, props) | 3dassets.dev/packs/armoured-column-and-field-camp | CC0 | **Enemy variants + map dressing** |
| T-34-85 / Panther / Leopard 2A6 (realistic WWII MBTs) | aizity.com mirrors of Sketchfab models | **CC-BY 4.0 — attribution required** | Optional heavy enemy variants; add `CREDITS.md` if used |
| Ruined Apartment Shell, Guard Tower, Fuel Station, boulders, trees | tevy.dev/models | CC0 | Map cover/scatter |
| Grass/dirt/rock PBR textures | ambientCG.com | CC0 | Terrain |
| HDRI sky | polyhaven.com/hdris or tevy.dev/skies | CC0 | Lighting |

⚠️ tevy.dev GLBs use `EXT_meshopt_compression` + `KHR_texture_basisu` (KTX2) — loader needs `MeshoptDecoder` + `KTX2Loader` with Basis transcoder vendored. 3dassets.dev GLBs claim no extra decoders — verify on first load.

Fallback if tevy tank disappoints: recolored 3dassets.dev light tanks for everything (cohesive stylized look beats muddy realism).

## World

- **Map**: ~500×500 m grassland battlefield, gentle height variation, dirt/grass blended terrain
- **Boundary**: treeline/fog + invisible wall
- **Cover**: scattered rocks, ruined walls/buildings, fuel drums from the packs — enough for gameplay, not navigable cover AI
- **Lighting**: HDRI sky + directional sun w/ shadows (tight shadow camera following player for perf)

## Architecture

```
src/
  main.ts               bootstrap, render loop, fixed-ish dt
  game/
    Tank.ts             hull physics, turret yaw, cannon+MG state, damage/death
    PlayerController.ts input → tank intents
    EnemyAI.ts          state machine: roam → engage → strafe/orbit → fire
    Ballistics.ts       shell sim (travel time, gravity drop, splash), MG hitscan/tracer
    World.ts            terrain, props, bounds, spawn points
    Effects.ts          muzzle flash, explosions (sprite/particle), dust, tracers
    HUD.ts              DOM overlay: crosshair, HP, ammo, speed + minimap canvas
  assets vendored in public/assets/
```

## Milestones (budget ≈ 18 h)

1. **Scaffold + tank load** (2–3 h): Vite+TS+Three.js, GLB loader w/ decoders, tevy tank renders, turret node rotates with mouse. *Risk: decoder setup.*
2. **World** (3–4 h): heightmap terrain + textures, sky, sun/shadows, post-processing chain, boundary.
3. **Player** (3–4 h): arcade drive physics, chase cam, cannon shells + MG, recoil/flash, hit detection vs enemies/props.
4. **Enemies** (4–5 h): enemy tank entities, AI state machine (strafe/lead/predict), damage/death/respawn, player HP/respawn.
5. **Dress + HUD** (2–3 h): scatter props, minimap, HUD polish, spawn logic.
6. **Ship** (1–2 h): `vite build`, smoke test, package folder + `PLAY.md` instructions.

## Cut lines (if running behind, in order)

1. MG → cannon only (save ~1 h)
2. Drop n8ao/SSAO → bloom only (save ~1 h)
3. Enemy count 6 → 3 (save tuning time)
4. Terrain texture detail / prop count reduction
5. Last resort: all-enemy recolor single tank model

## Open items to verify during build

- [ ] tevy.dev GLB loads with MeshoptDecoder + KTX2Loader in three.js
- [ ] 3dassets.dev GLBs need no extra decoders
- [ ] CC-BY tank attribution if heavy variants are used → `CREDITS.md`
- [ ] Local run requires static server (`npx serve dist` or `npm run preview`) — file:// won't work with modules; ship a double-clickable `PLAY.command` for macOS
