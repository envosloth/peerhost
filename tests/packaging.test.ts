import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import path from 'node:path';
test('Windows package points to the actual compiled Electron main and exposes reproducible verification commands',async()=>{
  const p=JSON.parse(await readFile('package.json','utf8'));
  assert.equal(p.main,'dist/apps/desktop/main.js');await access(path.resolve(p.main));
  assert.equal(p.scripts['check:desktop'],'npm run build && node tools/desktop-check.mjs');
  assert.equal(p.scripts['check:handoff'],'npm run build && node tools/desktop-handoff-check.mjs');
  assert.equal(p.scripts['package:windows'],'npm test && node tools/package-windows.mjs');
  assert.equal(p.scripts.demo,undefined,'do not advertise a nonexistent demo');
  await access('tools/package-windows.mjs');
});
