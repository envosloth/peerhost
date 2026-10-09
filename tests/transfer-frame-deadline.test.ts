import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TLSSocket } from 'node:tls';
import { createIdentity, connectPeer, listenPeer, readFrame, writeFrame, isVerifiedPeerSocket, isRetryablePeerError } from '../src/core/peer-transport.js';
import { createSnapshot, readSnapshot } from '../src/core/snapshots.js';
import { sendSnapshot, receiveSnapshot } from '../src/core/transfers.js';
import { OwnershipLedger } from '../src/core/ownership.js';

async function fixture() {
  const root = await mkdtemp(path.join(process.env.TMPDIR ?? process.cwd(), 'transfer-deadline-'));
  const source = path.join(root, 'source'), store = path.join(root, 'store'), incoming = path.join(root, 'incoming');
  await mkdir(source);
  const bytes = Buffer.alloc(131089, 37);
  await writeFile(path.join(source, 'world.bin'), bytes);
  const snapshot = await createSnapshot(source, store);
  const [sender, receiver] = await Promise.all([createIdentity(), createIdentity()]);
  const ledger = new OwnershipLedger(path.join(root, 'source.sqlite'), sender.fingerprint);
  const target = new OwnershipLedger(path.join(root, 'target.sqlite'), receiver.fingerprint);
  await ledger.initialize(snapshot.id);
  const offer = await ledger.prepareTransfer(receiver.fingerprint, snapshot.id);
  return { root, store, incoming, snapshot, bytes, sender, receiver, ledger, target, offer };
}
async function fenced(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal((await f.ledger.status()).state, 'offered');
  assert.equal((await f.ledger.status()).offer?.id, f.offer.id);
  await assert.rejects(f.ledger.startHosting(), /blocked/i);
  const entries = await readdir(f.incoming).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e; });
  assert.equal(entries.some(name => name.startsWith('.transfer-')), false);
}
async function session(f: Awaited<ReturnType<typeof fixture>>, accept: boolean, lostAck = false) {
  let finish!: (error?: Error) => void;
  const completion = new Promise<Error | undefined>(resolve => { finish = resolve; });
  let inbound!: TLSSocket;
  let callbacks = 0;
  const listener = await listenPeer(f.receiver, [f.sender.fingerprint], (socket, fingerprint) => {
    inbound = socket;
    assert.equal(isVerifiedPeerSocket(socket), true);
    void receiveSnapshot(socket, fingerprint, f.incoming, async (snapshot, source, offer) => {
      callbacks++;
      // Match the current relay park callback: re-acknowledge durable acceptance, never re-apply.
      if (accept && !await f.target.hasAccepted(offer!.id)) await f.target.acceptTransfer(offer!, source, snapshot.id);
      if (lostAck) socket.destroy();
      return accept;
    }, { reserveBytes: 0 }).then(() => finish(), finish);
  });
  const socket = await connectPeer(f.sender, f.receiver.fingerprint, listener.host, listener.port);
  assert.equal(isVerifiedPeerSocket(socket), true);
  return { socket, completion, listener, inbound: () => inbound, callbacks: () => callbacks };
}

for (const frameType of ['snapshot', 'chunk']) {
  test(`Stop-style park survives a real TLS ${frameType} write callback deferred 5500ms`, { timeout: 20000 }, async () => {
    const f = await fixture();
    const s = await session(f, true);
    let held = false, forwarded = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const write = s.socket.write.bind(s.socket);
    s.socket.write = ((packet: Buffer, callback: (error?: Error | null) => void) => {
      const type = JSON.parse(packet.subarray(4).toString()).type;
      if (!held && type === frameType) {
        held = true;
        return write(packet, error => {
          // Real native TLS completion and real bytes, only forwarding of that callback is delayed.
          const timer = setTimeout(() => { timers.delete(timer); forwarded = true; callback(error); }, 5500);
          timers.add(timer);
        });
      }
      return write(packet, callback);
    }) as typeof s.socket.write;
    try {
      const started = performance.now();
      const result = await sendSnapshot(s.socket, f.store, f.snapshot.id, f.offer);
      assert.ok(performance.now() - started >= 5500);
      assert.equal(held && forwarded, true);
      assert.equal(await s.completion, undefined);
      assert.equal(result.ownershipAccepted, true);
      assert.equal(result.bytesSent, f.bytes.length);
      assert.deepEqual(await readFile(path.join(f.incoming, 'objects', f.snapshot.files[0]!.hash)), f.bytes);
      assert.equal((await f.target.status()).state, 'owned');
      await fenced(f); // Sender confirms separately; receipt alone does not lift the fence.
      await f.ledger.confirmTransfer(f.offer.id, f.receiver.fingerprint);
      assert.equal((await f.ledger.status()).state, 'transferred');
    } finally {
      s.socket.destroy();
      await s.listener.close();
      await s.completion;
      for (const timer of timers) clearTimeout(timer);
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

// Deliberately fast real timer bounds, not fake TLS/output or an inactivity reset.
function fastFrameTimers(writesOnly = false) {
  const native = globalThis.setTimeout;
  const observed: number[] = [];
  globalThis.setTimeout = ((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    if (new Error().stack?.match(writesOnly ? /writePacket/ : /writePacket|readOneFrame/)) {
      observed.push(ms!);
      return native(callback, ms === 120000 ? 350 : ms === 5000 ? 150 : ms, ...args);
    }
    return native(callback, ms, ...args);
  }) as typeof setTimeout;
  return { observed, restore: () => { globalThis.setTimeout = native; } };
}

test('hard-stalled actual chunk callback expires within transfer whole-frame cap and cleans staged receiver', { timeout: 10000 }, async () => {
  const f = await fixture(), s = await session(f, true);
  const fast = fastFrameTimers(true);
  const write = s.socket.write.bind(s.socket);
  let nativeCompleted = false;
  s.socket.write = ((packet: Buffer, callback: (error?: Error | null) => void) => {
    if (JSON.parse(packet.subarray(4).toString()).type === 'chunk') {
      return write(packet, () => { nativeCompleted = true; /* hard-stall callback forwarding */ });
    }
    return write(packet, callback);
  }) as typeof s.socket.write;
  try {
    const started = performance.now();
    await assert.rejects(sendSnapshot(s.socket, f.store, f.snapshot.id, f.offer), (e: any) => {
      assert.equal(e.code, 'PEER_FRAME_TIMEOUT'); assert.equal(isRetryablePeerError(e), true); return true;
    });
    assert.ok(performance.now() - started < 2000);
    assert.equal(nativeCompleted, true);
    assert.ok(fast.observed.includes(120000), 'transfer writes explicitly select the two-minute bound');
    assert.ok(await s.completion instanceof Error);
    assert.equal(s.callbacks(), 0);
    await assert.rejects(readSnapshot(f.incoming, f.snapshot.id), /ENOENT/);
    await fenced(f);
  } finally {
    fast.restore(); s.socket.destroy(); await s.listener.close(); await s.completion;
    await rm(f.root, { recursive: true, force: true });
  }
});

test('truncated actual TLS chunk EOF exits with typed disconnect and preserves source fence', { timeout: 10000 }, async () => {
  const f = await fixture(), s = await session(f, true);
  try {
    await writeFrame(s.socket, { type: 'snapshot', version: 2, snapshotId: f.snapshot.id, parentId: f.snapshot.parentId, fileCount: 1, offer: f.offer });
    await writeFrame(s.socket, { type: 'files', files: f.snapshot.files });
    assert.equal((await readFrame(s.socket)).type, 'need');
    const file = f.snapshot.files[0]!;
    await writeFrame(s.socket, { type: 'object', hash: file.hash, size: file.size });
    const packet = Buffer.alloc(6); packet.writeUInt32BE(20); packet.write('{"', 4);
    s.socket.end(packet);
    const error = await s.completion as any;
    assert.equal(error.code, 'PEER_DISCONNECTED');
    assert.equal(isRetryablePeerError(error), true);
    assert.equal(s.callbacks(), 0);
    await assert.rejects(readSnapshot(f.incoming, f.snapshot.id), /ENOENT/);
    await fenced(f);
  } finally { s.socket.destroy(); await s.listener.close(); await s.completion; await rm(f.root, { recursive: true, force: true }); }
});

test('durably accepted lost acknowledgment stays fenced and same-offer Park retry is idempotent', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const lost = await session(f, true, true);
    try {
      await assert.rejects(sendSnapshot(lost.socket, f.store, f.snapshot.id, f.offer), (e: any) => e.code === 'PEER_DISCONNECTED' && isRetryablePeerError(e));
      assert.ok(await lost.completion instanceof Error);
      assert.equal((await f.target.status()).state, 'owned');
      await fenced(f);
    } finally { lost.socket.destroy(); await lost.listener.close(); await lost.completion; }
    const retry = await session(f, true);
    try {
      const result = await sendSnapshot(retry.socket, f.store, f.snapshot.id, f.offer);
      assert.equal(await retry.completion, undefined);
      assert.equal(result.ownershipAccepted, true);
      assert.equal(result.filesSent, 0);
      await fenced(f);
      await f.ledger.confirmTransfer(f.offer.id, f.receiver.fingerprint);
      assert.equal((await f.ledger.status()).state, 'transferred');
    } finally { retry.socket.destroy(); await retry.listener.close(); await retry.completion; }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('ordinary control write retains 5000ms whole-frame timeout on pinned TLS', { timeout: 10000 }, async () => {
  const [sender, receiver] = await Promise.all([createIdentity(), createIdentity()]);
  const listener = await listenPeer(receiver, [sender.fingerprint], socket => socket.resume());
  const socket = await connectPeer(sender, receiver.fingerprint, listener.host, listener.port);
  const fast = fastFrameTimers();
  const write = socket.write.bind(socket);
  socket.write = ((packet: Buffer) => write(packet, () => {})) as typeof socket.write;
  try {
    for (const invalid of [0, -1, NaN, Infinity, 120001]) {
      await assert.rejects(writeFrame(socket, { type: 'status' }, invalid), RangeError);
      assert.equal(socket.destroyed, false, 'invalid budgets cannot write or destroy an admitted socket');
    }
    await assert.rejects(writeFrame(socket, { type: 'status' }), (e: any) => e.code === 'PEER_FRAME_TIMEOUT');
    assert.deepEqual(fast.observed, [5000]);
  } finally { fast.restore(); socket.destroy(); await listener.close(); }
});

test('incoming chunk trickle cannot reset the bounded whole-frame transfer deadline', { timeout: 10000 }, async () => {
  const f = await fixture(), s = await session(f, true);
  let fast: ReturnType<typeof fastFrameTimers> | undefined;
  const timers: ReturnType<typeof setTimeout>[] = [];
  try {
    await writeFrame(s.socket, { type: 'snapshot', version: 2, snapshotId: f.snapshot.id, parentId: f.snapshot.parentId, fileCount: 1, offer: f.offer });
    await writeFrame(s.socket, { type: 'files', files: f.snapshot.files });
    assert.equal((await readFrame(s.socket)).type, 'need');
    const file = f.snapshot.files[0]!;
    await writeFrame(s.socket, { type: 'object', hash: file.hash, size: file.size });
    // Activate only after preparation and hello: the actual next transfer read gets a real 350 ms timer.
    fast = fastFrameTimers();
    const header = Buffer.alloc(4); header.writeUInt32BE(100);
    s.socket.write(header);
    let sent = 0;
    for (const ms of [50, 120, 220, 300, 450]) timers.push(setTimeout(() => {
      if (!s.socket.destroyed) { sent++; s.socket.write(Buffer.from(' ')); }
    }, ms));
    const started = performance.now();
    const error = await s.completion as any;
    assert.equal(error.code, 'PEER_FRAME_TIMEOUT');
    assert.ok(sent >= 2, 'real TLS bytes progressed while the incomplete body was held');
    assert.ok(performance.now() - started < 1500);
    assert.ok(fast.observed.includes(120000));
    assert.equal(s.callbacks(), 0);
    await fenced(f);
    await assert.rejects(readSnapshot(f.incoming, f.snapshot.id), /ENOENT/);
  } finally {
    fast?.restore(); for (const timer of timers) clearTimeout(timer);
    s.socket.destroy(); await s.listener.close(); await s.completion;
    await rm(f.root, { recursive: true, force: true });
  }
});
