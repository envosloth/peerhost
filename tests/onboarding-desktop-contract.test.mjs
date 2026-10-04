import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Source regression complements the real Electron check; not proof of execution.
test('sandbox bridge exposes every setup action through a validated native main handler', async () => {
  const preload = await readFile(new URL('../apps/desktop/preload.cts', import.meta.url), 'utf8');
  const main = await readFile(new URL('../apps/desktop/main.ts', import.meta.url), 'utf8');
  for (const method of ['listServerVersions','discoverJava','pickJava','createServer','configureSimpleProfile','saveGameGateway','checkGameGateway','openSetupLink']) {
    assert.ok(preload.includes(`'${method}'`), `${method} must be exposed in the sandbox bridge`);
    assert.match(main, new RegExp(`case '${method}'`), `${method} needs a native main handler`);
  }
  assert.match(main, /validateCall\(method,payload/);
  assert.match(main, /nodeIntegration:false,contextIsolation:true,sandbox:true/);
});

test('frameless window chrome is wired through the same validated bridge', async () => {
  const preload = await readFile(new URL('../apps/desktop/preload.cts', import.meta.url), 'utf8');
  const main = await readFile(new URL('../apps/desktop/main.ts', import.meta.url), 'utf8');
  for (const method of ['getWindowState', 'windowMinimize', 'windowToggleFullscreen', 'windowClose', 'quitApp']) {
    assert.ok(preload.includes(`'${method}'`), `${method} must be exposed in the sandbox bridge`);
    assert.match(main, new RegExp(`case '${method}'`), `${method} needs a native main handler`);
  }
  assert.match(main, /frame:false/, 'custom title bar replaces the native frame');
});
