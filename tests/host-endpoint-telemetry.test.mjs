import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createIdentity, connectPeer, readFrame, writeFrame } from '../dist/src/core/peer-transport.js';
import { SeedHostApplication } from '../dist/src/core/application.js';
import { RelayNode } from '../dist/src/core/relay.js';
import { relayStatus, relayRequest, openRelayHostSession } from '../dist/src/core/relay-client.js';

// A live hosting group: owner parked the world, member claimed it and is running it with an
// authenticated host session. All sockets are real pinned TLS on loopback.
async function fixture(t) {
  const scratch = process.env.TMPDIR;
  assert.ok(scratch?.replaceAll('\\', '/').toLowerCase().includes('hermes/cache/scratch'), 'disposable scratch root required');
  const root = await mkdtemp(path.join(scratch, 'seedhost-endpoint-'));
  const relay = new RelayNode(path.join(root, 'relay'), await createIdentity(), { log() {}, name: 'Shared world' });
  const app = options => new SeedHostApplication(path.join(root, options.name), options.identity, {
    resolveGroupLaunchProfile: async () => ({ executable: process.execPath, args: [path.resolve('tools/fake-java-server.mjs'), '--lifetime-ms=30000'] }),
  });
  const owner = app({ name: 'owner', identity: await createIdentity() });
  const member = app({ name: 'member', identity: await createIdentity() });
  t.after(async () => { await member.close(); await owner.close(); await relay.close(); await rm(root, { recursive: true, force: true }); });
  await relay.open(); await relay.listen(); await owner.open(); await member.open();
  await relay.trust('Owner', owner.identity.fingerprint); await relay.setOwner(owner.identity.fingerprint);
  await owner.addPeer({ name: relay.name, fingerprint: relay.identity.fingerprint, ...relay.endpoint });
  const source = path.join(root, 'source');
  await mkdir(source); await writeFile(path.join(source, 'world.bin'), 'initial'); await writeFile(path.join(source, 'eula.txt'), 'eula=true\n');
  await owner.importExisting(source, true);
  await owner.saveRelay({ fingerprint: relay.identity.fingerprint, parkOnStop: false });
  await member.joinHostingGroup({ code: (await owner.createInvite()).code, name: 'Member' });
  return { root, owner, member, relay, pin: relay.identity.fingerprint, remote: { fingerprint: relay.identity.fingerprint, host: relay.endpoint.host, port: relay.endpoint.port } };
}
async function hostingMember(t) {
  const f = await fixture(t);
  await f.owner.parkAtRelay(); await f.member.claimPendingGroup(f.pin); await f.relay.settled();
  await f.member.saveProfile({ executable: process.execPath, args: [path.resolve('tools/fake-java-server.mjs'), '--lifetime-ms=30000'] });
  await f.member.startGroup(f.pin, true);
  const recovery = await f.member.groupRecoveryStatus();
  assert.ok(recovery.admission?.revision, 'fixture: hosting admission journal carries the exact revision');
  return { ...f, revision: recovery.admission.revision };
}
async function destroyed(socket) {
  if (socket.destroyed) return;
  await new Promise(resolve => { socket.once('close', resolve); socket.once('error', () => {}); setTimeout(resolve, 5000); });
  assert.ok(socket.destroyed, 'the relay must destroy the socket');
}

test('host session publishes, replaces and clears a verified join endpoint that every member can read', async t => {
  const { owner, member, relay, remote } = await hostingMember(t);
  const before = await relayStatus(owner.identity, remote);
  assert.equal(before.hosting, true, 'the live host session is observed');
  assert.equal(before.holderEndpoint, null, 'nothing is published yet');
  await member.publishHostEndpoint({ address: 'alice-world.tun.ply.gg', verifiedAt: 111111111 });
  const published = await relayStatus(owner.identity, remote);
  assert.deepEqual(published.holderEndpoint, { address: 'alice-world.tun.ply.gg', verifiedAt: 111111111 });
  assert.equal(published.hosting, true);
  await member.publishHostEndpoint({ address: 'alice-world.joinmc.link', verifiedAt: 222222222 });
  assert.deepEqual((await relayStatus(owner.identity, remote)).holderEndpoint, { address: 'alice-world.joinmc.link', verifiedAt: 222222222 });
  await member.publishHostEndpoint({ address: 'Bad_Upper.example', verifiedAt: 1 });
  assert.deepEqual((await relayStatus(owner.identity, remote)).holderEndpoint, { address: 'alice-world.joinmc.link', verifiedAt: 222222222 }, 'an invalid address is never stored');
  await member.publishHostEndpoint(null);
  const cleared = await relayStatus(owner.identity, remote);
  assert.equal(cleared.holderEndpoint, null, 'null clears the stored endpoint');
  assert.equal(cleared.hosting, true, 'clearing the endpoint keeps the host session');
  assert.equal((await relayStatus(member.identity, remote)).hosting, true, 'the holder also sees its own live session');
});

test('the endpoint disappears with the host session and is never exposed for a stopped generation', async t => {
  const { owner, member, relay, remote } = await hostingMember(t);
  await member.publishHostEndpoint({ address: 'alice-world.tun.ply.gg', verifiedAt: 444444444 });
  assert.deepEqual((await relayStatus(owner.identity, remote)).holderEndpoint, { address: 'alice-world.tun.ply.gg', verifiedAt: 444444444 });
  await member.stopServer();
  const stopped = await relayStatus(owner.identity, remote);
  assert.equal(stopped.hosting, null, 'the session closed with the stop');
  assert.equal(stopped.holderEndpoint, null, 'a closed session exposes no endpoint');
  assert.equal(stopped.owner, relay.identity.fingerprint, 'the world parked back at the relay');
});

test('malformed and oversized endpoint frames are ignored or destroy only that session, and a fresh session recovers', async t => {
  const { owner, member, relay, pin, remote, revision } = await hostingMember(t);
  const socket = await connectPeer(member.identity, pin, remote.host, remote.port);
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await writeFrame(socket, { ...relayRequest('host-running'), ...revision });
  assert.equal((await readFrame(socket)).type, 'relay-host-accepted', 'a fresh exact host session replaces the old one');
  await writeFrame(socket, { type: 'host-endpoint', address: 'raw-host.tun.ply.gg', verifiedAt: 424242 });
  await writeFrame(socket, { type: 'host-endpoint', address: 'Bad_Address.tun.ply.gg', verifiedAt: 1 });
  await writeFrame(socket, { type: 'host-endpoint', address: 'raw-host.tun.ply.gg', verifiedAt: 0 });
  await writeFrame(socket, { type: 'host-endpoint', address: 'raw-host.tun.ply.gg', verifiedAt: 9, extra: true });
  await writeFrame(socket, { type: 'ignored-frame', address: 'other.tun.ply.gg', verifiedAt: 5 });
  const junk = Buffer.from('this is not json');
  const junkPacket = Buffer.alloc(4 + junk.length); junkPacket.writeUInt32BE(junk.length, 0); junk.copy(junkPacket, 4);
  socket.write(junkPacket);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual((await relayStatus(owner.identity, remote)).holderEndpoint, { address: 'raw-host.tun.ply.gg', verifiedAt: 424242 }, 'only the exact valid shape from the socket held it');
  const oversized = Buffer.alloc(8); oversized.writeUInt32BE(5000, 0);
  socket.write(oversized);
  await destroyed(socket);
  const lost = await relayStatus(owner.identity, remote);
  assert.equal(lost.hosting, null, 'the oversized frame destroyed only that session');
  assert.equal(lost.holderEndpoint, null);
  const revived = await openRelayHostSession(member.identity, remote, revision);
  t.after(() => revived.close());
  await revived.sendEndpoint({ address: 'revived.joinmc.link', verifiedAt: 555 });
  assert.deepEqual((await relayStatus(owner.identity, remote)).holderEndpoint, { address: 'revived.joinmc.link', verifiedAt: 555 }, 'the relay accepted a clean session after the destroy');
});

test('a buffer flood past the 64 KiB cap destroys the session without disturbing relay bookkeeping', async t => {
  const { owner, member, relay, pin, remote, revision } = await hostingMember(t);
  const socket = await connectPeer(member.identity, pin, remote.host, remote.port);
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await writeFrame(socket, { ...relayRequest('host-running'), ...revision });
  assert.equal((await readFrame(socket)).type, 'relay-host-accepted');
  socket.write(Buffer.alloc(4 + 4096 + 70000, 0));
  await destroyed(socket);
  const lost = await relayStatus(owner.identity, remote);
  assert.equal(lost.hosting, null);
  assert.equal(lost.holderEndpoint, null);
  assert.equal(lost.owner, member.identity.fingerprint, 'custody itself is untouched by the destroyed telemetry session');
});

test('sendEndpoint round-trips over pinned TLS, validates shape and surfaces transport errors only to the caller', async t => {
  const { member, pin, remote, revision } = await hostingMember(t);
  const session = await openRelayHostSession(member.identity, remote, revision);
  await assert.rejects(session.sendEndpoint({ address: 'Nope.example', verifiedAt: 5 }), /invalid|address/i);
  await assert.rejects(session.sendEndpoint({ address: 'fine.tun.ply.gg', verifiedAt: 0 }), /invalid|address/i);
  await assert.rejects(session.sendEndpoint({ address: 'fine.tun.ply.gg', verifiedAt: 1.5 }), /invalid|address/i);
  await session.sendEndpoint({ address: 'direct-host.tun.ply.gg', verifiedAt: 987654321 });
  assert.deepEqual((await relayStatus(member.identity, remote)).holderEndpoint, { address: 'direct-host.tun.ply.gg', verifiedAt: 987654321 });
  await session.sendEndpoint(null);
  assert.equal((await relayStatus(member.identity, remote)).holderEndpoint, null);
  session.close();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await relayStatus(member.identity, remote)).hosting, null);
});

test('publishHostEndpoint without a live host session is a quiet no-op', async t => {
  const { owner, member, pin, relay, remote } = await fixture(t);
  await owner.parkAtRelay(); await member.claimPendingGroup(pin); await relay.settled();
  await member.publishHostEndpoint({ address: 'nobody.tun.ply.gg', verifiedAt: 12 });
  await member.publishHostEndpoint(null);
  await member.publishHostEndpoint({ address: 'BAD', verifiedAt: -1 });
  assert.equal((await relayStatus(owner.identity, remote)).holderEndpoint, null, 'nothing was published without a session');
  assert.equal((await member.getState()).server.ownership.state, 'owned', 'the no-op never changed custody');
});

test('a broken host socket logs quietly and never fails or undoes hosting', async t => {
  const { owner, member, relay, pin, remote, revision } = await hostingMember(t);
  const takeover = await connectPeer(member.identity, pin, remote.host, remote.port);
  takeover.on('error', () => {});
  t.after(() => takeover.destroy());
  await writeFrame(takeover, { ...relayRequest('host-running'), ...revision });
  assert.equal((await readFrame(takeover)).type, 'relay-host-accepted');
  await assert.doesNotReject(member.publishHostEndpoint({ address: 'lost.tun.ply.gg', verifiedAt: 6 }), 'telemetry failure never rejects');
  const state = await member.getState();
  assert.equal(state.server.state, 'running', 'the local server keeps running');
  assert.equal(state.server.ownership.state, 'hosting', 'hosting was not undone');
  assert.equal(state.busy, null, 'no popup or stuck operation');
  await writeFrame(takeover, { type: 'host-endpoint', address: 'survivor.tun.ply.gg', verifiedAt: 7 });
  assert.deepEqual((await relayStatus(owner.identity, remote)).holderEndpoint, { address: 'survivor.tun.ply.gg', verifiedAt: 7 }, 'the failed publish never polluted the surviving session');
});

// ---------- renderer: the multi-host page shows the remote holder's verified join address ----------

async function relayHarness({ status, state: stateOverride } = {}) {
  const source = await readFile(new URL('../apps/desktop/renderer.js', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('  function renderRelay()'), source.indexOf('  function renderPeerList()'));
  assert.ok(block.includes('function copyRelayJoin'), 'the renderer slice must include the join-address copy action');
  const elements = new Map(), copies = [];
  const get = id => {
    if (!elements.has(id)) elements.set(id, { hidden: false, disabled: false, textContent: '', dataset: {}, handlers: {}, replaceChildren() {}, setAttribute() {}, append() {}, addEventListener(k, v) { this.handlers[k] = v; } });
    return elements.get(id);
  };
  const state = stateOverride ?? {
    deviceId: 'a'.repeat(64),
    relay: { fingerprint: 'c'.repeat(64), name: 'Always-on helper', parkOnStop: false },
    peers: [],
    server: { id: 'world-1', group: { fingerprint: 'g'.repeat(64) }, ownership: { state: 'transferred', owner: 'b'.repeat(64) } },
  };
  const ctx = {
    state, bridgeReady: true, isBusy: () => false, $: get, element: () => ({ setAttribute() {}, append() {}, value: '' }),
    relayStatus: status ?? null, relayStatusError: null, relayDirty: false,
    syncRelayContext: () => 'relay-context', formatEndpoint: (host, port) => `${host}:${port}`,
    isStopped: () => state.server?.state !== 'running', isHosting: () => false, ownsServer: () => false, pendingOffer: () => null,
    checkRelay: async () => {},
    navigator: { clipboard: { writeText: async value => { copies.push(value); } } },
  };
  vm.createContext(ctx);
  vm.runInContext(block, ctx);
  vm.runInContext('renderRelay()', ctx);
  return { ctx, get, copies };
}

test('the multi-host page shows and copies the remote holder’s verified join address after a live re-read', async () => {
  const status = { state: 'transferred', owner: 'b'.repeat(64), ownerName: 'B', holderEndpoint: { address: 'b-pc.tun.ply.gg', verifiedAt: 123456 } };
  const { ctx, get, copies } = await relayHarness({ status });
  assert.equal(get('relay-join').hidden, false);
  assert.equal(get('relay-join-value').textContent, 'b-pc.tun.ply.gg');
  assert.equal(get('relay-join-copy').hidden, false);
  assert.equal(get('relay-join-copy').disabled, false);
  assert.equal(get('relay-join-note').hidden, true);
  // The copy action re-reads live relay state first and never copies the stale cached value.
  ctx.checkRelay = async () => { ctx.relayStatus = { ...status, holderEndpoint: { address: 'newer.joinmc.link', verifiedAt: 777 } }; };
  await vm.runInContext('copyRelayJoin()', ctx);
  assert.deepEqual(copies, ['newer.joinmc.link']);
  // If the live re-read no longer vouches for an address, nothing is copied.
  ctx.checkRelay = async () => { ctx.relayStatus = { ...status, holderEndpoint: null }; };
  await vm.runInContext('copyRelayJoin()', ctx);
  assert.deepEqual(copies, ['newer.joinmc.link'], 'no copy without a live verified address');
});

test('the multi-host page holds an honest unknown and never copies an address the relay did not verify', async () => {
  const remoteState = {
    deviceId: 'a'.repeat(64),
    relay: { fingerprint: 'c'.repeat(64), name: 'Always-on helper', parkOnStop: false },
    peers: [],
    server: { id: 'world-1', group: { fingerprint: 'g'.repeat(64) }, ownership: { state: 'transferred', owner: 'b'.repeat(64) } },
  };
  const none = await relayHarness({ status: { state: 'transferred', owner: 'b'.repeat(64), ownerName: 'B', holderEndpoint: null }, state: remoteState });
  assert.equal(none.get('relay-join').hidden, true, 'no address row without a published endpoint');
  assert.equal(none.get('relay-join-note').hidden, false);
  assert.match(none.get('relay-join-note').textContent, /has not published a join address yet/);
  assert.match(none.get('relay-join-note').textContent, /Join address on their PC/);
  assert.equal(none.get('relay-join-copy').hidden, true, 'no copy control without an address');
  const unverified = await relayHarness({ status: { state: 'transferred', owner: 'b'.repeat(64), ownerName: 'B', holderEndpoint: { address: 'b-pc.tun.ply.gg', verifiedAt: 0 } }, state: remoteState });
  assert.equal(unverified.get('relay-join').hidden, true, 'an unverified endpoint is never shown as a join address');
  assert.equal(unverified.get('relay-join-value').textContent, '');
  await vm.runInContext('copyRelayJoin()', unverified.ctx);
  assert.deepEqual(unverified.copies, [], 'an unverified endpoint can never be copied');
  const mine = await relayHarness({ status: { state: 'transferred', owner: 'a'.repeat(64), ownerName: 'Me', holderEndpoint: { address: 'mine.tun.ply.gg', verifiedAt: 5 } }, state: { ...remoteState, server: { ...remoteState.server, ownership: { state: 'owned', owner: 'a'.repeat(64) } } } });
  assert.equal(mine.get('relay-join').hidden, true, 'this PC’s own hosting never says “Join at” about itself');
  assert.equal(mine.get('relay-join-note').hidden, true);
});

test('the multi-host page refetches relay status when the world or relay context changes, fencing A to B to A', async () => {
  const source = await readFile(new URL('../apps/desktop/renderer.js', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('  let relayStatus = null;'), source.indexOf('  const TIMEOUT_MIN'));
  assert.ok(block.includes('function syncRelayContext'));
  const calls = [];
  const ctx = {
    state: { deviceId: 'a'.repeat(64), relay: { fingerprint: 'c'.repeat(64) }, server: { id: 'w1' }, peers: [] },
    window: {},
    checkRelay: async foreground => { calls.push(foreground); },
  };
  vm.createContext(ctx);
  vm.runInContext(block, ctx);
  vm.runInContext('syncRelayContext()', ctx);
  assert.equal(calls.length, 1, 'a new relay context is refetched once');
  assert.equal(calls[0], false, 'the automatic refetch is silent');
  vm.runInContext('syncRelayContext()', ctx);
  assert.equal(calls.length, 1, 'an unchanged context never refetches');
  ctx.state.server = { id: 'w2' };
  vm.runInContext('syncRelayContext()', ctx);
  assert.equal(calls.length, 2, 'switching worlds refetches');
  ctx.state.server = { id: 'w1' };
  vm.runInContext('syncRelayContext()', ctx);
  assert.equal(calls.length, 3, 'A to B to A refetches again instead of trusting the stale projection');
  ctx.state.relay = null;
  vm.runInContext('syncRelayContext()', ctx);
  assert.equal(calls.length, 3, 'no relay: there is nothing to fetch');
});

test('the relay card offers Join at <address> with a copy control in the page markup', async () => {
  const html = await readFile(new URL('../apps/desktop/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="relay-join"[^>]*>\s*Join at\s*<code id="relay-join-value"/, 'the multi-host relay card offers a Join at line');
  assert.match(html, /id="relay-join-copy"[^>]*>Copy</);
});
