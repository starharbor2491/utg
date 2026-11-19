import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  await page.goto(`${process.env.TANK_GAME_URL ?? 'http://127.0.0.1:5173/'}showroom.html?v=rocket&view=side`);
  await page.waitForFunction(() => window.__showroom);
  const measured = await page.evaluate(async () => {
    const { Path, Shape, extrude } = await import('/src/game/engine/geometry.ts');
    const ring = new Path().absarc(0, 0, 0.3, 0, 2 * Math.PI, true);
    const plate = new Shape().moveTo(-1, -1).lineTo(1, -1).lineTo(1, 1).lineTo(-1, 1).closePath();
    plate.holes.push(ring);
    const geo = extrude(plate, { depth: 1, bevelEnabled: false });
    let capArea = 0, topFaceY = 0;
    const pos = geo.positions;
    for (let i = 0; i < geo.indices.length; i += 3) {
      const [a, b, c] = geo.indices.slice(i, i + 3).map((n) => n * 3);
      if ([a, b, c].every((j) => pos[j + 2] === 1)) capArea += Math.abs(
        (pos[b] - pos[a]) * (pos[c + 1] - pos[a + 1]) - (pos[c] - pos[a]) * (pos[b + 1] - pos[a + 1])) / 2;
      if ([a, b, c].every((j) => pos[j + 1] === 1)) topFaceY +=
        (pos[b + 2] - pos[a + 2]) * (pos[c] - pos[a]) - (pos[b] - pos[a]) * (pos[c + 2] - pos[a + 2]);
    }
    const { rig } = window.__showroom.rigs[0];
    const face = rig.muzzleNode.getPosition();
    return { capArea, topFaceY, ports: rig.rocketMeshes.length, muzzleZ: face.z };
  });
  assert.ok(Math.abs(measured.capArea - (4 - Math.PI * 0.3 ** 2)) < 0.003, `port must be open: ${JSON.stringify(measured)}`);
  assert.ok(measured.topFaceY > 0, 'cab roof must face outward');
  assert.equal(measured.ports, 6);
  assert.ok(measured.muzzleZ < 1.7, 'resting pod clears the rear of the cab');
  console.log('Open ports, outward-facing roof, six rounds and bed clearance passed.');
} finally { await browser.close(); }
