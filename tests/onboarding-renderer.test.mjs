import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Renderer/real Chromium DOM tests with a TEST-ONLY bridge. Not backend or Minecraft verification.
let browser;
before(async () => { browser = await chromium.launch({ executablePath: existsSync(chromium.executablePath()) ? chromium.executablePath() : '/usr/bin/chromium', headless: true }); });
after(async () => { await browser?.close(); });
const progress = () => ({ version: 1, step: 'server', dismissed: false, completed: false, skipped: [], draft: { name: 'My server', loader: 'vanilla', gameVersion: '', memoryMiB: 2048 }, error: null });
function appState(server = null) { return { version: 'test', deviceId: 'a'.repeat(64), server, peers: [], logs: [], settings: {}, relay: null, onboarding: progress(), gateway: { enabled: false, localPort: 25565, state: 'off', detail: '' } }; }
function server() { return { name: 'Existing world', state: 'offline', serverDir: '/fixture/server', storeDir: '/fixture/store', snapshotId: 's1', ownership: { state: 'owned', owner: 'a'.repeat(64) }, profile: { executable: '/fixture/java', args: ['@args.txt', 'nogui'] }, mods: { server: [], client: [] } }; }
async function renderer(t, state = appState()) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  t.after(() => page.close());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, [], 'no renderer exceptions'));
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(({ state }) => {
    window.fixture = { state, calls: [], failure: null, snapshots: [{ id: 's1', parentId: null, fileCount: 2, bytes: 32, current: true }, { id: 's0', parentId: null, fileCount: 1, bytes: 16, current: false }] };
    window.seedhost = { call: async (method, payload) => {
      const f = window.fixture; f.calls.push({ method, payload });
      if (f.failure === method) throw Error('Fixture refusal: ' + method);
      if (method === 'getState') return f.state;
      if (method === 'saveOnboarding') f.state.onboarding = { ...payload, version: 1, error: null };
      if (method === 'listServerVersions') return { latest: '1.21.1', versions: [{ id: '1.21.1' }, { id: '1.20.1' }] };
      if (method === 'discoverJava') return [{ executable: '/fixture/java', major: 21, version: '21.0.1' }];
      if (method === 'pickJava') return f.pickedJava ?? null;
      if (method === 'listSnapshots') return f.snapshots;
      return undefined; // Cancellation, unless a test explicitly exercises a successful mutation.
    } };
  }, { state });
  await page.goto('file://' + fileURLToPath(new URL('../apps/desktop/index.html', import.meta.url)));
  await page.waitForFunction(() => document.querySelector('#activity-message').textContent.startsWith('Ready'));
  return page;
}
async function settled(page) { await page.waitForFunction(() => document.querySelector('#activity-message').textContent.startsWith('Ready')); }

test('fresh empty state has exact centered create action and resumable optional setup', async t => {
  const page = await renderer(t);
  assert.equal(await page.locator('#create-server-empty').count(), 1, 'empty state offers create a server');
  assert.equal(await page.locator('#create-server-empty').textContent(), 'create a server');
  assert.equal(await page.locator('#setup-dialog').isVisible(), true);
  await page.locator('#setup-name').fill('Saved draft');
  await page.locator('#setup-dialog').press('Escape');
  await page.waitForFunction(() => !document.querySelector('#setup-dialog').open);
  const saved = await page.evaluate(() => window.fixture.state.onboarding);
  assert.equal(saved.draft.name, 'Saved draft'); assert.equal(saved.dismissed, true);
  // A new test-only bridge boot uses the saved contract (real durability belongs to the live tool).
  const reopened = await renderer(t, { ...appState(), onboarding: saved });
  assert.equal(await reopened.locator('#setup-dialog').isVisible(), false);
  await reopened.locator('#nav-setup').click();
  assert.equal(await reopened.locator('#setup-name').inputValue(), 'Saved draft');
  assert.equal(await page.locator('#mod-search-form').count(), 1);
  assert.equal(await page.locator('#join-friend-form').count(), 1);
});

test('creation uses explicit EULA, release loader RAM and selected Java; cancellation never advances', async t => {
  const page = await renderer(t);
  assert.equal(await page.locator('#setup-create').count(), 1, 'creation form exists');
  if (await page.locator('#setup-choose-create').isVisible()) await page.locator('#setup-choose-create').click();
  await page.waitForFunction(() => document.querySelector('#setup-version').options.length > 1);
  await page.locator('#setup-loader').selectOption('fabric');
  await page.locator('#setup-memory').selectOption('4096');
  await page.locator('#setup-java').selectOption('/fixture/java');
  await page.locator('#setup-create').click();
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(c => c.method === 'createServer').length), 0);
  assert.match(await page.locator('#setup-error').textContent(), /EULA/);
  await page.locator('#setup-eula').check();
  await page.locator('#setup-create').click(); await settled(page);
  assert.equal(await page.locator('#setup-server').isVisible(), true, 'cancelled native confirmation does not advance');
  assert.deepEqual(await page.evaluate(() => window.fixture.calls.find(c => c.method === 'createServer').payload), { name: 'My server', loader: 'fabric', gameVersion: '1.21.1', memoryMiB: 4096, javaExecutable: '/fixture/java', eulaAccepted: true });
  await page.evaluate(() => { window.fixture.failure = 'createServer'; });
  await page.locator('#setup-create').click(); await settled(page);
  assert.equal(await page.locator('#setup-error').isVisible(), true, 'backend refusal is in the modal');
  await page.evaluate(s => { const call = window.seedhost.call; window.seedhost.call = async (method, payload) => { if (method === 'createServer') { window.fixture.calls.push({ method, payload }); window.fixture.state.server = s; return {}; } return call(method, payload); }; }, server());
  await page.locator('#setup-create').click(); await settled(page);
  await page.waitForFunction(() => !document.querySelector('#setup-runtime').hidden);
  assert.equal(await page.locator('#setup-runtime-java').inputValue(), '/fixture/java', 'created Java selection is already in runtime help');
  assert.equal(await page.evaluate(() => window.fixture.calls.some(c => c.method === 'startServer')), false);
  await page.locator('#setup-back').click(); await settled(page);
  assert.equal(await page.locator('#setup-create').isDisabled(), true, 'revisiting cannot overwrite the created server');
});

test('existing profiles are not interrupted; simple Java help preserves argument files and native cancellation', async t => {
  const page = await renderer(t, appState(server()));
  assert.equal(await page.locator('#setup-dialog').isVisible(), false);
  await page.locator('#nav-setup').click();
  await page.locator('[data-setup-step="runtime"]').click(); await settled(page);
  assert.equal(await page.locator('#setup-profile-save').count(), 1, 'simple runtime help exists');
  await page.locator('#setup-runtime-pick').click(); await settled(page);
  assert.equal(await page.locator('#setup-runtime-java').inputValue(), '/fixture/java', 'cancel preserves selection');
  await page.locator('#setup-runtime-memory').selectOption('3072');
  await page.evaluate(() => { const call = window.seedhost.call; window.seedhost.call = async (method, payload) => { if (method === 'configureSimpleProfile') { window.fixture.calls.push({ method, payload }); window.fixture.state.server.profile = { executable: payload.javaExecutable, args: ['-Xmx3072M', '@args.txt', 'nogui'] }; return {}; } return call(method, payload); }; });
  await page.locator('#setup-profile-save').click(); await settled(page);
  assert.deepEqual(await page.evaluate(() => window.fixture.calls.find(c => c.method === 'configureSimpleProfile').payload), { javaExecutable: '/fixture/java', memoryMiB: 3072 });
  assert.match(await page.locator('#setup-runtime-feedback').textContent(), /Saved/);
  assert.deepEqual(await page.evaluate(() => window.fixture.state.server.profile.args), ['-Xmx3072M', '@args.txt', 'nogui']);
  await page.locator('#setup-runtime-memory').selectOption('4096');
  await page.evaluate(() => { const call = window.seedhost.call; window.seedhost.call = async (method, payload) => method === 'configureSimpleProfile' ? undefined : call(method, payload); });
  await page.locator('#setup-profile-save').click(); await settled(page);
  assert.match(await page.locator('#setup-error').textContent(), /could not be confirmed/);
});

test('optional friends are real existing controls in wizard, never saved as draft secrets, and skip persists', async t => {
  const page = await renderer(t);
  await page.locator('[data-setup-step="friends"]').click(); await settled(page);
  assert.equal(await page.locator('#setup-friends #join-friend-form').count(), 1, 'wizard exposes invitation controls');
  await page.locator('#friend-code').fill('SEEDHOST-private-secret');
  await page.locator('#setup-skip').click(); await settled(page);
  assert.equal(await page.locator('#setup-gateway').isVisible(), true);
  await page.locator('#setup-skip').click(); await settled(page);
  const saved = await page.evaluate(() => window.fixture.state.onboarding);
  assert.deepEqual(saved.skipped, ['friends', 'gateway']);
  assert.equal(saved.completed, false, 'no server is not completion');
  assert.doesNotMatch(JSON.stringify(saved), /private-secret|friend-code|invitation/);
  await page.locator('#setup-next').click(); await settled(page);
  assert.equal(await page.locator('#friend-code').inputValue(), '', 'close clears transient secrets');
  assert.equal(await page.locator('#peers-panel #join-friend-form').count(), 1, 'existing friends inspector stays usable');
});

test('gateway uses actual tunnel opt-in and explicit connectivity checks, not preference or viewed instructions', async t => {
  const page = await renderer(t);
  await page.locator('[data-setup-step="gateway"]').click(); await settled(page);
  assert.equal(await page.locator('#setup-gateway-check').count(), 1, 'real gateway check control exists');
  assert.match(await page.locator('#setup-gateway-status').textContent(), /Not checked/);
  assert.match(await page.locator('#setup-relay-command').textContent(), /--game-host 0\.0\.0\.0 --game-port 25565/);
  await page.evaluate(() => { const call = window.seedhost.call; window.seedhost.call = async (method, payload) => { if (method === 'saveGameGateway') { window.fixture.calls.push({ method, payload }); window.fixture.state.gateway = { ...payload, state: 'connecting', detail: 'Waiting for hosting' }; return {}; } if (method === 'checkGameGateway') return { enabled: true, host: 'relay.example', port: 25565, ready: false, detail: 'No confirmed host tunnel' }; return call(method, payload); }; });
  await page.locator('#setup-gateway-enabled').check();
  await page.locator('#setup-gateway-save').click(); await settled(page);
  assert.deepEqual(await page.evaluate(() => window.fixture.calls.find(c => c.method === 'saveGameGateway').payload), { enabled: true, localPort: 25565 });
  assert.equal(await page.evaluate(() => window.fixture.calls.some(c => c.method === 'saveSettings')), false);
  await page.locator('#setup-gateway-check').click(); await settled(page);
  assert.match(await page.locator('#setup-gateway-status').textContent(), /Not ready.*No confirmed host tunnel/);
  await page.evaluate(() => { const call = window.seedhost.call; window.seedhost.call = async (m, p) => m === 'checkGameGateway' ? { enabled: true, host: 'relay.example', port: 25565, ready: true, detail: 'Confirmed tunnel' } : call(m, p); });
  await page.locator('#setup-gateway-check').click(); await settled(page);
  assert.match(await page.locator('#setup-gateway-status').textContent(), /Verified.*relay.example:25565/);
  await page.evaluate(() => { const call = window.seedhost.call; window.seedhost.call = async (m, p) => { if (m === 'checkGameGateway') throw Error('Relay went offline'); return call(m, p); }; });
  await page.locator('#setup-gateway-check').click(); await settled(page);
  assert.match(await page.locator('#setup-gateway-status').textContent(), /Unreachable/);
  assert.doesNotMatch(await page.locator('#setup-gateway-status').textContent(), /Verified/);
});

test('real revision list uses native restore API, cancellation retains world and unsafe states disable restore but not Stop', async t => {
  const page = await renderer(t, appState(server()));
  assert.equal(await page.locator('#snapshot-history').count(), 1, 'history is visible in Operate');
  await page.waitForFunction(() => document.querySelectorAll('#snapshot-list li').length === 2);
  assert.match(await page.locator('#snapshot-history').textContent(), /local.*not.*remote/i);
  const restore = page.locator('#snapshot-list button[data-snapshot="s0"]');
  await restore.click(); await settled(page);
  assert.equal(await page.evaluate(() => window.fixture.state.server.snapshotId), 's1');
  assert.deepEqual(await page.evaluate(() => window.fixture.calls.find(c => c.method === 'restoreSnapshot').payload), { snapshotId: 's0' });
  await page.evaluate(() => { window.fixture.state.server.state = 'running'; window.fixture.state.server.ownership.state = 'hosting'; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => document.querySelector('#server-status').textContent === 'Hosting');
  assert.equal(await restore.isDisabled(), true);
  assert.equal(await page.locator('#stop-server').isDisabled(), false);
  await page.evaluate(() => { window.fixture.state.server.state = 'offline'; window.fixture.state.server.ownership.state = 'owned'; window.fixture.state.server.modInstallError = 'Install fence'; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => document.querySelector('#server-status').textContent === 'Stopped');
  assert.equal(await restore.isDisabled(), true);
});

test('modal keeps errors, close and navigation on-screen at both sizes; polling preserves keyboard focus', async t => {
  const page = await renderer(t);
  await page.locator('[data-setup-step="friends"]').click(); await settled(page);
  await page.locator('#friend-name').fill('Keyboard user');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await settled(page);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'friend-name', 'polling must not detach focused friends controls');
  for (const [width, height] of [[1000, 700], [1240, 860]]) {
    await page.setViewportSize({ width, height });
    for (const stage of ['server', 'runtime', 'friends', 'gateway', 'ready']) {
      await page.locator(`[data-setup-step="${stage}"]`).click(); await settled(page);
      const geometry = await page.evaluate(() => {
        const d = document.querySelector('#setup-dialog');
        return { overflow: d.scrollWidth > d.clientWidth + 1, buttons: ['setup-save-close', 'setup-next'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return { id, visible: r.top >= 0 && r.bottom <= innerHeight }; }) };
      });
      assert.equal(geometry.overflow, false, `${stage} no horizontal overflow at ${width}`);
      assert.equal(geometry.buttons.every(b => b.visible), true, `${stage} close/footer in viewport at ${width}`);
    }
  }
});

test('failed optional progress saves cannot trap the user away from lifecycle controls', async t => {
  const existing = server(); existing.state = 'running'; existing.ownership.state = 'hosting';
  const page = await renderer(t, appState(existing));
  await page.locator('#nav-setup').click();
  await page.evaluate(() => { window.fixture.failure = 'saveOnboarding'; });
  await page.locator('#setup-save-close').click(); await settled(page);
  assert.equal(await page.locator('#setup-error').isVisible(), true);
  assert.equal(await page.locator('#setup-close-unsaved').count(), 1, 'failed progress has emergency close');
  await page.locator('#setup-close-unsaved').click();
  assert.equal(await page.locator('#setup-dialog').isVisible(), false);
  assert.equal(await page.locator('#stop-server').isDisabled(), false);
});

test('ready completion requires a real launch command, not just an executable or visiting a stage', async t => {
  const existing = server(); existing.profile.args = [];
  const page = await renderer(t, appState(existing));
  await page.locator('#nav-setup').click(); await page.locator('[data-setup-step="ready"]').click(); await settled(page);
  await page.locator('#setup-next').click(); await settled(page);
  assert.equal(await page.evaluate(() => window.fixture.state.onboarding.completed), false, 'missing arguments are not a prepared server');
});

test('Operate displays actual player tunnel status independently of the saved address preference', async t => {
  const state = appState(server()); state.gateway = { enabled: true, localPort: 25565, state: 'ready', detail: 'Pinned confirmed holder' };
  state.settings = { persistentAddress: true, gatewayAddress: 'relay.example:25565' };
  const page = await renderer(t, state);
  assert.equal(await page.locator('#player-gateway-status').count(), 1, 'actual gateway status lives in Operate');
  assert.match(await page.locator('#player-gateway-status').textContent(), /Ready.*Pinned confirmed holder/);
  assert.equal(await page.locator('#player-address').textContent(), 'Displayed player address: relay.example:25565');
  await page.evaluate(() => { window.fixture.state.gateway.state = 'error'; window.fixture.state.gateway.detail = 'Relay unreachable'; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => document.querySelector('#player-gateway-status').textContent.includes('Relay unreachable'));
  assert.match(await page.locator('#player-gateway-status').textContent(), /Error/);
});
