import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { createIdentity } from '../src/core/peer-transport.js';
import { SeedHostApplication } from '../src/core/application.js';
import { OwnershipLedger } from '../src/core/ownership.js';

const fixture = path.resolve('tools/fake-java-server.mjs');
async function setup(prefix: string, confirm: () => Promise<boolean>) {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(path.resolve('.test-data/' + prefix));
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'eula.txt'), 'eula=true\n');
  await writeFile(path.join(source, 'world.bin'), 'original');
  const ia = await createIdentity(), ib = await createIdentity();
  const a = new SeedHostApplication(path.join(root, 'a'), ia);
  const b = new SeedHostApplication(path.join(root, 'b'), ib, { confirmIncomingHandoff: confirm });
  await a.open(); await b.open(); await a.importExisting(source, true);
  await a.saveProfile({ executable: process.execPath, args: [fixture, '--lifetime-ms=30000'] });
  return { root, ia, ib, a, b };
}
async function connect(s: Awaited<ReturnType<typeof setup>>) {
  await a_listen(s.a); await a_listen(s.b);
  await s.a.addPeer({ name: 'B', fingerprint: s.ib.fingerprint, ...(await s.b.getState()).peerEndpoint! });
  await s.b.addPeer({ name: 'A', fingerprint: s.ia.fingerprint, ...(await s.a.getState()).peerEndpoint! });
}
async function a_listen(app: SeedHostApplication) { if (!(await app.getState()).peerEndpoint) await app.startPeerListener(); }
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function idle(app: SeedHostApplication) {
  for (let i = 0; i < 500; i++) { if (!(await app.getState()).busy) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('Application did not become idle');
}

test('an unreachable recipient leaves the source fenced, and retrying the same offer completes the handoff', async () => {
  let approvals = 0;
  const s = await setup('handoff-retry-', async () => { approvals++; return true; });
  try {
    await s.a.addPeer({ name: 'B', fingerprint: s.ib.fingerprint, host: '127.0.0.1', port: await closedPort() });
    await assert.rejects(s.a.handoff(s.ib.fingerprint), /retry/i);
    const fenced = (await s.a.getState()).server!.ownership;
    assert.equal(fenced.state, 'offered');
    await assert.rejects(s.a.startServer(true), /ownership/i);
    await s.a.addPeer({ name: 'C', fingerprint: 'c'.repeat(64), host: '127.0.0.1', port: 1 });
    await assert.rejects(s.a.handoff('c'.repeat(64)), /pending.*another peer/i, 'a pending offer cannot be redirected');
    await connect(s);
    await s.a.handoff(s.ib.fingerprint);
    await idle(s.b);
    assert.equal((await s.a.getState()).server!.ownership.state, 'transferred');
    const received = (await s.b.getState()).server!.ownership;
    assert.equal(received.state, 'owned');
    assert.equal(received.generation, 1);
    assert.equal(received.acceptedOfferId, fenced.offer!.id, 'the retry carried the original offer');
    assert.equal(approvals, 1);
  } finally { await s.a.close(); await s.b.close(); await rm(s.root, { recursive: true, force: true }); }
});

test('a lost acknowledgment after the recipient committed is re-acknowledged on retry without a second approval', async () => {
  let approvals = 0;
  const s = await setup('handoff-lost-ack-', async () => { approvals++; return true; });
  const accept = OwnershipLedger.prototype.acceptTransfer;
  try {
    await connect(s);
    OwnershipLedger.prototype.acceptTransfer = async function (...args: Parameters<OwnershipLedger['acceptTransfer']>) {
      await accept.apply(this, args);
      throw new Error('Fixture: acknowledgment lost after durable commit');
    };
    await assert.rejects(s.a.handoff(s.ib.fingerprint), /lost after durable commit/i);
    OwnershipLedger.prototype.acceptTransfer = accept;
    await idle(s.b);
    assert.equal((await s.a.getState()).server!.ownership.state, 'offered');
    assert.equal((await s.b.getState()).server!.ownership.state, 'owned');
    await s.a.handoff(s.ib.fingerprint);
    await idle(s.b);
    assert.equal((await s.a.getState()).server!.ownership.state, 'transferred');
    assert.equal((await s.b.getState()).server!.ownership.generation, 1);
    assert.equal(approvals, 1, 'the committed offer is not shown to the user again');
  } finally {
    OwnershipLedger.prototype.acceptTransfer = accept;
    await s.a.close(); await s.b.close(); await rm(s.root, { recursive: true, force: true });
  }
});

test('an explicit decline restores source ownership so it can host again', async () => {
  const s = await setup('handoff-decline-restore-', async () => false);
  try {
    await connect(s);
    await assert.rejects(s.a.handoff(s.ib.fingerprint), /declined/i);
    await idle(s.b);
    const ownership = (await s.a.getState()).server!.ownership;
    assert.equal(ownership.state, 'owned');
    assert.equal(ownership.offer, undefined);
    assert.equal((await s.b.getState()).server, null);
    await s.a.startServer(true);
    await s.a.stopServer();
    assert.equal((await s.a.getState()).server!.ownership.state, 'owned');
  } finally { await s.a.close(); await s.b.close(); await rm(s.root, { recursive: true, force: true }); }
});
