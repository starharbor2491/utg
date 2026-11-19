// Run against npm run dev. This uses the production public signaling path.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-gpu', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling'],
});
const url = process.env.TANK_GAME_URL ?? 'http://127.0.0.1:5173/';
const errors = [];
const read = (page) => page.evaluate(() => window.__tankQA.getMatchState());
const ready = (page) => page.locator('.fcs-readiness');
const engage = (page) => page.locator('.fcs-engage-btn');
const matchText = async (locator, re) => {
  await locator.filter({ hasText: re }).waitFor();
};
const vehicleState = (page) => page.evaluate(() => ({
  tanks: window.__tankQA.getMatchState().tanks.map(({ x, y, z, yaw, flight }) => [x, y, z, yaw, flight]),
  mgHeat: window.__tankQA.getRenderStats().mgHeat,
  cooldown: document.querySelector('.fcs-ordnance-grid .fcs-bar-readout').textContent,
}));
const openPage = async () => {
  const page = await browser.newPage({ viewport: { width: 1140, height: 740 } });
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => { if (msg.type() === 'error' && !msg.text().includes('favicon')) errors.push(msg.text()); });
  await page.goto(url);
  return page;
};
const chooseDuel = async (page) => {
  await page.waitForFunction(() => window.__tankQA);
  await page.getByRole('button', { name: '1v1', exact: true }).click();
  assert.ok(await engage(page).isDisabled());
};
const connect = async (host, guest) => {
  await Promise.all([host, guest].map(chooseDuel));
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
};
try {
  const [host, guest] = await Promise.all([openPage(), openPage()]);
  await connect(host, guest);
  assert.deepEqual((await read(host)).tanks.map((t) => t.team), ['blue', 'red']);
  assert.deepEqual((await read(guest)).tanks.map((t) => t.team), ['red', 'blue']);
  await guest.getByRole('button', { name: 'Humvee Wheeled' }).click();
  await host.waitForFunction(() => window.__tankQA.getMatchState().tanks[1].cls === 'humvee');
  await guest.waitForFunction(() => window.__tankQA.getMatchState().tanks[0].cls === 'humvee');
  await matchText(ready(host), /You: Not ready. Opponent: Not ready/);
  await matchText(engage(host), /Ready up/);
  const parked = await vehicleState(host);
  await host.locator('.fcs-engage-btn').click();
  await matchText(ready(guest), /You: Not ready. Opponent: Ready/);
  await host.keyboard.down('w');
  await host.keyboard.press('f');
  await host.keyboard.press('c');
  await host.mouse.click(1000, 200);
  await host.evaluate(() => window.__tankQA.fastForward(1));
  await host.keyboard.up('w');
  assert.deepEqual(await vehicleState(host), parked);
  assert.ok(await host.locator('.fcs-briefing-backdrop').isVisible());
  assert.doesNotMatch(await ready(host).innerText(), /Battle starts/);

  await guest.locator('.fcs-engage-btn').click();
  await Promise.all([host, guest].map((page) => matchText(ready(page), /Battle starts in/)));
  await guest.locator('.fcs-engage-btn').click();
  await matchText(ready(host), /You: Ready. Opponent: Not ready/);
  await matchText(engage(guest), /Ready up/);
  await guest.locator('.fcs-engage-btn').click();
  await matchText(ready(guest), /Battle starts in/);
  await host.locator('.fcs-engage-btn').click();
  await matchText(ready(guest), /You: Ready. Opponent: Not ready/);
  await host.waitForTimeout(3100);
  assert.ok(await host.locator('.fcs-briefing-backdrop').isVisible(), 'cancelled countdown does not start');
  assert.deepEqual(await vehicleState(host), parked);

  await host.locator('.fcs-engage-btn').click();
  await Promise.all([host, guest].map((page) => matchText(ready(page), /Battle starts in/)));
  await guest.keyboard.down('w');
  await guest.keyboard.press('f');
  await guest.keyboard.press('c');
  await guest.mouse.click(1000, 200);
  assert.deepEqual(await vehicleState(host), parked);
  await Promise.all([host, guest].map((page) => page.locator('.fcs-briefing-backdrop').waitFor({ state: 'hidden' })));
  await guest.keyboard.down('w'); // An auto-repeat from before start is not a new press.
  await guest.keyboard.up('w');
  assert.deepEqual(await vehicleState(host), parked);

  // The host's menu must not stop the authoritative simulation.
  await host.keyboard.press('p');
  await host.getByRole('heading', { name: 'Duel menu' }).waitFor();
  await matchText(host.locator('.fcs-room-status'), /does not pause/);
  const z = (await read(host)).tanks[1].z;
  await guest.keyboard.down('w');
  await host.waitForFunction((initial) => window.__tankQA.getMatchState().tanks[1].z < initial - 1, z);
  await guest.keyboard.up('w');
  await guest.waitForFunction((initial) => window.__tankQA.getMatchState().tanks[0].z < initial - 1, z);

  await host.getByRole('button', { name: 'Resume battle' }).click();
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

  const retry = await openPage();
  await connect(host, retry);
  await Promise.all([host, retry].map((page) => engage(page).click()));
  await matchText(ready(retry), /Battle starts in/);
  await retry.getByRole('button', { name: 'Leave duel' }).click();
  await host.getByRole('heading', { name: 'Duel ended' }).waitFor();
  await retry.getByRole('heading', { name: 'Untitled Tank Game' }).waitFor();
  await host.waitForTimeout(3100);
  assert.ok(await engage(host).isDisabled(), 'leaving during countdown must not start the abandoned duel');
  assert.deepEqual(errors, []);
  console.log('Public rooms: readiness, no pre-start input, cancellation by either player, auto-start, menu, combat, disconnect, and leave/retry passed');
} finally {
  await browser.close();
}
