import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

const root = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'seed-library-ui-'));
const source = async (name) => {
  const dir = path.join(root, name);
  await mkdir(dir);
  await writeFile(path.join(dir, 'eula.txt'), 'eula=true\n');
  await writeFile(path.join(dir, 'world.bin'), name);
  return dir;
};
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: ['--no-sandbox', ...(process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : []), path.resolve('dist/apps/desktop/main.js'), '--profile-root=' + root],
  env,
});
try {
  const page = await app.firstWindow();
  const errors = []; page.on('pageerror', (error) => errors.push(String(error)));
  await page.waitForFunction(() => document.querySelector('#app-version')?.textContent.includes('0.5.0'));
  await page.waitForFunction(() => document.querySelector('#splash').hidden);
  await page.evaluate(() => document.querySelector('#setup-dialog')?.close?.());
  // Native answers only: cancel first for the delete, continue for everything else.
  await app.evaluate(({ dialog }) => {
    globalThis.__answer = 1;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.__next ?? ''] });
    dialog.showMessageBox = async () => ({ response: globalThis.__answer, checkboxChecked: false });
  });
  const answer = (value) => app.evaluate((_e, v) => { globalThis.__answer = v; }, value);
  const queueDir = (dir) => app.evaluate((_e, d) => { globalThis.__next = d; }, dir);

  // Home is the multi-server library: with no servers it shows the empty state and the one-running limit note.
  assert.equal(await page.locator('#home-panel').isVisible(), true, 'the app opens on Home');
  assert.equal(await page.locator('#server-list .server-row').count(), 0, 'no servers: no cards');
  assert.equal(await page.locator('#server-empty').isVisible(), true);
  assert.match(await page.locator('#home-concurrency').textContent(), /one server.*time/i, 'the one-running-server limit is visible');

  for (const name of ['alpha', 'bravo']) {
    await queueDir(await source(name));
    await page.locator('#import-server').click();
    try {
      await page.waitForFunction((n) => [...document.querySelectorAll('.server-row-name')].some((el) => el.textContent === n), name, { timeout: 15000 });
    } catch (error) {
      const state = await page.evaluate(() => window.seedhost.call('getState')).catch(() => null);
      console.log('DIAG servers=' + JSON.stringify(state?.servers) + ' busy=' + state?.busy);
      console.log('DIAG banner=' + (await page.locator('#error-text').textContent()));
      console.log('DIAG list=' + (await page.locator('#server-list').innerHTML()));
      console.log('DIAG errors=' + JSON.stringify(errors));
      throw error;
    }
  }
  const rows = page.locator('#server-list .server-row');
  assert.equal(await rows.count(), 2, 'both servers are listed as real cards');
  assert.equal(await page.locator('#server-list .server-row.is-current .server-row-name').textContent(), 'bravo', 'the newest import is in use');
  assert.equal(await page.locator('#server-list .server-row.is-current').getAttribute('class'), 'server-row is-current');
  assert.match(await page.locator('#server-list').textContent(), /Open server/, 'the active card opens its workspace');
  assert.equal(await page.locator('#server-list [data-action="select"]').count(), 0, 'no legacy switch action remains');

  // Switch to the first server through the card's visible control; the card opens the workspace.
  await rows.first().locator('button[data-action="open"]').click();
  await page.waitForFunction(() => document.querySelector('#server-name').textContent === 'alpha');
  await page.waitForFunction(() => document.querySelector('#server-list .server-row.is-current .server-row-name')?.textContent === 'alpha');
  assert.equal(await page.locator('#operate-panel').isVisible(), true, 'opening a card lands on the selected server workspace');
  assert.equal(await rows.filter({ hasText: 'alpha' }).locator('button[data-action="open"]').textContent(), 'Open server');

  // Back to Home for the library actions.
  await page.locator('#home-tab').click();

  // Cancelling the native confirmation deletes nothing.
  await answer(0);
  await page.locator('#server-list .server-row.is-current button[data-action="delete"]').click();
  await page.waitForFunction(() => document.querySelector('#activity-message').textContent.startsWith('Ready'));
  assert.equal(await rows.count(), 2, 'cancel keeps the server');
  assert.equal(await page.locator('#server-name').textContent(), 'alpha');

  // Approving deletes it and falls back to the remaining server.
  await answer(1);
  await page.locator('#server-list .server-row.is-current button[data-action="delete"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#server-list .server-row').length === 1);
  assert.equal(await page.locator('#server-list .server-row-name').textContent(), 'bravo');
  assert.equal(await page.locator('#server-name').textContent(), 'bravo', 'the app falls back to the server that is left');
  assert.equal(await page.locator('#server-list .server-row.is-current .server-row-name').textContent(), 'bravo');
  const stored = await page.evaluate(() => window.seedhost.call('getState'));
  assert.deepEqual(stored.servers.map((entry) => entry.name), ['bravo']);

  // The backup store is shared between servers: the one that is left must still take and list backups.
  const before = (await page.evaluate(() => window.seedhost.call('getState'))).server.snapshotId;
  await page.evaluate(() => window.seedhost.call('createSnapshot'));
  const after = (await page.evaluate(() => window.seedhost.call('getState'))).server.snapshotId;
  assert.notEqual(after, before, 'the remaining server still saves backups after another was deleted');
  await page.locator('#backups-tab').click();
  await page.locator('#refresh-snapshots').click();
  await page.waitForFunction(() => document.querySelectorAll('#snapshot-list li').length >= 1);
  assert.doesNotMatch(await page.locator('#snapshot-history-status').textContent(), /Couldn.t load backups/);

  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(root, 'library.png') });
  console.log('PASS visible Home library: import adds cards, open moves the workspace, cancel keeps, delete removes and falls back. Screenshot ' + path.join(root, 'library.png'));
} finally {
  await app.close();
}
