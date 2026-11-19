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

  for (const team of ['blue', 'red']) {
    await page.goto(`${process.env.TANK_GAME_URL ?? 'http://127.0.0.1:5173/'}showroom.html?v=support&team=${team}&view=top`);
    await page.waitForFunction(() => window.__showroom);
    assert.equal(await page.locator('#audit-overlay').textContent(), `support/${team}: 0 error, 0 warn`);
    const slots = await page.evaluate(async (team) => {
      const { DroneManager } = await import('/src/game/Drone.ts');
      const { Tank } = await import('/src/game/Tank.ts');
      const { Vec3 } = await import('/src/game/engine/math.ts');
      const { worldBounds } = await import('/src/game/engine/scene.ts');
      const { assets, scene } = window.__showroom;
      const carrier = new Tank('carrier-test', team, 'support', assets, new Vec3(20, 1, 18), 0.74, true, 'Test');
      scene.addChild(carrier.root);
      const manager = new DroneManager();
      manager.world = { getHeightAt: () => 1 };
      return ['gun', 'fpv'].map((kind) => {
        const selected = carrier.root.findByName(`${kind}_drone`);
        const other = carrier.root.findByName(kind === 'gun' ? 'fpv_drone' : 'gun_drone');
        const source = selected.getPosition().clone();
        const before = worldBounds(selected, undefined, true);
        const gap = before.min.y - selected.parent.getPosition().y;
        const flight = manager.launch(carrier, { kind });
        const occupied = other.enabled && !selected.enabled && selected.parent.enabled;
        const spawnGap = source.distance(flight.pos);
        manager.reset();
        return { kind, gap, occupied, spawnGap, restored: selected.enabled && other.enabled };
      });
    }, team);
    for (const slot of slots) {
      assert.ok(slot.occupied && slot.restored, `${team} ${slot.kind}: only the launched drone disappears; both recover`);
      assert.ok(slot.spawnGap < 0.001 && Math.abs(slot.gap) < 0.005, `${team} ${slot.kind}: grounded dock and world-space launch`);
    }
  }
  console.log('Both carrier variants and all four dock launch/restore paths passed.');
} finally { await browser.close(); }
