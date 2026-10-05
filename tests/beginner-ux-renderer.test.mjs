import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Beginner-UX renderer contract with a TEST-ONLY bridge. Not backend or Minecraft verification.
let browser;
before(async () => { browser = await chromium.launch({ executablePath: existsSync(chromium.executablePath()) ? chromium.executablePath() : '/usr/bin/chromium', headless: true }); });
after(async () => { await browser?.close(); });
const progress = (step = 'server') => ({ version: 1, step, dismissed: false, completed: false, skipped: [], draft: { name: 'My Minecraft server', loader: 'vanilla', gameVersion: '', memoryMiB: 2048 }, error: null });
const versions = Array.from({ length: 15 }, (_, i) => ({ id: `1.21.${15 - i}` }));
function appState(server = null, extra = {}) { return { version: 'test', deviceId: 'a'.repeat(64), server, peers: [], logs: [], settings: {}, relay: null, onboarding: progress(), gateway: { enabled: false, localPort: 25565, state: 'off', detail: '' }, lanAddresses: ['192.168.1.20'], ...extra }; }
function server() { return { name: 'Weekend world', state: 'offline', serverDir: '/fixture/server', storeDir: '/fixture/store', snapshotId: 's1', ownership: { state: 'owned', owner: 'a'.repeat(64) }, profile: { executable: '/fixture/java21', args: ['-Xmx2048M', '-jar', 'server.jar', 'nogui'] }, mods: { server: [], client: [] } }; }
async function renderer(t, state = appState()) {
  const page = await browser.newPage({ viewport: { width: 1240, height: 860 } });
  t.after(() => page.close());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, [], 'no renderer exceptions'));
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(({ state, versions }) => {
    window.fixture = { state, calls: [] };
    window.seedhost = { call: async (method, payload) => {
      const f = window.fixture; f.calls.push({ method, payload });
      if (method === 'getState') return f.state;
      if (method === 'saveOnboarding') f.state.onboarding = { ...payload, version: 1, error: null };
      if (method === 'listServerVersions') return { latest: versions[0].id, versions };
      if (method === 'discoverJava') return [{ executable: '/fixture/java17', major: 17, version: '17.0.2' }, { executable: '/fixture/java21', major: 21, version: '21.0.4' }];
      if (method === 'listSnapshots') return [{ id: 's1'.padEnd(64, '0'), parentId: null, fileCount: 12, bytes: 5 * 1048576, current: true }];
      return undefined;
    } };
  }, { state, versions });
  await page.goto('file://' + fileURLToPath(new URL('../apps/desktop/index.html', import.meta.url)));
  await page.waitForFunction(() => document.querySelector('#activity-message').textContent.startsWith('Ready'));
  return page;
}
const settled = page => page.waitForFunction(() => document.querySelector('#activity-message').textContent.startsWith('Ready'));

test('first run starts with a plain choice, not a form', async t => {
  const page = await renderer(t);
  await page.waitForFunction(() => document.querySelector('#setup-dialog').open);
  assert.match(await page.locator('#setup-intro').textContent(), /friends/i, 'explains what the app is for');
  assert.equal(await page.locator('#setup-choose-create').isVisible(), true);
  assert.equal(await page.locator('#setup-import').isVisible(), true);
  assert.equal(await page.locator('#setup-create-form').isVisible(), false, 'no form until a path is chosen');
  assert.equal(await page.locator('#setup-next').isVisible(), false, 'nothing to advance to before a server exists');
  assert.match(await page.locator('[data-setup-step="friends"]').textContent(), /optional/i);
  assert.match(await page.locator('[data-setup-step="gateway"]').textContent(), /optional/i);
});

test('new world form picks sensible defaults: latest release, newest Java, RAM in GB', async t => {
  const page = await renderer(t);
  await page.locator('#setup-choose-create').click();
  assert.equal(await page.locator('#setup-create-form').isVisible(), true);
  await page.waitForFunction(() => document.querySelector('#setup-version').value === '1.21.15');
  await page.waitForFunction(() => document.querySelector('#setup-java').value === '/fixture/java21');
  assert.equal(await page.locator('#setup-memory').evaluate(e => e.tagName), 'SELECT');
  assert.equal(await page.locator('#setup-memory').inputValue(), '2048');
  assert.match(await page.locator('#setup-memory option:checked').textContent(), /2 GB/);
  assert.ok(await page.locator('#setup-version option').count() <= 11, 'only recent releases by default');
  await page.locator('#setup-all-versions').check();
  assert.equal(await page.locator('#setup-version option').count(), 16, 'every release on request');
  assert.equal(await page.locator('#setup-version').inputValue(), '1.21.15', 'toggling keeps the selection');
  assert.equal(await page.locator('#setup-discover-java').isVisible(), false, 'retry only when detection found nothing');
});

test('stepper shows completed stages and Ready summarises what was set up', async t => {
  const page = await renderer(t, appState(server(), { onboarding: progress('ready') }));
  await page.locator('#nav-setup').click();
  assert.equal(await page.locator('[data-setup-step="server"]').getAttribute('data-done'), 'true');
  assert.equal(await page.locator('[data-setup-step="friends"]').getAttribute('data-done'), 'false');
  const summary = await page.locator('#setup-ready-list').textContent();
  assert.match(summary, /Weekend world/);
  assert.match(summary, /2 GB/);
  assert.match(await page.locator('#setup-ready').textContent(), /localhost/);
  assert.equal(await page.locator('#setup-next').textContent(), 'Go to my server');
});

test('always-on PC stage leads with a short explanation; terminal steps are folded away', async t => {
  const page = await renderer(t);
  await page.locator('[data-setup-step="gateway"]').click(); await settled(page);
  assert.equal(await page.locator('#setup-relay-details').evaluate(d => d.open), false);
  assert.equal(await page.locator('#setup-relay-command').isVisible(), false);
  assert.match(await page.locator('#setup-skip').textContent(), /skip/i);
});

test('Operate without a server shows a getting-started checklist', async t => {
  const page = await renderer(t);
  await page.locator('#setup-later').click(); await settled(page);
  assert.equal(await page.locator('#getting-started').isVisible(), true);
  assert.equal(await page.locator('#getting-started li').count(), 4);
  assert.equal(await page.locator('#create-server-empty').textContent(), 'create a server');
  assert.equal(await page.locator('#player-gateway').isVisible(), false, 'gateway jargon hidden until used');
  assert.equal(await page.locator('#advanced-peers').evaluate(d => d.open), false, 'fingerprints are advanced');
  assert.equal(await page.locator('#device-fingerprint').isVisible(), false);
  for (const id of ['mods-details', 'profile-details', 'console-section']) assert.equal(await page.locator('#' + id).isVisible(), false, id + ' hidden until a server exists');
});

test('Operate with a server uses plain words and explains how to join', async t => {
  const page = await renderer(t, appState(server(), { onboarding: { ...progress('ready'), dismissed: true } }));
  assert.equal(await page.getByRole('button', { name: 'Start server', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Save backup', exact: true }).count(), 1);
  assert.equal(await page.locator('#snapshot-history-title').textContent(), 'Backups');
  assert.equal(await page.locator('#server-details').evaluate(d => d.open), false, 'paths and IDs are folded away');
  assert.equal(await page.locator('#server-directory').isVisible(), false);
  const join = await page.locator('#join-help').textContent();
  assert.match(join, /localhost/);
  assert.match(join, /192\.168\.1\.20:25565/);
  await page.waitForFunction(() => document.querySelectorAll('#snapshot-list li').length === 1);
  assert.match(await page.locator('#snapshot-list').textContent(), /5\.0 MB/);
});
