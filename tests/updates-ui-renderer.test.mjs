import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
// Headed Electron + REAL renderer, TEST-ONLY deterministic bridge; no backend/network/TLS claims.
let app, page, root;
const errors = [];
before(async () => {
  const scratch = process.env.TMPDIR || (process.platform === 'win32' && path.join(process.env.LOCALAPPDATA, 'hermes/cache/scratch'));
  if (!scratch) throw new Error('Hermes scratch TMPDIR required');
  root = await mkdtemp(path.join(scratch, 'seed-updates-ui-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.resolve('tools/dashboard-fixture-main.cjs'), '--profile-root=' + root], env });
  page = await app.firstWindow(); page.setDefaultTimeout(7000);
  page.on('pageerror', e => errors.push(e.message));
});
after(async () => { if (app) { app.process().kill(); await app.close().catch(() => {}); } });
async function openAppSettings() {
  await page.bringToFront();
  await page.locator('#settings-tab').click();
  await page.locator('#settings-cat-app').click();
}
async function reset() {
  await page.evaluate(() => window.dashboardFixture.reset());
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#splash').hidden);
}

test('the Updates card checks on demand and reports the result without manual refreshes', async () => {
  await reset();
  await openAppSettings();
  assert.equal(await page.locator('#update-badge').textContent(), 'Not checked');
  assert.match(await page.locator('#update-version').textContent(), /Current version: 0\.5\.0-test/);
  assert.match(await page.locator('#update-version').textContent(), /development build/);
  await page.locator('#update-check').click();
  await page.waitForFunction(() => document.querySelector('#update-badge').textContent === 'Up to date');
  assert.match(await page.locator('#update-feedback').textContent(), /newest published version/);
  assert.deepEqual(errors, []);
});

test('a check that is already running settles the badge by itself once the operation finishes', async () => {
  await reset();
  await openAppSettings();
  // A launch/background check is in flight; clicking returns the busy snapshot instead of a result.
  await page.evaluate(() => window.dashboardFixture.set({ updateBusy: true }));
  await page.locator('#update-check').click();
  await page.waitForFunction(() => document.querySelector('#update-badge').textContent === 'Checking…');
  assert.equal(await page.locator('#update-check').isDisabled(), true, 'no second check can start while one runs');
  // The operation finishes; the card must converge on its own (no further clicks).
  await page.evaluate(() => window.dashboardFixture.set({ updateBusy: false }));
  await page.waitForFunction(() => document.querySelector('#update-badge').textContent === 'Up to date', { timeout: 6000 });
  assert.equal(await page.locator('#update-check').isDisabled(), false, 'the button is usable again after settling');
  assert.deepEqual(errors, []);
});
