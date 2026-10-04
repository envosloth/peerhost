// Real visible Electron + live Modrinth + loopback relay. No fabricated Modrinth responses.
// Run after npm run build. --static checks the renderer contract without opening a window.
// --mods-only exercises only the live catalogue/install path, not friends or relay handoff.
import assert from 'node:assert/strict';
import { dismissInitialSetup } from './desktop-test-setup.mjs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const html = await readFile(path.join(project, 'apps/desktop/index.html'), 'utf8');
const renderer = await readFile(path.join(project, 'apps/desktop/renderer.js'), 'utf8');
for (const id of ['mod-search-form', 'mod-query', 'mod-results', 'mod-loader', 'mod-game-version', 'save-mod-target', 'mod-next', 'mod-previous', 'create-invite', 'copy-invite', 'invite-code', 'join-friend-form', 'friend-name', 'friend-code', 'join-friend', 'refresh-friends', 'friend-list', 'friend-holder']) {
  assert.ok(html.includes(`id="${id}"`), `missing visible control #${id}`);
}
for (const method of ['searchMods', 'saveModTarget', 'installMod', 'openModPage', 'createInvite', 'joinWithInvite', 'listFriends']) assert.ok(renderer.includes(`'${method}'`), `missing bridge wiring ${method}`);
assert.ok(!renderer.includes('innerHTML'), 'external metadata must use safe DOM text');
assert.match(html, /img-src 'self' data: https:\/\/cdn\.modrinth\.com;/, 'catalogue icons allow only the validated Modrinth CDN');
if (process.argv.includes('--static')) {
  console.log('PASS: Browser/friends renderer controls and safe-text contract (static only).');
} else {
  const { _electron: electron } = await import('playwright');
  const { RelayNode } = await import('../dist/src/core/relay.js');
  const { createIdentity } = await import('../dist/src/core/peer-transport.js');
  const root = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'peerhost-browser-friends-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = createRequire(import.meta.url)('electron');
  const apps = [];
  const errors = [];
  const modsOnly = process.argv.includes('--mods-only');
  let relay;
  let clipboard;
  const getState = (page) => page.evaluate(() => window.peerhost.call('getState'));
  const wait = (page, expression, arg, timeout = 60000) => page.waitForFunction(expression, arg, { timeout });
  async function click(page, selector) { await page.bringToFront(); await page.locator(selector).click(); }
  async function settled(page) { await wait(page, () => document.querySelector('#activity-message').textContent.startsWith('Ready')); }
  async function launch(name) {
    const app = await electron.launch({ executablePath, args: [...(process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : []), path.join(project, 'dist/apps/desktop/main.js'), '--profile-root=' + path.join(root, name)], env });
    apps.push(app);
    const page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(String(error)));
    await settled(page);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await dismissInitialSetup(page);
    return { app, page };
  }
  async function join(page, code, name) {
    await page.locator('#friend-code').fill(code);
    await page.locator('#friend-name').fill(name);
    await click(page, '#join-friend');
    await wait(page, () => document.querySelector('#friend-feedback').textContent.includes('Joined'));
    await settled(page);
  }
  try {
    const a = await launch('a');
    clipboard = await a.app.evaluate(({ clipboard }) => clipboard.readText());
    let b;
    if (!modsOnly) {
    console.log('Checking validation before any join or network search.');
    await click(a.page, '#join-friend');
    await wait(a.page, () => document.querySelector('#friend-name').getAttribute('aria-invalid') === 'true');
    await a.page.locator('#dismiss-error').click();
    relay = new RelayNode(path.join(root, 'relay'), await createIdentity(), { name: 'QA relay', log: () => {} });
    await relay.open(); await relay.listen();
    await join(a.page, (await relay.createInvite({ hours: 1 })).code, 'Angel <QA>');
    assert.equal((await getState(a.page)).relay.parkOnStop, true);
    await click(a.page, '#create-invite');
    await wait(a.page, () => document.querySelector('#invite-code').value.startsWith('PEERHOST-'));
    const invitation = await a.page.locator('#invite-code').inputValue();
    await click(a.page, '#copy-invite');
    await wait(a.page, () => document.querySelector('#copy-invite').textContent === 'Copied');
    assert.equal(await a.app.evaluate(({ clipboard }) => clipboard.readText()), invitation);
    b = await launch('b');
    await join(b.page, invitation, 'Sam');
    await click(a.page, '#refresh-friends');
    await wait(a.page, () => document.querySelectorAll('#friend-list li').length === 2);
    assert.ok((await a.page.locator('#friend-list').textContent()).includes('Angel <QA>'));
    assert.equal(await a.page.locator('#friend-list qa').count(), 0, 'friend names are literal text');
    assert.deepEqual(relay.trusted.map((member) => member.name).sort(), ['Angel <QA>', 'Sam']);
    await a.page.screenshot({ path: path.join(root, 'friends-invitation-members.png') });
    }
    const source = path.join(root, 'Disposable QA server - NOT Minecraft');
    await mkdir(source); await writeFile(path.join(source, 'eula.txt'), 'eula=true\n');
    await a.app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, source);
    await click(a.page, '#import-server');
    await wait(a.page, () => document.querySelector('#server-name').textContent.includes('NOT Minecraft'));
    await settled(a.page);
    await a.page.locator('#mods-details > summary').click();
    await a.page.locator('#mod-loader').selectOption('fabric');
    await a.page.locator('#mod-game-version').fill('1.21.1');
    await click(a.page, '#save-mod-target');
    await wait(a.page, () => document.querySelector('#mod-target-feedback').textContent.includes('fabric 1.21.1'));
    await wait(a.page, () => document.querySelectorAll('#mod-results .mod-project').length > 0 && document.querySelector('#mod-results').getAttribute('aria-busy') === 'false');
    const first = await a.page.locator('#mod-results .mod-project').first().getAttribute('data-project-id');
    await click(a.page, '#mod-next');
    await wait(a.page, (first) => document.querySelector('#mod-results .mod-project')?.dataset.projectId !== first && document.querySelector('#mod-results').getAttribute('aria-busy') === 'false', first);
    await click(a.page, '#mod-previous');
    await wait(a.page, (first) => document.querySelector('#mod-results .mod-project')?.dataset.projectId === first && document.querySelector('#mod-results').getAttribute('aria-busy') === 'false', first);
    await a.page.locator('#mod-query').fill('peerhost-qa-no-such-mod-9f13c726');
    await a.page.locator('#mod-query').press('Enter');
    await wait(a.page, () => document.querySelector('#mod-search-status').textContent.includes('No compatible mods found'));
    assert.equal(await a.page.locator('#mod-next').isDisabled(), true);
    console.log('Searching live Modrinth for Lithium, cancelling then approving the native install dialog.');
    await a.page.locator('#mod-query').fill('lithium');
    await click(a.page, '#search-mods');
    await wait(a.page, () => document.querySelector('#mod-results [data-project-id="gvQqBUqZ"]') && document.querySelector('#mod-results').getAttribute('aria-busy') === 'false');
    await a.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    const install = '#mod-results [data-project-id="gvQqBUqZ"] button[data-install]';
    await click(a.page, install); await settled(a.page);
    assert.equal((await getState(a.page)).server.mods.server.length, 0, 'cancel leaves installed mods untouched');
    await a.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await click(a.page, install);
    await wait(a.page, () => document.querySelector('#server-mods').textContent.toLowerCase().includes('lithium'), undefined, 120000);
    await settled(a.page);
    const installed = await getState(a.page);
    assert.ok(installed.server.mods.server.some((mod) => mod.source?.projectId === 'gvQqBUqZ'), 'real backend records project provenance');
    assert.ok((await readdir(path.join(installed.server.serverDir, 'mods'))).some((file) => /lithium.*\.jar$/i.test(file)), 'real downloaded jar exists');
    await wait(a.page, () => document.querySelector('#mod-results [data-project-id="gvQqBUqZ"] button[data-install]').textContent === 'Repair / check');
    assert.equal(await a.page.locator(install).isDisabled(), false, 'existing projects keep the repair action reachable');
    // Seed a second supported destination through real, consented IPC, then remove
    // the server copy through its visible button: the client copy keeps Repair visible.
    await a.page.evaluate(() => window.peerhost.call('installMod', { projectId: 'gvQqBUqZ', targets: ['server', 'client'] }));
    await wait(a.page, () => document.querySelector('#client-mods').textContent.toLowerCase().includes('lithium'));
    await click(a.page, '#server-mods button[data-kind="server"]'); await settled(a.page);
    assert.equal((await getState(a.page)).server.mods.server.length, 0);
    assert.equal((await getState(a.page)).server.mods.client.length, 1);
    assert.equal(await a.page.locator(install).isDisabled(), false);
    await click(a.page, install);
    await wait(a.page, () => document.querySelector('#server-mods').textContent.toLowerCase().includes('lithium'), undefined, 120000);
    await settled(a.page);
    assert.ok((await getState(a.page)).server.mods.server.some(mod => mod.source?.projectId === 'gvQqBUqZ'), 'visible repair restores missing server side');
    await a.page.reload(); await settled(a.page);
    assert.ok((await getState(a.page)).server.mods.server.some((mod) => mod.source?.projectId === 'gvQqBUqZ'), 'provenance survives reload');
    assert.equal((await getState(a.page)).server.modTarget.gameVersion, '1.21.1');
    await a.page.locator('#mods-details > summary').click();
    await a.page.locator('#mod-query').fill('lithium');
    await click(a.page, '#search-mods');
    await wait(a.page, () => document.querySelector('#mod-results [data-project-id="gvQqBUqZ"] button[data-install]')?.textContent === 'Repair / check' && document.querySelector('#mod-results').getAttribute('aria-busy') === 'false');
    await wait(a.page, () => document.querySelector('#mod-results [data-project-id="gvQqBUqZ"] img')?.naturalWidth > 0);
    for (const [width, height] of [[1240, 860], [1000, 700]]) {
      await a.page.setViewportSize({ width, height });
      await a.page.locator('#mod-browser-heading').evaluate((el) => el.scrollIntoView({ block: 'start' }));
      const overflow = await a.page.evaluate(() => ['#mod-browser', '#peers-panel'].filter((selector) => { const el = document.querySelector(selector); return el.scrollWidth > el.clientWidth + 1; }));
      assert.deepEqual(overflow, [], `no browser/friends clipping at ${width}`);
      await a.page.screenshot({ path: path.join(root, `browser-friends-${width}.png`) });
    }
    if (!modsOnly) {
    console.log('Checking real relay holder updates through park and claim controls.');
    await click(a.page, '#refresh-friends');
    await wait(a.page, () => document.querySelector('#friend-holder').textContent.includes('unknown'));
    await click(a.page, '#park-relay'); await settled(a.page);
    await click(a.page, '#refresh-friends');
    await wait(a.page, () => document.querySelector('#friend-holder').textContent.includes('waiting on the always-on PC'));
    await click(b.page, '#claim-relay'); await settled(b.page);
    await wait(b.page, () => document.querySelector('#server-name').textContent === 'Received server');
    const claimed = await getState(b.page);
    assert.ok(claimed.server.mods.server.some(mod => mod.source?.projectId === 'gvQqBUqZ'), 'claimed server carries the real downloaded mod and its provenance');
    assert.equal(claimed.server.snapshotId, (await getState(a.page)).server.snapshotId, 'both profiles agree on the final revision');
    await click(a.page, '#refresh-friends');
    await wait(a.page, () => document.querySelector('#friend-holder').textContent === 'Hosting: Sam');
    assert.equal((await getState(b.page)).server.ownership.owner, (await getState(b.page)).deviceId);
    }
    assert.deepEqual(errors, []);
    console.log(modsOnly ? 'PASS: Mod-only visible check: live Modrinth popular/pagination/empty/search, native cancel/install, real jar + persisted provenance. Friends NOT exercised. Fixture is NOT Minecraft.' : 'PASS: Real relay invites, copy, join, members/holder park/claim; live Modrinth popular/pagination/empty/search, native cancel/install, real jar + persisted provenance. Fixture is NOT Minecraft.');
  } catch (error) {
    for (const [index, app] of apps.entries()) for (const page of app.windows()) if (!page.isClosed()) {
      console.error('UI DIAGNOSTIC:', await page.locator('#error-text').textContent(), await page.locator('#mod-search-status').textContent(), await page.locator('#friend-holder').textContent());
      await page.screenshot({ path: path.join(root, `failure-${index}.png`) }).catch(() => {});
    }
    console.error('FAIL:', error); process.exitCode = 1;
  } finally {
    if (apps[0] && clipboard !== undefined) await apps[0].evaluate(({ clipboard: cb }, previous) => cb.writeText(previous), clipboard).catch(() => {});
    for (const app of apps.reverse()) await app.close().catch(() => {});
    await relay?.close();
    console.log('ARTIFACT_DIR=' + root);
  }
}
