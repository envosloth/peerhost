import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { openSelectedServer, reveal } from '../tools/desktop-test-setup.mjs';

// Exercise the real renderer/DOM with a test-only preload bridge. No app profiles,
// Minecraft process, or external catalogue requests are created by these tests.
let browser;
before(async () => {
  const executablePath = existsSync(chromium.executablePath()) ? chromium.executablePath() : '/usr/bin/chromium';
  browser = await chromium.launch({ executablePath, headless: false });
});
after(async () => { await browser?.close(); });
const hit = { projectId: 'project1', title: 'Dual-side mod', author: 'Test', slug: 'dual-mod', placement: ['server', 'client'], description: 'Fixture', downloads: 1 };
const mod = { name: 'dual.jar', size: 10, source: { projectId: hit.projectId, versionId: 'version1' } };
function appState(sides = []) {
  return {
    version: 'test', deviceId: 'a'.repeat(64), peers: [], logs: [], settings: {}, relay: null,
    servers: [{ id: 'repair-fixture', name: 'Renderer fixture', active: true, state: 'offline', configured: true }],
    server: { id: 'repair-fixture', name: 'Renderer fixture', serverDir: '/fixture/server', storeDir: '/fixture/store', state: 'offline', snapshotId: 'b'.repeat(64),
      ownership: { state: 'owned', owner: 'a'.repeat(64) }, profile: { executable: 'java', args: [] },
      mods: { server: sides.includes('server') ? [mod] : [], client: sides.includes('client') ? [mod] : [] },
      modsError: null, modTarget: { loader: 'fabric', gameVersion: '1.21.1', detected: false } },
  };
}
async function renderer(t, state = appState(), friends = { members: [], custody: 'unknown', holder: null }) {
  const page = await browser.newPage();
  await page.bringToFront();
  console.log('VISIBLE renderer contract (TEST-ONLY bridge): ' + t.name);
  t.after(async () => {
    if (!page.isClosed() && process.env.TMPDIR) await page.screenshot({ path: process.env.TMPDIR + '/seedhost-repair-' + t.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 90) + '.png' });
    await page.close();
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'renderer must not throw'));
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(({ state, hit, friends }) => {
    window.fixture = { state, friends, calls: [] };
    window.seedhost = { call: async (method, payload) => {
      window.fixture.calls.push({ method, payload });
      if (method === 'getState') return window.fixture.state;
      if (method === 'searchMods') return { hits: [hit], total: 1 };
      if (method === 'listFriends') return window.fixture.friends;
      // An undefined install result models cancelled native consent. The renderer
      // must read back state rather than treating the invocation as an install.
      return undefined;
    } };
  }, { state, hit, friends });
  await page.goto('file://' + fileURLToPath(new URL('../apps/desktop/index.html', import.meta.url)));
  await page.waitForFunction(() => document.querySelector('#activity-message').textContent.startsWith('Ready'));
  await openSelectedServer(page);
  return page;
}
async function catalogue(page) {
  await page.locator('#mods-tab').click();
  await page.locator('#mods-details').evaluate(node => { node.open = true; });
  await page.waitForFunction(() => document.querySelector('#mod-results button[data-install]') && document.querySelector('#mod-results').getAttribute('aria-busy') === 'false');
  return page.locator('#mod-results button[data-install]');
}
async function update(page, state) {
  await page.evaluate(state => {
    window.fixture.state = state;
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
  await page.waitForFunction(() => document.querySelector('#server-status').textContent === ({ offline: 'Stopped', running: 'Hosting' }[window.fixture.state.server.state]));
}

test('any existing project side offers enabled Repair / check through installMod, including cancelled consent', async t => {
  for (const sides of [['server'], ['client'], ['server', 'client']]) {
    const page = await renderer(t, appState(sides));
    const button = await catalogue(page);
    assert.equal(await button.textContent(), 'Repair / check');
    assert.equal(await button.isDisabled(), false);
    assert.equal(await button.getAttribute('aria-label'), 'Repair / check Dual-side mod');
    await button.click();
    await page.waitForFunction(() => window.fixture.calls.some(call => call.method === 'installMod') && document.querySelector('#activity-message').textContent.startsWith('Ready'));
    assert.deepEqual(await page.evaluate(() => window.fixture.calls.filter(call => call.method === 'installMod')), [{ method: 'installMod', payload: { projectId: hit.projectId } }]);
    assert.deepEqual(await page.evaluate(() => window.fixture.state.server.mods), appState(sides).server.mods, 'cancelled consent must not fabricate missing-side provenance');
    assert.equal(await button.isDisabled(), false, 'repair remains retryable after read-back');
    await page.close();
  }
});

test('mod metadata failure is scoped, blocks stale mod actions and browsing, but leaves Stop functional', async t => {
  const page = await renderer(t, appState(['server', 'client']));
  await catalogue(page);
  const failed = appState(['server', 'client']);
  failed.server.modsError = 'Invalid mod index: test fixture';
  await update(page, failed);
  await page.waitForFunction(() => document.querySelector('#mods-summary').textContent.includes('unavailable'), undefined, { timeout: 2000 });
  assert.match(await page.locator('#mod-target-feedback').textContent(), /Invalid mod index: test fixture/);
  for (const id of ['add-server-mods', 'add-client-mods', 'export-client-pack', 'mod-loader', 'mod-game-version', 'save-mod-target', 'mod-query', 'search-mods', 'mod-next', 'mod-previous']) {
    assert.equal(await page.locator('#' + id).isDisabled(), true, id);
  }
  assert.equal(await page.locator('#mod-results button:enabled').count(), 0, 'stale catalogue actions cannot stay enabled');
  assert.equal(await page.locator('.mod-list button:enabled').count(), 0, 'Remove is blocked too');
  assert.equal(await page.locator('#start-server').isDisabled(), false, 'mod read failure is not a global bridge failure');
  failed.server.state = 'running';
  failed.server.ownership.state = 'hosting';
  await update(page, failed);
  assert.equal(await page.locator('#stop-server').isDisabled(), false);
  await reveal(page, '#stop-server');
  await page.locator('#stop-server').click();
  await page.waitForFunction(() => window.fixture.calls.some(call => call.method === 'stopServer'));
  assert.equal(await page.locator('#error-banner').isVisible(), false);
  const repaired = appState(['server', 'client']);
  await update(page, repaired);
  const button = await catalogue(page);
  assert.equal(await button.isDisabled(), false, 'fresh state restores the scoped controls');
  assert.equal(await page.locator('#export-client-pack').isDisabled(), false);
});

test('friends display explicit custody instead of claiming every null holder means no member holds it', async t => {
  const state = appState();
  state.relay = { fingerprint: 'c'.repeat(64), name: 'Fixture relay', parkOnStop: true };
  const members = [{ name: 'Sam', fingerprint: state.deviceId, you: true }];
  for (const [custody, holder, label] of [
    ['unknown', null, 'Hosting: unknown · the always-on PC hasn’t stored this world yet.'],
    ['parked', null, 'Hosting: nobody · the world is waiting on the always-on PC.'],
    ['pending', null, 'Hosting: a hand-over is in progress.'],
    ['held', 'Sam <qa>', 'World held by Sam <qa> · hosting not observed'],
  ]) {
    const page = await renderer(t, state, { members, custody, holder });
    await page.waitForFunction(() => document.querySelector('#friend-list li') && !document.querySelector('#refresh-friends').disabled);
    assert.equal(await page.locator('#friend-holder').textContent(), label);
    assert.equal(await page.locator('#friend-holder qa').count(), 0, 'names are literal text');
    await page.close();
  }
});

test('renderer rejects contradictory holder results rather than displaying an unverified holder', async t => {
  const state = appState();
  state.relay = { fingerprint: 'c'.repeat(64), name: 'Fixture relay' };
  for (const result of [{ custody: 'held', holder: null }, { custody: 'unknown', holder: 'Local fallback' }, { holder: 'Legacy fallback' }]) {
    const page = await renderer(t, state, { members: [], ...result });
    await page.waitForFunction(() => window.fixture.calls.some(call => call.method === 'listFriends') && !document.querySelector('#refresh-friends').disabled);
    assert.match(await page.locator('#friend-holder').textContent(), /Members unavailable: Group information could not be verified/);
    assert.doesNotMatch(await page.locator('#friend-holder').textContent(), /fallback|no member holds/);
    await page.close();
  }
});

test('repair retains stopped-owner, busy, and unsaved-target guards', async t => {
  const page = await renderer(t, appState(['server']));
  const button = await catalogue(page);
  for (const change of [
    state => { state.server.state = 'running'; },
    state => { state.server.ownership.owner = 'd'.repeat(64); },
    state => { state.busy = 'createSnapshot'; },
  ]) {
    const blocked = appState(['server']); change(blocked);
    await update(page, blocked);
    await page.waitForFunction(() => document.querySelector('#mod-results button[data-install]').disabled);
    assert.equal(await button.isDisabled(), true);
    await update(page, appState(['server']));
    await page.waitForFunction(() => !document.querySelector('#mod-results button[data-install]').disabled);
  }
  await page.locator('#mod-game-version').fill('1.21.2');
  assert.equal(await button.isDisabled(), true);
  assert.match(await page.locator('#mod-target-feedback').textContent(), /Unsaved compatibility/);
});

test('initial metadata failure prevents catalogue requests; failure also fences a delayed catalogue result', async t => {
  const failed = appState();
  failed.server.modsError = 'Unreadable mod directory';
  failed.server.modTarget = { loader: null, gameVersion: null, detected: true };
  const unavailable = await renderer(t, failed);
  await unavailable.locator('#mods-details').evaluate(node => { node.open = true; });
  assert.match(await unavailable.locator('#mod-target-feedback').textContent(), /Unreadable mod directory/);
  assert.equal(await unavailable.locator('#search-mods').isDisabled(), true);
  assert.equal(await unavailable.evaluate(() => window.fixture.calls.filter(call => call.method === 'searchMods').length), 0);

  const page = await renderer(t);
  await page.evaluate(() => {
    const call = window.seedhost.call;
    window.seedhost.call = (method, payload) => {
      if (method !== 'searchMods') return call(method, payload);
      return new Promise(resolve => { window.fixture.completeSearch = resolve; });
    };
  });
  await page.locator('#mods-details').evaluate(node => { node.open = true; });
  await page.waitForFunction(() => typeof window.fixture.completeSearch === 'function');
  const broken = appState(); broken.server.modsError = 'Index failed during catalogue read';
  await update(page, broken);
  await page.waitForFunction(() => document.querySelector('#mods-summary').textContent === 'Mods unavailable');
  await page.evaluate(async hit => {
    window.fixture.completeSearch({ hits: [hit], total: 1 });
    await Promise.resolve(); await Promise.resolve();
  }, hit);
  assert.equal(await page.locator('#mod-results button').count(), 0, 'late response cannot revive stale actions');
  assert.equal(await page.locator('#search-mods').isDisabled(), true);
  assert.match(await page.locator('#mod-search-status').textContent(), /blocked/);
});
