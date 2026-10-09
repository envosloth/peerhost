import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { constants } from 'node:fs';
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { saveOnboarding, readOnboarding } from '../dist/src/core/onboarding.js';

const prior = { step: 'friends', dismissed: false, completed: false, skipped: [], draft: { name: 'Atomic fixture', loader: 'vanilla', gameVersion: '1.21.1', memoryMiB: 2048 } };
const next = { ...prior, step: 'ready' };
async function fixture(t) {
  assert.ok(process.env.TMPDIR?.replaceAll('\\', '/').includes('hermes/cache/scratch'));
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'seed-onboarding-atomic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await saveOnboarding(root, prior, null);
  return { root, file: path.join(root, 'onboarding-new.json') };
}
// Observe actual OS rename failure, never synthesize it. Release only after that failure.
function observeRename(t, file, onDenied) {
  const original = fs.promises.rename;
  let denials = 0;
  fs.promises.rename = async (source, destination) => {
    try { return await original(source, destination); }
    catch (error) {
      if (destination === file && ['EPERM', 'EBUSY'].includes(error.code)) { denials++; await onDenied?.(denials); }
      throw error;
    }
  };
  syncBuiltinESMExports();
  t.after(() => { fs.promises.rename = original; syncBuiltinESMExports(); });
  return () => denials;
}
test('Windows transient ordinary reader releases after denied rename within the same atomic save', { skip: process.platform !== 'win32' }, async t => {
  const { root, file } = await fixture(t);
  let held = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  t.after(async () => { await held?.close(); });
  const bytes = await readFile(file);
  const denials = observeRename(t, file, async n => {
    if (n === 1) { assert.deepEqual(await readFile(file), bytes); await held.close(); held = null; }
  });
  await saveOnboarding(root, next, null);
  assert.equal(denials(), 1, 'first replacement must really encounter the held Windows handle');
  assert.equal((await readOnboarding(root, false, null)).step, 'ready');
  assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.tmp')), []);
});
test('Windows persistent ordinary reader fails boundedly with original bytes and no staging leaks', { skip: process.platform !== 'win32' }, async t => {
  const { root, file } = await fixture(t);
  const held = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const bytes = await readFile(file);
  const denials = observeRename(t, file);
  try {
    await assert.rejects(saveOnboarding(root, next, null), { code: 'EPERM', syscall: 'rename' });
    assert.equal(denials(), 6, 'bounded replacement attempts, not an indefinite retry');
    assert.deepEqual(await readFile(file), bytes);
    assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.tmp')), []);
  } finally { await held.close(); }
  await saveOnboarding(root, next, null);
  assert.equal((await readOnboarding(root, false, null)).step, 'ready');
});
for (const unsafe of ['invalid', 'oversized', 'link']) {
  test(`Windows retry refuses ${unsafe} target swapped after actual sharing denial`, { skip: process.platform !== 'win32' }, async t => {
    const { root, file } = await fixture(t);
    let held = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    t.after(async () => { await held?.close(); });
    const linkedDirectory = path.join(root, 'do-not-overwrite');
    await mkdir(linkedDirectory);
    const destination = path.join(linkedDirectory, 'keep.json');
    await writeFile(destination, JSON.stringify({ version: 1, ...prior }));
    const bytes = await readFile(destination);
    const denials = observeRename(t, file, async n => {
      if (n !== 1) return;
      await held.close(); held = null;
      if (unsafe === 'link') { await rm(file); await symlink(linkedDirectory, file, 'junction'); assert.equal((await fs.promises.lstat(file)).isSymbolicLink(), true); }
      else await writeFile(file, unsafe === 'invalid' ? '{' : 'x'.repeat(20000));
    });
    await assert.rejects(saveOnboarding(root, next, null), /unreadable/);
    assert.equal(denials(), 1, 'validation must run again before replacement');
    assert.deepEqual(await readFile(destination), bytes);
    if (unsafe !== 'link') assert.equal(await readFile(file, 'utf8'), unsafe === 'invalid' ? '{' : 'x'.repeat(20000));
    else assert.equal((await fs.promises.lstat(file)).isSymbolicLink(), true);
    assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.tmp')), []);
  });
}
test('real concurrent onboarding readers see complete metadata while 100 atomic saves succeed', async t => {
  const { root } = await fixture(t);
  let calls = 0;
  for (let round = 0; round < 100; round++) {
    let stopped = false;
    const readers = Array.from({ length: 4 }, async () => {
      for (let n = 0; n < 100 && !stopped; n++) {
        const progress = await readOnboarding(root, false, null);
        assert.equal(progress.error, null);
        assert.ok(['friends', 'ready'].includes(progress.step));
        calls++;
      }
    });
    try { await saveOnboarding(root, round % 2 ? prior : next, null); }
    finally { stopped = true; await Promise.all(readers); }
    assert.equal((await readOnboarding(root, false, null)).step, round % 2 ? 'friends' : 'ready');
  }
  assert.ok(calls >= 400, 'real reader overlap exercised');
  assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.tmp')), []);
});
