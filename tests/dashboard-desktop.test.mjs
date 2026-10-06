import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

// REAL main/preload/backend; isolated scratch profile. No server or network start.
const scratch = process.env.TMPDIR || (process.platform === 'win32' && path.join(process.env.LOCALAPPDATA, 'hermes/cache/scratch'));
if (!scratch) throw new Error('TMPDIR must identify the isolated Hermes scratch directory');
const launch = async () => {
  const root = await mkdtemp(path.join(scratch, 'seed-dashboard-window-'));
  const env = { ...process.env, SEEDHOST_TEST_LOOPBACK: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.resolve('dist/apps/desktop/main.js'), '--profile-root=' + root], env });
  const page = await app.firstWindow();
  await page.bringToFront();
  return { app, page, root };
};
const state = page => page.evaluate(() => window.seedhost.call('getWindowState'));

test('fresh launch occupies fullscreen; F11, Escape and window button retain borderless control', { timeout: 60000 }, async () => {
  const { app, page, root } = await launch();
  try {
    console.log('REAL Electron: inspect fresh native fullscreen before renderer interaction');
    assert.equal((await state(page)).fullScreen, true, 'fresh BrowserWindow must be fullscreen');
    assert.equal(app.windows().length, 1);
    await page.waitForFunction(() => document.querySelector('#splash').hidden);
    if (await page.locator('#setup-dialog').evaluate(d => d.open)) {
      await page.bringToFront(); await page.locator('#setup-later').click();
    }
    await page.waitForFunction(() => document.querySelector('#window-mode').dataset.mode === 'fullscreen');
    await mkdir(path.join(root, 'evidence'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'evidence/fullscreen.png') });
    console.log('REAL Electron screenshot: ' + path.join(root, 'evidence/fullscreen.png'));
    await page.bringToFront(); await page.locator('#window-mode').click();
    await page.waitForFunction(() => document.querySelector('#window-mode').dataset.mode === 'borderless');
    assert.equal((await state(page)).fullScreen, false);
    await page.bringToFront(); await page.keyboard.press('F11');
    await page.waitForFunction(() => document.querySelector('#window-mode').dataset.mode === 'fullscreen');
    await page.bringToFront(); await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#window-mode').dataset.mode === 'borderless');
    assert.equal((await state(page)).fullScreen, false);
    console.log('PASS REAL fullscreen → button borderless → F11 fullscreen → Escape borderless');
  } finally { app.process().kill(); await app.close().catch(() => {}); }
});
