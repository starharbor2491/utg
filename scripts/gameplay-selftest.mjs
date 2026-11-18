// Run against npm run dev. Set PLAYWRIGHT_MODULE if Playwright is installed outside this repo.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1152, height: 720 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().includes('favicon')) errors.push(msg.text());
  });
  await page.goto(process.env.TANK_GAME_URL ?? 'http://127.0.0.1:5173/');
  await page.waitForFunction(() => window.__tankQA);
  await page.getByRole('button', { name: 'Little Bird Air' }).click();
  await page.getByRole('heading', { name: 'Little Bird' }).waitFor();
  assert.equal(await page.evaluate(() => window.__tankQA.getMatchState().tanks.filter((t) => t.cls === 'littlebird').length), 1);
  await page.locator('.fcs-engage-btn').click();
  const birdBefore = await page.evaluate(() => window.__tankQA.getMatchState().tanks[0]);
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
  await page.keyboard.press('p');
  await page.getByRole('heading', { name: 'Battle paused' }).waitFor();
  await page.evaluate(() => window.__tankQA.teleportForTest(0, -420, 0));
  await page.getByRole('button', { name: 'Support Wheeled' }).click();
  assert.equal((await page.locator('.fcs-engage-main').textContent()).trim(), 'Resume battle');
  await page.locator('.fcs-engage-btn').click();
  await page.keyboard.press('2');
  await page.waitForFunction(() => window.__tankQA.getRenderStats().activeShell === 'FPV');
  await page.mouse.click(560, 350);
  await page.locator('.fcs-fpv.is-active').waitFor();
  await page.locator('.fcs-marker-layer.is-fpv').waitFor({ state: 'attached' });
  await page.evaluate(() => window.__tankQA.fastForward(2.5));
  assert.ok(parseInt(await page.locator('.fcs-fpv-cooldown').innerText(), 10) < 9, 'FPV cooldown ticks while flying');
  await page.waitForFunction(() => window.__tankQA.getCamDebug().fov === 95);
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
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const { loadAllGameAssets } = await import('/src/game/AssetLoader.ts');
    const { DroneEntity, DroneManager, FPV_WARHEAD_SPEC } = await import('/src/game/Drone.ts');
    const { Tank, TANK_STATS } = await import('/src/game/Tank.ts');
    const { World } = await import('/src/game/World.ts');
    const { EffectsManager } = await import('/src/game/Effects.ts');
    const { BallisticsManager } = await import('/src/game/Ballistics.ts');
    const check = (condition, name) => { if (!condition) throw new Error(name); };
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
    const flat = {
      worldHalfSize: 520, getHeightAt: () => 0, getWaterDepthAt: () => 0,
      getNormalAt: (_x, _z, out = v()) => out.set(0, 1, 0), getRoadFactorAt: () => 0,
      getObstacles: () => [], raycastWorld: () => null, damageObstacle: () => false, blastObstacles: () => {},
    };
    const renderer = new THREE.WebGLRenderer();
    const assets = await loadAllGameAssets(renderer);
    const scene = new THREE.Scene();
    const mkTank = (cls, human, pos = v()) => new Tank(human ? 'player' : 'bot', human ? 'blue' : 'red', cls, assets, pos, 0, human, '');
    const intent = { throttle: 1, steer: 0, brake: false, aimPoint: v(0, 1, 100), fireCannon: false, fireMG: false };
    const dt = 1 / 60;
    for (const [cls, stats] of Object.entries(TANK_STATS)) {
      if (stats.drive === 'air') continue;
      for (const human of [true, false]) {
        const tank = mkTank(cls, human);
        const track = tank.root.getObjectByName('moving_track_L');
        const trackBefore = new THREE.Matrix4(), trackAfter = new THREE.Matrix4();
        if (track) track.getMatrixAt(0, trackBefore);
        for (let i = 0; i < 480; i++) tank.stepKinematics(dt, intent, flat, []);
        if (stats.drive === 'tracked') {
          check(track, `${cls} track rig exists`);
          const raw = (cls === 'ifv' ? assets.models.ifv : assets.models.player_mbt_lod1).getObjectByName('body').geometry;
          const hull = tank.rig.visualRoot.getObjectByName('body');
          check(hull.userData.bakedTracksRemoved && hull.geometry.getAttribute('position').count < raw.index.count * 0.9,
            `${cls} replaces rather than overlays baked tread triangles`);
          track.getMatrixAt(0, trackAfter);
          check(!trackBefore.equals(trackAfter), `${cls} track links move`);
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

    const shooter = mkTank('normal', true);
    const bird = mkTank('littlebird', true);
    const mainRotor = bird.root.getObjectByName('littlebird_main_rotor');
    const flight = { ...intent, flightYaw: 0, lift: 1, steer: 0 };
    let missiles = 0, burst = 0;
    for (let i = 0; i < 150; i++) bird.stepKinematics(dt, { ...flight, fireCannon: i === 84, fireMG: true }, flat, [], {
      onFireCannon: (_t, pos, _dir, shell) => { if (pos.y > 3 && shell.id === 'littlebird_missile') missiles++; },
      onFireMG: () => burst++,
    });
    check(bird.position.y > 8 && bird.position.z > 12 && mainRotor.rotation.y > 0, 'aircraft climbs, moves, and spins its rotor');
    check(missiles === 2 && burst > 8, 'aircraft fires missiles and its machine gun');
    check(bird.rig.hullTiltGroup.rotation.x > 0.4 && bird.velocity.z > 9, 'forward cyclic pitches the aircraft and accelerates it');
    const inertia = bird.velocity.z;
    bird.stepKinematics(dt, { ...flight, throttle: 0, flightYaw: Math.PI / 2, lift: 0 }, flat, []);
    check(bird.velocity.z > inertia * 0.95, 'releasing cyclic and turning does not snap the aircraft velocity');
    const bank = mkTank('littlebird', true, v(0, 30));
    for (let i = 0; i < 120; i++) bank.stepKinematics(dt, { ...flight, throttle: 0, steer: -1, lift: 0 }, flat, []);
    check(bank.rig.hullTiltGroup.rotation.z > 0.4 && bank.velocity.x < -4, 'left cyclic banks and accelerates the aircraft to the left');
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
    const q = new THREE.Quaternion();
    manual.getCameraPose(v(), q);
    check(v(0, 0, -1).applyQuaternion(q).dot(manual.forward(v())) > 0.999, 'nose camera matches flight direction');
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

    const world = new World(scene, assets);
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
    check(world.root.getObjectByName('scenery_rubble')?.count > 0, 'collapsed cover leaves visible rubble');

    for (const river of world.getRiverRadarSamples()) {
      for (const { x, z, halfWidth } of river) {
        const depth = world.getWaterDepthAt(x, z);
        check(depth > 0.8 && depth < 1.2, 'river stays fordable');
        check(nowDry(x, z - halfWidth - 2) && nowDry(x, z + halfWidth + 2), 'river has dry banks');
        check(near(world.getWaterLevelAt(x, z) - world.getHeightAt(x, z), depth), 'water and terrain heights agree');
      }
    }
    function nowDry(x, z) { return world.getWaterDepthAt(x, z) === 0; }
    renderer.dispose();
    return 'All vehicle speed/drift/timer, chip damage, FPV durability and damage, destruction, and river checks passed';
  });
  console.log(results);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
