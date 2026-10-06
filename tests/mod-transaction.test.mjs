import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { writeZip } from '../dist/src/core/zip.js';
import { readModIndex, writeModIndex } from '../dist/src/core/mod-index.js';
import { installMod } from '../dist/src/core/mod-install.js';
import { addModBatch } from '../dist/src/core/mods.js';

const scratch = process.env.TMPDIR || path.resolve('.test-data');
const fenceName = 'seedhost-mod-install.json';
const childCode = `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
const [serverDir, root, sha512, mode] = process.argv.slice(1);
const originalLink = fs.link;
fs.link = async (...args) => {
  await originalLink(...args);
  if (mode === 'publish' && args[1].endsWith('.jar')) process.exit(73);
};
const originalRename = fs.rename;
fs.rename = async (...args) => {
  await originalRename(...args);
  if (mode === 'index' && args[1] === path.join(serverDir, 'seedhost-mods.json')) process.exit(74);
};
syncBuiltinESMExports();
const { installMod } = await import('./dist/src/core/mod-install.js');
const version = id => ({ id: 'v-' + id, projectId: id, versionNumber: '1',
  loaders: ['fabric'], gameVersions: ['1.21.1'], incompatibleProjects: [],
  requiredProjects: id === 'root' ? [{ projectId: 'dep', versionId: null }] : [],
  file: { filename: id + '.jar', size: 1, sha512, url: 'fixture' } });
const client = {
  project: async id => ({ id, slug: id, title: id, placement: ['server', 'client'], supportedSides: ['server', 'client'] }),
  compatibleVersion: async id => version(id),
  download: async (file, dir) => { await fs.mkdir(dir); const dest = path.join(dir, file.filename); await fs.copyFile(path.join(root, 'fixture.jar'), dest); return dest; }
};
await installMod(serverDir, path.join(root, 'stage'), client, { projectId: 'root' });
`;
async function fixture(t) {
  const root = await mkdtemp(path.join(scratch, 'mod-transaction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const serverDir = path.join(root, 'server'); await mkdir(serverDir);
  await writeZip(path.join(root, 'fixture.jar'), [{ name: 'fabric.mod.json', data: Buffer.from('{"id":"fixture"}') }]);
  const sha512 = createHash('sha512').update(await readFile(path.join(root, 'fixture.jar'))).digest('hex');
  await writeModIndex(serverDir, { version: 1, target: { loader: 'fabric', gameVersion: '1.21.1' }, mods: [] });
  return { root, serverDir, sha512 };
}
async function crash(f, mode) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, f.serverDir, f.root, f.sha512, mode], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  assert.equal(code, mode === 'publish' ? 73 : 74, stderr);
}

test('forced exit after the first published jar leaves a durable explicit-repair fence', async t => {
  const f = await fixture(t); await crash(f, 'publish');
  assert.deepEqual((await readdir(path.join(f.serverDir, 'mods'))).filter(name => name.endsWith('.jar')), ['root.jar']);
  assert.equal((await readModIndex(f.serverDir)).mods.length, 0);
  assert.ok((await readdir(f.serverDir)).includes(fenceName), 'partial dependency graph must retain the install fence');
  const journal = JSON.parse(await readFile(path.join(f.serverDir, fenceName), 'utf8'));
  assert.equal(journal.version, 1);
  assert.deepEqual(journal.items.map(item => `${item.kind}:${item.name}`), ['server:root.jar', 'client:root.jar', 'server:dep.jar', 'client:dep.jar']);
  const { assertModInstallComplete } = await import('../dist/src/core/mod-transaction.js');
  await assert.rejects(assertModInstallComplete(f.serverDir), /mod install.*repair/i);
  assert.equal((await readModIndex(f.serverDir)).mods.length, 0, 'checking the fence must never synthesize provenance');
  assert.ok((await readdir(path.join(f.serverDir, 'mods'))).includes('root.jar'), 'checking the fence must not auto-delete jars');
});

test('interrupted install is refused before resolving or downloading another graph', async t => {
  const f = await fixture(t); await crash(f, 'publish');
  let requested = false;
  await assert.rejects(installMod(f.serverDir, path.join(f.root, 'another-stage'), {
    project: async () => { requested = true; throw Error('must not contact provider'); }
  }, { projectId: 'root' }), /mod install.*repair/i);
  assert.equal(requested, false);
});

test('forced exit immediately after index rename still fences start and ordinary snapshots', async t => {
  const f = await fixture(t); await crash(f, 'index');
  assert.equal((await readModIndex(f.serverDir)).mods.length, 4);
  assert.ok((await readdir(f.serverDir)).includes(fenceName));
  const { assertModInstallComplete } = await import('../dist/src/core/mod-install.js');
  for (const boundary of ['start', 'ordinary snapshot']) {
    let reached = false;
    await assert.rejects((async () => { await assertModInstallComplete(f.serverDir); reached = true; })(), /mod install.*repair/i, boundary);
    assert.equal(reached, false);
  }
  assert.deepEqual((await readdir(path.join(f.serverDir, 'mods'))).filter(name => name.endsWith('.jar')).sort(), ['dep.jar', 'root.jar']);
});

test('successful commit clears the fence and ordinary metadata failure completely rolls back', async t => {
  const f = await fixture(t);
  const source = path.join(f.root, 'fixture.jar');
  await assert.rejects(addModBatch(f.serverDir, [{ kind: 'server', source }, { kind: 'client', source }], async () => { throw Error('index commit failed'); }), /index commit failed/);
  assert.equal((await readdir(f.serverDir)).includes(fenceName), false);
  assert.equal((await readdir(f.serverDir)).includes('mods'), false);
  await addModBatch(f.serverDir, [{ kind: 'server', source }], async () => writeModIndex(f.serverDir, { version: 1, target: { loader: 'quilt', gameVersion: '1.21.1' }, mods: [] }));
  assert.equal((await readdir(f.serverDir)).includes(fenceName), false);
  assert.equal((await readModIndex(f.serverDir)).target.loader, 'quilt');
  const { assertModInstallComplete } = await import('../dist/src/core/mod-transaction.js');
  await assertModInstallComplete(f.serverDir);
});

test('commit which changed metadata then throws retains fence and jars for explicit repair', async t => {
  const f = await fixture(t);
  await assert.rejects(addModBatch(f.serverDir, [{ kind: 'server', source: path.join(f.root, 'fixture.jar') }], async () => {
    await writeModIndex(f.serverDir, { version: 1, target: { loader: 'quilt', gameVersion: '1.21.1' }, mods: [] });
    throw Error('index post-rename failure');
  }), /index post-rename failure/);
  assert.ok((await readdir(f.serverDir)).includes(fenceName), 'uncertain metadata commit must retain fence');
  assert.ok((await readdir(path.join(f.serverDir, 'mods'))).includes('fixture.jar'), 'never auto-delete jars after an uncertain commit');
});

test('rollback never deletes a jar replaced by somebody else', async t => {
  const f = await fixture(t);
  const destination = path.join(f.serverDir, 'mods', 'fixture.jar');
  await assert.rejects(addModBatch(f.serverDir, [{ kind: 'server', source: path.join(f.root, 'fixture.jar') }], async () => {
    await rm(destination); await writeFile(destination, 'externally replaced file');
    throw Error('commit failed');
  }));
  assert.ok((await readdir(f.serverDir)).includes(fenceName), 'uncertain file ownership must retain fence');
  assert.equal(await readFile(destination, 'utf8'), 'externally replaced file');
});

test('a publish that takes effect then rejects cannot be treated as a complete rollback', async t => {
  const f = await fixture(t);
  const originalLink = fs.link;
  const fault = t.mock.method(fs, 'link', async (...args) => { await originalLink(...args); throw Error('uncertain publish completion'); });
  syncBuiltinESMExports();
  try {
    await assert.rejects(addModBatch(f.serverDir, [{ kind: 'server', source: path.join(f.root, 'fixture.jar') }]), /uncertain publish/);
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
  assert.ok((await readdir(f.serverDir)).includes(fenceName), 'publish uncertainty must retain the fence');
  assert.ok((await readdir(path.join(f.serverDir, 'mods'))).includes('fixture.jar'));
});

test('uncertain fence unlink restores a visible repair fence', async t => {
  const f = await fixture(t);
  const originalUnlink = fs.unlink;
  let injected = false;
  const fault = t.mock.method(fs, 'unlink', async (...args) => {
    await originalUnlink(...args);
    if (args[0] === path.join(f.serverDir, fenceName) && !injected) { injected = true; throw Error('uncertain fence unlink'); }
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(addModBatch(f.serverDir, [{ kind: 'server', source: path.join(f.root, 'fixture.jar') }]), /uncertain fence unlink/);
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
  assert.ok((await readdir(f.serverDir)).includes(fenceName), 'uncertain unlink must not reopen start/snapshot boundaries');
});

test('durable barriers precede publish and follow metadata commit, temporary cleanup and fence removal', async t => {
  const f = await fixture(t); const events = [];
  const original = { open: fs.open, link: fs.link, rm: fs.rm, unlink: fs.unlink };
  const faults = [
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await original.open(...args), sync = handle.sync.bind(handle);
      handle.sync = async () => { await sync(); events.push(['sync', args[0]]); };
      return handle;
    }),
    t.mock.method(fs, 'link', async (...args) => { await original.link(...args); events.push(['publish', args[1]]); }),
    t.mock.method(fs, 'rm', async (...args) => { await original.rm(...args); events.push(['rm', args[0]]); }),
    t.mock.method(fs, 'unlink', async (...args) => { await original.unlink(...args); events.push(['unlink', args[0]]); })
  ];
  syncBuiltinESMExports();
  try {
    await mkdir(path.join(f.serverDir, 'mods'));
    await addModBatch(f.serverDir, [{ kind: 'server', source: path.join(f.root, 'fixture.jar') }], async () => {
      await writeModIndex(f.serverDir, { version: 1, target: { loader: 'quilt', gameVersion: '1.21.1' }, mods: [] });
      events.push(['commit', f.serverDir]);
    });
  } finally { for (const fault of faults) fault.mock.restore(); syncBuiltinESMExports(); }
  const publish = events.findIndex(([event]) => event === 'publish');
  assert.ok(events.slice(0, publish).some(([event, file]) => event === 'sync' && file === path.join(f.serverDir, fenceName)));
  assert.ok(events.slice(0, publish).some(([event, file]) => event === 'sync' && file === f.serverDir));
  const commit = events.findIndex(([event]) => event === 'commit');
  const unlink = events.findIndex(([event]) => event === 'unlink');
  assert.ok(events.slice(commit + 1, unlink).some(([event, file]) => event === 'sync' && file === f.serverDir));
  const cleanup = events.findIndex(([event, file]) => event === 'rm' && file.endsWith('.tmp') && file.includes('.seedhost-adding-'));
  assert.ok(events.slice(cleanup + 1, unlink).some(([event, file]) => event === 'sync' && file === path.join(f.serverDir, 'mods')), 'temporary cleanup must be durable before clearing fence');
  assert.ok(events.slice(unlink + 1).some(([event, file]) => event === 'sync' && file === f.serverDir));
});

test('completion never clears an externally modified intent journal', async t => {
  const f = await fixture(t), fence = path.join(f.serverDir, fenceName);
  await assert.rejects(addModBatch(f.serverDir, [{ kind: 'server', source: path.join(f.root, 'fixture.jar') }], async () => {
    await writeFile(fence, '{"external":"repair required"}');
  }), /mod install.*repair/i);
  assert.equal(await readFile(fence, 'utf8'), '{"external":"repair required"}');
});

test('failed journal flush publishes no jars and leaves the fence', async t => {
  const f = await fixture(t), originalOpen = fs.open;
  const fault = t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === path.join(f.serverDir, fenceName)) handle.sync = async () => { throw Error('journal flush failed'); };
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(addModBatch(f.serverDir, [{ kind: 'server', source: path.join(f.root, 'fixture.jar') }]), /journal flush failed/);
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
  assert.ok((await readdir(f.serverDir)).includes(fenceName));
  assert.equal((await readdir(f.serverDir)).includes('mods'), false);
});

test('rollback cleanup failure retains an explicit repair fence', async t => {
  const f = await fixture(t), originalRm = fs.rm;
  const destination = path.join(f.serverDir, 'mods', 'fixture.jar');
  const fault = t.mock.method(fs, 'rm', async (...args) => {
    if (args[0] === destination) throw Error('rollback deletion failed');
    return originalRm(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(addModBatch(f.serverDir, [{ kind: 'server', source: path.join(f.root, 'fixture.jar') }], async () => { throw Error('index commit failed'); }), /rollback deletion failed/);
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
  assert.ok((await readdir(f.serverDir)).includes(fenceName));
  assert.ok((await readdir(path.join(f.serverDir, 'mods'))).includes('fixture.jar'));
});

test('malformed, directory and dangling-symlink fences cannot be mistaken for successful recovery', async t => {
  const f = await fixture(t), fence = path.join(f.serverDir, fenceName);
  const { assertModInstallComplete } = await import('../dist/src/core/mod-transaction.js');
  await writeFile(fence, 'not JSON');
  await assert.rejects(assertModInstallComplete(f.serverDir), /mod install.*repair/i);
  await rm(fence); await mkdir(fence);
  await assert.rejects(assertModInstallComplete(f.serverDir), /mod install.*repair/i);
  await rm(fence, { recursive: true });
  // Windows refuses file/directory symlinks without Developer Mode or admin rights; a directory
  // junction is the same reparse-point attack and needs no elevation, so the case still runs.
  await fs.symlink(path.join(f.root, 'missing'), fence, process.platform === 'win32' ? 'junction' : undefined);
  await assert.rejects(assertModInstallComplete(f.serverDir), /mod install.*repair/i);
  assert.equal((await fs.lstat(fence)).isSymbolicLink(), true);
});
