# untitled tank game

Offline 3D browser tank game built with Three.js, Vite, and TypeScript. All 3D models, KTX2/Basis & Meshopt WASM decoders, PBR terrain textures, and HDRI sky are bundled locally in `dist/` for 100% offline play.

Play online at [starharbor2491.github.io/utg](https://starharbor2491.github.io/utg/).

## How to Play (Zero-Dependency Single HTML File!)

Double-click **`untitled-tank-game.html`** in Finder / File Explorer to open it directly in any modern browser (`file://`) — **no server, no internet connection, no installation, and no other files required**. You can send that single `.html` file by itself to anyone.

*(To rebuild the standalone single-file HTML after code edits, run `npm run build:single`.)*

### Optional Local Dev Server
If editing source code in `src/`:
```bash
npm install
npm run dev
```

## Controls

| Input | Action |
|---|---|
| `W / S` or `Up / Down` | Forward throttle / Reverse |
| `A / D` or `Left / Right` | Hull traverse (neutral & moving steer) |
| `Mouse` | Aim turret & gun (cursor locked inside window) |
| `Left Click` (or `F`) | Fire main cannon (or 30mm chain-gun on IFV) |
| `Right Click` (or `Shift` / `V`) | 2.8x Gunner Boresight Zoom (tap to toggle or hold to zoom) |
| `1 / 2` or `Q` | Switch between Shell / Ammo Belt Type 1 & Type 2 |
| `Space` (or `C`) | Fire machine gun (infinite-ammo 30mm chain-gun on IFV) |
| `X` | Track brake |
| `Scroll Wheel` | Adjust camera follow distance or zoom the optic down to a 4° field of view |
| `ESC` / `P` | Pause, view controls and loadouts, and choose a vehicle |

In the **Support** vehicle, press `2` and click to launch your FPV. Aim with the mouse, steer with `A / D`, speed up with `W`, or hold `S` to hover. The FPV detonates on impact. Right click aborts and lets it fall. Enemy fire can’t shoot the drone down, and battery, distance, or loss of the launch vehicle won’t cut your control.

**Little Bird** is player-only. Hold `Shift` to add lift and `Ctrl` to descend. Move the mouse or trackpad to yaw and pitch, use `W / S` to tilt the nose down or up, and `A / D` to bank. Tilting redirects rotor thrust, so speed builds over time and carries through a turn. Level the nose or hold `X` to brake. Left click fires the missile pod; `Space` fires the machine gun. Use right click or `V` for the optic, and `1` / `2` to choose guided or unguided rounds.
