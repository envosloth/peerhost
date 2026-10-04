// Real visible Electron/backend verification. ONLY native dialog answers are substituted.
// The imported Node process fixture is explicitly NOT Java or Minecraft.
// Run after npm run build; missing integration APIs are reported, never mocked.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { createServer, connect } from 'node:net';
import { RelayNode } from '../dist/src/core/relay.js';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { gatewayStatus } from '../dist/src/core/game-gateway.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'peerhost-onboarding-'));
const profile = path.join(root, 'profile');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let app, page, relay, echo;
const echoSockets = new Set();
const errors = [], blockers = [];
const requiredSetupMethods = ['saveOnboarding', 'listServerVersions', 'discoverJava', 'pickJava', 'createServer', 'configureSimpleProfile', 'listSnapshots', 'restoreSnapshot', 'saveGameGateway', 'checkGameGateway', 'openSetupLink'];
const compiledPreload = await readFile(path.join(project, 'dist/apps/desktop/preload.cjs'), 'utf8');
const compiledMain = await readFile(path.join(project, 'dist/apps/desktop/main.js'), 'utf8');
for (const method of requiredSetupMethods) {
  if (!compiledPreload.includes(`'${method}'`) && !compiledPreload.includes(`"${method}"`)) blockers.push(method + ': not exposed in compiled preload');
  else if (!new RegExp(`case ['"]${method}['"]`).test(compiledMain)) blockers.push(method + ': no compiled main handler');
}
const state = () => page.evaluate(() => window.peerhost.call('getState'));
const wait = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 30000 });
const settled = () => wait(() => document.querySelector('#activity-message').textContent.startsWith('Ready'));
async function launch() {
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [...(process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : []), path.join(project, 'dist/apps/desktop/main.js'), '--profile-root=' + profile], env });
  page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.bringToFront(); await settled();
  await page.context().newCDPSession(page).then(cdp => cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }));
}
async function click(id) { await page.bringToFront(); await page.locator('#' + id).click(); await settled(); }
async function native(response, folder = null) {
  await app.evaluate(({ dialog }, { response, folder }) => {
    dialog.showMessageBox = async () => ({ response });
    dialog.showOpenDialog = async () => folder ? ({ canceled: false, filePaths: [folder] }) : ({ canceled: true, filePaths: [] });
  }, { response, folder });
}
async function stage(name) { await page.locator(`[data-setup-step="${name}"]`).click(); await settled(); await wait(name => !document.querySelector('#setup-' + name).hidden, name); }
async function layout(label) {
  for (const [width, height] of [[1000, 700], [1240, 860]]) {
    await app.evaluate(({ BrowserWindow }, { width, height }) => BrowserWindow.getAllWindows()[0].setContentSize(width, height), { width, height });
    await page.setViewportSize({ width, height });
    const audit = await page.evaluate(() => {
      const d = document.querySelector('#setup-dialog');
      const buttons = ['setup-save-close', 'setup-next'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
      return { overflow: d.scrollWidth > d.clientWidth + 1, centered: Math.abs(d.getBoundingClientRect().left + d.getBoundingClientRect().width / 2 - innerWidth / 2) <= 1, buttons };
    });
    assert.equal(audit.overflow, false, label + ' horizontal overflow');
    assert.equal(audit.centered, true, label + ' centered modal');
    assert.equal(audit.buttons.every(Boolean), true, label + ' navigation stays visible');
    // Invitation strings are never captured: this tool never creates or pastes one.
    await page.screenshot({ path: path.join(root, `${label}-${width}.png`) });
  }
}
try {
  await launch();
  const initial = await state();
  assert.equal(initial.server, null);
  assert.ok(initial.onboarding, 'INTEGRATION BLOCKER: getState.onboarding missing');
  await wait(() => document.querySelector('#setup-dialog').open);
  assert.equal(await page.locator('#create-server-empty').textContent(), 'create a server');
  await native(0);
  for (const method of ['listServerVersions', 'discoverJava', 'checkGameGateway']) {
    const result = await page.evaluate(async method => { try { await window.peerhost.call(method); return null; } catch (e) { return e.message; } }, method);
    if (result && !blockers.some(b => b.startsWith(method + ':'))) blockers.push(method + ': ' + result);
  }
  assert.equal(await page.locator('#setup-create-form').isVisible(), false, 'first screen is a plain choice');
  await layout('fresh-choice');
  await click('setup-choose-create');
  await layout('fresh-server');
  await page.locator('#setup-name').fill('Durable onboarding draft');
  await page.locator('#setup-dialog').press('Escape');
  await wait(() => !document.querySelector('#setup-dialog').open);
  assert.equal((await state()).onboarding.draft.name, 'Durable onboarding draft');
  await click('nav-setup'); await stage('friends'); await layout('friends-empty');
  await click('setup-skip'); await wait(() => !document.querySelector('#setup-gateway').hidden);
  await layout('always-on-instructions'); await click('setup-skip');
  await click('setup-next'); await wait(() => !document.querySelector('#setup-dialog').open);
  assert.deepEqual((await state()).onboarding.skipped, ['friends', 'gateway']);
  await app.close(); app = null;
  await launch();
  assert.equal(await page.locator('#setup-dialog').isVisible(), false, 'dismissed setup stays closed after real relaunch');
  assert.deepEqual((await state()).onboarding.skipped, ['friends', 'gateway']);
  await click('nav-setup'); await stage('server');
  assert.equal(await page.locator('#setup-name').inputValue(), 'Durable onboarding draft');
  await native(0);
  await click('setup-back'); await click('setup-import'); assert.equal((await state()).server, null, 'cancelled native folder picker does not import');
  await click('setup-choose-create'); await click('setup-pick-java'); // Native cancel, if the new API is integrated.
  const pickerError = await page.locator('#setup-error').textContent();
  if (pickerError.includes('pickJava failed') && !blockers.some(b => b.startsWith('pickJava:'))) blockers.push('pickJava: ' + pickerError);
  const source = path.join(root, 'Node process fixture - NOT Minecraft');
  await mkdir(source); await writeFile(path.join(source, 'eula.txt'), 'eula=true\n'); await writeFile(path.join(source, 'world-marker.txt'), 'original\n');
  await click('setup-back'); await native(1, source); await click('setup-import');
  await wait(() => !document.querySelector('#setup-runtime').hidden);
  assert.notEqual((await state()).server.serverDir, source, 'managed copy created by real backend');
  await layout('imported-java-help');
  await click('setup-save-close'); await wait(() => !document.querySelector('#setup-dialog').open);
  const original = await state(), firstSnapshot = original.server.snapshotId;
  await wait(() => document.querySelectorAll('#snapshot-list li').length > 0);
  await writeFile(path.join(original.server.serverDir, 'world-marker.txt'), 'revised\n');
  await click('create-snapshot'); await wait(id => document.querySelector('#snapshot-id').textContent !== id, firstSnapshot);
  const revised = await state();
  await wait(id => document.querySelector(`#snapshot-list button[data-snapshot="${id}"]`), firstSnapshot);
  await native(0);
  await page.locator(`#snapshot-list button[data-snapshot="${firstSnapshot}"]`).click(); await settled();
  assert.equal((await state()).server.snapshotId, revised.server.snapshotId, 'cancelled restore leaves current revision intact');
  await native(1);
  await page.locator(`#snapshot-list button[data-snapshot="${firstSnapshot}"]`).click(); await settled();
  await wait(dir => document.querySelector('#server-directory').textContent !== dir, revised.server.serverDir);
  const restored = await state();
  assert.notEqual(restored.server.serverDir, revised.server.serverDir);
  assert.equal(await readFile(path.join(restored.server.serverDir, 'world-marker.txt'), 'utf8'), 'original\n');
  assert.equal(await readFile(path.join(revised.server.serverDir, 'world-marker.txt'), 'utf8'), 'revised\n', 'previous folder retained');
  assert.equal(restored.server.ownership.generation, revised.server.ownership.generation, 'ownership generation not rewound');
  const history = await page.evaluate(() => window.peerhost.call('listSnapshots'));
  assert.ok(history.some(s => s.id === revised.server.snapshotId), 'safety/revised snapshot retained');
  await page.locator('#profile-details').evaluate(node => { node.open = true; });
  await page.locator('#java-executable').fill(process.execPath);
  await page.locator('#java-args').fill(JSON.stringify([path.join(project, 'tools/fake-java-server.mjs'), '--lifetime-ms=120000']));
  await click('save-profile'); await click('start-server');
  await wait(() => document.querySelector('#server-status').textContent === 'Hosting');
  assert.equal(await page.locator('#snapshot-list button:enabled').count(), 0, 'restore blocked while running');
  await click('stop-server'); await wait(() => document.querySelector('#server-status').textContent === 'Stopped');
  assert.equal(await readFile(path.join(source, 'world-marker.txt'), 'utf8'), 'original\n', 'original imported source untouched');
  await page.screenshot({ path: path.join(root, 'history-stopped-node-fixture.png') });
  // Real relay plus socket echo fixture exercises visible gateway controls; not Minecraft.
  relay = new RelayNode(path.join(root, 'gateway-relay'), await createIdentity(), { log: () => {}, game: { host: '127.0.0.1', port: 0 } });
  await relay.open(); await relay.listen(); await relay.listenGame();
  await relay.trust('Visible host', (await state()).deviceId);
  echo = createServer(socket => { echoSockets.add(socket); socket.on('error', () => {}); socket.once('close', () => echoSockets.delete(socket)); socket.pipe(socket); });
  await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
  await click('peers-tab'); await page.locator('#advanced-peers').evaluate(node => { node.open = true; }); await page.locator('#add-peer-details').evaluate(node => { node.open = true; });
  for (const [id, value] of Object.entries({ 'peer-name': 'Visible relay', 'peer-fingerprint': relay.identity.fingerprint, 'peer-host': relay.endpoint.host, 'peer-port': String(relay.endpoint.port) })) await page.locator('#'+id).fill(value);
  await click('add-peer'); await click('settings-tab'); await page.locator('#relay-peer').selectOption(relay.identity.fingerprint); await page.locator('#park-on-stop').uncheck(); await click('save-settings');
  await click('peers-tab'); await click('park-relay'); await click('claim-relay');
  await page.locator('#profile-details').evaluate(node => { node.open = true; });
  await page.locator('#java-executable').fill(process.execPath); await page.locator('#java-args').fill(JSON.stringify([path.join(project, 'tools/fake-java-server.mjs'), '--lifetime-ms=120000'])); await click('save-profile');
  await click('nav-setup'); await stage('gateway'); await page.locator('#setup-gateway-enabled').check(); await page.locator('#setup-gateway-port').fill(String(echo.address().port)); await click('setup-gateway-save'); await click('setup-gateway-check');
  assert.match(await page.locator('#setup-gateway-status').textContent(), /Not ready/); assert.equal((await state()).gateway.enabled, true);
  await click('setup-save-close'); await click('start-server');
  const routeDeadline = Date.now()+20000;
  while (!(await page.evaluate(() => window.peerhost.call('checkGameGateway'))).ready) { if(Date.now()>routeDeadline) throw new Error('Visible host tunnel not ready'); await new Promise(resolve=>setTimeout(resolve,100)); }
  await click('nav-setup'); await stage('gateway'); await click('setup-gateway-check'); assert.match(await page.locator('#setup-gateway-status').textContent(), /Verified/);
  await page.screenshot({ path:path.join(root,'gateway-verified-visible.png') });
  const bytes = await new Promise((resolve,reject) => { const socket=connect({host:'127.0.0.1',port:relay.gameEndpoint.port}); socket.setTimeout(5000,()=>{socket.destroy();reject(new Error('Gateway echo timeout'));});socket.once('error',reject);socket.once('connect',()=>socket.write('visible gateway fixture'));socket.once('data',data=>{socket.destroy();resolve(data.toString());}); });
  assert.equal(bytes,'visible gateway fixture');
  await click('setup-save-close'); await click('stop-server');
  assert.equal((await page.evaluate(() => window.peerhost.call('checkGameGateway'))).ready,false);
  assert.equal((await state()).gateway.state,'off');
  assert.deepEqual(errors, []);
  console.log('PASS: Real Electron durable draft/ESC/skip/relaunch, native import cancel/approve, real snapshot list/native restore cancel/approve/safety folder, Node fixture Start/Stop; visible gateway save/not-ready/verified/stop and real pinned relay echo forwarding. NOT Minecraft.');
  if (blockers.length) { console.error('INTEGRATION BLOCKERS (no mocks):\n' + blockers.join('\n')); process.exitCode = 2; }
} catch (error) {
  console.error('FAIL:', error); process.exitCode = 1;
  if (page && !page.isClosed()) { console.error('UI ERROR:', await page.locator('#error-text').textContent()); await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); }
} finally {
  if (app) await app.close().catch(() => {});
  await relay?.close().catch(() => {});
  for (const socket of echoSockets) socket.destroy();
  if (echo) await new Promise(resolve => echo.close(resolve));
  await writeFile(path.join(root, 'result.json'), JSON.stringify({ errors, blockers, exitCode: process.exitCode ?? 0 }, null, 2));
  console.log('ARTIFACT_DIR=' + root);
}
