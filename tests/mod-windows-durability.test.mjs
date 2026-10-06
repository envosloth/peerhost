import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { addModBatch } from '../dist/src/core/mods.js';
import { assertModInstallComplete } from '../dist/src/core/mod-transaction.js';
import { readModIndex, writeModIndex } from '../dist/src/core/mod-index.js';
import { writeZip } from '../dist/src/core/zip.js';

// Native Windows filesystem, no fs mocks and no network/provider downloads.
test('Windows native addModBatch durably commits jars and metadata without a repair fence', { skip: process.platform !== 'win32' }, async t => {
  assert.ok(process.env.TMPDIR, 'native regression requires an explicit sandbox scratch directory');
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'mod-windows-durability-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = path.join(root, 'server');
  await mkdir(server);
  const source = path.join(root, 'fixture.jar');
  await writeZip(source, [{ name: 'fabric.mod.json', data: Buffer.from('{"id":"fixture"}') }]);
  const digest = createHash('sha512').update(await readFile(source)).digest('hex');
  const index = { version: 1, target: { loader: 'fabric', gameVersion: '1.21.1' }, mods: [] };
  const installed = await addModBatch(server, [{ kind: 'server', source }], () => writeModIndex(server, index));
  assert.deepEqual(installed, ['fixture.jar']);
  assert.equal(createHash('sha512').update(await readFile(path.join(server, 'mods', 'fixture.jar'))).digest('hex'), digest);
  assert.deepEqual(await readModIndex(server), index);
  assert.equal((await readdir(server)).includes('seedhost-mod-install.json'), false);
  await assertModInstallComplete(server);
});
