import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TLSSocket } from 'node:tls';
import { createIdentity, listenPeer, connectPeer, readFrame, writeFrame, type PeerIdentity } from '../src/core/peer-transport.js';
import { createSnapshot, readSnapshot, materializeSnapshot, type SnapshotManifest } from '../src/core/snapshots.js';
import { OwnershipLedger, type TransferOffer } from '../src/core/ownership.js';

interface TransferModule {
  sendSnapshotToPeer(identity: PeerIdentity, peer: { fingerprint: string; host: string; port: number }, store: string,
    id: string, offer?: TransferOffer): Promise<{ snapshot: SnapshotManifest; filesSent: number; bytesSent: number; ownershipAccepted: boolean }>;
  receiveSnapshot(socket: TLSSocket, fingerprint: string, store: string,
    callback?: (snapshot: SnapshotManifest, source: string, offer?: TransferOffer) => Promise<boolean | void>): Promise<void>;
}
const modulePath = '../src/core/transfers.js';
const transfers = await import(modulePath).catch((error: NodeJS.ErrnoException) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
}) as TransferModule;
let identityPair: Promise<{ sender: PeerIdentity; receiver: PeerIdentity }> | undefined;
function identities() {
  return identityPair ??= Promise.all([createIdentity(), createIdentity()]).then(([sender, receiver]) => ({ sender: sender!, receiver: receiver! }));
}
async function fixture(t: TestContext) {
  const base = path.resolve('.test-data');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'transfers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), store = path.join(root, 'sender'), incoming = path.join(root, 'incoming');
  await mkdir(source);
  await writeFile(path.join(source, 'secret.bin'), Buffer.from([0, 255, 128, 1]));
  const snapshot = await createSnapshot(source, store);
  return { root, source, store, incoming, snapshot, ...await identities() };
}
function closed(socket: TLSSocket): Promise<void> {
  return socket.closed ? Promise.resolve() : new Promise((resolve) => socket.once('close', () => resolve()));
}

async function receiving(t: TestContext, f: Awaited<ReturnType<typeof fixture>>,
  callback?: Parameters<TransferModule['receiveSnapshot']>[3]) {
  let finish!: (error: Error | undefined) => void;
  const completion = new Promise<Error | undefined>((resolve) => { finish = resolve; });
  let admit!: (socket: TLSSocket) => void;
  const inbound = new Promise<TLSSocket>((resolve) => { admit = resolve; });
  const listener = await listenPeer(f.receiver, [f.sender.fingerprint], (socket, fingerprint) => {
    admit(socket);
    void transfers.receiveSnapshot(socket, fingerprint, f.incoming, callback).then(() => finish(undefined), finish);
  });
  t.after(() => listener.close());
  return { peer: { ...listener, fingerprint: f.receiver.fingerprint }, completion, inbound };
}
async function assertClean(store: string) {
  const entries = await readdir(store).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  assert.equal(entries.some((entry) => entry.startsWith('.transfer-')), false, 'no abandoned transfer staging');
}

test('security: wrong server pin and unknown client transmit no snapshot fields', { timeout: 20000 }, async (t) => {
  assert.equal(typeof transfers.sendSnapshotToPeer, 'function', 'authenticated snapshot sender is implemented');
  const f = await fixture(t);
  let bytes = 0, admitted = 0;
  const endings: Promise<void>[] = [];
  const wrongPin = await listenPeer(f.receiver, [f.sender.fingerprint], (socket) => {
    admitted++;
    socket.on('data', (data: Buffer) => { bytes += data.length; });
    socket.resume();
    endings.push(closed(socket));
  });
  t.after(() => wrongPin.close());
  await assert.rejects(transfers.sendSnapshotToPeer(f.sender, { ...wrongPin, fingerprint: '00'.repeat(32) },
    f.store, f.snapshot.id), /pin|fingerprint/i);
  await Promise.all(endings);
  assert.equal(bytes, 0);
  let unknownAdmitted = 0;
  const unknown = await listenPeer(f.receiver, [], () => { unknownAdmitted++; });
  t.after(() => unknown.close());
  await assert.rejects(transfers.sendSnapshotToPeer(f.sender, { ...unknown, fingerprint: f.receiver.fingerprint },
    f.store, f.snapshot.id), /disconnect|closed|reject/i);
  assert.equal(unknownAdmitted, 0);
  assert.ok(admitted <= 1);
});

test('initial authenticated transfer is byte exact for chunked binary and empty files without granting ownership',
  { timeout: 30000 }, async (t) => {
    const f = await fixture(t);
    const binary = Buffer.alloc(3 * 65536 + 17);
    for (let i = 0; i < binary.length; i++) binary[i] = i % 251;
    await mkdir(path.join(f.source, 'world'));
    await writeFile(path.join(f.source, 'world', 'region.bin'), binary);
    await writeFile(path.join(f.source, 'copy.bin'), binary);
    await writeFile(path.join(f.source, 'empty'), '');
    const snapshot = await createSnapshot(f.source, f.store);
    let callbacks = 0;
    const session = await receiving(t, f, async (actual, source, offer) => {
      callbacks++;
      assert.deepEqual(actual, snapshot);
      assert.equal(source, f.sender.fingerprint);
      assert.equal(offer, undefined);
      assert.deepEqual(await readSnapshot(f.incoming, actual.id), actual, 'callback sees verified published revision');
    });
    const result = await transfers.sendSnapshotToPeer(f.sender, session.peer, f.store, snapshot.id);
    assert.equal(await session.completion, undefined);
    assert.deepEqual(result, { snapshot, filesSent: 3, bytesSent: binary.length + 4, ownershipAccepted: false });
    assert.equal(callbacks, 1);
    for (const file of snapshot.files) {
      assert.deepEqual(await readFile(path.join(f.incoming, 'objects', file.hash)), await readFile(path.join(f.source, file.path)));
    }
    const destination = path.join(f.root, 'disposable-materialized');
    await materializeSnapshot(f.incoming, snapshot.id, destination);
    assert.deepEqual(await readFile(path.join(destination, 'world', 'region.bin')), binary);
    assert.equal((await readdir(f.root)).includes('servers'), false, 'receiver does not create a live server');
    await assertClean(f.incoming);
  });

test('delta sends changed objects only, represents deletion, and retries without retransmission', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'unchanged'), 'keep me');
  await writeFile(path.join(f.source, 'deleted'), 'old contents');
  const first = await createSnapshot(f.source, f.store);
  const initial = await receiving(t, f);
  await transfers.sendSnapshotToPeer(f.sender, initial.peer, f.store, first.id);
  assert.equal(await initial.completion, undefined);
  await rm(path.join(f.source, 'deleted'));
  await writeFile(path.join(f.source, 'secret.bin'), Buffer.from([1, 2, 3, 4, 5]));
  const second = await createSnapshot(f.source, f.store, first.id);
  const delta = await receiving(t, f);
  const result = await transfers.sendSnapshotToPeer(f.sender, delta.peer, f.store, second.id);
  assert.equal(await delta.completion, undefined);
  assert.equal(result.filesSent, 1);
  assert.equal(result.bytesSent, 5);
  assert.deepEqual(await readSnapshot(f.incoming, second.id), second);
  assert.deepEqual(await readSnapshot(f.incoming, first.id), first);
  assert.equal(second.files.some((file) => file.path === 'deleted'), false);
  const retry = await receiving(t, f);
  const retried = await transfers.sendSnapshotToPeer(f.sender, retry.peer, f.store, second.id);
  assert.equal(await retry.completion, undefined);
  assert.equal(retried.filesSent, 0);
  assert.equal(retried.bytesSent, 0);
  await assertClean(f.incoming);
});

test('a fresh receiver gets the validated parent ancestry and its historical objects', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'secret.bin'), Buffer.from([5, 6, 7]));
  const child = await createSnapshot(f.source, f.store, f.snapshot.id);
  const session = await receiving(t, f);
  const result = await transfers.sendSnapshotToPeer(f.sender, session.peer, f.store, child.id);
  assert.equal(await session.completion, undefined);
  assert.deepEqual(await readSnapshot(f.incoming, f.snapshot.id), f.snapshot);
  assert.equal(result.filesSent, 2);
  assert.equal(result.bytesSent, 7);
  await materializeSnapshot(f.incoming, f.snapshot.id, path.join(f.root, 'historical'));
  assert.deepEqual(await readFile(path.join(f.root, 'historical', 'secret.bin')), Buffer.from([0, 255, 128, 1]));
  await assertClean(f.incoming);
});

test('ownership offer is callback data and only explicit true accepts it', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const offer: TransferOffer = { id: randomUUID(), source: f.sender.fingerprint, target: f.receiver.fingerprint,
    generation: 1, snapshotId: f.snapshot.id };
  for (const answer of [undefined, false, true]) {
    const session = await receiving(t, f, async (snapshot, source, actual) => {
      assert.deepEqual(actual, offer);
      assert.equal(source, offer.source);
      assert.equal(snapshot.id, offer.snapshotId);
      return answer;
    });
    const result = await transfers.sendSnapshotToPeer(f.sender, session.peer, f.store, f.snapshot.id, offer);
    assert.equal(await session.completion, undefined);
    assert.equal(result.ownershipAccepted, answer === true);
  }
  await assertClean(f.incoming);
});

test('final acknowledgment survives real 5500ms human approval and receiver materialization',
  { timeout: 15000 }, async (t) => {
    const f = await fixture(t);
    const source = new OwnershipLedger(path.join(f.root, 'source-ownership.sqlite'), f.sender.fingerprint);
    const target = new OwnershipLedger(path.join(f.root, 'target-ownership.sqlite'), f.receiver.fingerprint);
    await source.initialize(f.snapshot.id);
    const offer = await source.prepareTransfer(f.receiver.fingerprint, f.snapshot.id);
    const destination = path.join(f.root, 'approved-materialized');
    let approvalWait = 0;
    const session = await receiving(t, f, async (snapshot, fingerprint, actualOffer) => {
      assert.deepEqual(actualOffer, offer);
      assert.equal((await source.status()).state, 'offered', 'source is durably fenced while consent is pending');
      await assert.rejects(source.startHosting(), /blocked/i);
      const started = performance.now();
      await delay(5500); // Real time and real TLS: do not replace this regression with a fake clock.
      approvalWait = performance.now() - started;
      await materializeSnapshot(f.incoming, snapshot.id, destination);
      await target.acceptTransfer(actualOffer!, fingerprint, snapshot.id);
      return true;
    });
    const [sent] = await Promise.allSettled([
      transfers.sendSnapshotToPeer(f.sender, session.peer, f.store, f.snapshot.id, offer),
      session.completion,
    ]);
    assert.ok(approvalWait > 5000, `human approval actually waited ${approvalWait}ms`);
    assert.deepEqual(await readFile(path.join(destination, 'secret.bin')), Buffer.from([0, 255, 128, 1]));
    assert.equal((await target.status()).state, 'owned');
    assert.equal((await source.status()).state, 'offered', 'even a failed/late acknowledgment cannot restore source authority');
    await assert.rejects(source.startHosting(), /blocked/i);
    if (sent!.status === 'rejected') throw sent!.reason;
    assert.equal(await session.completion, undefined);
    assert.equal(sent!.value.ownershipAccepted, true);
    await source.confirmTransfer(offer.id, f.receiver.fingerprint);
    assert.equal((await source.status()).state, 'transferred');
    await assertClean(f.incoming);
  });

test('receiver bounds pending consent at 120000ms without automatic permission or durable-authority rollback',
  { timeout: 15000 }, async (t) => {
    for (const durableAcceptance of [false, true]) {
      await t.test(durableAcceptance ? 'already durable target authority is preserved' : 'unanswered consent grants no authority',
        { timeout: 6000 }, async (sub) => {
          const f = await fixture(sub);
          const sourceFile = path.join(f.root, 'source-ownership.sqlite');
          const targetFile = path.join(f.root, 'target-ownership.sqlite');
          const source = new OwnershipLedger(sourceFile, f.sender.fingerprint);
          const target = new OwnershipLedger(targetFile, f.receiver.fingerprint);
          await source.initialize(f.snapshot.id);
          const offer = await source.prepareTransfer(f.receiver.fingerprint, f.snapshot.id);
          let release!: (answer: boolean) => void;
          const approval = new Promise<boolean>((resolve) => { release = resolve; });
          let entered!: () => void;
          const pending = new Promise<void>((resolve) => { entered = resolve; });
          const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
          let restoreClearTimeout = () => {};
          const session = await receiving(sub, f, async (snapshot, fingerprint, actualOffer) => {
            // Only virtualize the callback's deadline, after real TLS/streaming and the sender's ack timer began.
            sub.mock.timers.enable({ apis: ['setTimeout'] });
            // MockTimers cannot clear preexisting native timers; preserve cleanup of the sender's real ack timer.
            const mockedClearTimeout = globalThis.clearTimeout;
            globalThis.clearTimeout = (timer) => {
              realClearTimeout(timer);
              mockedClearTimeout(timer);
            };
            // Do not register this with sub.mock.method: its later restoreAll would reinstall a stale mocked clearer.
            restoreClearTimeout = () => { globalThis.clearTimeout = mockedClearTimeout; };
            if (durableAcceptance) await target.acceptTransfer(actualOffer!, fingerprint, snapshot.id);
            entered();
            return approval;
          });
          const sending = transfers.sendSnapshotToPeer(f.sender, session.peer, f.store, f.snapshot.id, offer)
            .catch((error: Error) => error);
          let completed = false;
          void session.completion.then(() => { completed = true; });
          await pending;
          try {
            sub.mock.timers.tick(119999);
            await Promise.resolve();
            assert.equal(completed, false, 'consent does not expire before the full two-minute bound');
            sub.mock.timers.tick(1);
            let watchdog: ReturnType<typeof setTimeout> | undefined;
            const error = await Promise.race([session.completion, new Promise<Error>((resolve) => {
              watchdog = realSetTimeout(() => resolve(new Error('Receiver consent was not bounded at 120000ms')), 500);
            })]).finally(() => realClearTimeout(watchdog));
            assert.ok(error);
            assert.match(error.message, /approval.*timed out.*120000/i);
            assert.match(error.message, /ownership.*reconcil/i, 'timeout must report uncertainty, not a safe rollback');
            assert.ok(await sending instanceof Error, 'a timeout is never an accepted acknowledgment');
            assert.equal((await session.inbound).destroyed, true);
            assert.equal((await new OwnershipLedger(sourceFile, f.sender.fingerprint).status()).state, 'offered');
            await assert.rejects(source.startHosting(), /blocked/i);
            if (durableAcceptance) {
              assert.equal((await new OwnershipLedger(targetFile, f.receiver.fingerprint).status()).state, 'owned');
            } else {
              await assert.rejects(target.status(), /ENOENT/);
            }
            assert.deepEqual(await readSnapshot(f.incoming, f.snapshot.id), f.snapshot, 'verified replica survives timeout');
            await assertClean(f.incoming);
          } finally {
            restoreClearTimeout();
            sub.mock.timers.reset();
            release(true); // A callback can still finish late; this must never resurrect an acknowledgment.
            await sending;
            await session.completion;
          }
        });
    }
  });

function hello(snapshot: SnapshotManifest, offer: unknown = null) {
  return { type: 'snapshot', version: 1, snapshotId: snapshot.id, manifests: [snapshot], offer };
}
async function rejectMetadata(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, value: unknown, pattern: RegExp) {
  let callbacks = 0;
  const session = await receiving(t, f, async () => { callbacks++; });
  const socket = await connectPeer(f.sender, f.receiver.fingerprint, session.peer.host, session.peer.port);
  t.after(() => socket.destroy());
  const response = readFrame(socket);
  await writeFrame(socket, value);
  assert.equal((await response).type, 'error', 'reject before requesting or trusting any objects');
  const error = await session.completion;
  assert.ok(error);
  assert.match(error.message, pattern);
  assert.equal(callbacks, 0);
  await assert.rejects(readSnapshot(f.incoming, f.snapshot.id), /ENOENT/);
  await assertClean(f.incoming);
}

test('security: malformed ownership offer fields fail before object requests', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const offer = { id: randomUUID(), source: f.sender.fingerprint, target: f.receiver.fingerprint, generation: 1, snapshotId: f.snapshot.id };
  for (const invalid of [false, {}, { ...offer, generation: 0 }, { ...offer, id: '' }, { ...offer, target: '\u0000' },
    { ...offer, source: 17 }, { ...offer, extra: true }, { ...offer, snapshotId: 'f'.repeat(64) }]) {
    await rejectMetadata(t, f, hello(f.snapshot, invalid), /offer|fields|SHA256/i);
  }
});

function manifest(files: SnapshotManifest['files'], parentId: string | null = null): SnapshotManifest {
  const value = { version: 1 as const, parentId, files };
  return { ...value, id: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
}

test('security: explicit ancestry, file-count, object-byte, and total-byte limits precede object requests',
  { timeout: 30000 }, async (t) => {
    const f = await fixture(t);
    await rejectMetadata(t, f, { ...hello(f.snapshot), manifests: Array.from({ length: 129 }, () => f.snapshot) }, /ancestry.*limit/i);
    const oversized = manifest([{ path: 'huge', size: 16 * 1024 ** 3 + 1, hash: 'a'.repeat(64) }]);
    await rejectMetadata(t, f, hello(oversized), /object.*byte.*limit/i);
    const many = manifest(Array.from({ length: 4097 }, (_, i) => ({ path: `file-${String(i).padStart(5, '0')}`, size: 0, hash: 'a'.repeat(64) })));
    await rejectMetadata(t, f, hello(many), /file.*count.*limit/i);
    const total = manifest(Array.from({ length: 9 }, (_, i) => ({ path: `file-${i}`, size: 16 * 1024 ** 3,
      hash: createHash('sha256').update(String(i)).digest('hex') })));
    await rejectMetadata(t, f, hello(total), /total.*byte.*limit/i);
  });

async function scriptedReceiver(t: TestContext, f: Awaited<ReturnType<typeof fixture>>,
  script: (socket: TLSSocket) => Promise<void>) {
  let finish!: (error?: Error) => void;
  const completion = new Promise<Error | undefined>((resolve) => { finish = resolve; });
  const listener = await listenPeer(f.receiver, [f.sender.fingerprint], (socket) => {
    void script(socket).then(() => finish(), finish);
  });
  t.after(() => listener.close());
  return { peer: { ...listener, fingerprint: f.receiver.fingerprint }, completion };
}

test('security: the entire missing-object request is validated before sending any objects', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'extra.bin'), Buffer.from([8]));
  const snapshot = await createSnapshot(f.source, f.store);
  const hash = f.snapshot.files[0]!.hash;
  assert.equal(new Set(snapshot.files.map((file) => file.hash)).size, 2, 'request length fits the advertised object count');
  for (const hashes of [[hash, '../outside'], [hash, hash], [hash, 'f'.repeat(64)]]) {
    let sentFields = 0;
    const session = await scriptedReceiver(t, f, async (socket) => {
      assert.equal((await readFrame(socket)).type, 'snapshot');
      await writeFrame(socket, { type: 'need', hashes });
      const first = await readFrame(socket).catch(() => undefined);
      if (first) sentFields++;
    });
    await assert.rejects(transfers.sendSnapshotToPeer(f.sender, session.peer, f.store, snapshot.id), /SHA256|request|object/i);
    assert.equal(await session.completion, undefined);
    assert.equal(sentFields, 0, 'invalid requests receive no object header or content');
  }
});

test('security: sender requires exact acknowledgment id, actual counters, and offer-bound ownership', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  for (const wrong of [{ snapshotId: 'f'.repeat(64) }, { filesSent: 1 }, { bytesSent: 4 }, { ownershipAccepted: 'yes' },
    { extra: true }, { ownershipAccepted: true }]) {
    const session = await scriptedReceiver(t, f, async (socket) => {
      const initial = await readFrame(socket);
      await writeFrame(socket, { type: 'need', hashes: [] });
      const complete = await readFrame(socket);
      assert.deepEqual(complete, { type: 'complete', snapshotId: initial.snapshotId, filesSent: 0, bytesSent: 0 });
      await writeFrame(socket, { ...complete, type: 'ack', ownershipAccepted: false, ...wrong });
    });
    await assert.rejects(transfers.sendSnapshotToPeer(f.sender, session.peer, f.store, f.snapshot.id), /acknowledgment|ownership|fields/i);
    assert.equal(await session.completion, undefined);
  }
});

test('security: interrupted or tampered incoming objects preserve the previous revision and current pointer',
  { timeout: 30000 }, async (t) => {
    const f = await fixture(t);
    const initial = await receiving(t, f);
    await transfers.sendSnapshotToPeer(f.sender, initial.peer, f.store, f.snapshot.id);
    assert.equal(await initial.completion, undefined);
    const current = path.join(f.incoming, 'current.json');
    const currentBytes = JSON.stringify({ snapshotId: f.snapshot.id, liveFixture: true });
    await writeFile(current, currentBytes);
    await writeFile(path.join(f.source, 'secret.bin'), Buffer.from([2, 4, 6, 8]));
    const child = await createSnapshot(f.source, f.store, f.snapshot.id);
    const object = child.files[0]!;
    for (const attack of ['interrupted', 'tampered', 'short', 'completion-counters']) {
      let callbacks = 0;
      const session = await receiving(t, f, async () => { callbacks++; return true; });
      const socket = await connectPeer(f.sender, f.receiver.fingerprint, session.peer.host, session.peer.port);
      t.after(() => socket.destroy());
      await writeFrame(socket, { ...hello(child), manifests: [child, f.snapshot] });
      assert.deepEqual(await readFrame(socket), { type: 'need', hashes: [object.hash] });
      await writeFrame(socket, { type: 'object', hash: object.hash, size: object.size });
      await writeFrame(socket, { type: 'chunk', data: (attack === 'tampered' ? Buffer.from([3, 4, 6, 8]) :
        attack === 'short' || attack === 'interrupted' ? Buffer.from([2]) : Buffer.from([2, 4, 6, 8])).toString('base64') });
      if (attack === 'interrupted') socket.end();
      else {
        await writeFrame(socket, { type: 'object-end', hash: object.hash });
        if (attack === 'completion-counters') await writeFrame(socket, { type: 'complete', snapshotId: child.id, filesSent: 9, bytesSent: 4 });
        assert.equal((await readFrame(socket)).type, 'error');
      }
      const error = await session.completion;
      assert.ok(error);
      assert.match(error.message, /integrity|disconnect|completion|closed/i);
      assert.equal(callbacks, 0);
      await assert.rejects(readSnapshot(f.incoming, child.id), /ENOENT/);
      assert.deepEqual(await readSnapshot(f.incoming, f.snapshot.id), f.snapshot);
      assert.equal(await readFile(current, 'utf8'), currentBytes);
      assert.deepEqual(await readFile(path.join(f.incoming, 'objects', f.snapshot.files[0]!.hash)), Buffer.from([0, 255, 128, 1]));
      await assertClean(f.incoming);
    }
  });

test('security: oversized local metadata is rejected before dialing, and oversized wire headers fail closed',
  { timeout: 15000 }, async (t) => {
    const f = await fixture(t);
    const huge = manifest([{ path: '世界'.repeat(200000), size: 0, hash: createHash('sha256').update('').digest('hex') }]);
    await writeFile(path.join(f.store, 'snapshots', `${huge.id}.json`), JSON.stringify(huge));
    let admitted = 0;
    const listener = await listenPeer(f.receiver, [f.sender.fingerprint], (socket) => { admitted++; socket.resume(); });
    t.after(() => listener.close());
    await assert.rejects(transfers.sendSnapshotToPeer(f.sender, { ...listener, fingerprint: f.receiver.fingerprint }, f.store, huge.id), /metadata.*limit|one-MiB/i);
    assert.equal(admitted, 0, 'oversized metadata never starts a transfer');
    const session = await receiving(t, f);
    const socket = await connectPeer(f.sender, f.receiver.fingerprint, session.peer.host, session.peer.port);
    t.after(() => socket.destroy());
    const header = Buffer.alloc(4);
    header.writeUInt32BE(1048577);
    socket.write(header);
    const error = await session.completion;
    assert.ok(error);
    assert.match(error.message, /frame.*limit/i);
    await assert.rejects(readSnapshot(f.incoming, f.snapshot.id), /ENOENT/);
    await assertClean(f.incoming);
  });

test('security: invalid manifest paths, hashes, fields, content and ancestry never reach object requests',
  { timeout: 30000 }, async (t) => {
    const f = await fixture(t);
    const file = f.snapshot.files[0]!;
    const badPath = manifest([{ ...file, path: '../outside' }]);
    const badHash = manifest([{ ...file, hash: '../outside' }]);
    const collision = manifest([{ ...file, path: 'World/a' }, { ...file, path: 'world/b' }]);
    const missingParent = manifest([file], 'a'.repeat(64));
    for (const value of [
      { ...hello(f.snapshot), extra: true },
      { ...hello(f.snapshot), snapshotId: '../outside' },
      hello(badPath), hello(badHash), hello(collision), hello(missingParent),
      { ...hello(f.snapshot), manifests: [{ ...f.snapshot, files: [{ ...file, size: file.size + 1 }] }] },
      { ...hello(f.snapshot), manifests: [{ ...f.snapshot, extra: 'hidden' }] },
    ]) await rejectMetadata(t, f, value, /fields|SHA256|unsafe|integrity|ancestry/i);
  });

test('security: a corrupt existing object is rejected without retransmission or overwrite', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.incoming, 'objects'), { recursive: true });
  const objectPath = path.join(f.incoming, 'objects', f.snapshot.files[0]!.hash);
  await writeFile(objectPath, Buffer.from([9, 9, 9, 9]));
  await rejectMetadata(t, f, hello(f.snapshot), /integrity/i);
  assert.deepEqual(await readFile(objectPath), Buffer.from([9, 9, 9, 9]));
});

test('security: a receiver objects-directory junction cannot redirect writes outside the store', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'sentinel'), 'unchanged');
  await mkdir(f.incoming);
  await symlink(outside, path.join(f.incoming, 'objects'), process.platform === 'win32' ? 'junction' : 'dir');
  const session = await receiving(t, f);
  await assert.rejects(transfers.sendSnapshotToPeer(f.sender, session.peer, f.store, f.snapshot.id), /symlink|reparse|safety/i);
  const error = await session.completion;
  assert.ok(error);
  assert.deepEqual(await readdir(outside), ['sentinel']);
  assert.equal(await readFile(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
  await assertClean(f.incoming);
});

test('concurrent transfers use fresh staging and atomically publish the same immutable objects', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([receiving(t, f), receiving(t, f)]);
  const results = await Promise.all([transfers.sendSnapshotToPeer(f.sender, first.peer, f.store, f.snapshot.id),
    transfers.sendSnapshotToPeer(f.sender, second.peer, f.store, f.snapshot.id)]);
  assert.equal(await first.completion, undefined);
  assert.equal(await second.completion, undefined);
  assert.ok(results.every((result) => result.filesSent <= 1 && result.bytesSent === result.filesSent * 4));
  assert.deepEqual(await readSnapshot(f.incoming, f.snapshot.id), f.snapshot);
  assert.deepEqual(await readdir(path.join(f.incoming, 'objects')), [f.snapshot.files[0]!.hash]);
  await assertClean(f.incoming);
});

test('security: chunk size, canonical base64, and object header identity are enforced', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const object = f.snapshot.files[0]!;
  for (const attack of [
    { type: 'chunk', data: Buffer.alloc(65537).toString('base64') },
    { type: 'chunk', data: 'AA=A' },
    { type: 'chunk', data: '' },
    { type: 'chunk', data: 'AAAAAAA=' },
    { type: 'object', hash: '../outside', size: object.size },
  ]) {
    const session = await receiving(t, f);
    const socket = await connectPeer(f.sender, f.receiver.fingerprint, session.peer.host, session.peer.port);
    t.after(() => socket.destroy());
    await writeFrame(socket, hello(f.snapshot));
    assert.deepEqual(await readFrame(socket), { type: 'need', hashes: [object.hash] });
    if (attack.type !== 'object') await writeFrame(socket, { type: 'object', hash: object.hash, size: object.size });
    await writeFrame(socket, attack);
    assert.equal((await readFrame(socket)).type, 'error');
    const error = await session.completion;
    assert.ok(error);
    assert.match(error.message, /chunk|base64|integrity|header/i);
    await assert.rejects(readSnapshot(f.incoming, f.snapshot.id), /ENOENT/);
    await assertClean(f.incoming);
  }
});

test('receiver closes its socket after acknowledgment without waiting for the peer to end', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const session = await receiving(t, f);
  const socket = await connectPeer(f.sender, f.receiver.fingerprint, session.peer.host, session.peer.port);
  t.after(() => socket.destroy());
  const inbound = await session.inbound;
  const file = f.snapshot.files[0]!;
  await writeFrame(socket, hello(f.snapshot));
  assert.deepEqual(await readFrame(socket), { type: 'need', hashes: [file.hash] });
  await writeFrame(socket, { type: 'object', hash: file.hash, size: file.size });
  await writeFrame(socket, { type: 'chunk', data: Buffer.from([0, 255, 128, 1]).toString('base64') });
  await writeFrame(socket, { type: 'object-end', hash: file.hash });
  await writeFrame(socket, { type: 'complete', snapshotId: f.snapshot.id, filesSent: 1, bytesSent: 4 });
  const ack = await readFrame(socket);
  assert.equal(ack.type, 'ack');
  assert.equal(await session.completion, undefined);
  assert.equal(inbound.destroyed, true, 'a non-ending peer cannot leave an admitted transfer socket open');
});
