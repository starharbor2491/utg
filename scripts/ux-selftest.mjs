// Run against Vite or the standalone file, with the same headless Chromium settings as the gameplay tests.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const url = process.env.TANK_GAME_URL ?? 'http://127.0.0.1:5173/';
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--enable-unsafe-swiftshader'] });
const errors = [], network = [];
const track = (page) => {
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => { if (msg.type() === 'error' && !msg.text().includes('favicon')) errors.push(msg.text()); });
  page.on('request', (req) => { if (/^https?:/.test(req.url())) network.push(req.url()); });
};
const coldLoad = async (page) => {
  await page.goto(url);
  await page.waitForFunction(() => window.__tankQA);
  assert.doesNotMatch(await page.locator('meta[name="viewport"]').getAttribute('content'), /user-scalable|maximum-scale/i);
};
const choose = (page, name) => page.locator('.fcs-vrow').filter({ has: page.getByText(name, { exact: true }) });
const guideRows = (page, selector) => page.locator(selector).locator('dt,dd').allTextContents();
const layout = (page) => page.evaluate(() => {
  const vehicle = document.querySelector('.fcs-vehicle-panel');
  const radar = document.querySelector('.fcs-radar-panel');
  const a = vehicle.getBoundingClientRect(), b = radar.getBoundingClientRect();
  return {
    width: innerWidth, height: innerHeight,
    overlap: Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top),
    inBounds: [a, b].every((r) => r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1),
    clearCenter: [a, b].every((r) => r.left >= innerWidth / 2 || r.right <= innerWidth / 2 || r.top > innerHeight / 2),
    hudText: parseFloat(getComputedStyle(vehicle.querySelector('.fcs-bar-readout')).fontSize),
    fits: [...vehicle.querySelectorAll('.fcs-bar-readout,.fcs-part-state,.fcs-shell-code')].every((el) => !el.getClientRects().length ||
      el.getBoundingClientRect().right <= a.right && el.getBoundingClientRect().bottom <= a.bottom),
  };
});
const shot = (page, name) => process.env.UX_SHOT_DIR && page.screenshot({ path: `${process.env.UX_SHOT_DIR}/${name}.png` });
const instrumentsVisible = (page) => page.waitForFunction(() =>
  ['.fcs-vehicle-panel', '.fcs-radar-panel'].every((selector) => getComputedStyle(document.querySelector(selector)).opacity === '1'));
try {
  const offline = url.startsWith('file:');
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 720 }, offline });
  track(desktop);
  await coldLoad(desktop);
  await choose(desktop, 'Apache').click();
  assert.match(await desktop.locator('.fcs-flight-steps').innerText(), /Lift\..*Shift[\s\S]*Move\..*W[\s\S]*Level out\..*S/);
  if (process.env.UX_SHOT_DIR) {
    await desktop.waitForTimeout(150); // Allow the 15 FPS preview to render the selected model.
    await shot(desktop, 'apache-briefing');
  }
  await desktop.getByText('Controls & credits').click();
  const expected = await guideRows(desktop, '.fcs-kbgrid');
  assert.ok(expected.includes('Raise / lower throttle') && !expected.includes('Drive'));
  assert.ok(await desktop.getByRole('link', { name: 'CC BY 4.0' }).isVisible());
  const apacheSource = desktop.getByRole('link', { name: /Apache: Alex Park/ });
  assert.equal(await apacheSource.getAttribute('download'), 'apache-source.zip');
  if (offline) assert.match(await apacheSource.getAttribute('href'), /^blob:/);
  await desktop.locator('.fcs-engage-btn').click();
  await desktop.locator('.fcs-control-guide dd').first().waitFor();
  assert.deepEqual(await guideRows(desktop, '.fcs-control-guide dl'), expected);
  const initial = await desktop.evaluate(() => window.__tankQA.getMatchState().tanks[0].y);
  const flight = (fn, arg) => desktop.waitForFunction(`(${fn.toString()})(window.__tankQA.getMatchState().tanks[0], ${JSON.stringify(arg)})`);
  await desktop.keyboard.down('Shift');
  await flight((tank, start) => tank.y > start + 3, initial);
  await desktop.keyboard.up('Shift');
  await desktop.keyboard.down('w');
  await flight((tank) => tank.flight.pitch > 0.13, null);
  await desktop.keyboard.up('w');
  await desktop.keyboard.down('s');
  await flight((tank) => Math.abs(tank.flight.pitch) < 0.07, null);
  await desktop.keyboard.up('s');
  await desktop.keyboard.press('p');
  await desktop.getByRole('heading', { name: 'Battle paused' }).waitFor();
  const frozen = await desktop.evaluate(() => window.__tankQA.getMatchState().tanks[0].y);
  await desktop.getByLabel('HUD size').selectOption('large');
  assert.equal(await desktop.evaluate(() => window.__tankQA.getMatchState().tanks[0].y), frozen);
  await desktop.reload();
  await desktop.waitForFunction(() => window.__tankQA);
  assert.equal(await desktop.getByLabel('HUD size').inputValue(), 'large');
  await desktop.close();

  const touch = await browser.newPage({ viewport: { width: 390, height: 740 }, isMobile: true, hasTouch: true, offline });
  track(touch);
  await coldLoad(touch);
  const notice = touch.locator('#touch-play-note');
  const firstNotice = await notice.boundingBox();
  assert.ok(firstNotice.y >= 0 && firstNotice.y + firstNotice.height <= 740, 'notice appears before scrolling or tapping Play');
  await touch.locator('.fcs-engage-btn').scrollIntoViewIfNeeded();
  const reminder = await touch.locator('.fcs-touch-reminder').boundingBox();
  const play = await touch.locator('.fcs-engage-btn').boundingBox();
  assert.ok(reminder.y > 0 && reminder.y + reminder.height < play.y);
  await touch.locator('.fcs-engage-btn').tap();
  await instrumentsVisible(touch);
  const standard = await layout(touch);
  assert.ok(!standard.overlap && standard.inBounds && standard.fits && standard.clearCenter, JSON.stringify(standard));
  await touch.keyboard.press('p');
  await touch.getByRole('heading', { name: 'Battle paused' }).waitFor();
  await touch.getByLabel('HUD size').selectOption('large');
  await touch.getByRole('button', { name: 'Resume battle' }).tap();
  await instrumentsVisible(touch);
  const large = await layout(touch);
  assert.ok(!large.overlap && large.inBounds && large.fits && large.clearCenter, JSON.stringify(large));
  assert.ok(large.hudText >= standard.hudText * 1.2);
  await shot(touch, 'portrait-large-hud');

  // Pinch zoom and the compact layout are separate: pinch changes the visual viewport,
  // while shrinking the CSS viewport exercises the layout used for browser zoom.
  const cdp = await touch.context().newCDPSession(touch);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
  assert.equal(await touch.evaluate(() => visualViewport.scale), 2);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  for (const [width, height] of [[320, 568], [640, 360]]) {
    await touch.setViewportSize({ width, height });
    await touch.waitForFunction(([w, h]) => innerWidth === w && innerHeight === h, [width, height]);
    const compact = await layout(touch);
    assert.ok(!compact.overlap && compact.inBounds && compact.fits, JSON.stringify(compact));
    await touch.keyboard.press('p');
    await touch.getByRole('button', { name: 'Resume battle' }).tap();
  }
  assert.deepEqual(errors, []);
  if (offline) assert.deepEqual(network, []);
  console.log(`Flight onboarding, matched controls, touch expectations, zoom, saved HUD preference, and zero panel overlap passed (${standard.hudText}px → ${large.hudText}px).`);
} finally {
  await browser.close();
}
