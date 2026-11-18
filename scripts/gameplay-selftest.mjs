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
    const heading = (await player()).yaw;
    await page.keyboard.down('Alt');
    await page.waitForFunction(() => window.__tankQA.getCamDebug().freeLooking);
    let last = drone ? Math.atan2(before.camDir[0], before.camDir[2]) : before.yaw;
    let sweep = 0;
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(120 + i * 112, 350);
      await page.evaluate(() => window.__tankQA.fastForward(0.035));
      const next = await cam();
      const angle = drone ? Math.atan2(next.camDir[0], next.camDir[2]) : next.yaw;
      sweep += angleDelta(angle, last);
      last = angle;
      assert.deepEqual(next.aim, before.aim);
    }
    assert.ok(Math.abs(Math.abs(sweep) - 2 * Math.PI) < 0.3, `camera sweeps 360° (${sweep.toFixed(2)} rad)`);
    // A click while looking around must not turn into a shot, launch or FPV abort.
    await page.mouse.down();
    await page.mouse.up();
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    await page.evaluate(() => window.__tankQA.fastForward(0.12));
    if (!drone) assert.ok(Math.abs(angleDelta((await player()).yaw, heading)) < 0.2, 'orbit does not steer the vehicle');
    await page.mouse.move(560, 350);
    await page.keyboard.up('Alt');
    await page.evaluate(() => window.__tankQA.fastForward(0.1));
    const after = await cam();
    assert.equal(after.freeLooking, false);
    if (drone) assert.ok(Math.abs(angleDelta(Math.atan2(after.camDir[0], after.camDir[2]), Math.atan2(before.camDir[0], before.camDir[2]))) < 0.08, 'orbit does not steer the FPV');
    else assert.deepEqual([after.yaw, after.pitch], [before.yaw, before.pitch], 'view restores on release');
  }

  await orbit();
  assert.equal(await page.evaluate(() => window.__tankQA.getRenderStats().rocketsLeft), 2, 'free-look clicks do not fire missiles');
  // Reset aim after moving to the edge of the viewport in the pointer test.
  await page.evaluate(() => window.__tankQA.teleportForTest(0, -420, 0));
  const birdBefore = await player();
  await page.keyboard.down('Shift');
  await page.keyboard.down('w');
  await page.evaluate(() => window.__tankQA.fastForward(2));
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');
  const birdAfter = await page.evaluate(() => window.__tankQA.getMatchState().tanks[0]);
  assert.ok(birdAfter.y > birdBefore.y + 8 && birdAfter.z > birdBefore.z + 12, 'Little Bird climbs and flies forward');
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
  await page.getByRole('button', { name: 'Support Wheeled' }).click();
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
  await page.mouse.move(560, 28);
  await page.evaluate(() => window.__tankQA.fastForward(0.1));
  const { camPos: [cx, cy, cz], pitch } = await cam();
  const riverSurface = await page.evaluate(([x, z]) => window.__tankQA.waterAtForTest(x, z), [cx, cz]);
  assert.ok(pitch > 1.4 && riverSurface.depth > 0.6 && cy > riverSurface.level + 0.9, 'low orbit stays above river surface');
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
  await page.mouse.click(560, 350);
  await page.keyboard.up('Alt');
  await page.evaluate(() => window.__tankQA.fastForward(0.1));
  assert.equal(await page.evaluate(() => window.__tankQA.getMatchState().drones.active), 0, 'free-look clicks do not launch the FPV');
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
        tank.stepKinematics(dt, { ...intent, steer: 1 }, flat, []);
        const slip = -tank.velocity.x * Math.cos(tank.hullYaw) + tank.velocity.z * Math.sin(tank.hullYaw);
        check(human ? Math.abs(slip) > 0.02 : near(slip, 0), `${cls} drift`);
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
    findByName(bird.root, 'littlebird_main_rotor');
    const flight = { ...intent, flightYaw: 0, lift: 1, steer: 0 };
    let missiles = 0, burst = 0;
    for (let i = 0; i < 150; i++) bird.stepKinematics(dt, { ...flight, fireCannon: i === 84, fireMG: true }, flat, [], {
      onFireCannon: (_t, pos, _dir, shell) => { if (pos.y > 3 && shell.id === 'littlebird_missile') missiles++; },
      onFireMG: () => burst++,
    });
    check(bird.position.y > 8 && bird.position.z > 12 && bird.rotorAngle > 0, 'aircraft climbs, moves, and spins its rotor');
    check(missiles === 2 && burst > 8, 'aircraft fires missiles and its machine gun');
    check(bird.hullTilt.x > 0.4 && bird.velocity.z > 9, 'forward cyclic pitches the aircraft and accelerates it');
    const inertia = bird.velocity.z;
    bird.stepKinematics(dt, { ...flight, throttle: 0, flightYaw: Math.PI / 2, lift: 0 }, flat, []);
    check(bird.velocity.z > inertia * 0.95, 'releasing cyclic and turning does not snap the aircraft velocity');
    const bank = mkTank('littlebird', true, v(0, 30));
    for (let i = 0; i < 120; i++) bank.stepKinematics(dt, { ...flight, throttle: 0, steer: -1, lift: 0 }, flat, []);
    check(bank.hullTilt.z > 0.4 && bank.velocity.x < -4, 'left cyclic banks and accelerates the aircraft to the left');
    const altitude = bank.position.y;
    for (let i = 0; i < 120; i++) bank.stepKinematics(dt, { ...flight, throttle: 0, lift: -1 }, flat, []);
    check(bank.position.y < altitude - 3, 'reducing collective descends without requiring a tilt');
    const pointerBird = mkTank('littlebird', true, v(0, 30));
    for (let i = 0; i < 100; i++) pointerBird.stepKinematics(dt,
      { ...flight, throttle: 0, lift: 0, flightYaw: Math.PI / 2, flightPitch: 0.43 }, flat, []);
    check(pointerBird.velocity.x > 3 && pointerBird.hullYaw > 1.4, 'pointer aim tilts thrust and flies without WASD input');
    const xVel = pointerBird.velocity.x;
    for (let i = 0; i < 75; i++) pointerBird.stepKinematics(dt,
      { ...flight, throttle: 0, lift: 0, flightYaw: Math.PI / 2, brake: true }, flat, []);
    check(pointerBird.velocity.x < xVel * 0.8, 'brake counter-tilts to reduce momentum');
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
    check(victim.alive && victim.crewAlive === victim.crewTotal && snapshot().some((integrity, i) => integrity < initial[i] - 0.1), 'small bullets wear modules without killing the crew');

    const manager = new DroneManager();
    manager.world = flat;
    manager.effects = effects;
    const manual = new DroneEntity('blue', shooter, false, false, v(451, 45), 0);
    manual.phase = 'fly';
    shooter.alive = false;
    const input = { dmx: 0, dmy: 0, up: false, down: false, keys: new Set() };
    for (let i = 0; i < 3000; i++) manual.step(dt, input, manager);
    check(manual.phase === 'fly', 'FPV remains piloted past 450 m, 40 seconds, and operator death');
    manual.step(dt, { ...input, dmy: -70 }, manager);
    const q = new Quat();
    manual.getCameraPose(v(), q);
    check(applyQuat(v(0, 0, -1), q).dot(manual.forward(v())) > 0.999, 'nose camera matches flight direction');
    for (let i = 0; i < 8; i++) ballistics.fireCoaxMG(victim, v(manual.pos.x, manual.pos.y, manual.pos.z - 5), v(0, 0, 1));
    for (let i = 0; i < 3; i++) ballistics.update(dt, flat, [], () => {});
    check(manual.phase === 'fly', 'FPV is not damaged by projectiles');

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
    manager.world = { ...flat, getHeightAt: () => -2, getWaterDepthAt: () => 1 };
    waterLanding.step(dt, null, manager);
    check(!waterLanding.alive && manager.stats.lost === 1 && manager.lastDetonation.pos.y === -1, 'water impact detonates even below sea level');

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
    function nowDry(x, z) { return world.getWaterDepthAt(x, z) === 0; }
    // The detached test rigs share GPU meshes with the live game; the page owns their cleanup.
    return 'All vehicle speed/drift/timer, chip damage, FPV durability and damage, destruction, and river checks passed';
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
