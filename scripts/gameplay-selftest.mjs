// Run against npm run dev. Set PLAYWRIGHT_MODULE if Playwright is installed outside this repo.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1152, height: 720 } });
  const errors = [];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Runtime.enable');
  const consoleStacks = [];
  cdp.on('Runtime.consoleAPICalled', (event) => {
    if (event.type === 'error') consoleStacks.push(event.stackTrace);
  });
  const cam = () => page.evaluate(() => window.__tankQA.getCamDebug());
  const player = () => page.evaluate(() => window.__tankQA.getMatchState().tanks[0]);
  const angleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().includes('favicon')) errors.push(msg.text());
  });
  await page.goto(process.env.TANK_GAME_URL ?? 'http://127.0.0.1:5173/');
  await page.waitForFunction(() => window.__tankQA);
  const audits = await page.evaluate(() => window.__tankQA.runThreeAudit());
  for (const [cls, issues] of Object.entries(audits)) assert.deepEqual(issues, [], `${cls} rig audit`);
  const wreck = await page.evaluate(() => window.__tankQA.physicsSelfTest());
  assert.ok(wreck.drop.ok && wreck.edge.ok, 'wreck settles on flat ground and over an edge');
  await page.getByRole('button', { name: 'Little Bird Air' }).click();
  await page.getByRole('heading', { name: 'Little Bird' }).waitFor();
  assert.equal(await page.evaluate(() => window.__tankQA.getMatchState().tanks.filter((t) => t.cls === 'littlebird').length), 1);
  await page.locator('.fcs-engage-btn').click();

  // Sweep the pointer across 900 px in measured steps, wrapping through 360°.
  // Heading and aim are sampled after rendered frames, not just input events.
  async function orbit(drone = false) {
    await page.keyboard.down('Alt');
    await page.mouse.move(120, 350);
    await page.keyboard.up('Alt');
    await page.evaluate(() => window.__tankQA.fastForward(0.25));
    const before = await cam();
    const { yaw: heading, flight } = await player();
    await page.keyboard.down('Alt');
    await page.waitForFunction(() => window.__tankQA.getCamDebug().freeLooking);
    const frozenAim = (await cam()).aim;
    let last = drone ? Math.atan2(before.camDir[0], before.camDir[2]) : before.yaw;
    let sweep = 0;
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(120 + i * 112, 350);
      await page.evaluate(() => window.__tankQA.fastForward(0.035));
      const next = await cam();
      const angle = drone ? Math.atan2(next.camDir[0], next.camDir[2]) : next.yaw;
      sweep += angleDelta(angle, last);
      last = angle;
      assert.deepEqual(next.aim, frozenAim);
    }
    assert.ok(Math.abs(Math.abs(sweep) - 2 * Math.PI) < 0.3, `camera sweeps 360° (${sweep.toFixed(2)} rad)`);
    // A click while looking around must not turn into a shot, launch or FPV abort.
    await page.mouse.down();
    await page.mouse.up();
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    await page.evaluate(() => window.__tankQA.fastForward(0.12));
    if (!drone) {
      const next = await player();
      assert.ok(Math.abs(angleDelta(next.yaw, heading)) < 0.2, 'orbit does not steer the vehicle');
      if (flight) assert.equal(next.flight.pitch, flight.pitch, 'orbit does not pitch the airframe');
    }
    await page.mouse.move(560, 350);
    await page.keyboard.up('Alt');
    await page.evaluate(() => window.__tankQA.fastForward(0.1));
    const after = await cam();
    assert.equal(after.freeLooking, false);
    if (drone) assert.ok(Math.abs(angleDelta(Math.atan2(after.camDir[0], after.camDir[2]), Math.atan2(before.camDir[0], before.camDir[2]))) < 0.08, 'orbit does not steer the FPV');
    else assert.deepEqual([after.yaw, after.pitch], [before.yaw, before.pitch], 'view restores on release');
  }

  await orbit();
  async function mouseFlight() {
    if ((await cam()).fov < 55) {
      await page.keyboard.press('v');
      await page.waitForFunction(() => window.__tankQA.getCamDebug().fov > 55);
    }
    await page.mouse.move(560, 350);
    // After a vehicle swap, let the new airframe finish turning to the existing camera heading.
    await page.evaluate(() => window.__tankQA.fastForward(2));
    const before = await player();
    await page.mouse.move(660, 440, { steps: 4 });
    await page.evaluate(() => window.__tankQA.fastForward(0.5));
    const down = await player();
    assert.ok(down.flight.pitch > before.flight.pitch + 0.28, `${down.cls}: 90 px pitches down at the faster rate`);
    assert.ok(angleDelta(down.yaw, before.yaw) < -0.27, `${down.cls}: yaw follows a 100 px mouse turn within half a second`);
    await page.mouse.move(560, 350, { steps: 4 });
    await page.evaluate(() => window.__tankQA.fastForward(0.5));
    const up = await player();
    assert.ok(up.flight.pitch < down.flight.pitch - 0.06, 'mouse up raises the nose');
    assert.ok(Math.abs(angleDelta(up.yaw, before.yaw)) < 0.08, 'mouse left turns it back');
    assert.equal(up.flight.throttle, before.flight.throttle, 'mouse never adjusts collective');
    await page.keyboard.down('ArrowUp');
    await page.keyboard.down('ArrowRight');
    await page.evaluate(() => window.__tankQA.fastForward(0.25));
    await page.keyboard.up('ArrowRight');
    await page.keyboard.up('ArrowUp');
    const arrows = await player();
    assert.ok(arrows.flight.pitch > up.flight.pitch + 0.09 && arrows.flight.roll > up.flight.roll + 0.09,
      `${up.cls}: keyboard arrows still pitch and bank`);
    assert.equal(arrows.flight.throttle, up.flight.throttle);
    await page.keyboard.down('ArrowDown');
    await page.keyboard.down('ArrowLeft');
    await page.evaluate(() => window.__tankQA.fastForward(0.25));
    await page.keyboard.up('ArrowLeft');
    await page.keyboard.up('ArrowDown');
    const back = await player();
    assert.ok(back.flight.pitch < arrows.flight.pitch - 0.09 && back.flight.roll < arrows.flight.roll - 0.09,
      `${up.cls}: opposite arrows reverse pitch and bank`);

    const aimBeforeRoll = await cam();
    await page.keyboard.down('r');
    await page.mouse.move(660, 350, { steps: 4 });
    await page.evaluate(() => window.__tankQA.fastForward(0.15));
    const rightRoll = await player();
    assert.ok(rightRoll.flight.roll > back.flight.roll + 0.30, `${up.cls}: R + 100 px banks at the faster rate`);
    assert.ok(Math.abs(angleDelta(rightRoll.yaw, back.yaw)) < 0.03, `${up.cls}: cursor roll does not change heading`);
    assert.equal((await cam()).yaw, aimBeforeRoll.yaw, `${up.cls}: cursor roll does not orbit the camera`);
    assert.equal(rightRoll.flight.throttle, back.flight.throttle);

    await page.keyboard.down('Alt');
    await page.mouse.move(710, 350);
    await page.evaluate(() => window.__tankQA.fastForward(0.1));
    assert.equal((await player()).flight.roll, rightRoll.flight.roll, `${up.cls}: Alt overrides cursor roll`);
    await page.mouse.move(660, 350);
    await page.keyboard.up('Alt');

    await page.mouse.move(500, 350, { steps: 4 });
    await page.evaluate(() => window.__tankQA.fastForward(0.1));
    assert.ok((await player()).flight.roll < back.flight.roll - 0.06, `${up.cls}: R + mouse left banks left`);
    await page.mouse.move(560, 350);
    await page.evaluate(() => window.__tankQA.fastForward(0.1));
    await page.keyboard.up('r');

    async function mousePitchStroke(from, to) {
      await page.keyboard.down('Alt');
      await page.mouse.move(560, from);
      await page.keyboard.up('Alt');
      await page.mouse.move(560, to, { steps: 4 });
      await page.evaluate(() => window.__tankQA.fastForward(0.05));
    }
    const mouseNeutral = (await player()).flight.pitch;
    const cameraNeutral = (await cam()).pitch;
    for (let i = 0; i < 4; i++) await mousePitchStroke(160, 390);
    const airTurn = angleDelta((await player()).flight.pitch, mouseNeutral);
    const cameraTurn = angleDelta((await cam()).pitch, cameraNeutral);
    assert.ok(Math.cos(airTurn) < -0.95 && Math.cos(cameraTurn) < -0.95 && Math.abs(angleDelta(airTurn, -cameraTurn)) < 0.08,
      `${up.cls}: sustained mouse pitch rotates both airframe and chase view half a turn (${airTurn}, ${cameraTurn})`);
    for (let i = 0; i < 4; i++) await mousePitchStroke(390, 160);
    assert.ok(Math.abs(angleDelta((await player()).flight.pitch, mouseNeutral)) < 0.06,
      `${up.cls}: opposite mouse pitch brings the airframe back`);
  }
  async function flipFlight() {
    const advance = (seconds) => page.evaluate((t) => window.__tankQA.fastForward(t), seconds);
    await page.evaluate(() => window.__tankQA.teleportForTest(0, -420, 0));
    await page.keyboard.down('Shift');
    await advance(7);
    await page.keyboard.up('Shift');
    const start = await player();
    await page.keyboard.down('w');
    let total = 0, last = start.flight.pitch;
    for (let i = 0; i < 8; i++) {
      await advance(start.cls === 'apache' ? 0.69 : 0.51);
      const next = await player();
      total += angleDelta(next.flight.pitch, last);
      last = next.flight.pitch;
      if (i === 3) {
        assert.ok(Math.cos(last) < -0.8, `${next.cls} pitches upside down`);
        // A faster half-loop can still carry upward momentum. Hold inverted to test the thrust direction.
        await page.keyboard.up('w');
        await advance(1);
        const inverted = await player();
        assert.ok(inverted.flight.climb < 0 && inverted.flight.climb < next.flight.climb,
          `${next.cls} descends while inverted`);
        await page.keyboard.down('w');
      }
    }
    await page.keyboard.up('w');
    assert.ok(total > 5.8 && Math.cos(last) > 0.85, `${start.cls} completes a forward flip (${total.toFixed(2)} rad)`);
    assert.equal((await player()).flight.throttle, start.flight.throttle, 'flip does not change collective');
    await page.evaluate(() => window.__tankQA.teleportForTest(0, -420, 0));
  }
  await mouseFlight();
  await flipFlight();
  assert.equal(await page.evaluate(() => window.__tankQA.getRenderStats().rocketsLeft), 2, 'free-look clicks do not fire missiles');
  // Reset aim after moving to the edge of the viewport in the pointer test.
  await page.evaluate(() => window.__tankQA.teleportForTest(0, -420, 0));
  const birdBefore = await player();
  await page.keyboard.down('Shift');
  await page.evaluate(() => window.__tankQA.fastForward(0.65));
  await page.keyboard.down('w');
  await page.evaluate(() => window.__tankQA.fastForward(0.38));
  await page.keyboard.up('w');
  await page.evaluate(() => window.__tankQA.fastForward(1.4));
  await page.keyboard.up('Shift');
  const birdAfter = await page.evaluate(() => window.__tankQA.getMatchState().tanks[0]);
  assert.ok(birdAfter.y > birdBefore.y + 8 && birdAfter.z > birdBefore.z + 12, 'Little Bird climbs and flies forward');
  assert.equal(birdAfter.flight.throttle, 1);
  await page.mouse.click(560, 350);
  await page.keyboard.down('Space');
  await page.evaluate(() => window.__tankQA.fastForward(0.8));
  await page.keyboard.up('Space');
  assert.equal(await page.evaluate(() => window.__tankQA.getRenderStats().rocketsLeft), 0, 'Little Bird fires its missile pair');
  await page.mouse.click(560, 350, { button: 'right' });
  for (let i = 0; i < 11; i++) await page.mouse.wheel(0, -100);
  await page.waitForFunction(() => window.__tankQA.getCamDebug().fov < 4.2);
  await page.keyboard.down('Alt');
  await page.waitForFunction(() => window.__tankQA.getCamDebug().fov > 55);
  await page.keyboard.up('Alt');
  await page.waitForFunction(() => window.__tankQA.getCamDebug().fov < 4.2);
  await page.keyboard.press('p');
  await page.getByRole('heading', { name: 'Battle paused' }).waitFor();
  const paused = await page.evaluate(() => window.__tankQA.getMatchState());
  await page.waitForTimeout(250);
  assert.deepEqual(await page.evaluate(() => window.__tankQA.getMatchState()), paused, 'briefing pauses simulation');
  await page.evaluate(() => window.__tankQA.teleportForTest(0, -420, 0));
  await page.getByRole('button', { name: 'Apache Air' }).click();
  await page.locator('.fcs-engage-btn').click();
  const render = () => page.evaluate(() => window.__tankQA.getRenderStats());
  assert.equal((await render()).rocketsLeft, 16);
  await mouseFlight();
  await flipFlight();
  await page.keyboard.press('2');
  await page.waitForFunction(() => window.__tankQA.getRenderStats().activeShell === 'GATLING');
  await page.mouse.down();
  await page.evaluate(() => window.__tankQA.fastForward(0.2));
  await page.mouse.up();
  assert.ok((await player()).flight.mgHeat > 0, 'Apache fires its Gatling with the gun slot selected');
  assert.equal((await render()).rocketsLeft, 16, 'the Gatling does not spend missiles');
  await page.keyboard.press('1');
  await page.waitForFunction(() => window.__tankQA.getRenderStats().activeShell === '16× HE');
  await page.mouse.click(560, 350);
  await page.waitForFunction(() => window.__tankQA.getRenderStats().rocketsLeft === 0, undefined, { timeout: 3000 });
  assert.equal((await render()).salvoActive, false);
  await page.keyboard.press('p');
  await page.getByRole('heading', { name: 'Battle paused' }).waitFor();
  await page.evaluate(() => window.__tankQA.teleportForTest(0, -420, 0));
  await page.getByRole('button', { name: 'Drone Carrier Wheeled' }).click();
  assert.equal((await page.locator('.fcs-engage-main').textContent()).trim(), 'Resume battle');
  await page.locator('.fcs-engage-btn').click();
  await orbit();
  await page.evaluate(() => {
    const qa = window.__tankQA;
    const river = qa.probeWorld().waterSamples.find(point => point.depth > 0.8);
    if (!river) throw new Error('No wet camera test point');
    qa.teleportForTest(river.x, river.z, 0);
    qa.fastForward(0.1);
  });
  await page.keyboard.down('Alt');
  await page.mouse.move(560, 680);
  await page.mouse.move(560, 20);
  await page.evaluate(() => window.__tankQA.fastForward(0.1));
  const { camPos: [cx, cy, cz], pitch } = await cam();
  const riverSurface = await page.evaluate(([x, z]) => window.__tankQA.waterAtForTest(x, z), [cx, cz]);
  assert.ok(pitch > 1.4 && riverSurface.depth > 0.6 && cy > riverSurface.level + 0.9,
    `low orbit stays above river surface (pitch=${pitch}, camera=${cy}, depth=${riverSurface.depth}, surface=${riverSurface.level})`);
  await page.mouse.move(560, 350);
  await page.keyboard.up('Alt');
  await page.evaluate(() => {
    window.__tankQA.teleportForTest(0, -420, 0);
    window.__tankQA.fastForward(0.1);
  });
  const qaShell = () => page.evaluate(() => window.__tankQA.getRenderStats().activeShell);
  // Hold the controller update, not the keyboard: both Q edges arrive before the next simulation step.
  await page.evaluate(() => window.__tankQA.setCameraForTest(0, 10, -430, 0, 2, -420));
  await page.keyboard.press('q');
  await page.evaluate(() => window.__tankQA.clearCameraForTest());
  await page.waitForFunction(() => window.__tankQA.getRenderStats().activeShell === 'FPV');
  await page.keyboard.press('1');
  await page.waitForFunction(() => window.__tankQA.getRenderStats().activeShell !== 'FPV');
  const primarySlot = await qaShell();
  await page.keyboard.press('2');
  await page.waitForFunction(() => window.__tankQA.getRenderStats().activeShell === 'FPV');
  await page.evaluate(() => window.__tankQA.setCameraForTest(0, 10, -430, 0, 2, -420));
  await page.keyboard.press('q');
  await page.evaluate(() => window.__tankQA.clearCameraForTest());
  await page.waitForFunction((slot) => window.__tankQA.getRenderStats().activeShell === slot, primarySlot);
  await page.keyboard.press('2');
  await page.waitForFunction(() => window.__tankQA.getRenderStats().activeShell === 'FPV');
  await page.keyboard.down('Alt');
  await page.waitForFunction(() => window.__tankQA.getCamDebug().freeLooking);
  await page.mouse.click(560, 350);
  await page.keyboard.up('Alt');
  await page.evaluate(() => window.__tankQA.fastForward(0.1));
  assert.equal((await cam()).fpvActive, false, 'free-look clicks do not launch the player FPV');
  await page.mouse.click(560, 350);
  await page.locator('.fcs-fpv.is-active').waitFor();
  await page.locator('.fcs-marker-layer.is-fpv').waitFor({ state: 'attached' });
  await page.evaluate(() => window.__tankQA.fastForward(2.5));
  assert.ok(parseInt(await page.locator('.fcs-fpv-cooldown').innerText(), 10) < 9, 'FPV cooldown ticks while flying');
  await page.waitForFunction(() => window.__tankQA.getCamDebug().fov === 95);
  await orbit(true);
  console.log('360° free-look, optic restoration, input isolation, pause, and quick-Q switching passed');
  const yawBefore = await page.evaluate(() => window.__tankQA.getCamDebug().camDir[0]);
  await page.keyboard.down('a');
  await page.waitForFunction((x) => Math.abs(window.__tankQA.getCamDebug().camDir[0] - x) > 0.15, yawBefore);
  await page.keyboard.up('a');
  await page.evaluate(() => {
    const qa = window.__tankQA;
    qa.killForTest(qa.getMatchState().tanks[0].id, false);
    qa.fastForward(1);
  });
  assert.equal(await page.locator('.fcs-fpv.is-active').count(), 1, 'vehicle KO does not end FPV');
  await page.mouse.click(560, 350);
  await page.evaluate(() => window.__tankQA.fastForward(0.15));
  assert.equal(await page.locator('.fcs-fpv.is-active').count(), 1, 'left click does not detonate an airborne FPV');
  await page.mouse.click(560, 350, { button: 'right' });
  await page.evaluate(() => window.__tankQA.fastForward(3));
  await page.locator('.fcs-fpv.is-active').waitFor({ state: 'hidden' });
  assert.ok(await page.evaluate(() => window.__tankQA.getCamDebug().fpvExitT > 0.6), 'post-impact camera stays active');
  await page.waitForFunction(() => !window.__tankQA.getCamDebug().droneMode);
  console.log('FPV controls, operator KO, detonation, and camera return passed');

  const results = await page.evaluate(async () => {
    const { DroneEntity, DroneManager, FPV_WARHEAD_SPEC } = await import('/src/game/Drone.ts');
    const { Tank, TANK_STATS } = await import('/src/game/Tank.ts');
    const { World } = await import('/src/game/World.ts');
    const { EffectsManager } = await import('/src/game/Effects.ts');
    const { BallisticsManager } = await import('/src/game/Ballistics.ts');
    const { getApp } = await import('/src/game/engine/app.ts');
    const { geoFromMesh } = await import('/src/game/engine/geometry.ts');
    const { applyQuat, Mat4, Quat, Vec3 } = await import('/src/game/engine/math.ts');
    const { findByName, group, userData } = await import('/src/game/engine/scene.ts');
    const check = (condition, name) => { if (!condition) throw new Error(name); };
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    const v = (x = 0, y = 0, z = 0) => new Vec3(x, y, z);
    const flat = {
      worldHalfSize: 520, getHeightAt: () => 0, getWaterDepthAt: () => 0,
      getNormalAt: (_x, _z, out = v()) => out.set(0, 1, 0), getRoadFactorAt: () => 0,
      getObstacles: () => [], raycastWorld: () => null, damageObstacle: () => false, blastObstacles: () => {},
    };
    const assets = window.__tankQA.getAssetsForTest();
    const scene = group('gameplay_selftest_scene');
    scene.enabled = false;
    const mkTank = (cls, human, pos = v()) => {
      const tank = new Tank(human ? 'player' : 'bot', human ? 'blue' : 'red', cls, assets, pos, 0, human, '');
      scene.addChild(tank.root);
      return tank;
    };
    const intent = { throttle: 1, steer: 0, brake: false, aimPoint: v(0, 1, 100), fireCannon: false, fireMG: false };
    const dt = 1 / 60;
    const assertNoEmpty = (stage) => {
      const invalid = [];
      for (const layer of getApp().scene.layers.layerList) for (const mi of layer.meshInstances) {
        if (!mi.mesh?.vertexBuffer) invalid.push({ layer: layer.name, node: mi.node.name, parent: mi.node.parent?.name, mesh: mi.mesh?.id, color: mi.material?.diffuse?.toString?.(), positions: mi.mesh?.getPositions?.([]) });
      }
      if (invalid.length) throw new Error(`${stage}: ${JSON.stringify(invalid.slice(0, 8))}`);
    };
    for (const [cls, stats] of Object.entries(TANK_STATS)) {
      if (stats.drive === 'air') continue;
      for (const human of [true, false]) {
        const tank = mkTank(cls, human);
        assertNoEmpty(`${cls} ${human ? 'player' : 'npc'}`);
        const track = findByName(tank.root, 'moving_track_L');
        const trackBatch = track ? track.instancedMesh : null;
        const trackBefore = new Mat4(), trackAfter = new Mat4();
        if (trackBatch) trackBatch.getMatrixAt(0, trackBefore);
        for (let i = 0; i < 480; i++) tank.stepKinematics(dt, intent, flat, []);
        if (stats.drive === 'tracked') {
          check(track, `${cls} track rig exists`);
          const rawBody = findByName(cls === 'ifv' ? assets.models.ifv : assets.models.player_mbt_lod1, 'body');
          const raw = geoFromMesh(rawBody.render.meshInstances[0].mesh);
          const hull = findByName(tank.rig.visualRoot, 'body');
          const trimmed = geoFromMesh(hull.render.meshInstances[0].mesh);
          check(hull.bakedTracksRemoved && trimmed.vertexCount < raw.indices.length * 0.9,
            `${cls} replaces rather than overlays baked tread triangles`);
          trackBatch.getMatrixAt(0, trackAfter);
          check(!trackBefore.data.every((value, i) => value === trackAfter.data[i]), `${cls} track links move`);
        }
        const scale = human ? (cls === 'humvee' ? 1 : 1.25) : 0.6;
        check(near(tank.speed, stats.maxForwardSpeed * scale), `${cls} ${human ? 'player' : 'NPC'} top speed`);
        for (let i = 0; i < 24; i++) tank.stepKinematics(dt, { ...intent, steer: 1 }, flat, []);
        const slip = -tank.velocity.x * Math.cos(tank.hullYaw) + tank.velocity.z * Math.sin(tank.hullYaw);
        check(human ? Math.abs(slip) > 2 : near(slip, 0), `${cls} sustained drift`);
        const fire = { ...intent, throttle: 0, fireCannon: true, fireMG: true };
        const timers = human ? 0.5 : 1;
        tank.stepKinematics(dt, fire, flat, []);
        if (stats.hasCoaxMG) check(near(tank.mgCooldown, stats.mgFireInterval * timers), `${cls} MG timer`);
        if (stats.salvoSize) {
          for (let i = 0; i < 240 && tank.cannonCooldown === 0; i++) tank.stepKinematics(dt, { ...fire, fireCannon: false }, flat, []);
        }
        if (stats.hasMainCannon) check(near(tank.cannonCooldown, stats.cannonReloadTime * timers), `${cls} reload timer`);
      }
    }

    assertNoEmpty('after ground vehicles');
    const shooter = mkTank('normal', true);
    const bird = mkTank('littlebird', true);
    check(findByName(bird.root, 'Rotor_Main'), 'Little Bird uses the imported rigged airframe');
    const flight = { ...intent, flightYaw: 0, collectiveAdjust: 1, steer: 0 };
    const neutral = { ...flight, throttle: 0, collectiveAdjust: 0 };
    let missiles = 0, burst = 0;
    for (let i = 0; i < 162; i++) bird.stepKinematics(dt, { ...flight, throttle: i < 26 ? 1 : 0, fireCannon: i === 108, fireMG: i < 70 }, flat, [], {
      onFireCannon: (_t, pos, _dir, shell) => { if (pos.y > 3 && shell.id === 'littlebird_missile') missiles++; },
      onFireMG: (_t, _pos, _dir, shell) => { if (shell.id === 'littlebird_mg') burst++; },
    });
    check(bird.position.y > 8 && bird.position.z > 12 && bird.rotorAngle > 0, 'aircraft climbs, moves, and spins its rotor');
    check(missiles === 2 && burst > 8, `aircraft fires missiles and its machine gun (${missiles} missiles, ${burst} MG rounds)`);
    check(bird.hullTilt.x > 0.4 && bird.velocity.z > 9, 'forward cyclic pitches the aircraft and accelerates it');
    const inertia = bird.velocity.z;
    const pitch = bird.hullTilt.x;
    bird.stepKinematics(dt, { ...neutral, flightYaw: Math.PI / 2 }, flat, []);
    check(bird.velocity.z > inertia * 0.95, 'releasing cyclic and turning does not snap the aircraft velocity');
    check(bird.hullTilt.x === pitch && bird.flightThrottle === 1, 'pitch and throttle hold without input');
    let birdGunSelected = false;
    bird.stepKinematics(dt, { ...neutral, selectShell: 1, fireCannon: true }, flat, [], {
      onFireMG: (_t, _pos, _dir, shell) => { birdGunSelected = shell.id === 'littlebird_mg'; },
    });
    for (let i = 0; i < 8; i++) bird.stepKinematics(dt, { ...neutral, fireCannon: true }, flat, [], {
      onFireMG: (_t, _pos, _dir, shell) => { birdGunSelected = shell.id === 'littlebird_mg'; },
    });
    check(birdGunSelected, 'Little Bird can fire its machine gun from slot 2');
    for (const cls of ['littlebird', 'apache']) {
      const craft = mkTank(cls, true);
      for (let i = 0; i < 60; i++) craft.stepKinematics(dt, { ...neutral, throttle: 1, steer: -1 }, flat, []);
      const pitchRate = cls === 'apache' ? 1.14 : 1.52, rollRate = cls === 'apache' ? 1.08 : 1.44;
      check(near(craft.hullTilt.x, pitchRate) && near(craft.hullTilt.z, rollRate), `${cls}: one-second keyboard pitch and bank`);
      craft.respawnAt(v(), 0);
      craft.stepKinematics(dt, { ...neutral, flightYaw: -Math.PI / 2 }, flat, []);
      check(near(craft.hullYaw / dt, cls === 'apache' ? -3.6 : -5.6), `${cls}: quicker yaw slew cap`);
      check(craft.position.y === 0 && craft.flightThrottle === 0, `${cls}: cyclic alone changes no throttle`);
      craft.respawnAt(v(), 0);
      for (let i = 0; i < 600; i++) craft.stepKinematics(dt, { ...neutral, collectiveAdjust: 1 }, flat, []);
      check(craft.position.y > 200 && craft.velocity.y > 0, `${cls}: climbs through the old 150 m ceiling`);
      for (let i = 0; i < 60; i++) craft.stepKinematics(dt, { ...neutral, steer: -1 }, flat, []);
      check(craft.hullTilt.z > 0.4 && craft.velocity.x < -4, `${cls}: bank redirects thrust`);
      const bank = craft.hullTilt.z;
      craft.stepKinematics(dt, { ...neutral, brake: true }, flat, []);
      check(craft.hullTilt.z === bank && craft.flightThrottle === 1, `${cls}: brake input does not level an aircraft`);
      for (let i = 0; i < 420; i++) craft.stepKinematics(dt, { ...neutral, collectiveAdjust: -1 }, flat, []);
      check(craft.flightThrottle === 0 && craft.velocity.y < -3, `${cls}: reducing throttle descends`);
      craft.respawnAt(v(0, 600), 0);
      for (const pitchSign of [1, -1]) {
        const rate = pitchRate;
        const steps = Math.round(Math.PI / (2 * dt * rate));
        for (let i = 0; i < steps; i++) craft.stepKinematics(dt, { ...neutral, throttle: pitchSign }, flat, []);
        const nose = applyQuat(v(0, 0, 1), craft.rig.hullTiltGroup.getRotation());
        check(Math.abs(nose.y + pitchSign) < 0.001 && Math.hypot(nose.x, nose.z) <= dt * rate,
          `${cls}: manual cyclic points the nose straight ${pitchSign === 1 ? 'down' : 'up'}`);
        craft.respawnAt(v(0, 600), 0);
      }
    }
    const apache = mkTank('apache', true);
    check(findByName(apache.root, 'Apache_Airframe') && findByName(apache.root, 'Apache_MainRotor') &&
      findByName(apache.root, 'Apache_TailRotor'), 'Apache uses the imported FlightGear airframe and separate rotors');
    const launches = [];
    apache.stepKinematics(dt, { ...neutral, fireCannon: true }, flat, [], {
      onFireCannon: (_t, pos, _dir, shell) => launches.push([pos.x, pos.y, shell.splashRadius, shell.splashDamage]),
    });
    check(launches.length === 16 && apache.rocketsLeft === 0 && near(apache.cannonCooldown, 4.5),
      'Apache launches all 16 rounds on the trigger step then reloads');
    check(new Set(launches.map(([x, y]) => `${x},${y}`)).size === 16 &&
      launches.every(([, , radius, damage]) => radius > 13 && damage > 380),
    'Apache fires a high-yield missile from each distinct mount');
    const reloadBird = mkTank('littlebird', true);
    reloadBird.stepKinematics(dt, { ...neutral, fireCannon: true }, flat, []);
    for (let i = 0; i < 45 && reloadBird.rocketsLeft > 0; i++) reloadBird.stepKinematics(dt, neutral, flat, []);
    check(reloadBird.rocketsLeft === 0 && near(reloadBird.cannonCooldown, 1.75), 'Little Bird starts a 1.75 s reload after the second missile');
    for (const [craft, seconds] of [[apache, 4.5], [reloadBird, 1.75]]) {
      const reloadSteps = Math.round(seconds / dt);
      for (let i = 1; i < reloadSteps; i++) craft.stepKinematics(dt, neutral, flat, []);
      check(craft.rocketsLeft === 0, `${craft.stats.vehicleClass}: pod stays empty until reload ends`);
      for (let i = 0; i < 2; i++) craft.stepKinematics(dt, neutral, flat, []);
      check(craft.rocketsLeft === craft.stats.salvoSize, `${craft.stats.vehicleClass}: full pod when reload ends`);
    }
    assertNoEmpty('after aircraft');
    const victim = mkTank('heavy', false, v(0, 0, 10));
    const effects = new EffectsManager(scene);
    const ballistics = new BallisticsManager(scene, effects);
    for (let i = 0; i < 240; i++) victim.stepKinematics(dt, null, flat, []);
    const snapshot = () => [...victim.modules.values()].map((m) => m.integrity);
    const initial = snapshot();
    for (let i = 0; i < 24; i++) {
      ballistics.fireCoaxMG(shooter, v(0, 1, 0), v(0, 0, 1));
      for (let f = 0; f < 4; f++) ballistics.update(dt, flat, [victim], () => {});
    }
    const chipTotal = snapshot().reduce((sum, integrity, i) => sum + initial[i] - integrity, 0);
    check(victim.alive && victim.crewAlive === victim.crewTotal && chipTotal > 0.35,
      'buffed small bullets wear external modules without killing the crew');
    const fresh = mkTank('heavy', false, v(0, 0, 10));
    for (let i = 0; i < 240; i++) fresh.stepKinematics(dt, null, flat, []);
    const chipAtSameSpot = () => fresh.takeDamage(9, v(0, 1, 8), v(0, 1, 1), v(0, 0, 1), 'mg');
    chipAtSameSpot();
    const wornPart = fresh.lastXRayReport?.hitModules[0]?.id;
    check(wornPart && !fresh.lastXRayReport.penetrated, 'an armored MG hit reports affected hardware without penetration');
    for (let i = 0; i < 28; i++) chipAtSameSpot();
    check(fresh.moduleHealth(wornPart) === 'destroyed' && fresh.crewAlive === fresh.crewTotal &&
      !fresh.lastXRayReport.penetrated, 'repeating a hit disables the same external part, not the protected crew');

    const manager = new DroneManager();
    manager.world = flat;
    manager.effects = effects;
    const manual = new DroneEntity('blue', shooter, false, false, v(451, 45), 0);
    manual.phase = 'fly';
    shooter.alive = false;
    const input = { dmx: 0, dmy: 0, up: false, down: false, fire: false, keys: new Set() };
    for (let i = 0; i < 3000; i++) manual.step(dt, input, manager);
    check(manual.phase === 'fly', 'FPV remains piloted past 450 m, 40 seconds, and operator death');
    manual.step(dt, { ...input, dmy: -70 }, manager);
    const q = new Quat();
    manual.getCameraPose(v(), q);
    check(applyQuat(v(0, 0, -1), q).dot(manual.forward(v())) > 0.999, 'nose camera matches flight direction');
    ballistics.hitDrone = (...args) => manager.hitByProjectile(...args);
    manager.drones.push(manual);
    for (let i = 0; i < 8; i++) ballistics.fireCoaxMG(victim, v(manual.pos.x, manual.pos.y, manual.pos.z - 5), v(0, 0, 1));
    for (let i = 0; i < 3; i++) ballistics.update(dt, flat, [], () => {});
    check(manual.phase === 'fly', 'FPV is not damaged by projectiles');
    const gun = new DroneEntity('blue', shooter, false, false, v(40, 8, 40), 0, 'gun');
    gun.phase = 'fly';
    manager.drones.push(gun);
    let bursts = 0;
    manager.onFireMG = (operator, _pos, _dir, spec) => {
      check(operator === shooter && spec.id === 'drone_mg' && spec.splashRadius === 0, 'gun drone fires non-explosive MG rounds');
      bursts++;
    };
    for (let i = 0; i < 20; i++) gun.step(dt, { ...input, fire: true }, manager);
    check(bursts > 1, 'gun drone fires repeatedly while held');
    const launchHealth = gun.health;
    const fireAtGun = (attacker) => {
      ballistics.fireCoaxMG(attacker, v(gun.pos.x, gun.pos.y, gun.pos.z - 3), v(0, 0, 1));
      ballistics.update(dt, flat, [], () => {});
    };
    fireAtGun(victim);
    check(gun.health < launchHealth && gun.health > 0, 'an enemy projectile removes some gun drone health');
    for (let i = 0; i < 20; i++) fireAtGun(victim);
    check(gun.health === 0 && gun.phase === 'fall' && manager.stats.shotDown === 1, 'repeated enemy fire shoots down the gun drone');
    const lastBlast = manager.lastDetonation.t;
    for (let i = 0; i < 240 && gun.alive; i++) gun.step(dt, null, manager);
    check(!gun.alive && manager.lastDetonation.t === lastBlast, 'a destroyed gun drone crashes without detonating');
    manager.reset();

    shooter.alive = true;
    const bomb = manager.launch(shooter);
    check(bomb && manager.cooldownLeft(shooter) === 9, 'FPV timer starts at launch');
    manager.playerInput = input;
    manager.update(2, scene);
    check(manager.cooldownLeft(shooter) === 7 && bomb.alive, 'FPV cooldown counts down in flight');
    bomb.pos.set(0, 8, 10);
    bomb.phase = 'fall';
    bomb.vel.set(0, -20, 0);
    const oldTarget = mkTank('heavy', false, v(0, 0, 10));
    const newTarget = mkTank('heavy', false, v(0, 0, 10));
    for (let i = 0; i < 240; i++) {
      oldTarget.stepKinematics(dt, null, flat, []);
      newTarget.stepKinematics(dt, null, flat, []);
    }
    const oldWarhead = {
      ...FPV_WARHEAD_SPEC, directDamage: 300, splashDamage: 160, splashRadius: 5, penMm: 120,
      moduleDamage: { slug: 1, spall: 0.35, spallCount: 10 },
    };
    manager.allTanks = [shooter, newTarget];
    for (let i = 0; i < 30 && bomb.alive; i++) bomb.step(dt, null, manager);
    check(!bomb.alive && bomb.pos.y > 0.2 && newTarget.hitCounter === 1, 'contact with a tank detonates above the ground without a click');
    oldTarget.takeDamage(300, bomb.pos, bomb.pos.clone().add(v(0, 3)), v(0, -1), 'cannon', oldWarhead, { blastCenter: bomb.pos, blastRadius: 5 });
    const integrity = (tank) => [...tank.modules.values()].reduce((sum, m) => sum + m.integrity, 0);
    check(!newTarget.alive || integrity(newTarget) < integrity(oldTarget) - 0.5, 'FPV direct hit deals substantially more module damage');
    check(manager.cooldownLeft(shooter) === 7, 'impact does not restart the FPV cooldown');
    const waterLanding = new DroneEntity('blue', shooter, false, false, v(0, -0.9), 0);
    waterLanding.phase = 'fall';
    const lostBeforeWater = manager.stats.lost;
    manager.world = { ...flat, getHeightAt: () => -2, getWaterDepthAt: () => 1 };
    waterLanding.step(dt, null, manager);
    check(!waterLanding.alive && manager.stats.lost === lostBeforeWater + 1 && manager.lastDetonation.pos.y === -1, 'water impact detonates even below sea level');

    assertNoEmpty('after drones');
    const world = new World(scene, assets);
    assertNoEmpty('after second world');
    for (const kind of ['building', 'rock', 'tree']) {
      const prop = world.getObstacles().find((o) => o.kind === kind);
      const p = v(prop.x, prop.y + prop.height + 12, prop.z);
      check(world.raycastWorld(p, v(0, -1, 0), 100)?.obstacle === prop, `${kind} roof hit`);
      for (let i = 0; !prop.destroyed && i < 4; i++) {
        ballistics.fireCannon(shooter, p, v(0, -1, 0), { ...TANK_STATS.normal.shells[1], dispersionRad: 0 });
        for (let f = 0; f < 6; f++) ballistics.update(dt, world, [], () => {});
      }
      check(prop.destroyed && world.raycastWorld(p, v(0, -1, 0), 100)?.obstacle !== prop, `${kind} breaks and loses collision`);
    }
    const ram = mkTank('heavy', true);
    const prop = world.getObstacles().find((o) => o.kind === 'rock' && !o.destroyed);
    ram.position.set(prop.x, prop.y, prop.z - prop.radius - ram.stats.collisionRadius - 0.05);
    ram.speed = 14;
    ram.stepKinematics(dt, intent, { ...flat, getObstacles: () => [prop], damageObstacle: world.damageObstacle.bind(world) }, []);
    check(prop.destroyed, 'ram breaks a rock');
    for (let i = 0; i < 30; i++) world.update(dt, ram.position);
    const rubbleNode = findByName(world.root, 'scenery_rubble');
    check(rubbleNode && rubbleNode.instancedMesh.count > 0, 'collapsed cover leaves visible rubble');

    for (const river of world.getRiverRadarSamples()) {
      for (const { x, z, halfWidth } of river) {
        const depth = world.getWaterDepthAt(x, z);
        check(depth > 0.8 && depth < 1.2, 'river stays fordable');
        check(nowDry(x, z - halfWidth - 2) && nowDry(x, z + halfWidth + 2), 'river has dry banks');
        check(near(world.getWaterLevelAt(x, z) - world.getHeightAt(x, z), depth), 'water and terrain heights agree');
      }
    }
    for (const cls of ['normal', 'humvee']) {
      const ramp = { ...flat, getWaterDepthAt: (_x, z) => z >= 0 && z < 16 ? 1 : 0, getWaterLevelAt: () => 1 };
      const crossing = mkTank(cls, true, v(0, 0, -4));
      const startSpeed = TANK_STATS[cls].maxForwardSpeed * (cls === 'humvee' ? 1 : 1.25);
      crossing.speed = startSpeed;
      const sprays = [];
      let slowest = startSpeed;
      for (let i = 0; i < 90; i++) {
        crossing.stepKinematics(dt, intent, ramp, [], {
          onWaterWake: (p, k, sprayX, _sprayZ, bow) => {
            if (bow) sprays.push({ x: p.x, y: p.y, z: p.z, k, sprayX });
          },
        });
        slowest = Math.min(slowest, crossing.speed);
      }
      check(crossing.position.z > 16 && slowest > startSpeed * 0.90, `${cls} carries speed across water`);
      check(sprays.some(p => p.sprayX > 1) && sprays.some(p => p.sprayX < -1) &&
        sprays.every(p => p.k > 0.7 && near(p.y, 1.05) && p.z >= 0 && p.z < 16), `${cls} sprays outward from both bow corners at the water surface`);
    }
    function nowDry(x, z) { return world.getWaterDepthAt(x, z) === 0; }
    // The detached test rigs share GPU meshes with the live game; the page owns their cleanup.
    return 'Vehicle drift, water spray, Apache volley, manual flight, MG damage, FPV, and destruction checks passed';
  });
  console.log(results);
  if (errors.length) {
    const invalidMeshes = await page.evaluate(async () => {
      const { getApp } = await import('/src/game/engine/app.ts');
      const app = getApp();
      const out = [];
      for (const layer of app.scene.layers.layerList) {
        for (const mi of layer.meshInstances) {
          if (!mi.mesh?.vertexBuffer) out.push({ layer: layer.name, node: mi.node.name, enabled: mi.node.enabled, visible: mi.visible, material: mi.material?.name, mesh: !!mi.mesh, vertices: mi.mesh?.vertexBuffer?.numVertices });
        }
      }
      return out.slice(0, 30);
    });
    console.log('Invalid meshes:', JSON.stringify(invalidMeshes, null, 2));
    console.log('Console stacks:', JSON.stringify(consoleStacks.slice(0, 4), null, 2));
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
