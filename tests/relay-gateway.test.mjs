import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createIdentity, connectPeer, readFrame, writeFrame } from '../dist/src/core/peer-transport.js';
import { RelayNode } from '../dist/src/core/relay.js';
import { OwnershipLedger } from '../dist/src/core/ownership.js';
import { relayRequest } from '../dist/src/core/relay-client.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(process.env.TMPDIR ?? '.test-data', 'relay-gateway-'));
  const a = await createIdentity(), b = await createIdentity();
  const relay = new RelayNode(root, await createIdentity(), { log() {} });
  await relay.open(); await relay.trust('A', a.fingerprint); await relay.trust('B', b.fingerprint); await relay.listen();
  t.after(async () => { await relay.close(); await rm(root, { recursive: true, force: true }); });
  const peer = { ...relay.endpoint, fingerprint: relay.identity.fingerprint };
  const ledger = new OwnershipLedger(path.join(root, 'ownership.sqlite'), relay.identity.fingerprint);
  return { root, a, b, relay, peer, ledger };
}
async function checkout(f) {
  await f.ledger.initialize('a'.repeat(64));
  const offer = await f.ledger.prepareTransfer(f.a.fingerprint, 'a'.repeat(64));
  await f.ledger.confirmTransfer(offer.id, f.a.fingerprint);
  return { generation: offer.generation, lineage: offer.lineage };
}
async function register(t, f, identity, route) {
  const socket = await connectPeer(identity, f.peer.fingerprint, f.peer.host, f.peer.port);
  t.after(() => socket.destroy());
  await writeFrame(socket, { ...relayRequest('game-tunnel'), ...route });
  return { socket, reply: await readFrame(socket, 4096) };
}
async function closed(socket, ms = 1000) {
  socket.resume();
  for (let i = 0; i < ms / 20; i++) { if (socket.destroyed) return; await delay(20); }
  assert.fail('socket did not expire/close');
}

test('standby tunnels expire their bounded lease without a player', async t => {
  const f = await fixture(t); const route = await checkout(f);
  await f.relay.listenGame({ leaseMs: 120 });
  const { socket, reply } = await register(t, f, f.a, route);
  assert.equal(reply.type, 'relay-tunnel-ready');
  await closed(socket);
});

test('concurrent registrations cannot exceed four standby tunnels', async t => {
  const f = await fixture(t); const route = await checkout(f); await f.relay.listenGame();
  const results = await Promise.all(Array.from({ length: 12 }, () => register(t, f, f.a, route)));
  assert.equal(results.filter(r => r.reply.type === 'relay-tunnel-ready').length, 4);
  assert.equal(results.filter(r => r.reply.type === 'error').length, 8);
});

test('unsolicited standby raw bytes are rejected instead of becoming player data', async t => {
  const f = await fixture(t); const route = await checkout(f); await f.relay.listenGame();
  const { socket, reply } = await register(t, f, f.a, route); assert.equal(reply.type, 'relay-tunnel-ready');
  socket.write(Buffer.alloc(100, 255)); await closed(socket);
});

test('malformed durable generation cannot authorize a gateway route', async t => {
  const f = await fixture(t); const route = await checkout(f); await f.relay.listenGame();
  const { DatabaseSync } = await import('node:sqlite');
  const state = await f.ledger.status();
  const db = new DatabaseSync(path.join(f.root, 'ownership.sqlite'));
  db.prepare('UPDATE ownership SET data = ? WHERE id = 1').run(JSON.stringify({ ...state, generation: -1 })); db.close();
  const result = await register(t, f, f.a, { ...route, generation: -1 });
  assert.equal(result.reply.type, 'error');
});

test('gateway registration denies nonholders, stale generations, foreign lineage and target fields', async t => {
  const f = await fixture(t); const route = await checkout(f); await f.relay.listenGame();
  for (const [id, request] of [[f.b, route], [f.a, { ...route, generation: route.generation + 1 }],
    [f.a, { ...route, lineage: 'foreign' }], [f.a, { ...route, host: '192.0.2.1', port: 22 }]]) {
    assert.equal((await register(t, f, id, request)).reply.type, 'error');
  }
});

test('no ledger, parked or unacknowledged claims never authorize a tunnel', async t => {
  const f = await fixture(t); await f.relay.listenGame();
  assert.equal((await register(t, f, f.a, { generation: 1, lineage: 'none' })).reply.type, 'error');
  await f.ledger.initialize('a'.repeat(64)); const state = await f.ledger.status();
  assert.equal((await register(t, f, f.a, { generation: 1, lineage: state.lineage })).reply.type, 'error');
  const offer = await f.ledger.prepareTransfer(f.a.fingerprint, 'a'.repeat(64));
  assert.equal((await register(t, f, f.a, { generation: offer.generation, lineage: offer.lineage })).reply.type, 'error');
});

test('invite-bootstrap connections stay excluded after enrollment on a second socket', async t => {
  const f = await fixture(t); const route = await checkout(f); await f.relay.listenGame();
  const stranger = await createIdentity();
  await assert.rejects(connectPeer(stranger, f.peer.fingerprint, f.peer.host, f.peer.port), error => error.code === 'PEER_AUTHORIZATION_DENIED');
  const { joinRelayInvite } = await import('../dist/src/core/relay-client.js');
  const invite = await f.relay.createInvite();
  const bootstrap = await connectPeer(stranger, f.peer.fingerprint, f.peer.host, f.peer.port); t.after(() => bootstrap.destroy());
  await joinRelayInvite(stranger, invite.code, 'New friend');
  await writeFrame(bootstrap, { ...relayRequest('game-tunnel'), ...route });
  const reply = await readFrame(bootstrap, 4096); assert.equal(reply.type, 'error'); assert.match(reply.message, /untrusted/);
});

test('re-enrollment does not revive the generation of a closed tunnel', async t => {
  const f = await fixture(t); const route = await checkout(f); await f.relay.listenGame();
  const { socket } = await register(t, f, f.a, route);
  await f.relay.untrust(f.a.fingerprint); await closed(socket);
  await f.relay.trust('A', f.a.fingerprint);
  const state = await f.ledger.status();
  await f.ledger.acceptTransfer({ id: 'park-fixture', lineage: state.lineage, source: f.a.fingerprint,
    target: f.relay.identity.fingerprint, generation: state.generation + 1, snapshotId: state.snapshotId }, f.a.fingerprint, state.snapshotId);
  const offer = await f.ledger.prepareTransfer(f.a.fingerprint, state.snapshotId); await f.ledger.confirmTransfer(offer.id, f.a.fingerprint);
  assert.equal((await register(t, f, f.a, route)).reply.type, 'error');
});



