// Visible mods check: real Electron UI and native-dialog paths. Only file pickers and confirmations are answered.
import assert from 'node:assert/strict';
import { dismissInitialSetup, reveal } from './desktop-test-setup.mjs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { writeZip } from '../dist/src/core/zip.js';

const electronPath = createRequire(import.meta.url)('electron');
const linuxKeyring = process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : [];
const project = process.cwd();
await mkdir('.test-data', { recursive: true });
const root = await mkdtemp(path.resolve('.test-data/desktop-mods-'));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const errors = [];
const state = (page) => page.evaluate(() => window.seedhost.call('getState'));
async function until(page, predicate, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await state(page);
    if (predicate(current)) return current;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const idle = (page) => until(page, (s) => !s.busy, 'idle');
async function click(page, selector) { await page.bringToFront(); await reveal(page, selector); await page.locator(selector).click(); }
async function jar(name) { const file = path.join(root, 'downloads', name); await writeZip(file, [{ name: 'fabric.mod.json', data: Buffer.from(`{"id":"${name}"}`) }]); return file; }

let app;
try {
  console.log('STEP 1: Launch the visible app and import a fixture server.');
  await mkdir(path.join(root, 'downloads'));
  const source = path.join(root, 'Modded fixture - NOT Minecraft');
  await mkdir(path.join(source, 'mods'), { recursive: true });
  await writeFile(path.join(source, 'eula.txt'), 'eula=true\n');
  app = await electron.launch({ executablePath: electronPath, args: [...linuxKeyring, path.join(project, 'dist/apps/desktop/main.js'), '--profile-root=' + path.join(root, 'profile')], env });
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.waitForFunction(() => document.querySelector('#app-version').textContent.includes('v0.4.0'));
  await app.evaluate(({ dialog }, source) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    dialog.showMessageBox = async () => ({ response: 1 });
  }, source);
  await dismissInitialSetup(page);
  await click(page, '#import-server'); await idle(page);
  await page.locator('#mods-details').evaluate((el) => { el.open = true; });

  console.log('STEP 2: Add two server mods through the native picker.');
  const serverMods = [await jar('lithium.jar'), await jar('create.jar')];
  await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, serverMods);
  await click(page, '#add-server-mods'); await idle(page);
  await page.waitForFunction(() => document.querySelectorAll('#server-mods .mod-item').length === 2);

  console.log('STEP 3: Add client-only mods; they must not reach the server mods folder.');
  const clientMods = [await jar('iris.jar'), await jar('xaeros-minimap.jar')];
  await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, clientMods);
  await click(page, '#add-client-mods'); await idle(page);
  await page.waitForFunction(() => document.querySelectorAll('#client-mods .mod-item').length === 2);
  const current = await state(page);
  assert.deepEqual((await readdir(path.join(current.server.serverDir, 'mods'))).sort(), ['create.jar', 'lithium.jar']);
  assert.equal(await page.locator('#mods-summary').textContent(), '2 server · 2 client');
  await page.screenshot({ path: path.join(root, 'mods-panel.png') });

  console.log('STEP 4: A text file renamed to .jar is refused with a visible error.');
  const fake = path.join(root, 'downloads', 'fake.jar'); await writeFile(fake, 'not a jar');
  await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [fake]);
  await click(page, '#add-server-mods');
  await page.waitForFunction(() => !document.querySelector('#error-banner').hidden && document.querySelector('#error-text').textContent.includes('not a valid jar'));
  await idle(page);

  console.log('STEP 5: Remove a server mod through its button and the native confirmation.');
  await click(page, '#server-mods button[data-name="lithium.jar"]'); await idle(page);
  await page.waitForFunction(() => document.querySelectorAll('#server-mods .mod-item').length === 1);

  console.log('STEP 6: Export the client pack through the native save dialog.');
  const destination = path.join(root, 'exported', 'players.zip');
  await mkdir(path.dirname(destination));
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, destination.replace(/\.zip$/, ''));
  await click(page, '#export-client-pack'); await idle(page);
  const zip = await readFile(destination);
  assert.ok(zip.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])), 'a real zip was written, with .zip appended');
  assert.ok((await state(page)).logs.some((line) => line.startsWith('Exported 2 client mod(s)')));
  assert.deepEqual(errors, []);
  console.log('PASS: Visible mods panel: add server + client mods via picker, invalid jar refused, remove, client pack exported. Fixture is NOT Minecraft.');
  console.log('ARTIFACT_DIR=' + root);
} catch (error) {
  console.error('FAIL:', error);
  process.exitCode = 1;
} finally {
  if (app) { console.log('Holding the visible window for 30 seconds for inspection.'); await new Promise((resolve) => setTimeout(resolve, 30000)); await app.close(); }
}
