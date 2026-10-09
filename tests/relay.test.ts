import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { createIdentity, connectPeer, type PeerIdentity } from '../src/core/peer-transport.js';
import { SeedHostApplication } from '../src/core/application.js';
import { OwnershipLedger } from '../src/core/ownership.js';
import { RelayNode } from '../src/core/relay.js';
import { relayStatus } from '../src/core/relay-client.js';

const fixture = path.resolve('tools/fake-java-server.mjs');
const quiet = () => {};
const held = async (relay: RelayNode) => { await relay.settled(); return relay.custody(); };

async function workspace(t: TestContext, prefix: string) {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(path.resolve('.test-data/' + prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'eula.txt'), 'eula=true\n');
  await writeFile(path.join(source, 'world.bin'), 'original');
  return { root, source };
}
async function startRelay(t: TestContext, root: string, identity?: PeerIdentity, options: { keepRevisions?: number } = {}) {
  const relay = new RelayNode(path.join(root, 'relay'), identity ?? await createIdentity(), { log: quiet, ...options });
  await relay.open();
  await relay.listen();
  t.after(() => relay.close());
  return relay;
}
/** A host app that trusts the relay (and vice versa) and uses it as its relay. */
async function host(t: TestContext, root: string, name: string, relay: RelayNode, identity?: PeerIdentity, confirm = async () => true) {
  const id = identity ?? await createIdentity();
  const app = new SeedHostApplication(path.join(root, name), id, {
    confirmIncomingHandoff: confirm,
    // Explicit local approval for a synthetic process; never a peer-provided runtime.
    resolveGroupLaunchProfile: async () => ({ executable: process.execPath, args: [fixture, '--lifetime-ms=30000'] }),
  });
  await app.open();
  t.after(() => app.close().catch(() => {}));
  await relay.trust(name, id.fingerprint);
  if (!(await app.getState()).peers.some((peer) => peer.fingerprint === relay.identity.fingerprint)) {
    await app.addPeer({ name: 'Relay', fingerprint: relay.identity.fingerprint, ...relay.endpoint! });
  }
  await app.saveRelay({ fingerprint: relay.identity.fingerprint, parkOnStop: false });
  return { app, identity: id };
}
async function profile(app: SeedHostApplication) {
  await app.saveProfile({ executable: process.execPath, args: [fixture, '--lifetime-ms=30000'] });
}
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
const world = async (app: SeedHostApplication) => readFile(path.join((await app.getState()).server!.serverDir, 'world.bin'), 'utf8');

test('ordinary group Start and mandatory Stop carry the latest server while the previous holder is off', async (t) => {
  const { root, source } = await workspace(t, 'relay-roundtrip-');
  const relay = await startRelay(t, root);
  const ia = await createIdentity();
  let a = (await host(t, root, 'a', relay, ia)).app;
  await a.importExisting(source, true);
  await profile(a);
  await a.startServer(true);
  await writeFile(path.join((await a.getState()).server!.serverDir, 'world.bin'), 'edited on A');
  await a.stopServer();
  const parked = (await a.getState()).server!;
  assert.equal(parked.ownership.state, 'transferred');
  assert.equal((await held(relay))!.generation, 3);
  await a.close();
  const b = (await host(t, root, 'b', relay)).app;
  assert.equal((await b.getState()).server, null);
  await b.startGroup(relay.identity.fingerprint, true);
  assert.equal((await b.getState()).server!.state, 'running');
  assert.equal(await world(b), 'edited on A');
  await writeFile(path.join((await b.getState()).server!.serverDir, 'world.bin'), 'edited on B');
  await b.stopServer();
  assert.equal((await held(relay))!.generation, 5);
  a = (await host(t, root, 'a', relay, ia)).app;
  await a.startServer(true);
  assert.equal((await a.getState()).server!.ownership.generation, 6);
  assert.equal(await world(a), 'edited on B');
  assert.equal(await readFile(path.join(source, 'world.bin'), 'utf8'), 'original');
  await a.stopServer();
});

test('claims are refused while another PC has the server checked out, and the relay reports who has it', async (t) => {
  const { root, source } = await workspace(t, 'relay-checked-out-');
  const relay = await startRelay(t, root);
  const a = (await host(t, root, 'a', relay)).app;
  const { app: b, identity: ib } = await host(t, root, 'b', relay);
  await a.importExisting(source, true);
  await assert.rejects(b.claimFromRelay(), /holds no server/i);
  await a.parkAtRelay();
  await b.claimFromRelay();
  await assert.rejects(a.claimFromRelay(), /checked out by b\b/i, 'the error names the holder');
  assert.equal((await a.getState()).server!.ownership.state, 'transferred');
  const status = await a.checkRelay();
  assert.equal(status!.owner, ib.fingerprint);
  assert.equal(status!.ownerName, 'b');
  assert.equal(status!.state, 'transferred');
  await assert.rejects(b.claimFromRelay(), /already holds/i);
});

test('a lost claim acknowledgment is resolved by retrying the claim, and blocks other PCs meanwhile', async (t) => {
  const { root, source } = await workspace(t, 'relay-lost-ack-');
  const relay = await startRelay(t, root);
  const a = (await host(t, root, 'a', relay)).app;
  const { app: b, identity: ib } = await host(t, root, 'b', relay);
  const c = (await host(t, root, 'c', relay)).app;
  await a.importExisting(source, true);
  await a.parkAtRelay();
  const accept = OwnershipLedger.prototype.acceptTransfer;
  OwnershipLedger.prototype.acceptTransfer = async function (...args: Parameters<OwnershipLedger['acceptTransfer']>) {
    await accept.apply(this, args);
    if (this.deviceId === ib.fingerprint) throw new Error('Fixture: claim acknowledgment lost after durable commit');
  };
  try { await assert.rejects(b.claimFromRelay(), /retry/i); }
  finally { OwnershipLedger.prototype.acceptTransfer = accept; }
  assert.equal((await b.getState()).server!.ownership.state, 'owned', 'B durably accepted');
  assert.equal((await held(relay))!.pendingTarget, ib.fingerprint);
  await assert.rejects(c.claimFromRelay(), /pending.*\bb\b/i);
  await b.claimFromRelay(); // retry: re-acknowledged, not re-applied
  assert.equal((await b.getState()).server!.ownership.generation, 2);
  assert.equal((await held(relay))!.state, 'transferred');
});

test('parking on a relay that already acknowledged-but-lost a claim treats the new park as proof of acceptance', async (t) => {
  const { root, source } = await workspace(t, 'relay-implicit-');
  const relay = await startRelay(t, root);
  const a = (await host(t, root, 'a', relay)).app;
  const { app: b, identity: ib } = await host(t, root, 'b', relay);
  await a.importExisting(source, true);
  await a.parkAtRelay();
  const accept = OwnershipLedger.prototype.acceptTransfer;
  OwnershipLedger.prototype.acceptTransfer = async function (...args: Parameters<OwnershipLedger['acceptTransfer']>) {
    await accept.apply(this, args);
    if (this.deviceId === ib.fingerprint) throw new Error('Fixture: lost');
  };
  try { await assert.rejects(b.claimFromRelay()); } finally { OwnershipLedger.prototype.acceptTransfer = accept; }
  assert.equal((await held(relay))!.state, 'offered');
  await b.parkAtRelay();
  assert.deepEqual((await held(relay)), { owner: relay.identity.fingerprint, state: 'owned', generation: 3,
    snapshotId: (await b.getState()).server!.snapshotId, pendingTarget: null });
});

test('an unreachable relay never fences a stopped holder and group Start refuses unknown status', async (t) => {
  const { root, source } = await workspace(t, 'relay-unreachable-');
  const relay = await startRelay(t, root);
  const a = (await host(t, root, 'a', relay)).app;
  await a.importExisting(source, true);
  await profile(a);
  await a.saveRelay({ fingerprint: relay.identity.fingerprint, parkOnStop: true });
  await a.startServer(true);
  await a.stopServer();
  assert.equal((await a.getState()).server!.ownership.owner, relay.identity.fingerprint, 'park-on-stop parked it');
  await a.claimFromRelay();
  await a.addPeer({ name: 'Relay', fingerprint: relay.identity.fingerprint, host: '127.0.0.1', port: await closedPort() });
  await assert.rejects(a.parkAtRelay(), /unreachable.*stays on this PC/i);
  assert.equal((await a.getState()).server!.ownership.state, 'owned', 'no offer was prepared');
  await assert.rejects(a.startServer(true), /unreachable.*unknown/i);
  const state = await a.getState();
  assert.equal(state.server!.ownership.state, 'owned');
  assert.equal(state.server!.state, 'offline');
});

test('the relay declines a different server, even with a higher generation, and the host keeps it', async (t) => {
  const { root, source } = await workspace(t, 'relay-foreign-');
  const relay = await startRelay(t, root);
  const a = (await host(t, root, 'a', relay)).app;
  const { app: c } = await host(t, root, 'c', relay);
  await a.importExisting(source, true);
  await a.parkAtRelay();
  await a.claimFromRelay(); // relay: transferred to A at generation 2
  const other = path.join(root, 'other');
  await mkdir(other);
  await writeFile(path.join(other, 'world.bin'), 'a different world');
  await c.importExisting(other, true);
  const ledger = new OwnershipLedger((await c.getState()).server!.ledgerFile, (c as any).identity.fingerprint);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync((await c.getState()).server!.ledgerFile);
  const state = await ledger.status();
  db.prepare('UPDATE ownership SET data = ? WHERE id = 1').run(JSON.stringify({ ...state, generation: 50 }));
  db.close();
  await assert.rejects(c.parkAtRelay(), /declined.*not the newest/i);
  assert.equal((await c.getState()).server!.ownership.state, 'owned', 'C keeps its own server');
  const custody = (await held(relay))!;
  assert.equal(custody.state, 'transferred');
  assert.equal(custody.generation, 2);
});

test('relay configuration must name a trusted peer and survives restart', async (t) => {
  const { root } = await workspace(t, 'relay-config-');
  const identity = await createIdentity();
  const app = new SeedHostApplication(path.join(root, 'a'), identity);
  await app.open();
  await assert.rejects(app.saveRelay({ fingerprint: 'a'.repeat(64), parkOnStop: false }), /trusted peer/i);
  await assert.rejects(app.parkAtRelay(), /no relay/i);
  await app.addPeer({ name: 'Mini PC', fingerprint: 'a'.repeat(64), host: '127.0.0.1', port: 47625 });
  await app.saveRelay({ fingerprint: 'a'.repeat(64), parkOnStop: true });
  await app.close();
  const reopened = new SeedHostApplication(path.join(root, 'a'), identity);
  await reopened.open();
  assert.deepEqual((await reopened.getState()).relay, { fingerprint: 'a'.repeat(64), name: 'Mini PC', parkOnStop: true });
  await reopened.saveRelay(null);
  assert.equal((await reopened.getState()).relay, null);
  await reopened.close();
});

test('the relay keeps a bounded history and never prunes the revision it holds', async (t) => {
  const { root, source } = await workspace(t, 'relay-history-');
  const relay = await startRelay(t, root, undefined, { keepRevisions: 2 });
  const a = (await host(t, root, 'a', relay)).app;
  await a.importExisting(source, true);
  for (let i = 0; i < 4; i++) {
    await writeFile(path.join((await a.getState()).server!.serverDir, 'world.bin'), `edit ${i}`);
    await a.parkAtRelay();
    await a.claimFromRelay();
  }
  await a.parkAtRelay();
  const manifests = await readdir(path.join(root, 'relay', 'store', 'snapshots'));
  assert.equal(manifests.length, 2);
  assert.ok(manifests.includes(`${(await held(relay))!.snapshotId}.json`));
});

test('the relay refuses devices it does not trust', async (t) => {
  const { root } = await workspace(t, 'relay-untrusted-');
  const relay = await startRelay(t, root);
  const stranger = await createIdentity();
  await assert.rejects(relayStatus(stranger, { fingerprint: relay.identity.fingerprint, ...relay.endpoint! }), /disconnect|closed|reject/i);
  await assert.rejects(connectPeer(stranger, 'f'.repeat(64), relay.endpoint!.host, relay.endpoint!.port), /pin|fingerprint/i);
});
