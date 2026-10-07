import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {_electron as electron} from 'playwright';
// Headed Electron + REAL renderer, TEST-ONLY deterministic bridge; no backend/network/TLS/Minecraft claims.
// The accountFriend* methods are simulated here because the friendship IPC merges from the parent agent.
let app, page, root;
const errors = [];
before(async () => {
  const scratch = process.env.TMPDIR || (process.platform === 'win32' && path.join(process.env.LOCALAPPDATA, 'hermes/cache/scratch'));
  if (!scratch) throw new Error('Hermes scratch TMPDIR required');
  root = await mkdtemp(path.join(scratch, 'seed-social-ui-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.resolve('tools/dashboard-fixture-main.cjs'), '--profile-root=' + root], env });
  page = await app.firstWindow(); page.setDefaultTimeout(7000);
  // TEST-ONLY timer control. Only the manual-refresh regression stops polling; ordinary cases retain it.
  await page.addInitScript(() => {
    const intervals = [], startInterval = window.setInterval.bind(window);
    window.setInterval = (...args) => { const id = startInterval(...args); intervals.push(id); return id; };
    window.__stopTestPolling = () => intervals.forEach(id => clearInterval(id));
  });
  page.on('pageerror', e => errors.push(e.message));
});
after(async () => { if (app) { app.process().kill(); await app.close().catch(() => {}); } });
async function reset() {
  await page.bringToFront(); await page.evaluate(() => window.dashboardFixture.reset()); await page.reload();
  await page.waitForFunction(() => document.querySelector('#splash').hidden);
}
async function click(selector) { await page.bringToFront(); await page.locator(selector).click(); }
const fixture = () => page.evaluate(() => window.dashboardFixture.read());
const settle = () => page.waitForFunction(() => document.querySelector('#activity-message').textContent === 'Ready');
async function set(value) { await page.evaluate(v => window.dashboardFixture.set(v), value); await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await settle(); }
async function signIn(username = 'me') {
  await page.evaluate(u => { window.dashboardFixture.set({ accountStatus: { configured: true, signedIn: true, online: true, username: u, detail: 'Signed in' } }); window.dispatchEvent(new Event('seedhost-account-changed')); }, username);
  await page.waitForFunction(u => document.querySelector('#account-heading').textContent === '@' + u, username);
}
async function openAlpha() { await click('#server-list [data-action="open"][data-id="alpha"]'); await page.waitForFunction(() => document.querySelector('#server-name').textContent === 'Mossy Hollow'); await settle(); }

test('Home removes recap and join widgets completely while retaining library, heading and startup controls', async () => {
  await reset();
  assert.equal(await page.locator('.marquee, #ticker-track, #ticker, #join-help, .join-help').count(), 0);
  assert.equal(await page.locator('#home-title').textContent(), 'Home');
  assert.equal(await page.locator('#server-list > li').count(), 2);
  assert.equal(await page.locator('#add-server').count(), 1);
  assert.equal(await page.locator('#import-server').count(), 1);
  assert.equal(await page.locator('#create-server-empty').count(), 1);
  assert.equal(await page.locator('#start-server').count(), 1);
  assert.equal(await page.locator('#home-concurrency').count(), 1);
  assert.deepEqual(errors, []);
});

test('Friends tab is ordinary social only: add by username, requests, friends list; no hosting group controls', async () => {
  await reset();
  await signIn('me');
  await page.evaluate(() => window.dashboardFixture.set({ accountFriendRequests: [{ id: 'req-1', from: 'sam', expiresAt: Date.now() + 3600000 }], accountFriends: [{ username: 'alex', since: 1720000000000 }] }));
  await page.evaluate(() => window.dispatchEvent(new Event('seedhost-account-changed')));
  await page.waitForFunction(() => document.querySelector('#friend-request-list').textContent.includes('@sam'));
  await click('#friends-tab');
  assert.equal(await page.locator('#friends-panel').isVisible(), true);
  // Hosting/group controls must not exist in the Friends panel at all.
  assert.equal(await page.locator('#friends-panel #account-start-group, #friends-panel #account-create-group, #friends-panel #account-inbox, #friends-panel #username-friend-form, #friends-panel #hosting-start-group, #friends-panel #hosting-card').count(), 0);
  assert.match(await page.locator('#friends-panel #account-card').textContent(), /no hosting or world-file access/i);
  // Add by username uses the ordinary friendship IPC only.
  await page.locator('#friend-add-username').fill('Newbie');
  await click('#friend-add-submit');
  await page.waitForFunction(() => document.querySelector('#account-friends-feedback').textContent.includes('@newbie'));
  let calls = (await fixture()).calls;
  assert.deepEqual(calls.filter(c => c.method === 'accountFriendSend').map(c => c.payload), [{ username: 'newbie' }]);
  assert.equal(calls.some(c => c.method === 'accountSend'), false, 'ordinary add never sends a hosting invitation');
  assert.ok(calls.filter(c => c.method === 'accountFriends').length >= 1 && calls.some(c => c.method === 'accountFriendRequests'), 'lists are re-read for authoritative readback');
  assert.match(await page.locator('#account-friends-feedback').textContent(), /Friend request sent to @newbie/);
  // Wrong-shaped replies never render a success claim.
  await page.evaluate(() => window.dashboardFixture.set({ friendSendResult: { sent: 'yes', username: 'ghost' } }));
  await page.locator('#friend-add-username').fill('ghost');
  await click('#friend-add-submit');
  await page.waitForFunction(() => document.querySelector('#account-friends-feedback').textContent.includes('could not be confirmed'));
  assert.doesNotMatch(await page.locator('#account-friends-feedback').textContent(), /sent to @ghost/i);
  await page.evaluate(() => window.dashboardFixture.set({ friendSendResult: null }));
  // Accept a request: readback proves the friendship; no hosting acceptance happens.
  await click('#friend-request-list [data-friend-accept="req-1"]');
  await page.waitForFunction(() => document.querySelector('#account-friends-feedback').textContent.includes('are now friends'));
  assert.match(await page.locator('#account-friends-feedback').textContent(), /no hosting or world-file access/i);
  assert.equal(await page.locator('#account-friends-list').textContent().then(t => t.includes('@sam')), true);
  assert.equal(await page.locator('#friend-request-list').textContent().then(t => t.includes('@sam')), false);
  calls = (await fixture()).calls;
  assert.deepEqual(calls.filter(c => c.method === 'accountFriendAccept').map(c => c.payload), [{ id: 'req-1' }]);
  assert.equal(calls.some(c => c.method === 'accountAccept'), false, 'ordinary friends never grant world access');
  // Decline keeps the request out of the list.
  await page.evaluate(() => { window.dashboardFixture.set({ accountFriendRequests: [{ id: 'req-2', from: 'pat', expiresAt: Date.now() + 3600000 }] }); window.dispatchEvent(new Event('seedhost-account-changed')); });
  await page.waitForFunction(() => document.querySelector('#friend-request-list').textContent.includes('@pat'));
  await click('#friend-request-list [data-friend-decline="req-2"]');
  await page.waitForFunction(() => document.querySelector('#account-friends-feedback').textContent.includes('@pat declined'));
  assert.equal((await fixture()).calls.some(c => c.method === 'accountFriendDecline' && c.payload.id === 'req-2'), true);
  // Remove.
  await click('#account-friends-list [data-friend-remove="alex"]');
  await page.waitForFunction(() => document.querySelector('#account-friends-feedback').textContent.includes('@alex was removed'));
  assert.equal((await fixture()).calls.some(c => c.method === 'accountFriendRemove' && c.payload.username === 'alex'), true);
  assert.deepEqual(errors, []);
});

test('manual friend refresh immediately redraws incoming requests and accepted friends', async () => {
  await reset();
  await page.evaluate(() => window.__stopTestPolling());
  await signIn('me');
  await click('#friends-tab');
  await page.waitForFunction(() => document.querySelector('#friend-request-list').textContent.includes('No friend requests waiting.'));
  await page.evaluate(() => window.dashboardFixture.set({
    accountFriendRequests: [{ id: 'req-refresh', from: 'sam', expiresAt: Date.now() + 3600000 }],
    accountFriends: [{ username: 'alex', since: 1720000000000 }]
  }));
  await click('#friend-requests-refresh');
  // Background polling is stopped above: only the explicit Refresh action can draw these new rows.
  await page.waitForFunction(() => document.querySelector('#friend-request-list [data-friend-accept="req-refresh"]'), undefined, { timeout: 3000 });
  assert.match(await page.locator('#account-friends-list').textContent(), /@alex/);
  assert.equal(await page.locator('#friend-requests-count').textContent(), '1');
  assert.deepEqual(errors, []);
});

test('signed-out Friends tab hides add/list controls and keeps sign-in reachable', async () => {
  await reset();
  await click('#friends-tab');
  assert.equal(await page.locator('#friend-add-form').isVisible(), false);
  assert.match(await page.locator('#friend-request-list').textContent(), /Sign in/);
  assert.equal(await page.locator('#account-open').isVisible(), true);
  assert.deepEqual(errors, []);
});

test('Multi-host is the only hosting flow: create group, invite accepted friends to host, ordinary add stays social', async () => {
  await reset();
  await signIn('me');
  await openAlpha();
  await page.evaluate(() => { window.dashboardFixture.set({ accountFriends: [{ username: 'sam', since: 1720000000000 }] }); window.dispatchEvent(new Event('seedhost-account-changed')); });
  await click('#peers-tab');
  assert.equal(await page.locator('#peers-panel #hosting-card').count(), 1, 'hosting card lives in Multi-host');
  assert.equal(await page.locator('#peers-panel #account-card').count(), 0);
  assert.equal(await page.locator('#friends-panel #hosting-card').count(), 0);
  assert.match(await page.locator('#multi-host-scope').textContent(), /app-wide.*group/i);
  // Only Multi-host creates a hosting group.
  assert.equal(await page.locator('#hosting-friend-list [data-host-invite="sam"]').isDisabled(), true, 'invite waits for a group');
  await click('#hosting-start-group');
  await page.waitForFunction(() => document.querySelector('#hosting-friend-feedback').textContent.includes('group is ready'));
  assert.equal((await fixture()).calls.some(c => c.method === 'accountStartGroup'), true);
  await page.waitForFunction(() => !document.querySelector('#hosting-friend-list [data-host-invite="sam"]').disabled);
  // Invite that friend to host THIS server.
  await click('#hosting-friend-list [data-host-invite="sam"]');
  await page.waitForFunction(() => document.querySelector('#hosting-friend-feedback').textContent.includes('@sam'));
  assert.match(await page.locator('#hosting-friend-feedback').textContent(), /Mossy Hollow/);
  const calls = (await fixture()).calls;
  assert.deepEqual(calls.filter(c => c.method === 'accountSend').map(c => c.payload), [{ username: 'sam' }]);
  // Add-by-username here is still an ordinary social request.
  await page.locator('#hosting-add-username').fill('Pat');
  await click('#hosting-add-submit');
  await page.waitForFunction(() => document.querySelector('#hosting-friend-feedback').textContent.includes('@pat'));
  assert.equal((await fixture()).calls.some(c => c.method === 'accountFriendSend' && c.payload.username === 'pat'), true);
  assert.deepEqual(errors, []);
});

test('Multi-host hosting inbox explains the route and consent, keeps the endpoint guard, and never fakes a join', async () => {
  await reset();
  await signIn('me');
  await openAlpha();
  const request = { id: 'req-hosting', from: 'owner', group: 'Test group', controlEndpoint: { host: '192.168.1.50', port: 8443, privateRoute: true, reachability: 'unverified' } };
  await page.evaluate(r => { window.dashboardFixture.set({ accountRequests: [r] }); window.dispatchEvent(new Event('seedhost-account-changed')); }, request);
  await click('#peers-tab');
  await page.waitForFunction(() => document.querySelector('#hosting-request-list').textContent.includes('Test group'));
  const text = await page.locator('#hosting-request-list').textContent();
  assert.match(text, /192\.168\.1\.50:8443/);
  assert.match(text, /private.*same network|same network.*private/i);
  assert.match(text, /Minecraft.*address.*not|not.*Minecraft.*address/i);
  assert.match(text, /unverified/i);
  assert.match(text, /world-file access/i);
  // A truthy but invalid enrollment result is refused.
  await page.evaluate(() => window.dashboardFixture.set({ accountAcceptResult: { joined: 'true', group: 'Test group' } }));
  await click('#hosting-request-list [data-account-accept="req-hosting"]');
  await page.waitForFunction(() => document.querySelector('#hosting-request-feedback').textContent.includes('could not be confirmed'));
  assert.doesNotMatch(await page.locator('#hosting-request-feedback').textContent(), /^Joined/);
  // A matching endpoint is accepted and verified against the local read-back.
  await page.evaluate(() => {
    window.dashboardFixture.set({
      accountRequests: [{ id: 'req-hosting-2', from: 'owner', group: 'Test group', controlEndpoint: { host: '192.168.1.50', port: 8443, privateRoute: true, reachability: 'unverified' } }],
      accountAcceptResult: { joined: true, group: 'Test group' },
      accountAcceptState: { relay: { fingerprint: 'c'.repeat(64), name: 'Test group', parkOnStop: true }, peers: [{ fingerprint: 'c'.repeat(64), host: '192.168.1.50', port: 8443 }] }
    });
    window.dispatchEvent(new Event('seedhost-account-changed'));
  });
  await page.waitForFunction(() => document.querySelector('#hosting-request-list [data-account-accept="req-hosting-2"]'));
  await click('#hosting-request-list [data-account-accept="req-hosting-2"]');
  await page.waitForFunction(() => document.querySelector('#hosting-request-feedback').textContent.includes('Joined Test group'));
  assert.match(await page.locator('#hosting-request-feedback').textContent(), /existing world stays on this PC; nothing was downloaded or started/i);
  // Decline stays separate and removes the request.
  await page.evaluate(() => { window.dashboardFixture.set({ accountRequests: [{ id: 'req-hosting-3', from: 'other', group: 'Other group', controlEndpoint: { host: '192.168.1.51', port: 8443 } }] }); window.dispatchEvent(new Event('seedhost-account-changed')); });
  await page.waitForFunction(() => document.querySelector('#hosting-request-list [data-account-decline="req-hosting-3"]'));
  await click('#hosting-request-list [data-account-decline="req-hosting-3"]');
  await page.waitForFunction(() => document.querySelector('#hosting-request-feedback').textContent.includes('declined'));
  assert.equal((await fixture()).calls.some(c => c.method === 'accountDecline' && c.payload.id === 'req-hosting-3'), true);
  assert.deepEqual(errors, []);
});

test('server cards show only the playit address attributed to that card; missing stays "not set"; copy is verified and never selects', async () => {
  await reset();
  assert.match(await page.locator('#server-list [data-address-for="alpha"]').textContent(), /mossy-hollow\.playit\.gg:25565/);
  assert.match(await page.locator('#server-list [data-address-for="alpha"]').textContent(), /Reachability unverified/);
  assert.match(await page.locator('#server-list [data-address-for="bravo"]').textContent(), /Playit address not set/);
  assert.doesNotMatch(await page.locator('#server-list [data-address-for="bravo"]').textContent(), /localhost|127\.0\.0\.1|192\.168/);
  // A record for another world, a foreign source, or a blank address never renders on this card.
  const f = await fixture();
  f.state.servers[0].publicJoinAddress = { address: 'attacker.example:1', reachability: 'verified', source: 'playit', targetServerId: 'bravo' };
  await set({ state: f.state });
  assert.match(await page.locator('#server-list [data-address-for="alpha"]').textContent(), /Playit address not set/);
  assert.doesNotMatch(await page.locator('#server-list [data-address-for="alpha"]').textContent(), /attacker/);
  f.state.servers[0].publicJoinAddress = { address: 'elsewhere.example:1', reachability: 'verified', source: 'other', targetServerId: 'alpha' };
  await set({ state: f.state });
  assert.match(await page.locator('#server-list [data-address-for="alpha"]').textContent(), /Playit address not set/);
  f.state.servers[0].publicJoinAddress = { address: '   ', reachability: 'verified', source: 'playit', targetServerId: 'alpha' };
  await set({ state: f.state });
  assert.match(await page.locator('#server-list [data-address-for="alpha"]').textContent(), /Playit address not set/);
  // Restore valid addresses and copy: completion is verified against the OS clipboard.
  f.state.servers[0].publicJoinAddress = { address: 'mossy-hollow.playit.gg:25565', reachability: 'verified', source: 'playit', targetServerId: 'alpha' };
  f.state.servers[1].publicJoinAddress = { address: 'sky-islands.playit.gg:25566', reachability: 'unverified', source: 'playit', targetServerId: 'bravo' };
  await set({ state: f.state });
  assert.match(await page.locator('#server-list [data-address-for="alpha"]').textContent(), /Reachability verified/);
  await click('#server-list [data-copy-address="alpha"]');
  await page.waitForFunction(() => document.querySelector('[data-address-for="alpha"] .server-address-status').textContent.includes('Copied'));
  assert.match(await page.locator('[data-address-for="alpha"] .server-address-status').textContent(), /Copied and verified/);
  assert.equal(await page.evaluate(() => window.dashboardFixture.clipboardText()), 'mossy-hollow.playit.gg:25565');
  const afterCopy = await fixture();
  assert.equal(afterCopy.calls.some(c => c.method === 'selectServer'), false, 'copy never selects or switches a server');
  assert.equal(afterCopy.state.servers.find(s => s.active).id, 'alpha');
  // Copying bravo's address must not change the active server either.
  await click('#server-list [data-copy-address="bravo"]');
  await page.waitForFunction(() => document.querySelector('[data-address-for="bravo"] .server-address-status').textContent.includes('Copied'));
  assert.equal(await page.evaluate(() => window.dashboardFixture.clipboardText()), 'sky-islands.playit.gg:25566');
  const final = await fixture();
  assert.equal(final.calls.some(c => c.method === 'selectServer'), false);
  assert.equal(final.state.servers.find(s => s.active).id, 'alpha');
  assert.deepEqual(errors, []);
});

test('the guide never moves the account card and page changes close it; ids stay unique', async () => {
  await reset();
  const f = await fixture(); f.state.onboarding = { ...f.state.onboarding, step: 'friends', dismissed: false };
  await set({ state: f.state });
  await click('#nav-setup');
  await page.waitForFunction(() => document.querySelector('#setup-dialog').open);
  await page.waitForFunction(() => !document.querySelector('#setup-friends').hidden);
  assert.equal(await page.locator('#setup-friends #account-card, #setup-friends #friends-controls').count(), 0, 'the guide never adopts the account card or group controls');
  assert.equal(await page.locator('#friends-panel #account-card').count(), 1);
  assert.equal(await page.locator('#peers-panel #friends-controls').count(), 1, 'group controls live in the hosting workspace');
  assert.equal(await page.locator('#friends-panel #friends-controls').count(), 0);
  assert.equal(await page.locator('#setup-open-friends').isVisible(), true);
  await click('#setup-open-friends');
  await page.waitForFunction(() => !document.querySelector('#setup-dialog').open);
  assert.equal(await page.locator('#friends-panel').isVisible(), true, 'Open Friends lands on the Friends page');
  assert.equal(await page.locator('#friends-panel #account-card').count(), 1);
  // A page change while the guide is open closes it rather than leaving it over another workspace.
  await click('#nav-setup');
  await page.waitForFunction(() => document.querySelector('#setup-dialog').open);
  await page.evaluate(() => window.seedDashboard.selectPage('settings'));
  await page.waitForFunction(() => !document.querySelector('#setup-dialog').open);
  // No duplicate ids anywhere in the document.
  const duplicates = await page.evaluate(() => { const seen = new Map(); for (const node of document.querySelectorAll('[id]')) seen.set(node.id, (seen.get(node.id) || 0) + 1); return [...seen].filter(([, count]) => count > 1).map(([id]) => id); });
  assert.deepEqual(duplicates, []);
  assert.deepEqual(errors, []);
});

test('a stale friend acceptance never renders after the account context changed', async () => {
  await reset();
  await signIn('me');
  await click('#friends-tab');
  await page.evaluate(() => { window.dashboardFixture.set({ accountFriendRequests: [{ id: 'req-slow', from: 'sam', expiresAt: Date.now() + 3600000 }], accountFriends: [] }); window.dispatchEvent(new Event('seedhost-account-changed')); });
  await page.waitForFunction(() => document.querySelector('#friend-request-list [data-friend-accept="req-slow"]'));
  await page.evaluate(() => window.dashboardFixture.set({ holdFriendOp: 'accountFriendAccept' }));
  await click('#friend-request-list [data-friend-accept="req-slow"]');
  await page.waitForFunction(() => window.dashboardFixture.read().calls.some(c => c.method === 'accountFriendAccept'));
  // Identity changes while the reply is pending.
  await page.evaluate(() => { window.dashboardFixture.set({ accountStatus: { configured: true, signedIn: false, online: false, username: null, detail: 'Signed out' } }); window.dispatchEvent(new Event('seedhost-account-changed')); });
  await page.waitForFunction(() => document.querySelector('#account-heading').textContent === 'Your Seed Hosting account');
  await page.evaluate(() => window.dashboardFixture.release());
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));
  assert.doesNotMatch(await page.locator('#account-friends-feedback').textContent(), /are now friends/i, 'a stale acceptance never claims success');
  assert.equal(await page.locator('#account-friends-list').textContent().then(t => t.includes('@sam')), false);
  assert.deepEqual(errors, []);
});
