import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';
import { createIdentity, listenPeer, type PeerIdentity } from '../src/core/peer-transport.js';
import { createSnapshot, readSnapshot, type SnapshotManifest } from '../src/core/snapshots.js';
import { receiveSnapshot, sendSnapshotToPeer } from '../src/core/transfers.js';

let pair: Promise<{ sender: PeerIdentity; receiver: PeerIdentity }> | undefined;
const identities = () => pair ??= Promise.all([createIdentity(), createIdentity()]).then(([sender, receiver]) => ({ sender: sender!, receiver: receiver! }));

async function fixture(t: TestContext) {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(path.resolve('.test-data/transfer-scale-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(source);
  return { root, source, store: path.join(root, 'sender'), incoming: path.join(root, 'incoming'), ...await identities() };
}
async function receiver(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, options?: { reserveBytes?: number }) {
  let finish!: (error: Error | undefined) => void;
  const completion = new Promise<Error | undefined>((resolve) => { finish = resolve; });
  const listener = await listenPeer(f.receiver, [f.sender.fingerprint], (socket: TLSSocket, fingerprint) => {
    void receiveSnapshot(socket, fingerprint, f.incoming, undefined, options).then(() => finish(undefined), finish);
  });
  t.after(() => listener.close());
  return { peer: { ...listener, fingerprint: f.receiver.fingerprint }, completion };
}

test('a modpack-sized server survives repeated stop snapshots and still transfers', { timeout: 120000 }, async (t) => {
  const f = await fixture(t);
  for (let d = 0; d < 50; d++) {
    await mkdir(path.join(f.source, 'config', `d${d}`), { recursive: true });
    for (let i = 0; i < 100; i++) await writeFile(path.join(f.source, 'config', `d${d}`, `f${i}.toml`), `value=${d}-${i}`);
  }
  let head: SnapshotManifest | undefined;
  for (let stop = 0; stop < 4; stop++) {
    await writeFile(path.join(f.source, 'latest.log'), `run ${stop}`);
    head = await createSnapshot(f.source, f.store, head?.id ?? null);
  }
  assert.equal(head!.files.length, 5001);
  const session = await receiver(t, f);
  const result = await sendSnapshotToPeer(f.sender, session.peer, f.store, head!.id);
  assert.equal(await session.completion, undefined);
  assert.equal(result.filesSent, 5001);
  assert.deepEqual(await readSnapshot(f.incoming, head!.id), head);
});

test('a history longer than 128 revisions does not block sending', { timeout: 120000 }, async (t) => {
  const f = await fixture(t);
  let head: SnapshotManifest | undefined;
  for (let stop = 0; stop < 130; stop++) {
    await writeFile(path.join(f.source, 'world.bin'), `revision ${stop}`);
    head = await createSnapshot(f.source, f.store, head?.id ?? null);
  }
  const session = await receiver(t, f);
  const result = await sendSnapshotToPeer(f.sender, session.peer, f.store, head!.id);
  assert.equal(await session.completion, undefined);
  assert.deepEqual(result, { snapshot: head, filesSent: 1, bytesSent: Buffer.byteLength('revision 129'), ownershipAccepted: false });
  assert.deepEqual(await readdir(path.join(f.incoming, 'snapshots')), [`${head!.id}.json`]);
});

test('a receiver refuses a snapshot that would eat into its free-disk reserve', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'world.bin'), 'needs space');
  const snapshot = await createSnapshot(f.source, f.store);
  const session = await receiver(t, f, { reserveBytes: Number.MAX_SAFE_INTEGER });
  await assert.rejects(sendSnapshotToPeer(f.sender, session.peer, f.store, snapshot.id), /disk space/i);
  const error = await session.completion;
  assert.match(String(error), /disk space/i);
  await assert.rejects(readSnapshot(f.incoming, snapshot.id), /ENOENT/);
});
