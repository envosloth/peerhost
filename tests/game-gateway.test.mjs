import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { RelayNode } from '../dist/src/core/relay.js';
import { OwnershipLedger } from '../dist/src/core/ownership.js';
import { createServer, connect } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

export async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(process.env.TMPDIR ?? '.test-data', 'game-gateway-'));
  const identity = await createIdentity();
  const relay = new RelayNode(root, await createIdentity(), { log() {}, ...options });
  await relay.open();
  await relay.trust('A', identity.fingerprint);
  await relay.listen();
  t.after(async () => { await relay.close(); await rm(root, { recursive: true, force: true }); });
  return { root, identity, relay, peer: { ...relay.endpoint, fingerprint: relay.identity.fingerprint } };
}

test('gateway discovery reports disabled by default without opening a player listener', async t => {
  const f = await fixture(t);
  const gateway = await import('../dist/src/core/game-gateway.js').catch(() => ({}));
  assert.equal(typeof gateway.gatewayStatus, 'function', 'gateway discovery API must exist');
  const status = await gateway.gatewayStatus(f.identity, f.peer);
  assert.deepEqual(status, { enabled: false, host: null, port: null, ready: false, detail: 'Player gateway is off' });
  assert.equal(f.relay.gameEndpoint, undefined);
});

async function waitFor(work) {
  for (let i = 0; i < 100; i++) { if (await work()) return; await delay(30); }
  assert.fail('condition did not become true');
}
async function echo(t, prefix = '') {
  const sockets = new Set();
  const server = createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); if (prefix) socket.write(prefix); socket.pipe(socket); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}
async function checkedOut(f, target = f.identity) {
  const ledger = new OwnershipLedger(path.join(f.root, 'ownership.sqlite'), f.relay.identity.fingerprint);
  await ledger.initialize('a'.repeat(64));
  const offer = await ledger.prepareTransfer(target.fingerprint, 'a'.repeat(64));
  await ledger.confirmTransfer(offer.id, target.fingerprint);
  return ledger;
}
function player(t, endpoint) {
  const socket = connect(endpoint.port, endpoint.host); socket.on('error', () => {}); t.after(() => socket.destroy()); return socket;
}
async function bytes(socket, length) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('player bytes timeout')); }, 4000);
    const pump = () => { const chunk = socket.read(length); if (chunk) { cleanup(); resolve(chunk); } };
    const cleanup = () => { clearTimeout(timer); socket.off('readable', pump); };
    socket.on('readable', pump); pump();
  });
}

test('opt-in gateway forwards early binary bytes to a pinned outbound holder tunnel', async t => {
  const f = await fixture(t);
  await checkedOut(f);
  const gateway = await import('../dist/src/core/game-gateway.js');
  assert.equal(typeof f.relay.listenGame, 'function', 'relay must open an opt-in raw TCP listener');
  await f.relay.listenGame();
  assert.equal(f.relay.gameEndpoint.host, '127.0.0.1');
  const host = await gateway.startHostGameGateway(f.identity, f.peer, await echo(t, 'hello'));
  t.after(() => host.close());
  await waitFor(async () => (await gateway.gatewayStatus(f.identity, f.peer)).ready);
  const socket = player(t, f.relay.gameEndpoint);
  const payload = Buffer.from([0, 255, 128, 1, 0, 23]);
  socket.write(payload);
  assert.deepEqual(await bytes(socket, 5 + payload.length), Buffer.concat([Buffer.from('hello'), payload]));
});

test('one stable endpoint changes A to B after real park/claim and disconnects old players', async t => {
  const f = await fixture(t);
  const { PeerHostApplication } = await import('../dist/src/core/application.js');
  const { startHostGameGateway, gatewayStatus } = await import('../dist/src/core/game-gateway.js');
  async function app(identity, name) {
    const app = new PeerHostApplication(path.join(f.root, name), identity);
    await app.open(); t.after(() => app.close());
    await f.relay.trust(name, identity.fingerprint);
    await app.addPeer({ name: 'Relay', ...f.peer });
    await app.saveRelay({ fingerprint: f.peer.fingerprint, parkOnStop: false });
    return app;
  }
  const a = await app(f.identity, 'A');
  const ib = await createIdentity(); const b = await app(ib, 'B');
  const source = path.join(f.root, 'source'); await mkdir(source); await writeFile(path.join(source, 'world.bin'), 'test revision');
  await a.importExisting(source, true); await a.parkAtRelay(); await a.claimFromRelay(); await f.relay.settled();
  await f.relay.listenGame();
  const endpoint = { ...f.relay.gameEndpoint };
  const ga = await startHostGameGateway(f.identity, f.peer, await echo(t, 'A')); t.after(() => ga.close());
  await waitFor(async () => (await gatewayStatus(f.identity, f.peer)).ready);
  const old = player(t, endpoint); old.write('x'); assert.equal((await bytes(old, 2)).toString(), 'Ax');
  await a.parkAtRelay(); await f.relay.settled();
  await waitFor(() => old.destroyed);
  assert.equal((await gatewayStatus(f.identity, f.peer)).ready, false);
  const denied = player(t, endpoint); denied.resume(); await waitFor(() => denied.destroyed);
  await b.claimFromRelay(); await f.relay.settled();
  const gb = await startHostGameGateway(ib, f.peer, await echo(t, 'B')); t.after(() => gb.close());
  await waitFor(async () => (await gatewayStatus(ib, f.peer)).ready);
  assert.deepEqual(f.relay.gameEndpoint, endpoint);
  const next = player(t, endpoint); next.write('x'); assert.equal((await bytes(next, 2)).toString(), 'Bx');
  await f.relay.untrust(ib.fingerprint);
  await waitFor(() => next.destroyed);
});

test('idle active player connections expire even when custody stays unchanged', async t => {
  const f = await fixture(t); await checkedOut(f); await f.relay.listenGame({ idleMs: 120 });
  const { startHostGameGateway, gatewayStatus } = await import('../dist/src/core/game-gateway.js');
  const host = await startHostGameGateway(f.identity, f.peer, await echo(t)); t.after(() => host.close());
  await waitFor(async () => (await gatewayStatus(f.identity, f.peer)).ready);
  const socket = player(t, f.relay.gameEndpoint); socket.write('x'); assert.equal((await bytes(socket, 1)).toString(), 'x');
  socket.resume(); await waitFor(() => socket.destroyed);
});

test('pin mismatch never becomes ready and closing cancels retries', async t => {
  const f = await fixture(t); await checkedOut(f); await f.relay.listenGame();
  const { startHostGameGateway, gatewayStatus } = await import('../dist/src/core/game-gateway.js');
  const statuses = [];
  const host = await startHostGameGateway(f.identity, { ...f.peer, fingerprint: 'f'.repeat(64) }, await echo(t), { onStatus: s => statuses.push(s) });
  t.after(() => host.close());
  await waitFor(() => statuses.some(s => s.state === 'error' && /pin|fingerprint/.test(s.detail)));
  assert.equal((await gatewayStatus(f.identity, f.peer)).ready, false);
  await host.close(); const count = statuses.length; await delay(1100); assert.equal(statuses.length, count);
});

test('standby expiry is replenished and host close cancels replenishment', async t => {
  const f = await fixture(t); await checkedOut(f); await f.relay.listenGame({ leaseMs: 150 });
  const { startHostGameGateway, gatewayStatus } = await import('../dist/src/core/game-gateway.js');
  const statuses = [];
  const host = await startHostGameGateway(f.identity, f.peer, await echo(t), { onStatus: s => statuses.push(s) }); t.after(() => host.close());
  await waitFor(() => statuses.filter(s => s.state === 'ready').length >= 4);
  // A deliberately tiny lease tests renewal, not a guarantee that a player can
  // arrive before that lease expires after a separate status round trip.
  await host.close();
  await delay(600); assert.equal((await gatewayStatus(f.identity, f.peer)).ready, false);
});

test('slow readers preserve a multi-megabyte binary payload across backpressure', async t => {
  const f = await fixture(t); await checkedOut(f); await f.relay.listenGame();
  const { startHostGameGateway, gatewayStatus } = await import('../dist/src/core/game-gateway.js');
  const host = await startHostGameGateway(f.identity, f.peer, await echo(t)); t.after(() => host.close());
  await waitFor(async () => (await gatewayStatus(f.identity, f.peer)).ready);
  const socket = player(t, f.relay.gameEndpoint);
  const payload = Buffer.alloc(2 * 1024 * 1024); for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  socket.write(payload); await delay(100);
  const chunks = []; let total = 0;
  while (total < payload.length) { const size = Math.min(16384, payload.length - total); const chunk = await bytes(socket, size); chunks.push(chunk); total += chunk.length; }
  assert.deepEqual(Buffer.concat(chunks), payload);
});

test('a relay that disconnects during local setup cannot leave orphan Minecraft sockets', async t => {
  const { listenPeer, readFrame, writeFrame } = await import('../dist/src/core/peer-transport.js');
  const { startHostGameGateway } = await import('../dist/src/core/game-gateway.js');
  const a = await createIdentity(), r = await createIdentity();
  const localSockets = new Set();
  const local = createServer(s => { localSockets.add(s); s.on('error', () => {}); s.once('close', () => localSockets.delete(s)); });
  local.listen(0, '127.0.0.1'); await once(local, 'listening');
  t.after(async () => { for (const s of localSockets) s.destroy(); await new Promise(resolve => local.close(resolve)); });
  const listener = await listenPeer(r, [a.fingerprint], s => {
    void (async () => {
      const request = await readFrame(s);
      if (request.op === 'gateway-status') { await writeFrame(s, { type: 'relay-gateway-status', enabled: true, host: '127.0.0.1', port: 25565,
        ready: false, detail: 'fixture', route: { owner: a.fingerprint, generation: 1, lineage: 'fixture' } }); s.end(); }
      else { await writeFrame(s, { type: 'relay-tunnel-ready' }); await writeFrame(s, { type: 'relay-tunnel-start' }); s.end(); }
    })().catch(() => s.destroy());
  });
  t.after(() => listener.close());
  const statuses = [];
  const host = await startHostGameGateway(a, { ...listener, fingerprint: r.fingerprint }, local.address().port, { onStatus: s => statuses.push(s) });
  t.after(() => host.close());
  await waitFor(() => statuses.some(s => s.state === 'error'));
  await delay(100);
  assert.equal(localSockets.size, 0, 'aborted relay activation must close local sockets too');
});

test('a throwing status observer cannot disable tunnel cleanup', async t => {
  const f = await fixture(t); await checkedOut(f); await f.relay.listenGame();
  const { startHostGameGateway, gatewayStatus } = await import('../dist/src/core/game-gateway.js');
  const host = await startHostGameGateway(f.identity, f.peer, await echo(t), { onStatus() { throw new Error('observer failure'); } });
  t.after(() => host.close());
  await waitFor(async () => (await gatewayStatus(f.identity, f.peer)).ready);
  await host.close(); await delay(100);
  assert.equal((await gatewayStatus(f.identity, f.peer)).ready, false);
});

test('out-of-process generation changes invalidate active players without reusing a stale tunnel', async t => {
  const f = await fixture(t); const ledger = await checkedOut(f); await f.relay.listenGame();
  const { startHostGameGateway, gatewayStatus } = await import('../dist/src/core/game-gateway.js');
  const host = await startHostGameGateway(f.identity, f.peer, await echo(t)); t.after(() => host.close());
  await waitFor(async () => (await gatewayStatus(f.identity, f.peer)).ready);
  const socket = player(t, f.relay.gameEndpoint); socket.write('x'); assert.equal((await bytes(socket, 1)).toString(), 'x'); socket.resume();
  const { DatabaseSync } = await import('node:sqlite'); const state = await ledger.status();
  const db = new DatabaseSync(path.join(f.root, 'ownership.sqlite'));
  db.prepare('UPDATE ownership SET data = ? WHERE id = 1').run(JSON.stringify({ ...state, generation: state.generation + 1 })); db.close();
  await waitFor(() => socket.destroyed);
});

test('closing the relay tears down an active player and both listeners', async t => {
  const f = await fixture(t); await checkedOut(f); await f.relay.listenGame();
  const { startHostGameGateway, gatewayStatus } = await import('../dist/src/core/game-gateway.js');
  const host = await startHostGameGateway(f.identity, f.peer, await echo(t)); t.after(() => host.close());
  await waitFor(async () => (await gatewayStatus(f.identity, f.peer)).ready);
  const socket = player(t, f.relay.gameEndpoint); socket.write('x'); assert.equal((await bytes(socket, 1)).toString(), 'x'); socket.resume();
  await f.relay.close(); await waitFor(() => socket.destroyed);
  assert.equal(f.relay.gameEndpoint, undefined); assert.equal(f.relay.endpoint, undefined);
  await host.close();
});

test('host close revokes active player streams without closing the stable endpoint', async t => {
  const f = await fixture(t); await checkedOut(f); await f.relay.listenGame();
  const { startHostGameGateway, gatewayStatus } = await import('../dist/src/core/game-gateway.js');
  const host = await startHostGameGateway(f.identity, f.peer, await echo(t)); t.after(() => host.close());
  await waitFor(async () => (await gatewayStatus(f.identity, f.peer)).ready);
  const endpoint = { ...f.relay.gameEndpoint };
  const socket = player(t, endpoint); socket.write('x'); assert.equal((await bytes(socket, 1)).toString(), 'x'); socket.resume();
  await host.close(); await waitFor(() => socket.destroyed);
  assert.deepEqual(f.relay.gameEndpoint, endpoint);
  await delay(600); assert.equal((await gatewayStatus(f.identity, f.peer)).ready, false);
});







