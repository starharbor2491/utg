import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUT_HTML = path.join(ROOT, 'untitled-tank-game.html');

const EMBED_FILES = [
  ['./decoders/basis/basis_transcoder.js', 'decoders/basis/basis_transcoder.js'],
  ['./decoders/basis/basis_transcoder.wasm', 'decoders/basis/basis_transcoder.wasm'],
  ['./assets/models/player_mbt_lod1.glb', 'assets/models/player_mbt_lod1.glb'],
  ['./assets/models/ruined_building.glb', 'assets/models/ruined_building.glb'],
  ['./assets/models/guard_tower.glb', 'assets/models/guard_tower.glb'],
  ['./assets/models/fuel_station.glb', 'assets/models/fuel_station.glb'],
  ['./assets/models/boulder_large.glb', 'assets/models/boulder_large.glb'],
  ['./assets/models/boulder_medium.glb', 'assets/models/boulder_medium.glb'],
  ['./assets/models/tree.glb', 'assets/models/tree.glb'],
  ['./assets/models/barrier_wall.glb', 'assets/models/barrier_wall.glb'],
  ['./assets/models/supply_crates.glb', 'assets/models/supply_crates.glb'],
  ['./assets/textures/terrain/grass_color.jpg', 'assets/textures/terrain/grass_color.jpg'],
  ['./assets/textures/terrain/grass_normal.jpg', 'assets/textures/terrain/grass_normal.jpg'],
  ['./assets/textures/terrain/dirt_color.jpg', 'assets/textures/terrain/dirt_color.jpg'],
  ['./assets/textures/terrain/dirt_normal.jpg', 'assets/textures/terrain/dirt_normal.jpg'],
  ['./assets/hdri/sky.hdr', 'assets/hdri/sky.hdr'],
];

const chunksDir = path.join(DIST_DIR, 'chunks');
const chunkFiles = fs.readdirSync(chunksDir);
const jsFile = chunkFiles.find((f) => f.startsWith('index-') && f.endsWith('.js'));
const cssFile = chunkFiles.find((f) => f.startsWith('index-') && f.endsWith('.css'));

if (!jsFile || !cssFile) {
  throw new Error('Missing built JS or CSS chunk in dist/chunks/. Run `npm run build` first.');
}

const rawCss = fs.readFileSync(path.join(chunksDir, cssFile), 'utf8');
let rawJs = fs.readFileSync(path.join(chunksDir, jsFile), 'utf8');
// Escape any literal `</script` sequence inside JS strings so HTML parser never closes <script> early
rawJs = rawJs.replace(/<\/script/gi, '<\\/script');

const vfs = {};
let rawBytesTotal = 0;
let gzBytesTotal = 0;

for (const [vfsKey, relPublic] of EMBED_FILES) {
  const fullPath = path.join(PUBLIC_DIR, relPublic);
  const buf = fs.readFileSync(fullPath);
  const gz = zlib.gzipSync(buf, { level: 9 });
  rawBytesTotal += buf.length;
  gzBytesTotal += gz.length;
  vfs[vfsKey] = gz.toString('base64');
}

const vfsJson = JSON.stringify(vfs).replace(/<\/script/gi, '<\\/script');

const singleHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no" />
    <title>untitled tank game</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      html, body {
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #0d100d;
        color: #eae6dc;
        font-family: 'Bahnschrift', 'DIN Condensed', 'Avenir Next Condensed', 'Arial Narrow', system-ui, -apple-system, sans-serif;
        user-select: none;
        -webkit-user-select: none;
      }
      #viewport { position: fixed; inset: 0; width: 100vw; height: 100vh; display: block; }
      #hud-root { position: fixed; inset: 0; pointer-events: none; z-index: 10; }
      ${rawCss}
    </style>
  </head>
  <body>
    <canvas id="viewport" tabindex="-1"></canvas>
    <div id="hud-root"></div>
    <script>window.__EMBEDDED_VFS__ = ${vfsJson};</script>
    <script type="module">${rawJs}</script>
  </body>
</html>
`;

fs.writeFileSync(OUT_HTML, singleHtml, 'utf8');
const finalStat = fs.statSync(OUT_HTML);
console.log(
  `Packed standalone single-file HTML: ${OUT_HTML}\n` +
    `  Raw assets: ${(rawBytesTotal / 1024 / 1024).toFixed(2)} MB -> Gzipped: ${(gzBytesTotal / 1024 / 1024).toFixed(2)} MB\n` +
    `  Total self-contained HTML size: ${(finalStat.size / 1024 / 1024).toFixed(2)} MB`
);
