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
      if (method === 'checkGameGateway') return f.gatewayCheck ?? { enabled: false, host: null, port: null, ready: false, detail: 'off' };
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

test('new world form picks sensible defaults: latest release, automatic Java, RAM in GB', async t => {
  const page = await renderer(t);
  await page.locator('#setup-choose-create').click();
  assert.equal(await page.locator('#setup-create-form').isVisible(), true);
  await page.waitForFunction(() => document.querySelector('#setup-version').value === '1.21.15');
  assert.equal(await page.locator('#setup-java').count(), 0, 'Java is automatic, not a choice');
  assert.equal(await page.locator('#setup-memory').evaluate(e => e.tagName), 'SELECT');
  assert.equal(await page.locator('#setup-memory').inputValue(), '2048');
  assert.match(await page.locator('#setup-memory option:checked').textContent(), /2 GB/);
  assert.ok(await page.locator('#setup-version option').count() <= 11, 'only recent releases by default');
  await page.locator('#setup-all-versions').check();
  assert.equal(await page.locator('#setup-version option').count(), 16, 'every release on request');
  assert.equal(await page.locator('#setup-version').inputValue(), '1.21.15', 'toggling keeps the selection');
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

test('always-on PC stage is two big choices, with no terminal or commands anywhere', async t => {
  const page = await renderer(t);
  await page.locator('[data-setup-step="gateway"]').click(); await settled(page);
  assert.equal(await page.locator('#always-on-be').isVisible(), true);
  assert.equal(await page.locator('#always-on-pair').isVisible(), true);
  assert.equal(await page.locator('#setup-gateway-advanced').evaluate(d => d.open), false, 'fine controls are folded away');
  assert.doesNotMatch(await page.locator('#setup-gateway').textContent(), /terminal|Node\.js|seedhost-relay|--host/i);
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

test('join help shows the always-on PC player address once the tunnel is ready', async t => {
  const running = server(); running.state = 'running'; running.ownership.state = 'hosting';
  const state = appState(running, { relay: { fingerprint: 'c'.repeat(64), name: 'Home relay', parkOnStop: true }, gateway: { enabled: true, localPort: 25565, state: 'ready', detail: 'Pinned host tunnel is ready' }, onboarding: { ...progress('ready'), dismissed: true } });
  const page = await renderer(t, state);
  await page.evaluate(() => { window.fixture.gatewayCheck = { enabled: true, host: '100.97.20.84', port: 25565, ready: true, detail: 'Confirmed host route' }; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => document.querySelector('#join-help').textContent.includes('100.97.20.84:25565'), undefined, { timeout: 8000 });
  assert.match(await page.locator('#join-help').textContent(), /always-on PC/i);
});

test('first gateway start explains the one-time hand-off in plain words', async t => {
  const running = server(); running.state = 'running'; running.ownership.state = 'hosting';
  const state = appState(running, { relay: { fingerprint: 'c'.repeat(64), name: 'Home relay', parkOnStop: true }, gateway: { enabled: true, localPort: 25565, state: 'error', detail: 'Park and Claim once to establish confirmed relay custody before forwarding' }, onboarding: { ...progress('ready'), dismissed: true } });
  const page = await renderer(t, state);
  const text = await page.locator('#player-gateway').textContent();
  assert.doesNotMatch(text, /Park and Claim|custody/);
  assert.match(text, /Stop server/);
  assert.match(text, /Take over hosting/);
});

test('joining a group while this PC already has the world does not say to receive it', async t => {
  const page = await renderer(t, appState(server(), { onboarding: { ...progress('ready'), dismissed: true } }));
  const relay = { fingerprint: 'c'.repeat(64), name: 'Home relay', host: '100.97.20.84', port: 47625 };
  await page.evaluate(relay => {
    const call = window.seedhost.call;
    window.seedhost.call = async (method, payload) => {
      if (method === 'previewInvite') return { relayName: relay.name, host: relay.host, port: relay.port, relayFingerprint: relay.fingerprint, expiresAt: Date.now() + 3600000 };
      if (method === 'joinWithInvite') { window.fixture.state.relay = { fingerprint: relay.fingerprint, name: relay.name, parkOnStop: true }; window.fixture.state.peers = [{ name: relay.name, fingerprint: relay.fingerprint, host: relay.host, port: relay.port }]; return { relayName: relay.name }; }
      if (method === 'listFriends') return { members: [], custody: 'unknown', holder: null };
      if (method === 'checkRelay') return null;
      return call(method, payload);
    };
  }, relay);
  await page.locator('#peers-tab').click();
  if (await page.locator('#friends-intent-join').isVisible()) await page.locator('#friends-intent-join').click();
  await page.locator('#friend-code').fill('SEEDHOST-' + 'A'.repeat(40));
  await page.locator('#friend-name').fill('Angel');
  await page.locator('#check-invitation').click();
  await page.getByRole('button', { name: 'Review & join group' }).click();
  await page.waitForFunction(() => /Joined/.test(document.querySelector('#friend-feedback').textContent));
  const message = await page.locator('#friend-feedback').textContent();
  assert.doesNotMatch(message, /receive the world/i, 'this PC already holds the world');
  assert.match(message, /Weekend world|your world/i);
});
