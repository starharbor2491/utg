# untitled tank game

3D browser tank game built with PlayCanvas, Vite, and TypeScript. Models, decoders, textures and lighting are bundled locally, so Free Play works entirely offline. Rendering uses WebGL2 and GLSL.

Play online at [starharbor2491.github.io/utg](https://starharbor2491.github.io/utg/).

## How to Play (Zero-Dependency Single HTML File!)

Double-click **`untitled-tank-game.html`** in Finder / File Explorer to open it directly in any modern browser (`file://`) — **no server, no internet connection, no installation, and no other files required**. You can send that single `.html` file by itself to anyone.

Save the [standalone HTML](https://starharbor2491.github.io/utg/untitled-tank-game.html) to play offline. To rebuild it after code edits, run `npm run build:single`.

Choose **Free Play** for a 6v6 match with bots. For **1v1**, choose **Host room** and send the six-character code to a friend. Your friend selects **1v1**, enters the code, and chooses **Join room**. Choose a vehicle, then press **Ready up**. Once both players are ready, a three-second countdown starts. Either player can unready during the countdown or leave the room. The battle opens automatically; click **Click to lock mouse** to capture the cursor. Opening the menu doesn't pause an online duel. Both browsers need internet access for public signaling; restrictive networks can block peer-to-peer connections. Use the same game version on both sides.

### Optional Local Dev Server
If editing source code in `src/`:
```bash
npm install
npm run dev
```

## Controls

Battle requires a keyboard and mouse. You can still drag the 3D vehicle preview with a finger to inspect it. With the preview focused, the arrow keys rotate it and `Home` resets it. Open **Controls & credits** for the selected vehicle's controls. While playing, the controls in the upper right match your current vehicle or drone. Press `H` to collapse or expand them. Choose **HUD size → Large** in the briefing or menu for larger readouts; the HUD automatically uses a compact layout on small viewports.

| Input | Action |
|---|---|
| `W / S` or `Up / Down` | Forward throttle / Reverse |
| `A / D` or `Left / Right` | Hull traverse (neutral & moving steer) |
| `Mouse` | Aim turret & gun (cursor locked inside window) |
| Hold `Alt` + move mouse | Look all the way around in ground vehicles, helicopters, or FPV. Release to return to aiming. |
| `Left Click` (or `F`) | Fire main cannon (or 30mm chain-gun on IFV) |
| `Right Click` (or `Shift` / `V`) | 2.8x Gunner Boresight Zoom (tap to toggle or hold to zoom) |
| `1 / 2` or `Q` | Switch between Shell / Ammo Belt Type 1 & Type 2 |
| `Space` (or `C`) | Fire machine gun (infinite-ammo 30mm chain-gun on IFV) |
| `X` | Track brake |
| `Scroll Wheel` | Adjust camera follow distance or zoom the optic down to a 4° field of view |
| `ESC` / `P` | Pause, view controls and loadouts, and choose a vehicle |

In the **Drone Carrier**, select `1` for the gun drone or `2` for the FPV, then click to launch. Aim with the mouse, steer with `A / D`, speed up with `W`, or hold `S` to hover. Hold left click or `Space` to fire the gun drone. It has a health readout, can be shot down, and does not explode on impact. The FPV still detonates on impact and cannot be shot down. Right click aborts either drone. You can fly one at a time; the nine-second reload starts at launch.

**Little Bird** and **Apache** are player-only. Hold `Shift` to raise throttle or `Ctrl` to lower it. Move the mouse up/down to pitch and left/right to turn. Hold `R` and move the mouse left/right to roll instead of turning. `W / S` or `↑ / ↓` also pitch the helicopter, and `A / D` or `← / →` roll it. Pitch and roll can go all the way around, so build altitude before flipping: the rotor pushes downward while inverted. Throttle and attitude stay where you leave them. Use opposite input to level out. Hold `Alt` to look around without steering. Right click or `V` toggles the optic.

Press `1` to select missiles or `2` to select the gun, then left click to fire. `Space` fires the gun regardless of the selected slot. The Little Bird carries two guided missiles and reloads in 1.75 seconds. The Apache fires all 16 high-yield missiles in one volley, reloads in 4.5 seconds, and carries a heavy Gatling.
