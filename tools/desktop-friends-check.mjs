// Visible Electron regressions. Real isolated profiles + real loopback RelayNode.
// Native consent and labelled delivery timing seams exercise real backend results.
// readback-rejected separately labels TEST-ONLY falsification; it is not persistence proof.
// Username cases use the actual TLS AccountService and RelayNode, never fabricated replies.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { randomBytes } from 'node:crypto';
import { AccountService } from '../dist/src/core/accounts.js';
import { RelayNode } from '../dist/src/core/relay.js';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { dismissInitialSetup, openSelectedServer } from './desktop-test-setup.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const packaged = process.argv.find(value => value.startsWith('--packaged='))?.slice('--packaged='.length);
const executablePath = packaged || createRequire(import.meta.url)('electron');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.SEEDHOST_ACCOUNT_SERVICE;
env.SEEDHOST_TEST_LOOPBACK = '1';
const scratch = process.env.TMPDIR || path.join(process.env.LOCALAPPDATA, 'hermes/cache/scratch');
await mkdir(scratch, { recursive: true });
env.TMP = scratch; env.TEMP = scratch; env.TMPDIR = scratch;
const root = await mkdtemp(path.join(scratch, 'seed-friends-'));
const apps = [], relays = [], pageErrors = [];
let workspaceSequence = 0, relaySequence = 0;
const workspaceBaselines = new WeakMap();
const serverTabs = ['operate', 'console', 'players', 'backups', 'scheduler', 'peers', 'mods', 'tunnels', 'server-settings', 'server-files'];
async function assertLibraryNavigation(page) {
  for (const name of serverTabs) assert.equal(await page.locator('#' + name + '-tab').isVisible(), false, name + ' must stay hidden outside an opened server');
}
async function enterPeers(page, app) {
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
  await click(page, '#home-tab'); await click(page, '#friends-tab');
  if (!workspaceBaselines.has(page)) workspaceBaselines.set(page, await state(page));
}
function assertWorkspaceUnchanged(page, saved) {
  const before = workspaceBaselines.get(page);
  assert.deepEqual(saved.server, before.server, 'Friends must not download, start, or replace the disposable server');
  assert.deepEqual(saved.servers, before.servers, 'Friends must not add or alter managed servers');
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
async function launch(name, online = false, workspace = !online) {
  if (online) {
    if (!accountService) {
      accountService = new AccountService(path.join(root, 'account-directory'), await createIdentity());
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
  if (workspace) await enterPeers(page, app);
  return { app, page };
}
async function relay(name = 'Garden <friends>') {
  const node = new RelayNode(path.join(root, 'relay-' + relaySequence++), await createIdentity(), { name, log: () => {} });
  await node.open(); await node.listen(); relays.push(node); return node;
}
async function idle(page) { await wait(page, () => document.querySelector('#activity-message').textContent === 'Ready'); }
async function signup(page, username) {
  await openFriendsGuide(page);
  assert.equal((await state(page)).server, null, 'username setup remains reachable without a server');
  await click(page, '#account-open');
  await fill(page, '#account-username', username);
  // Disposable loopback-only credentials, never a user account or logged secret.
  await fill(page, '#account-password', randomBytes(24).toString('hex'));
  await click(page, '#account-submit');
  await wait(page, () => !document.querySelector('#account-dialog').open && document.querySelector('#account-heading').textContent.startsWith('@'));
  assert.equal((await page.evaluate(() => window.seedhost.call('accountStatus'))).username, username);
  await click(page, '#setup-save-close'); await wait(page, () => !document.querySelector('#setup-dialog').open);
}
async function openFriendsGuide(page) {
  await click(page, '#nav-setup'); await click(page, '[data-setup-step="friends"]'); await idle(page);
  assert.equal(await page.locator('#setup-friends-slot #account-card').count(), 1);
  assert.equal(await page.locator('#setup-friends-slot #friends-controls').count(), 0);
  assert.equal(await page.locator('#friends-panel #friends-controls').count(), 1);
}
async function usernamePair(prefix) {
  const owner = await launch(prefix + '-owner', true), recipient = await launch(prefix + '-recipient', true);
  await signup(owner.page, prefix + '_owner'); await signup(recipient.page, prefix + '_recipient');
  const node = await relay('Username Garden');
  await node.setMemberInvites(true);
  const ownerDevice = (await state(owner.page)).deviceId;
  await node.trust(prefix + '_owner', ownerDevice); await node.setOwner(ownerDevice);
  await owner.page.evaluate(async peer => { await window.seedhost.call('addPeer', peer); await window.seedhost.call('saveRelay', { fingerprint: peer.fingerprint, parkOnStop: true }); }, { fingerprint: node.identity.fingerprint, name: node.name, ...node.endpoint });
  await owner.page.reload(); await idle(owner.page); await enterPeers(owner.page, owner.app);
  await wait(owner.page, () => !document.querySelector('#username-friend-form').hidden);
  return { owner, recipient, node };
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
// The redesigned guide hosts the username account card on the Friends stage. Pending account
// work is scoped to the account card / sign-in dialog: cards lock their own controls (and the
// dialog refuses Escape) until the verified result arrives; the guide footer is not a barrier
// for account work. Legacy code enrollment is absent from every workspace.
async function assertGuideUsernameStage(page) {
  assert.equal(await page.locator('#setup-dialog').evaluate(dialog => dialog.open), true, 'guide stays open');
  assert.equal(await page.locator('#setup-friends-slot #account-card').count(), 1, 'guide hosts the username account card');
  assert.equal(await page.locator('#setup-friends-slot #friends-controls').count(), 0, 'member controls stay in their workspace');
  assert.equal(await page.locator('#friends-panel #friends-controls').count(), 1, 'member controls stay on the Friends page');
}
async function releaseMutation(app, page) {
  console.log('TEST-ONLY IPC scheduling: release original completed method result.');
  await app.evaluate(() => globalThis.__heldMutation.release());
  await idle(page);
}
const assertNoInviteCode = (value, label) => assert.ok(!value.includes('SEEDHOST-'), label + ' must not surface an invitation code');

const cases = {
  async ['pending-send']() {
    console.log('STEP pending username send: the real TLS directory and relay complete first; the pending card locks itself, keeps the private typed username, and only a verified result clears it.');
    const { owner: { app, page }, recipient, node } = await usernamePair('send');
    await openFriendsGuide(page); await fill(page, '#friend-username', 'send_recipient');
    await holdMutationResult(app, 'accountSend');
    await click(page, '#username-invite'); await waitForHeldMutation(app);
    const requests = await recipient.page.evaluate(() => window.seedhost.call('accountRequests'));
    assert.equal(requests.length, 1, 'real directory delivery preceded the held result'); assert.equal(requests[0].from, 'send_owner');
    assert.equal(node.trusted.length, 1, 'sending by username never enrolls the recipient');
    assert.ok(!(await state(page)).busy, 'real backend completed; only result delivery is paused');
    await assertGuideUsernameStage(page);
    assert.equal(await page.locator('#username-invite').isDisabled(), true, 'pending send cannot be re-triggered');
    assert.equal(await page.locator('#friend-username').isDisabled(), true, 'pending send locks its input');
    assert.equal(await page.locator('#account-refresh').isDisabled(), true);
    assert.equal(await page.locator('#account-signout').isDisabled(), true, 'the card exit pauses while its action is pending');
    assert.equal(await page.locator('#friend-username').inputValue(), 'send_recipient', 'private typed username is kept while pending');
    assertNoInviteCode(await page.evaluate(() => JSON.stringify(localStorage)), 'local storage');
    assertNoInviteCode((await state(page)).logs.join('\n'), 'app logs');
    await shot(page, 'pending-username-send');
    await releaseMutation(app, page);
    await wait(page, () => document.querySelector('#account-friend-feedback').textContent.includes('Invitation sent to @send_recipient'));
    assert.equal(await page.locator('#friend-username').inputValue(), '', 'only verified delivery clears the typed username');
    await assertGuideUsernameStage(page);
    await shot(page, 'pending-send-resolved');
    await click(page, '#setup-save-close'); await wait(page, () => !document.querySelector('#setup-dialog').open);
    assert.equal(await page.locator('#friends-panel #account-card').count(), 1, 'closing restores the card to the Friends page');
    assert.match(await page.locator('#friends-panel #account-friend-feedback').textContent(), /Invitation sent to @send_recipient/);
  },
  async ['pending-accept']() {
    console.log('STEP pending username accept: real TLS inbox and enrollment complete first; the pending row locks accept/decline and keeps its context, and nothing downloads or starts.');
    const { owner, recipient: { app, page }, node } = await usernamePair('accept');
    await fill(owner.page, '#friend-username', 'accept_recipient'); await click(owner.page, '#username-invite');
    await wait(owner.page, () => document.querySelector('#account-friend-feedback').textContent.includes('Invitation sent'));
    await openFriendsGuide(page); await click(page, '#account-refresh');
    await page.locator('#account-inbox [data-account-accept]').waitFor({ state: 'visible' });
    const before = (await page.locator('#account-inbox').textContent()).trim();
    await holdMutationResult(app, 'accountAccept');
    await click(page, '#account-inbox [data-account-accept]'); await waitForHeldMutation(app);
    assert.equal(node.trusted.length, 2, 'actual enrollment finished before the held result');
    const saved = await state(page), peer = saved.peers.find(entry => entry.fingerprint === node.identity.fingerprint);
    assert.equal(saved.relay.fingerprint, node.identity.fingerprint); assert.equal(peer.host, node.endpoint.host); assert.equal(peer.port, node.endpoint.port);
    assert.equal(saved.server, null, 'accepting an invitation never downloads or starts a world'); assert.equal(saved.gateway.enabled, false);
    assert.deepEqual(await page.evaluate(() => window.seedhost.call('accountRequests')), [], 'the real acceptance dismissed the directory request');
    await assertGuideUsernameStage(page);
    assert.equal(await page.locator('#account-inbox [data-account-accept]').isDisabled(), true, 'pending acceptance cannot be repeated');
    assert.equal(await page.locator('#account-inbox [data-account-decline]').isDisabled(), true, 'pending acceptance locks decline too');
    assert.equal((await page.locator('#account-inbox').textContent()).trim(), before, 'pending acceptance keeps the pre-accept inbox context');
    await shot(page, 'pending-username-accept');
    await releaseMutation(app, page);
    await wait(page, () => document.querySelector('#account-friend-feedback').textContent.includes('Joined'));
    assert.equal(await page.locator('#account-inbox [data-account-accept]').count(), 0, 'verified acceptance clears the request row');
    assert.equal((await state(page)).onboarding.checks.friends, 'complete');
    assert.equal(await page.locator('#setup-dialog').evaluate(d => d.open), true);
    await shot(page, 'pending-accept-resolved');
    await click(page, '#setup-save-close'); await wait(page, () => !document.querySelector('#setup-dialog').open);
    assert.equal(await page.locator('#friends-panel #account-card').count(), 1);
  },
  async ['pending-signin']() {
    console.log('STEP pending username sign-in: real TLS registration; while the account dialog works, its exits pause, Escape is refused, and the typed username stays.');
    const { app, page } = await launch('pending-signin', true);
    assert.equal((await state(page)).server, null, 'fresh-profile sign-in needs no server');
    await openFriendsGuide(page);
    await click(page, '#setup-friends-slot #account-open');
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
    assert.equal(await page.locator('#setup-dialog').evaluate(dialog => dialog.open), true, 'the guide stays open behind the refused Escape');
    await shot(page, 'pending-username-signin');
    await releaseMutation(app, page);
    await wait(page, () => !document.querySelector('#account-dialog').open && document.querySelector('#account-heading').textContent.startsWith('@'));
    assert.equal((await page.evaluate(() => window.seedhost.call('accountStatus'))).username, 'pending_signup');
    assert.equal(await page.locator('#setup-dialog').evaluate(dialog => dialog.open), true, 'the guide continues after sign-in');
    assert.equal(await page.locator('#setup-friends-slot #username-friend-form').isVisible() || await page.locator('#setup-friends-slot #account-start-group').isVisible(), true);
    await shot(page, 'pending-signin-resolved');
    await click(page, '#setup-save-close'); await wait(page, () => !document.querySelector('#setup-dialog').open);
  },
  async ['readback-rejected']() {
    console.log('STEP username readback: TEST-ONLY IPC falsification after real account acceptance.');
    for (const field of ['fingerprint', 'peerFingerprint', 'host', 'port', 'parkOnStop']) {
      const prefix = 'rb_' + ['fingerprint', 'peerFingerprint', 'host', 'port', 'parkOnStop'].indexOf(field);
      const firstApp = apps.length, firstRelay = relays.length;
      const {owner,recipient:{app,page},node} = await usernamePair(prefix);
      await fill(owner.page, '#friend-username', prefix + '_recipient'); await click(owner.page, '#username-invite');
      await wait(owner.page, () => document.querySelector('#account-friend-feedback').textContent.includes('Invitation sent'));
      await click(page, '#friends-tab'); await click(page, '#account-refresh');
      await page.locator('#account-inbox [data-account-accept]').waitFor({state:'visible'});
      await app.evaluate(({ipcMain},field)=>{
        const original=ipcMain._invokeHandlers.get('seedhost:call');let accepted=false;
        ipcMain.removeHandler('seedhost:call');ipcMain.handle('seedhost:call',async(event,method,payload)=>{
          const result=await original(event,method,payload);
          if(method==='accountAccept'&&result)accepted=true;
          if(method==='getState'&&accepted&&result.relay){
            if(field==='fingerprint')result.relay.fingerprint='0'.repeat(64);
            if(field==='parkOnStop')result.relay.parkOnStop=false;
            const peer=result.peers.find(peer=>peer.fingerprint===result.relay.fingerprint);
            if(peer&&field==='peerFingerprint')peer.fingerprint='0'.repeat(64);
            if(peer&&field==='host')peer.host='localhost';
            if(peer&&field==='port')peer.port=peer.port===65535?65534:peer.port+1;
          }return result;
        });
      },field);
      await click(page,'#account-inbox [data-account-accept]');
      await wait(page,()=>!document.querySelector('#account-refresh').disabled);
      assert.doesNotMatch(await page.locator('#account-friend-feedback').textContent(),/^Joined/);
      assert.match(await page.locator('#account-friend-feedback').textContent(),/could not be confirmed/i);
      assert.equal(node.trusted.length,2,'only readback falsified; actual username enrollment is real');
      await shot(page,'username-readback-rejected-'+field);console.log('PASS readback-rejected='+field);
      // Retire each completed scenario: accumulated account pollers would stress the real
      // directory's per-address request budget and contaminate later independent cases.
      for (const completed of apps.splice(firstApp).reverse()) await completed.close();
      for (const completed of relays.splice(firstRelay)) await completed.close();
    }
  },
  async ['username-roundtrip']() {
    const {owner,recipient,node}=await usernamePair('roundtrip');
    const {page,app}=recipient;
    await click(page,'#friends-tab');
    assert.equal(await page.locator('#friend-code,#invite-code,#friends-intent-join,#friends-intent-invite').count(),0);
    async function send(){
      await fill(owner.page,'#friend-username','roundtrip_recipient');await click(owner.page,'#username-invite');
      await wait(owner.page,()=>!document.querySelector('#username-invite').disabled);
      await click(page,'#account-refresh');await page.locator('#account-inbox [data-account-accept]').waitFor({state:'visible'});
      assert.match(await page.locator('#account-inbox').textContent(),/@roundtrip_owner/);
    }
    await send();await click(page,'#account-inbox [data-account-decline]');
    await wait(page,()=>document.querySelector('#account-friend-feedback').textContent.includes('declined'));
    assert.equal(node.trusted.length,1);assert.deepEqual(await page.evaluate(()=>window.seedhost.call('accountRequests')),[]);
    await send();await click(page,'#account-inbox [data-account-accept]');
    await wait(page,()=>document.querySelector('#account-friend-feedback').textContent.startsWith('Joined'));
    const before=await state(page);assert.equal(before.server,null);assert.equal(before.gateway.enabled,false);
    assert.equal(before.relay.fingerprint,node.identity.fingerprint);assert.equal(before.relay.parkOnStop,true);
    const peer=before.peers.find(p=>p.fingerprint===node.identity.fingerprint);
    assert.equal(peer.host,node.endpoint.host);assert.equal(peer.port,node.endpoint.port);assert.equal(node.trusted.length,2);
    await page.reload();await idle(page);await click(page,'#friends-tab');await click(page,'#refresh-friends');
    await wait(page,()=>document.querySelector('#group-status').textContent==='Members confirmed');
    const after=await state(page);assert.deepEqual(after.relay,before.relay);assert.deepEqual(after.peers,before.peers);
    assert.match(await page.locator('#friend-list').textContent(),/roundtrip_owner.*roundtrip_recipient/s);
    await enterPeers(page,app);await openSelectedServer(page);await click(page,'#peers-tab');
    assert.equal(await page.locator('#peers-panel #account-card').isVisible(),true);
    assert.equal(await page.locator('#peers-panel #username-friend-form').isVisible(),true);
    assert.equal(await page.locator('#peers-panel #friends-controls').isVisible(),true);
    assert.equal(await page.locator('#peers-panel #advanced-peers').count(),0);
    assert.equal(await page.locator('#account-card').count(),1);
    await click(page,'#refresh-friends');await wait(page,()=>document.querySelector('#group-status').textContent==='Members confirmed');
    await shot(page,'username-multi-host');
  },
};

const selected = process.argv.find(arg => arg.startsWith('--case='))?.slice(7);
try {
  const names = selected === undefined ? Object.keys(cases) : selected.split(',');
  for (const name of names) assert.ok(Object.hasOwn(cases, name) && typeof cases[name] === 'function', 'Unknown regression case: ' + name);
  for (const name of names) {
    await cases[name](); console.log('PASS case=' + name);
    for (const completed of apps.splice(0).reverse()) await completed.close();
    for (const completed of relays.splice(0)) await completed.close();
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
  for (const node of relays) await node.close();
  await accountService?.close();
  console.log('ARTIFACT_DIR=' + root);
}
