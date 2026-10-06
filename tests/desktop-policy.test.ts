import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

test('packaged builds do not expose DevTools in the application menu', async () => {
  const { applicationMenuTemplate } = await import('../apps/desktop/menu.js');
  const roles = (packaged: boolean) => JSON.stringify(applicationMenuTemplate(packaged, { show() {}, quit() {} }));
  assert.match(roles(false), /toggleDevTools/);
  assert.doesNotMatch(roles(true), /toggleDevTools|forceReload/);
  assert.match(roles(true), /Quit safely/);
});

test('desktop checks resolve Electron through its package rather than a Windows-only path', async () => {
  const banned = 'electron' + '.exe';
  for (const directory of ['tests', 'tools']) {
    for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !/\.(?:[cm]?[jt]s)$/.test(entry.name)) continue;
      const file = path.join(entry.parentPath, entry.name);
      const text = await readFile(file, 'utf8');
      assert.equal(text.includes(banned), false, `${file} hardcodes ${banned}`);
    }
  }
});
