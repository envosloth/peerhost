// Visible Electron regressions. Real isolated profiles + the app's own always-on host for hosting groups.
// Native consent and labelled delivery timing seams exercise real backend results.
// readback-rejected separately labels TEST-ONLY falsification; it is not persistence proof.
// Username cases use the actual TLS AccountService, never fabricated replies.
//
// UI contract exercised here (current build): Friends is ordinary social only (add by username, requests,
// friends list); hosting groups live exclusively in the selected server's Multi-host page; a friendship
// alone never grants hosting or world access.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { randomBytes } from 'node:crypto';
import { AccountService } from '../dist/src/core/accounts.js';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { dismissInitialSetup } from './desktop-test-setup.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const packaged = process.argv.find(value => value.startsWith('--packaged='))?.slice('--packaged='.length);
const executablePath = packaged || createRequire(import.meta.url)('electron');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.SEEDHOST_ACCOUNT_SERVICE;
env.SEEDHOST_TEST_LOOPBACK = '1';
const scratch = process.env.TMPDIR || path.join(process.env.LOCALAPPDATA, 'hermes/cache/scratch');
await mkdir(scratch, { recursive: true });
env.TMP = scratch; env.TEMP = scratch; env.TMPDIR = scratch;
const root = await mkdtemp(path.join(scratch, 'seed-friends-'));
const apps = [], pageErrors = [];
let workspaceSequence = 0;
const serverTabs = ['operate', 'console', 'players', 'backups', 'scheduler', 'peers', 'mods', 'tunnels', 'server-settings', 'server-files'];
async function assertLibraryNavigation(page) {
  for (const name of serverTabs) assert.equal(await page.locator('#' + name + '-tab').isVisible(), false, name + ' must stay hidden outside an opened server');
}
async function enterWorkspace(page, app, tab) {
  await click(page, '#home-tab'); await assertLibraryNavigation(page);
  if (!(await state(page)).server) {
    console.log('STEP import disposable stopped workspace fixture (NOT Minecraft); native folder/consent answers only.');
    const source = path.join(root, 'workspace-' + workspaceSequence++);
    await mkdir(source, { recursive: true }); await writeFile(path.join(source, 'eula.txt'), 'eula=true\n');
    await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, source);
    await click(page, '#import-server'); await idle(page);
    await wait(page, () => document.querySelector('#server-list .is-current button[data-action="open"]'));
  }
  // A remembered selection is not an opened workspace: use the real library action.
  await assertLibraryNavigation(page);
  await click(page, '#server-list .is-current button[data-action="open"]');
  for (const name of serverTabs) assert.equal(await page.locator('#' + name + '-tab').isVisible(), true);
  if (tab) await click(page, '#' + tab + '-tab');
}
let previousClipboard, accountService;
const wait = (page, expression, arg) => page.waitForFunction(expression, arg, { timeout: 12000 });
const state = page => page.evaluate(() => window.seedhost.call('getState'));
async function click(page, selector) {
  console.log('ACTION click ' + selector);
  await page.bringToFront(); await page.locator(selector).click({ timeout: 12000 });
}
async function fill(page, selector, value) {
  console.log('ACTION fill ' + selector + (selector.includes('code') ? ' [private invitation]' : ''));
  await page.bringToFront(); await page.locator(selector).fill(value);
}
async function shot(page, name) {
  await page.bringToFront(); const target = path.join(root, name + '.png');
  await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))));
  await page.screenshot({ path: target }); console.log('SCREENSHOT=' + target);
}
async function launch(name, online = false) {
  if (online) {
    if (!accountService) {
      accountService = new AccountService(await mkdtemp(path.join(root, 'account-directory-')), await createIdentity());
      await accountService.listen({ host: '127.0.0.1', port: 0 });
    }
    const profile = path.join(root, name); await mkdir(profile, { recursive: true });
    await writeFile(path.join(profile, 'account-service.json'), JSON.stringify({ ...accountService.endpoint, fingerprint: accountService.identity.fingerprint }));
    await writeFile(path.join(profile, 'onboarding.json'), JSON.stringify({ version: 1, step: 'server', dismissed: true, completed: false, skipped: [], draft: { name: 'My Minecraft server', loader: 'vanilla', gameVersion: '', memoryMiB: 2048 } }));
  }
  const args = [...(process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : []), ...(packaged ? [] : [path.join(project, 'dist/apps/desktop/main.js')]), '--profile-root=' + path.join(root, name)];
  const app = await electron.launch({ executablePath, args, env });
  apps.push(app); const page = await app.firstWindow();
  page.on('pageerror', error => pageErrors.push(String(error)));
  await wait(page, () => document.querySelector('#activity-message').textContent === 'Ready');
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await page.bringToFront();
  if (online) { await wait(page, () => document.querySelector('#account-dialog').open); await click(page, '#account-offline'); }
  await dismissInitialSetup(page);
  if (previousClipboard === undefined) previousClipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
  await assertLibraryNavigation(page);
  return { app, page };
}
async function idle(page) { await wait(page, () => document.querySelector('#activity-message').textContent === 'Ready'); }
async function signup(page, username) {
  await click(page, '#friends-tab');
  assert.equal((await state(page)).server, null, 'username account setup remains reachable without a server');
  await click(page, '#account-open');
  await fill(page, '#account-username', username);
  // Disposable loopback-only credentials, never a user account or logged secret.
  await fill(page, '#account-password', randomBytes(24).toString('hex'));
  await click(page, '#account-submit');
  await wait(page, () => !document.querySelector('#account-dialog').open && document.querySelector('#account-heading').textContent.startsWith('@'));
  assert.equal((await page.evaluate(() => window.seedhost.call('accountStatus'))).username, username);
}
async function accountPair(prefix) {
  const a = await launch(prefix + '-owner', true), b = await launch(prefix + '-recipient', true);
  await signup(a.page, prefix + '_owner'); await signup(b.page, prefix + '_recipient');
  return { owner: a, recipient: b };
}
async function sendFriendRequest(page, username) {
  await click(page, '#friends-tab');
  await fill(page, '#friend-add-username', username);
  await click(page, '#friend-add-submit');
  // The typed username clears only on verified delivery; that is the completion signal (feedback text can persist from an earlier send).
  await wait(page, () => document.querySelector('#friend-add-username').value === '');
  await wait(page, u => document.querySelector('#account-friends-feedback').textContent.includes('Friend request sent to @' + u), username);
}
async function becomeFriends(prefix, pair) {
  await sendFriendRequest(pair.owner.page, prefix + '_recipient');
  await click(pair.recipient.page, '#friends-tab'); await click(pair.recipient.page, '#friend-requests-refresh');
  await pair.recipient.page.locator('#friend-request-list [data-friend-accept]').waitFor({ state: 'visible' });
  await click(pair.recipient.page, '#friend-request-list [data-friend-accept]');
  await wait(pair.recipient.page, () => document.querySelector('#account-friends-feedback').textContent.includes('are now friends'));
}

// TEST-ONLY scheduling: native consent and the actual backend finish first. Only delivery
// of the original successful result is held; payloads/results are never fabricated or logged.
async function holdMutationResult(app, method) {
  console.log('TEST-ONLY IPC scheduling: hold real ' + method + ' result after backend completion.');
  await app.evaluate(({ ipcMain }, method) => {
    const original = ipcMain._invokeHandlers.get('seedhost:call'); globalThis.__heldMutation = null;
    ipcMain.removeHandler('seedhost:call');
    ipcMain.handle('seedhost:call', async (event, called, payload) => {
      const result = await original(event, called, payload);
      if (called !== method) return result;
      return new Promise(resolve => { globalThis.__heldMutation = { release: () => resolve(result) }; });
    });
  }, method);
}
async function waitForHeldMutation(app) {
  for (let n = 0; n < 200; n++) {
    if (await app.evaluate(() => Boolean(globalThis.__heldMutation))) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('TEST-ONLY scheduling did not receive the real mutation result');
}
async function releaseMutation(app, page) {
  console.log('TEST-ONLY IPC scheduling: release original completed method result.');
  await app.evaluate(() => globalThis.__heldMutation.release());
  await idle(page);
}
const assertNoInviteCode = (value, label) => assert.ok(!value.includes('SEEDHOST-'), label + ' must not surface an invitation code');

const cases = {
  async ['friend-send-pending']() {
    console.log('STEP pending friend request: the real TLS directory completes first; the pending form locks itself, keeps the typed username, and only a verified result clears it.');
    const pair = await accountPair('send');
    const { owner: { app, page }, recipient } = pair;
    await click(page, '#friends-tab'); await fill(page, '#friend-add-username', 'send_recipient');
    await holdMutationResult(app, 'accountFriendSend');
    await click(page, '#friend-add-submit'); await waitForHeldMutation(app);
    const requests = await recipient.page.evaluate(() => window.seedhost.call('accountFriendRequests'));
    assert.equal(requests.length, 1, 'real directory delivery preceded the held result'); assert.equal(requests[0].from, 'send_owner');
    assert.equal((await state(page)).relay, null, 'a friendship never creates a hosting group');
    assert.ok(!(await state(page)).busy, 'real backend completed; only result delivery is paused');
    assert.equal(await page.locator('#friend-add-submit').isDisabled(), true, 'pending send cannot be re-triggered');
    assert.equal(await page.locator('#friend-add-username').isDisabled(), true, 'pending send locks its input');
    assert.equal(await page.locator('#friend-requests-refresh').isDisabled(), true);
    assert.equal(await page.locator('#account-signout').isDisabled(), true, 'the card exit pauses while its action is pending');
    assert.equal(await page.locator('#friend-add-username').inputValue(), 'send_recipient', 'private typed username is kept while pending');
    assertNoInviteCode(await page.evaluate(() => JSON.stringify(localStorage)), 'local storage');
    assertNoInviteCode((await state(page)).logs.join('\n'), 'app logs');
    await shot(page, 'pending-friend-send');
    await releaseMutation(app, page);
    await wait(page, () => document.querySelector('#account-friends-feedback').textContent.includes('Friend request sent to @send_recipient'));
    assert.equal(await page.locator('#friend-add-username').inputValue(), '', 'only verified delivery clears the typed username');
    assert.equal((await state(page)).relay, null, 'still no hosting group after a verified friendship');
    await shot(page, 'pending-friend-send-resolved');
  },
  async ['friend-accept-pending']() {
    console.log('STEP pending friend accept: the real TLS directory records the friendship first; the pending row locks accept/decline and keeps its context, and nothing downloads or starts.');
    const pair = await accountPair('accept');
    await sendFriendRequest(pair.owner.page, 'accept_recipient');
    const { app, page } = pair.recipient;
    await click(page, '#friends-tab'); await click(page, '#friend-requests-refresh');
    await page.locator('#friend-request-list [data-friend-accept]').waitFor({ state: 'visible' });
    const before = (await page.locator('#friend-request-list').textContent()).trim();
    await holdMutationResult(app, 'accountFriendAccept');
    await click(page, '#friend-request-list [data-friend-accept]'); await waitForHeldMutation(app);
    const friends = await page.evaluate(() => window.seedhost.call('accountFriends'));
    assert.ok(friends.some(f => f.username === 'accept_owner'), 'actual friendship finished before the held result');
    assert.equal((await state(page)).relay, null, 'accepting a friendship never enrolls hosting');
    assert.equal(await page.locator('#friend-request-list [data-friend-accept]').isDisabled(), true, 'pending acceptance cannot be repeated');
    assert.equal(await page.locator('#friend-request-list [data-friend-decline]').isDisabled(), true, 'pending acceptance locks decline too');
    assert.equal((await page.locator('#friend-request-list').textContent()).trim(), before, 'pending acceptance keeps the pre-accept row');
    await shot(page, 'pending-friend-accept');
    await releaseMutation(app, page);
    await wait(page, () => document.querySelector('#account-friends-feedback').textContent.includes('are now friends'));
    assert.equal(await page.locator('#friend-request-list [data-friend-accept]').count(), 0, 'verified acceptance clears the request row');
    assert.match(await page.locator('#account-friends-list').textContent(), /@accept_owner/);
    await shot(page, 'pending-friend-accept-resolved');
  },
  async ['signin-pending']() {
    console.log('STEP pending sign-in: real TLS registration; while the account dialog works, its exits pause, Escape is refused, and the typed username stays.');
    const { app, page } = await launch('pending-signin', true);
    assert.equal((await state(page)).server, null, 'fresh-profile sign-in needs no server');
    await click(page, '#friends-tab'); await click(page, '#account-open');
    await wait(page, () => document.querySelector('#account-dialog').open);
    await fill(page, '#account-username', 'pending_signup');
    await fill(page, '#account-password', randomBytes(24).toString('hex'));
    await holdMutationResult(app, 'accountRegister');
    await click(page, '#account-submit'); await waitForHeldMutation(app);
    assert.equal(await page.locator('#account-dialog').evaluate(dialog => dialog.open), true);
    assert.equal(await page.locator('#account-submit').isDisabled(), true, 'pending registration cannot be resubmitted');
    assert.equal(await page.locator('#account-offline').isDisabled(), true, 'the dialog exit pauses while registering');
    assert.equal(await page.locator('#account-username').inputValue(), 'pending_signup', 'typed username survives the pending registration');
    console.log('ACTION Escape must not dismiss a working account dialog.');
    await page.bringToFront(); await page.keyboard.press('Escape');
    assert.equal(await page.locator('#account-dialog').evaluate(dialog => dialog.open), true, 'Escape must not exit a pending sign-in');
    await shot(page, 'pending-signin');
    await releaseMutation(app, page);
    await wait(page, () => !document.querySelector('#account-dialog').open && document.querySelector('#account-heading').textContent.startsWith('@'));
    assert.equal((await page.evaluate(() => window.seedhost.call('accountStatus'))).username, 'pending_signup');
    assert.equal(await page.locator('#friend-add-form').isVisible(), true, 'Friends tools appear after sign-in');
    await shot(page, 'pending-signin-resolved');
  },
  async ['readback-rejected']() {
    console.log('STEP friend readback: TEST-ONLY IPC falsification after real account changes.');
    for (const field of ['missing-friend', 'stale-request']) {
      const prefix = 'rb_' + (field === 'missing-friend' ? 'm' : 's');
      const firstApp = apps.length;
      const pair = await accountPair(prefix);
      await sendFriendRequest(pair.owner.page, prefix + '_recipient');
      const { app, page } = pair.recipient;
      await click(page, '#friends-tab'); await click(page, '#friend-requests-refresh');
      await page.locator('#friend-request-list [data-friend-accept]').waitFor({ state: 'visible' });
      await app.evaluate(({ ipcMain }, { field, prefix }) => {
        const original = ipcMain._invokeHandlers.get('seedhost:call'); let accepted = false, declined = null;
        ipcMain.removeHandler('seedhost:call'); ipcMain.handle('seedhost:call', async (event, method, payload) => {
          const result = await original(event, method, payload);
          if (method === 'accountFriendAccept' && result) accepted = true;
          if (method === 'accountFriendDecline' && result) declined = (payload && payload.id) || result.id;
          if (method === 'accountFriends' && accepted && field === 'missing-friend' && Array.isArray(result)) return result.filter(f => f.username !== prefix + '_owner');
          if (method === 'accountFriendRequests' && declined && field === 'stale-request' && Array.isArray(result)) return [...result, { id: declined, from: prefix + '_owner', expiresAt: Date.now() + 600000 }];
          return result;
        });
      }, { field, prefix });
      if (field === 'missing-friend') {
        await click(page, '#friend-request-list [data-friend-accept]');
        await wait(page, () => document.querySelector('#account-friends-feedback').textContent.length > 0);
        assert.match(await page.locator('#account-friends-feedback').textContent(), /did not confirm this friend/i);
        assert.doesNotMatch(await page.locator('#account-friends-feedback').textContent(), /are now friends/);
      } else {
        await click(page, '#friend-request-list [data-friend-decline]');
        await wait(page, () => document.querySelector('#account-friends-feedback').textContent.length > 0);
        assert.match(await page.locator('#account-friends-feedback').textContent(), /did not confirm this decline/i);
      }
      // Only the readback was falsified; the real directory remains authoritative and durable.
      const friends = await page.evaluate(() => window.seedhost.call('accountFriends'));
      assert.ok(Array.isArray(friends), 'the real directory still answers after falsified readback');
      await shot(page, 'friend-readback-rejected-' + field); console.log('PASS readback-rejected=' + field);
      // Retire each completed scenario: accumulated account pollers would stress the real
      // directory's per-address request budget and contaminate later independent cases.
      for (const completed of apps.splice(firstApp).reverse()) await completed.close();
    }
  },
  async ['friends-roundtrip']() {
    console.log('STEP ordinary friends roundtrip: send, decline, send, accept, remove — with no hosting authorization at any step.');
    const pair = await accountPair('roundtrip');
    const { owner, recipient: { page } } = pair;
    await click(page, '#friends-tab');
    // The retired hosting-invitation UI must not exist on Friends.
    assert.equal(await page.locator('#friend-code,#invite-code,#friends-intent-join,#friends-intent-invite').count(), 0);
    await sendFriendRequest(owner.page, 'roundtrip_recipient');
    await click(page, '#friend-requests-refresh');
    await page.locator('#friend-request-list [data-friend-accept]').waitFor({ state: 'visible' });
    assert.match(await page.locator('#friend-request-list').textContent(), /@roundtrip_owner/);
    await click(page, '#friend-request-list [data-friend-decline]');
    await wait(page, () => document.querySelector('#account-friends-feedback').textContent.includes('declined'));
    assert.deepEqual(await page.evaluate(() => window.seedhost.call('accountFriendRequests')), []);
    await sendFriendRequest(owner.page, 'roundtrip_recipient');
    await click(page, '#friend-requests-refresh');
    await page.locator('#friend-request-list [data-friend-accept]').waitFor({ state: 'visible' });
    await click(page, '#friend-request-list [data-friend-accept]');
    await wait(page, () => document.querySelector('#account-friends-feedback').textContent.includes('are now friends'));
    const after = await state(page); assert.equal(after.server, null); assert.equal(after.relay, null, 'ordinary friendship grants no hosting');
    await click(page, '#friend-requests-refresh');
    await wait(page, () => document.querySelector('#account-friends-list').textContent.includes('@roundtrip_owner'));
    await page.reload(); await idle(page); await click(page, '#friends-tab');
    await wait(page, () => document.querySelector('#account-friends-list').textContent.includes('@roundtrip_owner'));
    assert.match(await page.locator('#account-friends-list').textContent(), /@roundtrip_owner/);
    await click(owner.page, '#friends-tab');
    await wait(owner.page, () => document.querySelector('#account-friends-list').textContent.includes('@roundtrip_recipient'));
    await page.bringToFront(); await click(page, '#account-friends-list [data-friend-remove]');
    await wait(page, () => document.querySelector('#account-friends-feedback').textContent.includes('was removed'));
    assert.equal(await page.locator('#account-friends-list [data-friend-remove]').count(), 0);
    await shot(page, 'friends-roundtrip');
  },
  async ['guide-friends']() {
    console.log('STEP guide Friends step: static instructions, no retired invitation UI, and Open Friends lands on the Friends page.');
    const { page } = await launch('guide', true);
    await click(page, '#nav-setup'); await click(page, '[data-setup-step="friends"]'); await idle(page);
    const text = await page.locator('#setup-friends').textContent();
    assert.match(text, /Friends page/);
    assert.doesNotMatch(text, /Invitation code|invitation code|friend code/i);
    assert.equal(await page.locator('#setup-friends #friend-code, #setup-friends #friends-controls, #setup-friends #account-card').count(), 0, 'guide holds no retired card or duplicated controls');
    await click(page, '#setup-open-friends'); await idle(page);
    assert.equal(await page.locator('#setup-dialog').evaluate(dialog => dialog.open), false, 'Open Friends closes the guide');
    assert.equal(await page.locator('#friends-panel').isVisible(), true, 'Open Friends lands on the Friends page');
    await page.locator('#account-open').waitFor({ state: 'visible' });
    await shot(page, 'guide-open-friends');
  },
  async ['hosting-roundtrip']() {
    console.log('STEP hosting roundtrip: friendship first, group creation and invitation only in Multi-host, recipient enrollment keeps their own world intact.');
    const pair = await accountPair('hosting');
    await becomeFriends('hosting', pair);
    const { owner, recipient } = pair;
    // Both PCs have their own disposable world in their library.
    await enterWorkspace(owner.page, owner.app, 'peers');
    await enterWorkspace(recipient.page, recipient.app, 'peers');
    // Only Multi-host creates the group; it binds to the owner's selected world.
    assert.equal(await owner.page.locator('#peers-panel #hosting-card').count(), 1, 'hosting card lives in Multi-host');
    assert.equal(await owner.page.locator('#friends-panel #hosting-card').count(), 0);
    await owner.page.locator('#hosting-create-group').waitFor({ state: 'visible' });
    await click(owner.page, '#hosting-start-group');
    await wait(owner.page, () => document.querySelector('#hosting-friend-feedback').textContent.includes('group is ready'));
    await owner.page.locator('#hosting-friend-list [data-host-invite="hosting_recipient"]').waitFor({ state: 'visible' });
    const ownerState = await state(owner.page);
    assert.ok(ownerState.relay, 'the owner group is bound to their selected world');
    const ownerServer = ownerState.servers.find(entry => entry.id === ownerState.server.id);
    assert.equal(ownerServer.group.fingerprint, ownerState.relay.fingerprint, 'group binding is per server');
    // Invite an accepted friend to host THIS server.
    await click(owner.page, '#hosting-friend-list [data-host-invite="hosting_recipient"]');
    await wait(owner.page, () => document.querySelector('#hosting-friend-feedback').textContent.includes('Hosting invitation sent to @hosting_recipient'));
    // The recipient accepts in their own Multi-host page; their world must stay unchanged.
    const recipientBefore = await state(recipient.page);
    await click(recipient.page, '#hosting-requests-refresh');
    await recipient.page.locator('#hosting-request-list [data-account-accept]').waitFor({ state: 'visible' });
    const route = await recipient.page.locator('#hosting-request-list').textContent();
    assert.match(route, /unverified/i, 'hosting route is labelled unverified');
    await click(recipient.page, '#hosting-request-list [data-account-accept]');
    await wait(recipient.page, () => document.querySelector('#hosting-request-feedback').textContent.includes('Joined'));
    const recipientAfter = await state(recipient.page);
    assert.deepEqual(recipientAfter.servers, recipientBefore.servers, 'accepting an invitation must not change the recipient world');
    assert.equal(recipientAfter.server.id, recipientBefore.server.id, 'their selected world is unchanged');
    assert.equal(recipientAfter.server.state, 'offline', 'accepting never starts a server');
    assert.equal(recipientAfter.gateway.enabled, false, 'accepting never opens the gateway');
    // Membership is durably recorded either as a per-server binding or as a pending group.
    const recorded = recipientAfter.relay?.fingerprint === ownerState.relay.fingerprint
      || recipientAfter.pendingGroups?.some(entry => entry.fingerprint === ownerState.relay.fingerprint);
    assert.equal(recorded, true, 'enrollment is recorded for the exact group');
    await shot(recipient.page, 'hosting-recipient-joined');
    await owner.page.bringToFront(); await shot(owner.page, 'hosting-owner-multi-host');
  },
  async ['home-widgets']() {
    console.log('STEP home widgets: no status marquee/ticker/recap or join-help widget; server cards carry the Playit address row.');
    const { page, app } = await launch('homewidgets');
    await enterWorkspace(page, app);
    await click(page, '#home-tab');
    for (const selector of ['#marquee', '#ticker', '#ticker-track', '#join-help', '.ticker-item', '#marquee-server-led']) {
      assert.equal(await page.locator(selector).count(), 0, selector + ' must not exist');
    }
    assert.equal(await page.locator('#home-title').count(), 1, 'the Home header replaces the marquee');
    const addressRow = page.locator('#server-list .server-card-address');
    assert.equal(await addressRow.count(), 1, 'each server card carries one address row');
    assert.match(await addressRow.textContent(), /Playit address not set/, 'with no tunnel the card says so instead of inventing an address');
    assert.equal(await page.locator('#server-list [data-copy-address]').count(), 0, 'no copy button without a real address');
    await shot(page, 'home-widgets');
  },
};

const selected = process.argv.find(arg => arg.startsWith('--case='))?.slice(7);
try {
  const names = selected === undefined ? Object.keys(cases) : selected.split(',');
  for (const name of names) assert.ok(Object.hasOwn(cases, name) && typeof cases[name] === 'function', 'Unknown regression case: ' + name);
  for (const name of names) {
    await cases[name](); console.log('PASS case=' + name);
    for (const completed of apps.splice(0).reverse()) await completed.close();
    // Each case owns a fresh directory and its normal rate limits; a faster UI must not exhaust another case's auth budget.
    await accountService?.close(); accountService = undefined;
  }
  assert.deepEqual(pageErrors, [], 'renderer errors');
  console.log('PASS: visible Electron Friends regressions. Loopback only; no Minecraft/cross-network proof.');
} catch (error) {
  for (const [index, app] of apps.entries()) for (const page of app.windows()) if (!page.isClosed()) await shot(page, 'failure-' + index).catch(() => {});
  console.error('FAIL:', error); process.exitCode = 1;
} finally {
  const hold = Number(process.argv.find(arg => arg.startsWith('--hold='))?.slice(7) || process.env.SEED_FRIENDS_HOLD_SECONDS || 0);
  for (let remaining = hold; remaining > 0; remaining -= 15) { console.log('FINAL visible inspection: ' + remaining + ' seconds remaining'); await new Promise(resolve => setTimeout(resolve, Math.min(15, remaining) * 1000)); }
  if (apps[0] && previousClipboard !== undefined) await apps[0].evaluate(({ clipboard }, text) => clipboard.writeText(text), previousClipboard).catch(() => {});
  for (const app of apps.reverse()) await app.close().catch(() => {});
  await accountService?.close();
  console.log('ARTIFACT_DIR=' + root);
}
