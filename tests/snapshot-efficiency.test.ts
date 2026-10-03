import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp, { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createSnapshot, materializeSnapshot, pruneStore, readSnapshot } from '../src/core/snapshots.js';
import { createIdentity, listenPeer } from '../src/core/peer-transport.js';
import { receiveSnapshot, sendSnapshotToPeer } from '../src/core/transfers.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture(t: TestContext) {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(path.resolve('.test-data/snapshot-efficiency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(source);
  return { root, source, store: path.join(root, 'store') };
}
/** Count real calls to a node:fs/promises export (live ESM bindings are synced both ways). */
function spy(t: TestContext, name: 'open' | 'readdir', keep: (target: string) => boolean): string[] {
  const calls: string[] = [];
  const original = (fsp as any)[name];
  (fsp as any)[name] = function (target: unknown, ...rest: unknown[]) {
    if (typeof target === 'string' && keep(path.resolve(target))) calls.push(path.resolve(target));
    return original.call(this, target, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => { (fsp as any)[name] = original; syncBuiltinESMExports(); });
  return calls;
}
const hourAgo = () => new Date(Date.now() - 3600_000);

test('snapshots flush new objects, the manifest and their directories before returning', async (t) => {
  const f = await fixture(t);
  for (const name of ['a', 'b', 'c']) await writeFile(path.join(f.source, name), name);
  const handle = await fsp.open(path.join(f.source, 'a'), 'r');
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const sync = prototype.sync;
  let syncs = 0;
  prototype.sync = function (...args: unknown[]) { syncs++; return sync.apply(this, args); };
  t.after(() => { prototype.sync = sync; });
  await createSnapshot(f.source, f.store);
  const expected = 3 + 1 + (process.platform === 'win32' ? 0 : 2);
  assert.ok(syncs >= expected, `expected at least ${expected} fsyncs, saw ${syncs}`);
});

test('unchanged files are reused from the stat cache while edited and freshly written files are re-read', async (t) => {
  const f = await fixture(t);
  for (const name of ['stable', 'edited']) {
    await writeFile(path.join(f.source, name), `${name} v1`);
    await utimes(path.join(f.source, name), hourAgo(), hourAgo());
  }
  await writeFile(path.join(f.source, 'fresh'), 'fresh v1');
  const first = await createSnapshot(f.source, f.store);
  await writeFile(path.join(f.source, 'edited'), 'edited v2');
  const opened = spy(t, 'open', (target) => target.startsWith(f.source + path.sep));
  const second = await createSnapshot(f.source, f.store, first.id);
  assert.deepEqual([...new Set(opened)].map((target) => path.basename(target)).sort(), ['edited', 'fresh']);
  assert.deepEqual(second.files.map((file) => [file.path, file.hash]),
    [['edited', digest('edited v2')], ['fresh', digest('fresh v1')], ['stable', digest('stable v1')]]);
});

test('a same-size edit that restores the old modification time is still detected', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.source, 'level.dat');
  await writeFile(file, 'AAAA');
  await utimes(file, hourAgo(), hourAgo());
  const first = await createSnapshot(f.source, f.store);
  const { mtime } = await fsp.stat(file);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(file, 'BBBB');
  await utimes(file, mtime, mtime);
  const second = await createSnapshot(f.source, f.store, first.id);
  assert.equal(second.files[0]!.hash, digest('BBBB'));
});

test('sending walks each store once regardless of history length', { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  let head = null as string | null;
  for (let i = 0; i < 6; i++) {
    await writeFile(path.join(f.source, 'world.bin'), `revision ${i}`);
    head = (await createSnapshot(f.source, f.store, head)).id;
  }
  const incoming = path.join(f.root, 'incoming');
  const [sender, receiver] = await Promise.all([createIdentity(), createIdentity()]);
  let done!: (error?: unknown) => void;
  const received = new Promise((resolve) => { done = resolve; });
  const listener = await listenPeer(receiver, [sender.fingerprint], (socket, fingerprint) => {
    void receiveSnapshot(socket, fingerprint, incoming).then(() => done(), done);
  });
  t.after(() => listener.close());
  const walks = spy(t, 'readdir', (target) => target === path.resolve(f.store) || target === path.resolve(incoming));
  await sendSnapshotToPeer(sender, { ...listener, fingerprint: receiver.fingerprint }, f.store, head!);
  assert.equal(await received, undefined);
  assert.ok(walks.filter((target) => target === path.resolve(f.store)).length <= 1, `sender store walked ${walks.length} times`);
  assert.ok(walks.filter((target) => target === path.resolve(incoming)).length <= 1, 'receiver store walked once');
});

test('pruneStore keeps required and recent revisions and deletes only unreferenced objects', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'shared'), 'shared');
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    await writeFile(path.join(f.source, 'world.bin'), `revision ${i}`);
    ids.push((await createSnapshot(f.source, f.store, ids.at(-1) ?? null)).id);
  }
  assert.deepEqual(await pruneStore(f.store, { keep: [ids[3]!], ancestors: 3 }), { snapshotsRemoved: 0, objectsRemoved: 0, bytesFreed: 0 });
  const result = await pruneStore(f.store, { keep: [ids[3]!, ids[0]!] });
  assert.deepEqual(result, { snapshotsRemoved: 2, objectsRemoved: 2, bytesFreed: Buffer.byteLength('revision 1') + Buffer.byteLength('revision 2') });
  for (const id of [ids[0]!, ids[3]!]) {
    await readSnapshot(f.store, id);
    await materializeSnapshot(f.store, id, path.join(f.root, 'check-' + id.slice(0, 8)));
  }
  for (const id of [ids[1]!, ids[2]!]) await assert.rejects(readSnapshot(f.store, id), /ENOENT/);
  assert.deepEqual((await readdir(path.join(f.store, 'objects'))).sort(),
    [digest('revision 0'), digest('revision 3'), digest('shared')].sort());
  assert.equal(await readFile(path.join(f.root, 'check-' + ids[3]!.slice(0, 8), 'world.bin'), 'utf8'), 'revision 3');
  await assert.rejects(pruneStore(f.store, { keep: ['e'.repeat(64)] }), /ENOENT|missing/i, 'an unknown kept revision is refused');
});
