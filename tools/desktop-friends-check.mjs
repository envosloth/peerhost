// Visible Electron regressions. Real isolated profiles + real loopback RelayNode.
// Only native dialog answers are substituted in real cases. Concurrency cases explicitly
// install a TEST-ONLY preload bridge, never claimed as backend/network verification.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { RelayNode } from '../dist/src/core/relay.js';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { dismissInitialSetup } from './desktop-test-setup.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const packaged = process.argv.find(value => value.startsWith('--packaged='))?.slice('--packaged='.length);
const executablePath = packaged || createRequire(import.meta.url)('electron');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const scratch = process.env.TMPDIR || path.join(process.env.LOCALAPPDATA, 'hermes/cache/scratch');
await mkdir(scratch, { recursive: true });
const root = await mkdtemp(path.join(scratch, 'seed-friends-'));
const apps = [], relays = [], pageErrors = [];
let previousClipboard;
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
async function launch(name) {
  const args = [...(packaged ? [] : [path.join(project, 'dist/apps/desktop/main.js')]), '--profile-root=' + path.join(root, name)];
  const app = await electron.launch({ executablePath, args, env });
  apps.push(app); const page = await app.firstWindow();
  page.on('pageerror', error => pageErrors.push(String(error)));
  await wait(page, () => document.querySelector('#activity-message').textContent === 'Ready');
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await page.bringToFront(); await dismissInitialSetup(page);
  if (previousClipboard === undefined) previousClipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
  await click(page, '#peers-tab');
  return { app, page };
}
async function relay(name = 'Garden <friends>') {
  const node = new RelayNode(path.join(root, 'relay-' + relays.length), await createIdentity(), { name, log: () => {} });
  await node.open(); await node.listen(); relays.push(node); return node;
}
async function idle(page) { await wait(page, () => document.querySelector('#activity-message').textContent === 'Ready'); }
async function chooseJoin(page) { await click(page, '#friends-intent-join'); }
async function check(page, code, name = 'Sam') {
  await chooseJoin(page); await fill(page, '#friend-code', code); await fill(page, '#friend-name', name);
  await click(page, '#check-invitation');
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
async function attemptPendingGuideExit(page) {
  await page.bringToFront(); await page.locator('#friends-play-only').scrollIntoViewIfNeeded();
  if (await page.locator('#friends-play-only').isEnabled()) await click(page, '#friends-play-only');
  else {
    console.log('ACTION play-only disabled; TEST-ONLY event dispatch verifies the handler also refuses guide exit.');
    await page.bringToFront();
    await page.locator('#friends-play-only').dispatchEvent('click');
  }
  assert.equal(await page.locator('#setup-dialog').evaluate(dialog => dialog.open), true, 'pending mutation must keep the guide open');
  assert.equal(await page.locator('#setup-friends-slot #friends-controls').count(), 1, 'pending guide retains its Friends controls');
  assert.equal(await page.locator('#friends-play-only').isDisabled(), true, 'play-only must visibly pause during mutation');
  for (const selector of ['#setup-save-close', '#setup-later', '#setup-next', '#setup-skip']) assert.equal(await page.locator(selector).isDisabled(), true, selector + ' must not exit a pending guide');
  console.log('ACTION Escape must not exit a pending guide.');
  await page.bringToFront(); await page.keyboard.press('Escape');
  assert.equal(await page.locator('#setup-dialog').evaluate(dialog => dialog.open), true, 'Escape must not exit a pending guide');
}

const cases = {
  async ['pending-create']() {
    console.log('STEP pending create: real approval/backend plus TEST-ONLY result scheduling; all guide exits pause and private fields stay until completion.');
    const { app, page } = await launch('pending-create'), node = await relay('Pending Create Garden');
    await node.setMemberInvites(true); await node.trust('Host', (await state(page)).deviceId);
    await page.evaluate(async peer => { await window.seedhost.call('addPeer', peer); await window.seedhost.call('saveRelay', { fingerprint: peer.fingerprint, parkOnStop: true }); }, { fingerprint: node.identity.fingerprint, name: node.name, ...node.endpoint });
    await page.reload(); await idle(page); await click(page, '#peers-tab');
    await click(page, '#nav-setup'); await click(page, '[data-setup-step="friends"]'); await idle(page);
    await click(page, '#create-invite');
    await wait(page, () => document.querySelector('#invite-code').value.startsWith('SEEDHOST-'));
    const previousCode = await page.locator('#invite-code').inputValue();
    await holdMutationResult(app, 'createInvite');
    await click(page, '#create-invite'); await waitForHeldMutation(app);
    assert.ok(!(await state(page)).busy, 'real backend completed; the renderer is still waiting for result delivery');
    await shot(page, 'pending-create-before-exit');
    await attemptPendingGuideExit(page);
    assert.ok(await page.locator('#invite-code').inputValue() === previousCode, 'pending creation must retain the previous private invitation');
    await shot(page, 'pending-create-exit-blocked');
    console.log('TEST-ONLY IPC scheduling: release the original real create result.');
    await app.evaluate(() => globalThis.__heldMutation.release()); await idle(page);
    assert.equal(await page.locator('#setup-dialog').evaluate(dialog => dialog.open), true);
    const nextCode = await page.locator('#invite-code').inputValue();
    assert.ok(nextCode.startsWith('SEEDHOST-') && nextCode !== previousCode, 'real creation result is shown in the still-open guide');
    assert.equal(node.trusted.length, 1, 'creating invitations does not enroll another member');
    assert.equal(await page.locator('#friends-play-only').isEnabled(), true);
    await shot(page, 'pending-create-resolved-open-guide');
    await click(page, '#friends-play-only'); await wait(page, () => !document.querySelector('#setup-dialog').open);
    assert.equal(await page.locator('#invite-code').inputValue(), '', 'post-completion exit clears the private invitation');
    assert.equal(await page.locator('#join-help').isVisible(), true);
    await shot(page, 'pending-create-completed-exit-cleared');
  },
  async ['pending-join']() {
    console.log('STEP pending join: real approval/enrollment plus TEST-ONLY result scheduling; guide/input survives attempted exit and confirms real saved group on completion.');
    const { app, page } = await launch('pending-join'), node = await relay('Pending Join Garden'), invite = await node.createInvite({ hours: 1 });
    await click(page, '#nav-setup'); await click(page, '[data-setup-step="friends"]'); await idle(page);
    await check(page, invite.code, 'Pending host'); await wait(page, () => !document.querySelector('#join-friend').disabled);
    await holdMutationResult(app, 'joinWithInvite');
    await click(page, '#join-friend'); await waitForHeldMutation(app);
    const saved = await state(page), peer = saved.peers.find(entry => entry.fingerprint === node.identity.fingerprint);
    assert.equal(node.trusted.length, 1, 'actual backend enrollment finished before the held result');
    assert.equal(saved.relay.fingerprint, node.identity.fingerprint); assert.equal(peer.host, node.endpoint.host); assert.equal(peer.port, node.endpoint.port);
    assert.ok(!saved.busy, 'real backend completed; renderer mutation still pending');
    await shot(page, 'pending-join-before-exit');
    await attemptPendingGuideExit(page);
    assert.ok(await page.locator('#friend-code').inputValue() === invite.code, 'pending join must retain the exact private input');
    assert.equal(await page.locator('#friend-name').inputValue(), 'Pending host');
    await shot(page, 'pending-join-exit-blocked');
    console.log('TEST-ONLY IPC scheduling: release the original real join result.');
    await app.evaluate(() => globalThis.__heldMutation.release()); await idle(page);
    await wait(page, () => document.querySelector('#friend-feedback').textContent.startsWith('Joined'));
    assert.equal(await page.locator('#setup-dialog').evaluate(dialog => dialog.open), true);
    assert.equal(await page.locator('#friend-code').inputValue(), '', 'only verified success clears the invitation');
    assert.equal(await page.locator('#friend-name').inputValue(), 'Pending host');
    await chooseJoin(page); assert.equal(await page.locator('#join-friend-feedback').textContent(), '');
    await shot(page, 'pending-join-resolved-open-guide');
    await click(page, '#friends-play-only'); await wait(page, () => !document.querySelector('#setup-dialog').open);
    assert.equal(await page.locator('#friend-name').inputValue(), '', 'completed guide exit clears the remaining draft');
    assert.equal(await page.locator('#friend-code').inputValue(), '');
    assert.equal(await page.locator('#join-help').isVisible(), true);
    await shot(page, 'pending-join-completed-exit-cleared');
  },
  async preview() {
    console.log('STEP preview: local decoding never enrolls or changes settings; full verification details.');
    const { page } = await launch('preview'); const node = await relay();
    const invite = await node.createInvite({ hours: 1 });
    assert.equal(await page.locator('#check-invitation').count(), 1, 'missing local Check invitation step');
    assert.equal(await page.locator('#check-invitation').getAttribute('type'), 'button');
    assert.equal(await page.locator('#join-friend').isDisabled(), true, 'joining requires a checked invitation');
    await check(page, invite.code, 'River <QA>');
    await wait(page, () => !document.querySelector('#invitation-preview').hidden);
    assert.equal(await page.locator('#preview-group').textContent(), node.name);
    assert.equal(await page.locator('#preview-address').textContent(), node.endpoint.host + ':' + node.endpoint.port);
    assert.equal(await page.locator('#preview-local-warning').count(), 1, 'loopback invitations need a plain-language same-PC warning');
    assert.equal(await page.locator('#preview-local-warning').isVisible(), true);
    assert.match(await page.locator('#preview-local-warning').textContent(), /only.*this.*PC.*ask.*friend.*new.*code.*LAN.*VPN/is);
    await click(page, '#invitation-verify > summary');
    assert.equal(await page.locator('#preview-fingerprint').textContent(), node.identity.fingerprint);
    assert.match(await page.locator('#preview-expiry').textContent(), /Expires/);
    assert.match(await page.locator('#invitation-preview').textContent(), /not a connection check.*verify with.*friend/is);
    assert.equal(await page.locator('#join-friend').isEnabled(), true);
    assert.equal(node.trusted.length, 0, 'preview must not redeem or enroll');
    assert.equal((await state(page)).relay, null); assert.equal((await state(page)).server, null);
    assert.equal(await page.locator('#invitation-preview friends').count(), 0, 'group name renders literal text');
    const storage = await page.evaluate(() => JSON.stringify(localStorage)); assert.ok(!storage.includes(invite.code)); assert.ok(!storage.includes('River'));
    await shot(page, 'local-preview-full-fingerprint');
  },
  async stale() {
    console.log('STEP stale: real Electron + TEST-ONLY IPC scheduling bridge; late preview cannot replace newer input or a closed wizard.');
    const { app, page } = await launch('stale'); const node = await relay();
    const first = await node.createInvite({ hours: 1 }), second = await node.createInvite({ hours: 1 });
    await check(page, first.code); await wait(page, () => !document.querySelector('#invitation-preview').hidden);
    await fill(page, '#friend-code', second.code);
    assert.equal(await page.locator('#invitation-preview').isVisible(), false, 'editing the code must remove old verification details');
    assert.equal(await page.locator('#join-friend').isDisabled(), true);
    // This controls timing only. Results still come from the real local decoder/main handler.
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('seedhost:call'); globalThis.__previewQueue = [];
      ipcMain.removeHandler('seedhost:call');
      ipcMain.handle('seedhost:call', (event, method, payload) => method !== 'previewInvite' ? original(event, method, payload) : new Promise((resolve, reject) => {
        globalThis.__previewQueue.push(() => Promise.resolve(original(event, method, payload)).then(resolve, reject));
      }));
    });
    const queued = async count => { for (let n = 0; n < 100; n++) { if (await app.evaluate(() => globalThis.__previewQueue.length) === count) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('preview scheduling bridge did not queue'); };
    await check(page, first.code); await queued(1);
    await fill(page, '#friend-code', second.code);
    assert.equal(await page.locator('#check-invitation').isEnabled(), true, 'new input must be checkable while the old request is pending');
    await click(page, '#check-invitation'); await queued(2);
    await app.evaluate(() => globalThis.__previewQueue[1]());
    await wait(page, () => !document.querySelector('#invitation-preview').hidden);
    await app.evaluate(() => globalThis.__previewQueue[0]());
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#join-friend').isEnabled(), true, 'old result must not replace the checked newer code');
    await fill(page, '#friend-name', 'Changed name');
    assert.equal(await page.locator('#invitation-preview').isVisible(), false, 'display-name changes require a fresh review');
    await click(page, '#nav-setup'); await click(page, '[data-setup-step="friends"]'); await idle(page);
    await check(page, first.code); await queued(3);
    await click(page, '#setup-save-close'); await wait(page, () => !document.querySelector('#setup-dialog').open);
    await app.evaluate(() => globalThis.__previewQueue[2]()); await page.waitForTimeout(100);
    assert.equal(await page.locator('#friend-code').inputValue(), '');
    assert.equal(await page.locator('#friend-name').inputValue(), '', 'closing wizard clears private draft');
    assert.equal(await page.locator('#invitation-preview').isVisible(), false);
    assert.equal(await page.locator('#join-friend').isDisabled(), true);
    assert.equal(node.trusted.length, 0);
    await shot(page, 'stale-preview-closed-wizard');
  },
  async layout() {
    console.log('STEP layout: visible 1000x700 / 1240x860, light/dark, one set of wizard controls.');
    const { app, page } = await launch('layout'); const node = await relay('Layout Garden'), invite = await node.createInvite({ hours: 1 });
    for (const [width, height] of [[1000, 700], [1240, 860]]) for (const theme of ['light', 'dark']) {
      console.log('ACTION window bounds ' + width + 'x' + height + ' ' + theme);
      await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), { width, height });
      await click(page, '#settings-tab'); await click(page, `input[name="theme"][value="${theme}"]`);
      await click(page, '#peers-tab');
      const overflow = await page.evaluate(() => ['#friends-controls', '#peers-panel', '.friends-configure'].filter(selector => { const el = document.querySelector(selector); return el.scrollWidth > el.clientWidth + 1; }));
      assert.deepEqual(overflow, [], 'no clipping at ' + width + ' ' + theme);
      await shot(page, `friends-${width}-${theme}`);
      await check(page, invite.code); await wait(page, () => !document.querySelector('#invitation-preview').hidden);
      await click(page, '#invitation-verify > summary');
      const previewOverflow = await page.evaluate(() => ['#invitation-preview', '.preview-facts', '#preview-fingerprint'].filter(selector => { const el = document.querySelector(selector); return el.scrollWidth > el.clientWidth + 1; }));
      assert.deepEqual(previewOverflow, [], 'full preview fits at ' + width + ' ' + theme);
      await page.locator('#invitation-preview').scrollIntoViewIfNeeded(); await shot(page, `friends-preview-${width}-${theme}`);
      await click(page, '#nav-setup'); await click(page, '[data-setup-step="friends"]'); await idle(page);
      assert.equal(await page.locator('#setup-friends-slot #friends-controls').count(), 1);
      const wizardOverflow = await page.evaluate(() => ['#setup-dialog', '.setup-body', '#setup-friends-slot'].filter(selector => { const el = document.querySelector(selector); return el.scrollWidth > el.clientWidth + 1; }));
      assert.deepEqual(wizardOverflow, [], 'wizard controls fit at ' + width + ' ' + theme);
      await page.locator('#friends-controls').scrollIntoViewIfNeeded();
      await shot(page, `wizard-friends-${width}-${theme}`);
      await click(page, '#setup-save-close'); await wait(page, () => !document.querySelector('#setup-dialog').open);
    }
  },
  async invitation() {
    console.log('STEP invitation: real configured relay, one-use code, large copy action and honest next steps.');
    const { app, page } = await launch('invitation'); const node = await relay('Seed Garden');
    await node.setMemberInvites(true);
    const deviceId = (await state(page)).deviceId; await node.trust('Host', deviceId);
    await page.evaluate(async peer => { await window.seedhost.call('addPeer', peer); await window.seedhost.call('saveRelay', { fingerprint: peer.fingerprint, parkOnStop: true }); }, { fingerprint: node.identity.fingerprint, name: node.name, ...node.endpoint });
    await page.reload(); await idle(page); await click(page, '#peers-tab');
    await click(page, '#create-invite');
    await wait(page, () => document.querySelector('#invite-code').value.startsWith('SEEDHOST-'));
    assert.equal(await page.locator('#invite-next-steps li').count(), 3, 'ready invitation needs three concise sharing steps');
    assert.match(await page.locator('#invite-next-steps').textContent(), /privately.*I have an invitation.*name.*review.*join/is);
    assert.match(await page.locator('#invite-warning').textContent(), /new.*does not revoke.*previous/is);
    assert.match(await page.locator('#invite-help').textContent(), /one.use|one.time/i);
    assert.match(await page.locator('#invite-help').textContent(), /24 hours/);
    const code = await page.locator('#invite-code').inputValue();
    assert.ok((await page.locator('#copy-invite').boundingBox()).height >= 40, 'copy is the large primary next action');
    await click(page, '#copy-invite');
    await wait(page, () => document.querySelector('#copy-invite').textContent.includes('Copied'));
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), code);
    assert.match(await page.locator('#invite-status').textContent(), /copied.*send.*privately/i);
    assert.equal(node.trusted.length, 1, 'creation/copy never infers another member');
    assert.ok(!(await page.locator('#friend-feedback').textContent()).includes('A friend joined'));
    await shot(page, 'invitation-ready-copied');
  },
  async members() {
    console.log('STEP members: explicit no-group/checking/confirmed/unreachable states; no fake presence.');
    const { page } = await launch('members');
    assert.equal(await page.locator('#group-status').count(), 1, 'group status must distinguish saved settings from checked members');
    assert.match(await page.locator('#group-status').textContent(), /No group/);
    const node = await relay('Seed Members'), deviceId = (await state(page)).deviceId;
    await node.trust('You <literal>', deviceId); await node.trust('Other host', (await createIdentity()).fingerprint);
    await page.evaluate(async peer => { await window.seedhost.call('addPeer', peer); await window.seedhost.call('saveRelay', { fingerprint: peer.fingerprint, parkOnStop: true }); }, { fingerprint: node.identity.fingerprint, name: node.name, ...node.endpoint });
    await page.reload(); await idle(page); await click(page, '#peers-tab');
    await wait(page, () => document.querySelectorAll('#friend-list li').length === 2);
    assert.match(await page.locator('#group-status').textContent(), /Members confirmed/);
    assert.match(await page.locator('#friend-list').textContent(), /You.*Can host/s);
    assert.ok(!/online|connected/i.test(await page.locator('#friend-list').textContent()));
    assert.match(await page.locator('#friend-last-checked').textContent(), /Last checked/);
    await shot(page, 'members-confirmed-not-presence');
    await node.close(); await click(page, '#refresh-friends');
    await wait(page, () => document.querySelector('#group-status').textContent.includes('Unreachable'));
    assert.equal(await page.locator('#friend-list li').count(), 0, 'failed refresh must not leave stale confirmed members');
    assert.equal(await page.locator('#nav-friend-count').isVisible(), false);
    assert.equal(await page.locator('#refresh-friends').isEnabled(), true);
    assert.match(await page.locator('#friend-holder').textContent(), /unavailable.*Refresh/i);
    await shot(page, 'members-unreachable-retry');
  },
  async validation() {
    console.log('STEP validation: explicit inline name and complete-code errors without leaking private input.');
    const { page } = await launch('validation');
    await click(page, '#check-invitation');
    assert.equal(await page.locator('#friend-name-error').count(), 1, 'name needs an inline error near its field');
    assert.equal(await page.locator('#friend-code-error').count(), 1, 'code needs an inline error near its field');
    assert.match(await page.locator('#friend-name-error').textContent(), /own.*name/i);
    assert.match(await page.locator('#friend-code-error').textContent(), /complete.*code/i);
    assert.equal(await page.locator('#friend-name').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#friend-code').getAttribute('aria-invalid'), 'true');
    await fill(page, '#friend-name', 'Sam'); await fill(page, '#friend-code', 'private-invalid-input');
    await click(page, '#check-invitation');
    assert.match(await page.locator('#friend-code-error').textContent(), /copy.*complete.*code/i);
    assert.ok(!(await page.locator('#error-text').textContent()).includes('private-invalid-input'));
    assert.ok(!(await page.locator('#friend-code-error').textContent()).includes('private-invalid-input'));
    assert.equal(await page.locator('#friend-name').getAttribute('aria-invalid'), null);
    assert.equal((await state(page)).relay, null);
    await shot(page, 'inline-field-validation');
  },
  async recovery() {
    console.log('STEP recovery: damaged and expired real-protocol codes recover inline, no redemption or secret errors.');
    const { page } = await launch('recovery'); const node = await relay();
    const invite = await node.createInvite({ hours: 1 }); const damaged = invite.code.slice(0, -4);
    await check(page, damaged);
    await wait(page, () => !document.querySelector('#friend-code-error').hidden);
    assert.match(await page.locator('#friend-code-error').textContent(), /damaged.*copy.*complete.*code/is);
    assert.equal(await page.locator('#join-friend').isDisabled(), true);
    assert.equal(await page.locator('#invitation-preview').isVisible(), false);
    const realNow = Date.now; let expired;
    try { Date.now = () => realNow() - 7200000; expired = await node.createInvite({ hours: 1 }); } finally { Date.now = realNow; }
    await check(page, expired.code);
    await wait(page, () => document.querySelector('#friend-code-error').textContent.includes('expired'));
    assert.match(await page.locator('#friend-code-error').textContent(), /ask.*new code/i);
    assert.ok(await page.locator('#friend-code').inputValue() === expired.code, 'recovery keeps pasted invitation');
    assert.ok(!(await page.locator('#error-text').textContent()).includes(expired.code));
    assert.equal(node.trusted.length, 0); assert.equal((await state(page)).relay, null);
    await shot(page, 'expired-code-inline-recovery');
  },
  async cancel() {
    console.log('STEP consent cancellation: not joined; keep name, code and checked details for retry.');
    const { app, page } = await launch('cancel'); const node = await relay(); const invite = await node.createInvite({ hours: 1 });
    await check(page, invite.code, 'Sam'); await wait(page, () => !document.querySelector('#join-friend').disabled);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    await click(page, '#join-friend'); await idle(page);
    assert.equal(await page.locator('#join-friend-feedback').count(), 1, 'join result needs inline recovery/status');
    assert.match(await page.locator('#join-friend-feedback').textContent(), /Not joined\. Your invitation is kept\./);
    assert.ok(await page.locator('#friend-code').inputValue() === invite.code, 'native cancellation keeps invitation');
    assert.equal(await page.locator('#friend-name').inputValue(), 'Sam');
    assert.equal(await page.locator('#join-friend').isEnabled(), true);
    assert.equal(node.trusted.length, 0); assert.equal((await state(page)).relay, null);
    await shot(page, 'consent-cancel-invitation-kept');
    await click(page, '#nav-setup'); await click(page, '[data-setup-step="friends"]'); await idle(page);
    await click(page, '#setup-save-close'); await wait(page, () => !document.querySelector('#setup-dialog').open);
    assert.equal(await page.locator('#join-friend-feedback').textContent(), '', 'wizard close must not say an erased invitation is kept');
  },
  async retry() {
    console.log('STEP retry: real native cancel then unchanged-code approval; actual backend enrollment clears the old cancellation notice. Dialog answers only; no IPC bridge.');
    const { app, page } = await launch('retry'); const node = await relay('Retry Garden'), invite = await node.createInvite({ hours: 1 });
    await check(page, invite.code, 'Retry host'); await wait(page, () => !document.querySelector('#join-friend').disabled);
    await app.evaluate(({ dialog }) => {
      globalThis.__retryAnswers = [];
      dialog.showMessageBox = async () => {
        const response = globalThis.__retryAnswers.length === 0 ? 0 : 1;
        globalThis.__retryAnswers.push(response); return { response };
      };
    });
    await click(page, '#join-friend'); await idle(page);
    assert.match(await page.locator('#join-friend-feedback').textContent(), /Not joined\. Your invitation is kept\./);
    assert.ok(await page.locator('#friend-code').inputValue() === invite.code, 'cancellation retains the exact invitation for retry');
    assert.equal(await page.locator('#friend-name').inputValue(), 'Retry host');
    assert.equal(node.trusted.length, 0); assert.equal((await state(page)).relay, null);
    await shot(page, 'retry-native-cancel');
    // Do not edit/recheck: only retry the already reviewed invitation and approve.
    await click(page, '#join-friend'); await idle(page);
    await wait(page, () => document.querySelector('#friend-feedback').textContent.startsWith('Joined'));
    const saved = await state(page), peer = saved.peers.find(entry => entry.fingerprint === node.identity.fingerprint);
    assert.equal(saved.relay.fingerprint, node.identity.fingerprint); assert.equal(saved.relay.parkOnStop, true);
    assert.equal(peer.host, node.endpoint.host); assert.equal(peer.port, node.endpoint.port);
    assert.equal(node.trusted.length, 1); assert.equal(node.trusted[0].name, 'Retry host');
    assert.deepEqual(await app.evaluate(() => globalThis.__retryAnswers), [0, 1]);
    assert.equal(await page.locator('#friend-code').inputValue(), '');
    await wait(page, () => document.querySelector('#group-status').textContent === 'Members confirmed');
    await chooseJoin(page);
    assert.equal(await page.locator('#join-friend-feedback').textContent(), '', 'verified retry must clear the old Not joined notice');
    assert.match(await page.locator('#friend-feedback').textContent(), /^Joined/);
    await shot(page, 'retry-real-enrollment-no-stale-notice');
  },
  async failure() {
    console.log('STEP failure: unreachable relay gives inline network/VPN recovery and retains entries.');
    const { page } = await launch('failure'); const node = await relay(); const invite = await node.createInvite({ hours: 1 });
    await node.close(); await check(page, invite.code, 'Sam'); await wait(page, () => !document.querySelector('#join-friend').disabled);
    await click(page, '#join-friend'); await idle(page);
    assert.match(await page.locator('#join-friend-feedback').textContent(), /same network.*VPN.*always.on PC/is);
    assert.match(await page.locator('#join-friend-feedback').textContent(), /Couldn.t confirm joining.*Retry the same code on this PC/is, 'network failure is not proof that the relay did not enroll');
    assert.ok(await page.locator('#friend-code').inputValue() === invite.code, 'failure preserves code');
    assert.equal(await page.locator('#friend-name').inputValue(), 'Sam');
    assert.equal((await state(page)).relay, null); assert.equal(node.trusted.length, 0);
    assert.ok(!(await page.locator('#error-text').textContent()).includes(invite.code));
    await shot(page, 'unreachable-join-invitation-kept');
    await fill(page, '#friend-name', 'New name');
    assert.equal(await page.locator('#join-friend-feedback').textContent(), '', 'new input clears old join result');
  },
  async readback() {
    console.log('STEP readback: TEST-ONLY IPC falsification of each saved field after real enrollment; never claim verified join.');
    for (const field of ['fingerprint', 'host', 'port', 'parkOnStop']) {
      const { app, page } = await launch('readback-' + field); const node = await relay('Readback Garden');
      const invite = await node.createInvite({ hours: 1 }); await check(page, invite.code); await wait(page, () => !document.querySelector('#join-friend').disabled);
      await app.evaluate(({ ipcMain }, field) => {
        const original = ipcMain._invokeHandlers.get('seedhost:call'); let joined = false;
        ipcMain.removeHandler('seedhost:call'); ipcMain.handle('seedhost:call', async (event, method, payload) => {
          const result = await original(event, method, payload);
          if (method === 'joinWithInvite' && result) joined = true;
          if (method === 'getState' && joined && result.relay) {
            if (field === 'fingerprint') result.relay.fingerprint = '0'.repeat(64);
            if (field === 'parkOnStop') result.relay.parkOnStop = false;
            const peer = result.peers.find(peer => peer.fingerprint === result.relay.fingerprint);
            if (peer && field === 'host') peer.host = 'localhost';
            if (peer && field === 'port') peer.port = peer.port === 65535 ? 65534 : peer.port + 1;
          }
          return result;
        });
      }, field);
      await click(page, '#join-friend'); await idle(page);
      assert.ok(await page.locator('#friend-code').inputValue() === invite.code, 'unconfirmed ' + field + ' readback must preserve code');
      assert.ok(!(await page.locator('#friend-feedback').textContent()).includes('Joined'), 'unconfirmed join cannot announce success');
      assert.match(await page.locator('#join-friend-feedback').textContent(), /couldn.t confirm.*kept/i);
      assert.equal(node.trusted.length, 1, 'test only falsifies readback, actual enrollment is real');
      await shot(page, 'readback-rejected-' + field);
    }
  },
  async join() {
    console.log('STEP join: two real profiles, real invitation/copy/enrollment/member reads; nothing downloads or starts.');
    const node = await relay('Shared Garden'); await node.setMemberInvites(true);
    const a = await launch('join-a'), b = await launch('join-b'); const initial = await node.createInvite({ hours: 1 });
    await check(a.page, initial.code, 'River <QA>'); await wait(a.page, () => !document.querySelector('#join-friend').disabled);
    await click(a.page, '#join-friend'); await idle(a.page);
    await wait(a.page, () => document.querySelector('#friend-feedback').textContent.startsWith('Joined'));
    assert.match(await a.page.locator('#friend-feedback').textContent(), /Nothing was downloaded or started.*Next.*review.*start.*ready/is);
    assert.equal(await a.page.locator('#preview-fingerprint').textContent(), '', 'successful join clears preview secret context');
    await click(a.page, '#create-invite'); await wait(a.page, () => document.querySelector('#invite-code').value.startsWith('SEEDHOST-'));
    const invitation = await a.page.locator('#invite-code').inputValue(); await click(a.page, '#copy-invite');
    // The renderer's copy is async: wait for the app's own confirmation before checking the OS clipboard.
    await wait(a.page, () => /^(?:Copied|Couldn)/.test(document.querySelector('#invite-status').textContent));
    const copyStatus = await a.page.locator('#invite-status').textContent();
    assert.match(copyStatus, /^Copied/, 'copy confirmation: ' + copyStatus);
    let clipboardText = '';
    for (let attempt = 0; attempt < 50 && clipboardText !== invitation; attempt++) { clipboardText = await a.app.evaluate(({ clipboard }) => clipboard.readText()); if (clipboardText !== invitation) await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.equal(clipboardText, invitation, 'actual clipboard contains invitation (got ' + clipboardText.length + ' chars)');
    await check(b.page, invitation, 'Sam'); await wait(b.page, () => !document.querySelector('#join-friend').disabled);
    assert.equal(node.trusted.length, 1, 'B preview does not enroll');
    await click(b.page, '#join-friend'); await idle(b.page);
    await wait(b.page, () => document.querySelector('#friend-feedback').textContent.startsWith('Joined'));
    for (const instance of [a, b]) {
      const saved = await state(instance.page), peer = saved.peers.find(peer => peer.fingerprint === node.identity.fingerprint);
      assert.equal(saved.relay.fingerprint, node.identity.fingerprint); assert.equal(saved.relay.parkOnStop, true);
      assert.equal(peer.host, node.endpoint.host); assert.equal(peer.port, node.endpoint.port);
      assert.equal(saved.server, null); assert.equal(saved.gateway.enabled, false); assert.equal(saved.settings.persistentAddress, false);
      assert.ok(!saved.logs.some(line => line.includes(invitation) || /Downloading|Starting server/.test(line)));
      assert.ok(!(await readdir(path.join(root, instance === a ? 'join-a' : 'join-b'))).includes('servers'), 'joining creates no managed server');
    }
    await click(a.page, '#refresh-friends'); await wait(a.page, () => document.querySelectorAll('#friend-list li').length === 2);
    assert.deepEqual(node.trusted.map(member => member.name).sort(), ['River <QA>', 'Sam']);
    assert.equal(await a.page.locator('#friend-list qa').count(), 0);
    await a.page.bringToFront(); await a.page.locator('#friend-list').scrollIntoViewIfNeeded();
    await shot(a.page, 'two-profile-invitation-members');
    await b.page.bringToFront(); await b.page.locator('#friend-feedback').scrollIntoViewIfNeeded();
    await shot(b.page, 'two-profile-joined-next-steps');
  },
  async used() {
    console.log('STEP used: a redeemed invitation remains locally previewable, but second PC gets fresh-code recovery.');
    const node = await relay('One-use Garden'), invite = await node.createInvite({ hours: 1 });
    const a = await launch('used-a'), b = await launch('used-b');
    await check(a.page, invite.code, 'First host'); await wait(a.page, () => !document.querySelector('#join-friend').disabled);
    await click(a.page, '#join-friend'); await idle(a.page);
    await check(b.page, invite.code, 'Second host'); await wait(b.page, () => !document.querySelector('#join-friend').disabled);
    await click(b.page, '#join-friend'); await idle(b.page);
    assert.match(await b.page.locator('#join-friend-feedback').textContent(), /already used.*ask.*new code/is);
    assert.ok(await b.page.locator('#friend-code').inputValue() === invite.code, 'used-code failure retains input');
    assert.equal((await state(b.page)).relay, null); assert.equal(node.trusted.length, 1);
    await shot(b.page, 'already-used-request-new-code');
  },
  async conflict() {
    console.log('STEP conflict: other-group code is locally reviewable but cannot replace saved relay automatically.');
    const { page } = await launch('conflict'); const current = await relay('Current Garden'), other = await relay('Other Garden');
    await check(page, (await current.createInvite({ hours: 1 })).code); await wait(page, () => !document.querySelector('#join-friend').disabled);
    await click(page, '#join-friend'); await idle(page);
    const otherInvite = await other.createInvite({ hours: 1 }); await check(page, otherInvite.code);
    await wait(page, () => !document.querySelector('#invitation-preview').hidden);
    assert.equal(await page.locator('#join-friend').isDisabled(), true, 'other-group invitation must be blocked before consent');
    assert.match(await page.locator('#join-friend-feedback').textContent(), /different group.*Settings.*Network.*Relay.*None.*Save/is);
    assert.equal((await state(page)).relay.fingerprint, current.identity.fingerprint); assert.equal(other.trusted.length, 0);
    assert.ok(await page.locator('#friend-code').inputValue() === otherInvite.code);
    await shot(page, 'different-group-settings-guidance');
  },
  async stopped() {
    console.log('STEP stopped guard: deliberately run an isolated Node process fixture (NOT Minecraft), block join until stopped.');
    const { app, page } = await launch('stopped'); const node = await relay(), invite = await node.createInvite({ hours: 1 });
    const source = path.join(root, 'Stopped-guard fixture NOT Minecraft'); await mkdir(source); await writeFile(path.join(source, 'eula.txt'), 'eula=true\n');
    await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, source);
    await click(page, '#operate-tab'); await click(page, '#import-server'); await idle(page);
    await page.evaluate(profile => window.seedhost.call('saveProfile', profile), { executable: process.execPath, args: [path.join(project, 'tools/fake-java-server.mjs')], startTimeoutSeconds: 10, stopTimeoutSeconds: 10 });
    await page.reload(); await idle(page);
    try {
      await click(page, '#start-server'); await wait(page, () => document.querySelector('#server-status').textContent === 'Hosting');
      await click(page, '#peers-tab'); await check(page, invite.code); await wait(page, () => !document.querySelector('#invitation-preview').hidden);
      assert.equal(await page.locator('#join-friend').isDisabled(), true, 'server must be stopped before joining');
      assert.match(await page.locator('#join-friend-feedback').textContent(), /Stop.*server.*join/i);
      assert.equal(node.trusted.length, 0); await shot(page, 'running-fixture-join-blocked');
    } finally {
      if (['running', 'starting'].includes((await state(page)).server?.state)) await page.evaluate(() => window.seedhost.call('stopServer'));
      await idle(page);
    }
    await wait(page, () => !document.querySelector('#join-friend').disabled);
    assert.equal((await state(page)).server.state, 'offline');
  },
  async chooser() {
    console.log('STEP chooser: one intent panel; no-group actions; play-only and same wizard controls.');
    const { page } = await launch('chooser');
    assert.equal(await page.locator('#friends-intent-join').count(), 1, 'missing clear two-button intent chooser');
    assert.equal(await page.locator('#friends-intent-invite').count(), 1);
    assert.equal(await page.locator('#join-friend-details').isVisible(), true);
    assert.equal(await page.locator('#invite-panel').isVisible(), false);
    await click(page, '#friends-intent-invite');
    assert.equal(await page.locator('#join-friend-details').isVisible(), false);
    assert.equal(await page.locator('#create-invite').isVisible(), false, 'no dead invite button without a group');
    assert.equal(await page.locator('#friends-setup-hosting').isEnabled(), true);
    await shot(page, 'no-group-invite');
    await click(page, '#friends-setup-hosting');
    await wait(page, () => document.querySelector('#setup-dialog').open && !document.querySelector('#setup-gateway').hidden);
    await click(page, '#setup-save-close'); await wait(page, () => !document.querySelector('#setup-dialog').open);
    await click(page, '#friends-use-invitation');
    assert.equal(await page.locator('#join-friend-details').isVisible(), true);
    const before = await state(page);
    await click(page, '#friends-play-only');
    assert.equal(await page.locator('#operate-panel').isVisible(), true);
    assert.equal(await page.locator('#join-help').isVisible(), true);
    assert.match(await page.locator('#join-help').textContent(), /Minecraft.*address|address.*Minecraft/i);
    const after = await state(page); assert.deepEqual(after.settings, before.settings); assert.equal(after.relay, before.relay);
    await click(page, '#nav-setup'); await click(page, '[data-setup-step="server"]'); await idle(page);
    if (await page.locator('#setup-back').isVisible()) await click(page, '#setup-back');
    await click(page, '#setup-choose-join');
    await wait(page, () => document.querySelector('#friends-controls').parentElement.id === 'setup-friends-slot');
    assert.equal(await page.locator('#friends-controls').count(), 1);
    assert.equal(await page.locator('#friends-intent-join').getAttribute('aria-pressed'), 'true');
    await shot(page, 'wizard-join-intent');
    await click(page, '#setup-save-close'); await wait(page, () => !document.querySelector('#setup-dialog').open);
    await wait(page, () => document.activeElement.id === 'nav-setup');
    assert.equal(await page.locator('#advanced-peers').getAttribute('open'), null);
    assert.match(await page.locator('#advanced-peers').textContent(), /loopback.only/i);
  },
};

const selected = process.argv.find(arg => arg.startsWith('--case='))?.slice(7);
try {
  const names = selected === undefined ? Object.keys(cases) : selected.split(',');
  for (const name of names) assert.ok(Object.hasOwn(cases, name) && typeof cases[name] === 'function', 'Unknown regression case: ' + name);
  for (const name of names) {
    await cases[name](); console.log('PASS case=' + name);
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
  console.log('ARTIFACT_DIR=' + root);
}
