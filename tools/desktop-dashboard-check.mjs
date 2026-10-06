// Visible real Electron/main/preload/backend + an official Minecraft Java server.
// Native dialog answers alone are substituted. Profiles, downloads and worlds stay in scratch.
// Loopback only; Minecraft status and console commands are not authenticated gameplay/WAN proof.
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { desktopArtifactLaunch } from './desktop-artifact-launch.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron } from 'playwright';
import { ServerSetupClient, probeJava } from '../dist/src/core/server-setup.js';
import { dismissInitialSetup } from './desktop-test-setup.mjs';

assert.ok(process.env.TMPDIR, 'An isolated scratch root is required');
const java = process.env.SEEDHOST_SMOKE_JAVA;
assert.ok(java && path.isAbsolute(java), 'An explicitly approved installed Java runtime is required');
assert.equal(process.env.SEEDHOST_SMOKE_ACCEPT_EULA, 'true', 'Explicit disposable-test EULA acceptance is required');
const root = await mkdtemp(path.join(process.env.TMPDIR, 'seedhost-real-dashboard-'));
const profile = path.join(root, 'profile');
await mkdir(profile);
const evidence = { root, java, steps: [], errors: [], limitations: ['Loopback only, not two-network proof.', 'Status and console verified; no authenticated Minecraft player/gameplay test.', 'Native confirmation answers substituted; production IPC/backend unchanged.'] };
console.log('ARTIFACT_DIR=' + root);
const step = text => { console.log('STEP ' + (evidence.steps.length + 1) + ': ' + text); evidence.steps.push(text); };
const portServer = createServer();
await new Promise((resolve, reject) => { portServer.once('error', reject); portServer.listen(0, '127.0.0.1', resolve); });
const port = portServer.address().port;
await new Promise(resolve => portServer.close(resolve));
let app, page;
const packed = process.env.SEEDHOST_APP_EXECUTABLE;
const env = { ...process.env, SEEDHOST_TEST_LOOPBACK: '1' };
delete env.ELECTRON_RUN_AS_NODE; delete env.SEEDHOST_ACCOUNT_SERVICE;
const state = () => page.evaluate(() => window.seedhost.call('getState'));
async function idle() { await page.waitForFunction(() => document.querySelector('#activity-message').textContent.startsWith('Ready'), undefined, { timeout: 300000 }); }
async function click(selector) { await page.bringToFront(); await page.locator(selector).click(); await idle(); }
async function fill(selector, value) { await page.bringToFront(); await page.locator(selector).fill(value); }
async function screenshot(name) {
  await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))); });
  const file = path.join(root, name + '.png'); await page.screenshot({ path: file }); console.log('SCREENSHOT=' + file);
}
async function answer(value) { await app.evaluate((_electron, value) => { globalThis.__dashboardAnswer = value; }, value); }
async function launch() {
  app = await _electron.launch({ ...desktopArtifactLaunch(path.resolve('.'), profile, packed), env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => evidence.errors.push(error.message));
  await page.bringToFront(); await page.waitForFunction(() => document.querySelector('#splash').hidden); await idle();
  await app.evaluate(({ dialog }) => {
    globalThis.__dashboardAnswer = 1;
    dialog.showMessageBox = async () => ({ response: globalThis.__dashboardAnswer });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.__dashboardSource] });
  });
}
try {
  evidence.runtime = await probeJava(java);
  step('Download checksum-verified official Vanilla 1.21.1 into scratch; bind only 127.0.0.1');
  await mkdir(path.join(root, 'downloads'));
  const prepared = await new ServerSetupClient().prepare(path.join(root, 'downloads'), { name: 'Dashboard test', loader: 'vanilla', gameVersion: '1.21.1', javaExecutable: java, memoryMiB: 1024, eulaAccepted: true });
  await writeFile(path.join(prepared.sourceDir, 'server.properties'), `server-ip=127.0.0.1\nserver-port=${port}\nonline-mode=true\nlevel-seed=12345\nlevel-type=minecraft:flat\ngenerate-structures=false\nview-distance=2\nsimulation-distance=2\nmax-players=2\nmax-tick-time=120000\nmotd=Isolated dashboard test\npvp=true\nwhite-list=false\n`);
  await writeFile(path.join(prepared.sourceDir, 'dashboard-note.txt'), 'Isolated test note\n');
  const sources = [];
  for (const name of ['Mossy Hollow', 'Sky Islands']) { const dir = path.join(root, name); await cp(prepared.sourceDir, dir, { recursive: true }); sources.push(dir); }
  await launch();
  assert.equal((await page.evaluate(() => window.seedhost.call('getWindowState'))).fullScreen, true);
  await dismissInitialSetup(page);
  step('Import two managed copies through visible Home controls; source folders stay unchanged');
  for (const dir of sources) {
    await app.evaluate((_electron, dir) => { globalThis.__dashboardSource = dir; }, dir);
    await click('#import-server');
    if (await page.locator('#setup-dialog').evaluate(d => d.open)) await click('#setup-save-close');
  }
  assert.equal(await page.locator('#server-list .server-row').count(), 2);
  const library = (await state()).servers;
  const firstId = library.find(s => s.name === 'Mossy Hollow').id, secondId = library.find(s => s.name === 'Sky Islands').id;
  await screenshot('home');
  await click(`#server-list [data-action="open"][data-id="${firstId}"]`);
  await click('#server-settings-tab');
  await click('#profile-details > summary');
  await fill('#java-executable', java); await fill('#java-args', JSON.stringify(prepared.profile.args));
  await fill('#start-timeout', '300'); await fill('#stop-timeout', '120'); await click('#save-profile');
  assert.equal((await state()).server.profile.executable, java);
  step('Save numeric and boolean server properties through real IPC and verify actual disk bytes');
  await page.waitForFunction(() => document.querySelector('#property-max-players').value === '2');
  assert.equal(await page.locator('#property-pvp').isChecked(), true);
  await fill('#property-max-players', '3'); await page.locator('#property-pvp').uncheck(); await click('#properties-save');
  await page.waitForFunction(() => document.querySelector('#properties-feedback').textContent.includes('Verified'));
  let managed = (await state()).server.serverDir;
  assert.match(await readFile(path.join(managed, 'server.properties'), 'utf8'), /max-players=3/);
  assert.match(await readFile(path.join(managed, 'server.properties'), 'utf8'), /pvp=false/);
  assert.match(await readFile(path.join(sources[0], 'server.properties'), 'utf8'), /max-players=2/);
  await screenshot('settings');
  step('Edit a managed text file with native Cancel/Approve and hash-guarded read-back');
  await click('#server-files-tab');
  await page.waitForFunction(() => document.querySelector('#file-list').textContent.includes('dashboard-note.txt'));
  await click('#file-list [data-path="dashboard-note.txt"]');
  await page.waitForFunction(() => document.querySelector('#file-editor').value === 'Isolated test note\n');
  await fill('#file-editor', 'Saved through the real dashboard\n'); await answer(0); await click('#file-save');
  assert.equal(await readFile(path.join(managed, 'dashboard-note.txt'), 'utf8'), 'Isolated test note\n');
  await answer(1); await click('#file-save');
  await page.waitForFunction(() => document.querySelector('#file-feedback').textContent.includes('Verified'));
  assert.equal(await readFile(path.join(managed, 'dashboard-note.txt'), 'utf8'), 'Saved through the real dashboard\n');
  assert.equal(await readFile(path.join(sources[0], 'dashboard-note.txt'), 'utf8'), 'Isolated test note\n');
  await screenshot('files');
  step('Persist and manually run a stopped-world backup schedule; verify its real new revision');
  await click('#scheduler-tab'); await fill('#schedule-name', 'Verified backup'); await fill('#schedule-interval', '60'); await page.locator('#schedule-enabled').uncheck(); await click('#schedule-save');
  await page.waitForFunction(() => document.querySelector('#schedule-feedback').textContent.includes('Verified saved'));
  const before = (await state()).server.snapshotId;
  await click('#schedule-list [data-job-action="run"]');
  await page.waitForFunction(() => document.querySelector('#schedule-list').textContent.includes('Completed backup:'));
  assert.notEqual((await state()).server.snapshotId, before);
  await screenshot('scheduler');
  await click('#backups-tab'); await click('#refresh-snapshots');
  await page.waitForFunction(() => document.querySelectorAll('#snapshot-list li').length >= 1);
  await screenshot('backups');
  step('Start the actual official Minecraft server through visible controls and verify measured PID/resources/status');
  await click('#start-server');
  await page.waitForFunction(async () => (await window.seedhost.call('getState')).server?.state === 'running', undefined, { timeout: 300000 });
  await click('#operate-tab'); await click('#dashboard-refresh');
  await page.waitForFunction(() => document.querySelector('#performance-memory').textContent.includes('MiB'));
  await page.waitForFunction(() => document.querySelector('#performance-cpu').textContent.includes('%'), undefined, { timeout: 20000 });
  const dash = await page.evaluate(id => window.seedhost.call('getServerDashboard', { id }), firstId);
  assert.ok(dash.performance.pid > 0 && dash.performance.memoryMiB > 0 && Number.isFinite(dash.performance.cpuPercent));
  evidence.measured = dash.performance;
  await screenshot('performance');
  await click('#players-tab');
  await page.waitForFunction(() => document.querySelector('#players-count').textContent.includes('0 / 3'));
  assert.equal(dash.players.online, 0); assert.equal(dash.players.max, 3);
  await screenshot('players');
  step('Send a real Minecraft console mutation; prohibit switching to another world while running');
  await click('#console-tab'); await fill('#server-command', 'scoreboard objectives add dashboardCheck dummy'); await click('#send-command');
  await page.waitForFunction(() => document.querySelector('#console-lines').textContent.includes('dashboardCheck'));
  await screenshot('console');
  await click('#home-tab'); assert.equal(await page.locator(`#server-list [data-action="open"][data-id="${secondId}"]`).isDisabled(), true);
  step('Stop the real Minecraft process directly from Home; verify the stopped state and saved world');
  await click('#home-stop-first');
  assert.equal(await page.locator('#home-panel').isVisible(), true, 'Home remains open after stopping the server');
  assert.equal((await state()).server.state, 'offline');
  assert.equal((await state()).server.ownership.state, 'owned');
  assert.ok((await readFile(path.join(managed, 'world/data/scoreboard.dat'))).length > 0);
  step('All ten server sections are real accessible pages; app-wide group/tunnel scope remains explicit');
  await click(`#server-list [data-action="open"][data-id="${firstId}"]`);
  for (const section of ['operate', 'console', 'players', 'backups', 'scheduler', 'peers', 'mods', 'tunnels', 'server-settings', 'server-files']) {
    await click('#' + section + '-tab'); assert.equal(await page.locator('#' + section + '-panel').isVisible(), true);
  }
  assert.match(await page.locator('#multi-host-scope').textContent(), /app-wide/i);
  assert.match(await page.locator('#tunnels-scope').textContent(), /app-wide/i);
  await click('#home-tab'); await click(`#server-list [data-action="open"][data-id="${secondId}"]`);
  assert.equal((await state()).server.id, secondId);
  await click('#console-tab'); assert.doesNotMatch(await page.locator('#console-lines').textContent(), /dashboardCheck/);
  await click('#home-tab'); await screenshot('home-complete');
  assert.deepEqual(evidence.errors, []);
  evidence.pass = true;
  console.log('PASS real official Minecraft dashboard: ' + evidence.steps.length + ' stages, unchanged sources, managed writes, persisted schedules/backups, actual process/status, real console, guarded switching.');
  const hold = Math.max(0, Math.min(180, Number(process.argv.find(a => a.startsWith('--hold='))?.slice(7) ?? 90)));
  for (let remaining = hold; remaining > 0; remaining -= 10) { console.log('VISIBLE INSPECTION HOLD: ' + remaining + ' seconds'); await delay(Math.min(10, remaining) * 1000); }
} catch (error) {
  evidence.pass = false; evidence.error = error.stack; process.exitCode = 1; console.error(error);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
} finally {
  if (page && !page.isClosed()) { try { const s = await state(); if (s.server && ['running', 'starting'].includes(s.server.state)) await page.evaluate(() => window.seedhost.call('stopServer')); } catch (error) { evidence.cleanupError = error.message; process.exitCode = 1; } }
  if (app) await app.close().catch(error => { evidence.cleanupError = error.message; process.exitCode = 1; });
  evidence.exitCode = process.exitCode ?? 0;
  await writeFile(path.join(root, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log('RESULT_FILE=' + path.join(root, 'result.json'));
}
