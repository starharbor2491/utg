// Run against npm run dev. This uses the production public signaling path.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-gpu', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling'],
});
const url = process.env.TANK_GAME_URL ?? 'http://127.0.0.1:5173/';
const errors = [];
const read = (page) => page.evaluate(() => window.__tankQA.getMatchState());
try {
  const host = await browser.newPage({ viewport: { width: 1140, height: 740 } });
  const guest = await browser.newPage({ viewport: { width: 1140, height: 740 } });
  for (const page of [host, guest]) {
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => { if (msg.type() === 'error' && !msg.text().includes('favicon')) errors.push(msg.text()); });
  }
  await Promise.all([host, guest].map(async (page) => {
    await page.goto(url);
    await page.waitForFunction(() => window.__tankQA);
    await page.getByRole('button', { name: '1v1', exact: true }).click();
    assert.ok(await page.locator('.fcs-engage-btn').isDisabled());
  }));
  await host.getByRole('button', { name: 'Host room' }).click();
  await host.waitForFunction(() => /Share|failed|Could not/.test(document.querySelector('.fcs-room-status').textContent),
    undefined, { timeout: 22000 });
  assert.match(await host.locator('.fcs-room-status').innerText(), /share/i);
  const code = await host.locator('.fcs-room-code').innerText();
  assert.match(code, /^[A-Z2-9]{6}$/);
  await guest.getByRole('textbox', { name: 'Room code' }).fill(code.toLowerCase());
  await guest.getByRole('button', { name: 'Join room' }).click();
  await Promise.all([host, guest].map((page) => page.waitForFunction(() => window.__tankQA.getMatchState().tanks.length === 2,
    undefined, { timeout: 22000 })));
  assert.deepEqual((await read(host)).tanks.map((t) => t.team), ['blue', 'red']);
  assert.deepEqual((await read(guest)).tanks.map((t) => t.team), ['red', 'blue']);
  await guest.getByRole('button', { name: 'Humvee Wheeled' }).click();
  await host.waitForFunction(() => window.__tankQA.getMatchState().tanks[1].cls === 'humvee');
  await guest.waitForFunction(() => window.__tankQA.getMatchState().tanks[0].cls === 'humvee');
  await host.locator('.fcs-engage-btn').click();
  await guest.locator('.fcs-engage-btn').click();
  const z = (await read(host)).tanks[1].z;
  await guest.keyboard.down('w');
  await host.waitForFunction((initial) => window.__tankQA.getMatchState().tanks[1].z < initial - 1, z);
  await guest.keyboard.up('w');
  await guest.waitForFunction((initial) => window.__tankQA.getMatchState().tanks[0].z < initial - 1, z);

  await host.keyboard.down('Space');
  await host.waitForFunction(() => window.__tankQA.getRenderStats().mgHeat > 0);
  await host.keyboard.up('Space');

  // Send a short burst through the host's real ballistics path into the parked opponent.
  await host.waitForTimeout(3000);
  await host.evaluate(() => window.__tankQA.stageDuelShotForTest());
  await host.waitForFunction(() => window.__tankQA.getMatchState().score.blue === 1);
  await guest.waitForFunction(() => window.__tankQA.getMatchState().score.blue === 1);
  assert.equal((await read(guest)).tanks[0].alive, false);

  await guest.close();
  await host.getByRole('heading', { name: 'Duel ended' }).waitFor();
  assert.ok(await host.locator('.fcs-engage-btn').isDisabled());
  await host.getByRole('button', { name: 'Return to start' }).click();
  await host.getByRole('heading', { name: 'Untitled Tank Game' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Public room code, two-player roster, guest movement, authoritative kill and score, and disconnect passed');
} finally {
  await browser.close();
}
