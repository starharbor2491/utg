// Works against Vite, GitHub Pages, or the standalone file. Uses real display pixels and input.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--enable-unsafe-swiftshader'] });
const url = process.env.TANK_GAME_URL ?? 'http://127.0.0.1:5173/';
const errors = [], network = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1152, height: 720 }, hasTouch: true, offline: url.startsWith('file:') });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => { if (msg.type() === 'error' && !msg.text().includes('favicon')) errors.push(msg.text()); });
  page.on('request', (req) => { if (/^https?:/.test(req.url())) network.push(req.url()); });
  await page.goto(url);
  await page.waitForFunction(() => window.__tankQA);
  const pane = page.locator('.fcs-model-preview'), guide = page.locator('.fcs-control-guide');
  const play = () => page.locator('.fcs-engage-btn').click();
  const state = () => page.evaluate(() => window.__tankQA.getMatchState());
  const advance = (t) => page.evaluate((s) => window.__tankQA.fastForward(s), t);
  const frame = () => page.waitForTimeout(150); // briefing is capped at 15 Hz
  const choose = (name) => page.locator('.fcs-vrow').filter({ has: page.getByText(name, { exact: true }) }).click();
  const pixels = async () => {
    await frame();
    const { x, y, width, height } = await pane.boundingBox();
    return (await page.screenshot({ clip: { x: x + width * 0.27, y: y + height * 0.24, width: width * 0.46, height: height * 0.47 } })).toString('base64');
  };
  async function difference(a, b) {
    return page.evaluate(async ([a, b]) => {
      const sample = async (s) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + s;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 48;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, 48, 48);
        return ctx.getImageData(0, 0, 48, 48).data;
      };
      const [first, second] = await Promise.all([sample(a), sample(b)]);
      return first.reduce((sum, n, i) => sum + Math.abs(n - second[i]), 0) / first.length;
    }, [a, b]);
  }
  await choose('Rocket artillery');
  await pane.focus();
  const snapshot = await state(), before = await pixels();
  await page.mouse.move(850, 360);
  await page.mouse.down(); await page.mouse.move(1024, 417, { steps: 8 }); await page.mouse.up();
  assert.ok(await difference(before, await pixels()) > 5, 'drag changes the 3D view');
  await pane.press('Home');
  assert.ok(await difference(before, await pixels()) < 2, 'Home restores the original view');
  for (let i = 0; i < 5; i++) await pane.press('ArrowRight');
  assert.ok(await difference(before, await pixels()) > 4, 'keyboard rotates the 3D view');
  assert.deepEqual(await state(), snapshot, 'inspecting a vehicle does not run the offline match');
  assert.ok(await guide.isHidden());
  await play();
  await guide.getByText('Fire salvo').waitFor();
  await page.keyboard.press('h');
  assert.ok(await guide.locator('dl').isHidden());
  await page.keyboard.press('h');
  await guide.getByText('Fire salvo').waitFor();
  await page.mouse.click(570, 355); await advance(2);
  await page.waitForFunction(() => window.__tankQA.getRenderStats().rocketsLeft === 0);
  await advance(12);
  assert.equal(await page.evaluate(() => window.__tankQA.getRenderStats().rocketsLeft), 6);
  await page.keyboard.press('p'); await page.getByRole('heading', { name: 'Battle paused' }).waitFor();
  await page.evaluate(() => window.__tankQA.teleportForTest(100, -360, 0));
  await choose('Apache');
  assert.equal((await state()).tanks[0].cls, 'rocket', 'selection away from base must be queued');
  assert.match(await pane.getAttribute('aria-label'), /Apache/);
  await page.setViewportSize({ width: 390, height: 740 });
  const phone = await pixels();
  const cdp = await ctx.newCDPSession(page);
  for (const [type, points] of [['touchStart', [{ x: 150, y: 110 }]], ['touchMove', [{ x: 278, y: 157 }]], ['touchEnd', []]]) {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  }
  assert.ok(await difference(phone, await pixels()) > 4, 'touch rotates the selected preview in portrait');
  assert.ok(await page.locator('.fcs-briefing-backdrop').isVisible());
  await page.setViewportSize({ width: 1152, height: 720 });
  await page.evaluate(() => window.__tankQA.teleportForTest(0, -420, 0));
  await choose('Apache'); await play();
  await guide.getByText('Throttle', { exact: true }).waitFor();
  await page.keyboard.press('p'); await choose('Drone Carrier'); await play();
  await guide.getByText('Launch', { exact: true }).waitFor();
  await page.keyboard.press('1'); await page.mouse.click(570, 355);
  await guide.getByText('Fire gun', { exact: true }).waitFor();
  await page.mouse.click(570, 355, { button: 'right' }); await advance(12);
  await page.keyboard.press('2');
  await page.waitForFunction(() => window.__tankQA.getRenderStats().activeShell === 'FPV');
  await page.mouse.click(570, 355); await guide.getByText('Detonate', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  if (url.startsWith('file:')) assert.deepEqual(network, []);
  console.log('Mouse, touch and keyboard previews, queued loadout, six-round salvo/reload, and contextual controls passed.');
} finally { await browser.close(); }
