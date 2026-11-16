# untitled tank game

Offline 3D browser tank game built with Three.js, Vite, and TypeScript. All 3D models, KTX2/Basis & Meshopt WASM decoders, PBR terrain textures, and HDRI sky are bundled locally in `dist/` for 100% offline play.

## How to Play (Zero-Dependency Single HTML File!)

Double-click **`untitled-tank-game.html`** (`13.4 MB`) in Finder / File Explorer to open it directly in any modern browser (`file://`) — **no server, no internet connection, no installation, and no other files required**. You can send that single `.html` file by itself to anyone.

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
| `Scroll Wheel` | Adjust camera follow distance / optic magnification |
| `ESC` / `P` | Pause & switch between **Normal MBT**, **Heavy Tank**, and **IFV** |
