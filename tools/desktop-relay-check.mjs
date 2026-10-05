// Visible relay check: a real headless relay process, two real desktop instances, and the original host closed
// while the other PC claims the server. Only native consent dialogs are answered by QA. Fixture is NOT Minecraft.
import assert from 'node:assert/strict';
import { dismissInitialSetup, reveal } from './desktop-test-setup.mjs';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

const electronPath = createRequire(import.meta.url)('electron');
const linuxKeyring = process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : [];
const project = process.cwd();
await mkdir('.test-data', { recursive: true });
const root = await mkdtemp(path.resolve('.test-data/desktop-relay-'));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const cli = path.join(project, 'dist/src/relay/cli.js');
const relayRoot = path.join(root, 'relay');
const errors = [];

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args]);
    let out = '';
    child.stdout.on('data', (data) => { out += data; });
    child.stderr.on('data', (data) => { out += data; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`relay ${args[0]} exited ${code}: ${out}`)));
  });
}
async function launch(name) {
  const app = await electron.launch({ executablePath: electronPath, args: [...linuxKeyring, path.join(project, 'dist/apps/desktop/main.js'), '--profile-root=' + path.join(root, name)], env });
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.waitForFunction(() => document.querySelector('#app-version').textContent.includes('v0.3.0'));
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await dismissInitialSetup(page);
  return { app, page };
}
const state = (page) => page.evaluate(() => window.seedhost.call('getState'));
/** Poll app state from Node. (page.waitForFunction treats an async predicate's Promise as truthy and returns at once.) */
async function until(page, predicate, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await state(page);
    if (predicate(current)) return current;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}; busy=${current.busy}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const idle = (page) => until(page, (s) => !s.busy, 'idle');
async function click(page, selector) { await page.bringToFront(); await reveal(page, selector); await page.locator(selector).click(); }
async function useRelay(page, fingerprint, host, port) {
  await page.bringToFront();
  await page.locator('#advanced-peers').evaluate((el) => { el.open = true; });
  await page.locator('#add-peer-details').evaluate((el) => { el.open = true; });
  await reveal(page, '#peer-name');
  await page.locator('#peer-name').fill('Mini PC relay');
  await page.locator('#peer-fingerprint').fill(fingerprint);
  await page.locator('#peer-host').fill(host);
  await page.locator('#peer-port').fill(String(port));
  await click(page, '#add-peer'); await idle(page);
  await click(page, '#settings-tab');
  await reveal(page, '#relay-peer');
  await page.locator('#relay-peer').selectOption(fingerprint);
  await click(page, '#save-settings');
  await page.waitForFunction(() => !document.querySelector('#relay-card').hidden);
  await idle(page);
  await click(page, '#peers-tab');
}
async function profile(page) {
  await page.bringToFront();
  await page.locator('#profile-details').evaluate((el) => { el.open = true; });
  await reveal(page, '#java-executable');
  await page.locator('#java-executable').fill(process.execPath);
  await page.locator('#java-args').fill(JSON.stringify([path.join(project, 'tools/fake-java-server.mjs')]));
  await click(page, '#save-profile');
  await page.waitForFunction(() => !document.querySelector('#start-server').disabled);
}
const holder = (page, text) => page.waitForFunction((text) => document.querySelector('#relay-holder').textContent === text, text);

let relay, a, b;
try {
  console.log('STEP 1: Initialize and start the headless relay process (loopback).');
  const fingerprint = /FINGERPRINT=([a-f0-9]{64})/.exec(await run(['init', '--root', relayRoot]))[1];
  console.log('STEP 2: Launch two visible desktop instances and trust them on the relay.');
  a = await launch('a'); b = await launch('b');
  for (const [name, instance] of [['Desktop A', a], ['Laptop B', b]]) await run(['trust', '--root', relayRoot, '--name', name, '--fingerprint', (await state(instance.page)).deviceId]);
  relay = spawn(process.execPath, [cli, 'serve', '--root', relayRoot, '--port', '0']);
  const [, host, port] = await new Promise((resolve, reject) => {
    const lines = createInterface({ input: relay.stdout });
    const timer = setTimeout(() => reject(new Error('relay did not start')), 10000);
    lines.on('line', (line) => { const match = /^LISTENING=([0-9.]+):(\d+)$/.exec(line); if (match) { clearTimeout(timer); resolve(match); } });
  });
  for (const { page } of [a, b]) await useRelay(page, fingerprint, host, Number(port));

  console.log('STEP 3: A imports, hosts, edits, stops, and parks the server on the relay through the visible control.');
  const source = path.join(root, 'Disposable fixture - NOT Minecraft');
  await mkdir(source); await writeFile(path.join(source, 'eula.txt'), 'eula=true\n'); await writeFile(path.join(source, 'world.bin'), 'original');
  await a.app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, source);
  await click(a.page, '#import-server');
  await a.page.waitForFunction(() => document.querySelector('#server-name').textContent.includes('NOT Minecraft'));
  await profile(a.page);
  await click(a.page, '#start-server'); await a.page.waitForFunction(() => document.querySelector('#server-status').textContent === 'Hosting');
  await writeFile(path.join((await state(a.page)).server.serverDir, 'world.bin'), 'played on A');
  await click(a.page, '#stop-server'); await a.page.waitForFunction(() => document.querySelector('#server-status').textContent === 'Stopped'); await idle(a.page);
  await click(a.page, '#park-relay'); await idle(a.page);
  await holder(a.page, 'WAITING ON ALWAYS-ON PC');
  assert.equal(await a.page.locator('#start-server').isDisabled(), true, 'A is fenced once the relay holds the server');
  await a.page.screenshot({ path: path.join(root, 'A-parked.png') });

  console.log('STEP 4: Close A completely. B, which has never had the server, claims it from the relay.');
  await a.app.close(); a = undefined;
  await b.page.bringToFront(); await click(b.page, '#check-relay'); await holder(b.page, 'WAITING ON ALWAYS-ON PC');
  await click(b.page, '#claim-relay'); await idle(b.page);
  await b.page.waitForFunction(() => document.querySelector('#ownership-state').textContent.includes('this device'));
  const claimed = await state(b.page);
  assert.equal(await readFile(path.join(claimed.server.serverDir, 'world.bin'), 'utf8'), 'played on A');
  assert.equal(claimed.server.profile.executable, '', 'B does not inherit the executable path from A');
  await holder(b.page, 'WITH LAPTOP B');
  assert.equal(await b.page.locator('#peer-list button').count(), 0, 'the relay peer offers no direct send/handoff buttons');
  await profile(b.page);
  await click(b.page, '#start-server'); await b.page.waitForFunction(() => document.querySelector('#server-status').textContent === 'Hosting');
  await writeFile(path.join(claimed.server.serverDir, 'world.bin'), 'played on B');
  await click(b.page, '#stop-server'); await b.page.waitForFunction(() => document.querySelector('#server-status').textContent === 'Stopped'); await idle(b.page);
  await b.page.screenshot({ path: path.join(root, 'B-claimed.png') });

  console.log('STEP 5: B enables park-on-stop, hosts again, and a clean stop parks the server automatically. Then B closes.');
  await click(b.page, '#settings-tab'); await reveal(b.page, '#park-on-stop'); await b.page.locator('#park-on-stop').check(); await click(b.page, '#save-settings'); await idle(b.page);
  await until(b.page, (s) => s.relay?.parkOnStop === true, 'park-on-stop setting');
  await click(b.page, '#peers-tab');
  await click(b.page, '#start-server'); await b.page.waitForFunction(() => document.querySelector('#server-status').textContent === 'Hosting');
  await click(b.page, '#stop-server'); await idle(b.page);
  await until(b.page, (s) => !s.busy && s.server.ownership.owner === s.relay.fingerprint, 'park-on-stop');
  const parkLogs = (await state(b.page)).logs;
  assert.ok(parkLogs.some((line) => line.startsWith('Parked ')), 'park-on-stop reported the park: ' + JSON.stringify(parkLogs.filter((line) => !line.startsWith('fixture') && !line.startsWith('console:'))));
  await b.app.close(); b = undefined;

  console.log('STEP 6: A comes back and claims the newest revision, skipping the generations it missed.');
  a = await launch('a');
  await click(a.page, '#check-relay'); await holder(a.page, 'WAITING ON ALWAYS-ON PC');
  await click(a.page, '#claim-relay'); await idle(a.page);
  await a.page.waitForFunction(() => document.querySelector('#ownership-state').textContent.includes('this device'));
  const back = await state(a.page);
  assert.equal(back.server.ownership.generation, 4);
  assert.equal(await readFile(path.join(back.server.serverDir, 'world.bin'), 'utf8'), 'played on B');
  assert.equal(await readFile(path.join(source, 'world.bin'), 'utf8'), 'original', 'imported source untouched');
  await a.page.screenshot({ path: path.join(root, 'A-reclaimed.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: Real relay process; A parked, closed; B claimed with A off; park-on-stop; A reclaimed generation 4. Fixture is NOT Minecraft.');
  console.log('ARTIFACT_DIR=' + root);
} catch (error) {
  for (const [name, instance] of [['a', a], ['b', b]]) if (instance && !instance.page.isClosed()) await instance.page.screenshot({ path: path.join(root, name + '-failed.png') }).catch(() => {});
  console.error('FAIL:', error);
  process.exitCode = 1;
} finally {
  if (a || b) { console.log('Holding visible windows for 90 seconds for inspection.'); await new Promise((resolve) => setTimeout(resolve, 90000)); }
  if (a) await a.app.close();
  if (b) await b.app.close();
  if (relay && relay.exitCode === null) relay.kill('SIGTERM');
}
