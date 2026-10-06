import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer, connect as connectTcp } from 'node:net';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createIdentity, isRetryablePeerError, connectPeer, listenPeer, readFrame } from '../dist/src/core/peer-transport.js';
import { AccountIntegration } from '../dist/src/core/account-integration.js';
import { AccountService } from '../dist/src/core/accounts.js';
import { SeedHostApplication } from '../dist/src/core/application.js';
import { RelayNode } from '../dist/src/core/relay.js';
import { decodeInvite } from '../dist/src/core/invites.js';

async function relayFixture(t) {
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'invite-network-'));
  const identity = await createIdentity();
  const relay = new RelayNode(root, identity, { log() {} });
  await relay.open();
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    await relay.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, relay, identity, cleanup: close => closers.push(close) };
}

test('restarting a loopback relay preserves its explicit client-facing proxy hostname and port', async t => {
  const { root, relay } = await relayFixture(t);
  const advertised = { host: 'group.example', port: 8443 };
  await relay.listen({ host: '127.0.0.1', port: 0, advertise: advertised });
  await relay.close();
  await relay.listen({ host: '127.0.0.1', port: 0 });
  const invite = decodeInvite((await relay.createInvite()).code);
  assert.deepEqual({ host: invite.host, port: invite.port }, advertised,
    'listener bind/ephemeral port must not replace the externally advertised endpoint');
  const persisted = JSON.parse(await readFile(path.join(root, 'relay.json'), 'utf8'));
  assert.deepEqual(persisted.advertise, advertised);
});

test('an explicit loopback proxy advertisement retains its configured port rather than becoming inferred', async t => {
  const { relay } = await relayFixture(t);
  const advertised = { host: 'localhost', port: 8443 };
  await relay.listen({ host: '127.0.0.1', port: 0, advertise: advertised });
  await relay.close();
  await relay.listen({ host: '127.0.0.1', port: 0, advertiseHost: '192.168.10.5' });
  const invitation = decodeInvite((await relay.createInvite()).code);
  assert.deepEqual({ host: invitation.host, port: invitation.port }, advertised);
});

test('creator bootstrap uses the local listener without publishing that address to remote invitations', async t => {
  const { root, relay, identity, cleanup } = await relayFixture(t);
  const publicEndpoint = { host: 'group.example', port: 8443 };
  await relay.listen({ host: '127.0.0.1', port: 0, advertise: publicEndpoint });
  await relay.close();
  const { AlwaysOnHost } = await import('../dist/src/core/always-on.js');
  const host = new AlwaysOnHost(root, identity, { host: '127.0.0.1', port: 0, gamePorts: [0], discoveryPort: 0 });
  cleanup(() => host.close());
  await host.enable('Group');
  const owner = await createIdentity();
  const bootstrap = decodeInvite((await host.ownerInvite('alice', owner.fingerprint)).code);
  assert.equal(bootstrap.host, '127.0.0.1', 'creator must not rely on public ingress/hairpin NAT');
  const persisted = JSON.parse(await readFile(path.join(root, 'relay.json'), 'utf8'));
  assert.deepEqual(persisted.advertise, publicEndpoint, 'local creator enrollment must not redirect later friend invitations');
});

test('LAN pairing codes do not overwrite the configured remote invitation address', async t => {
  const { root, relay, identity, cleanup } = await relayFixture(t);
  const publicEndpoint = { host: 'group.example', port: 8443 };
  await relay.listen({ host: '127.0.0.1', port: 0, advertise: publicEndpoint });
  await relay.close();
  const { AlwaysOnHost } = await import('../dist/src/core/always-on.js');
  const host = new AlwaysOnHost(root, identity, { host: '127.0.0.1', port: 0, gamePorts: [0], discoveryPort: 0 });
  cleanup(() => host.close());
  await host.enable();
  assert.ok((await host.newCode()).code);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'relay.json'), 'utf8')).advertise, publicEndpoint);
});

test('a deliberately configured always-on proxy endpoint reaches recipient-bound invitations', async t => {
  const { root, identity, cleanup } = await relayFixture(t);
  const { AlwaysOnHost } = await import('../dist/src/core/always-on.js');
  const { joinRelayInvite, relayInviteFor } = await import('../dist/src/core/relay-client.js');
  const publicEndpoint = { host: 'group.example', port: 8443 };
  const host = new AlwaysOnHost(root, identity, { host: '127.0.0.1', port: 0, gamePorts: [0], discoveryPort: 0, advertise: publicEndpoint });
  cleanup(() => host.close());
  await host.enable();
  const [owner, recipient] = await Promise.all([createIdentity(), createIdentity()]);
  const localInvite = await host.ownerInvite('alice', owner.fingerprint);
  await joinRelayInvite(owner, localInvite.code, 'alice');
  const local = decodeInvite(localInvite.code);
  const remote = decodeInvite((await relayInviteFor(owner,
    { host: local.host, port: local.port, fingerprint: identity.fingerprint }, recipient.fingerprint)).code);
  assert.deepEqual({ host: remote.host, port: remote.port }, publicEndpoint);
});

test('LAN-only hosts use the selected listener port as a fallback, never a wildcard or stale loopback port', async t => {
  const { relay } = await relayFixture(t);
  await relay.listen({ host: '127.0.0.1', port: 0, advertiseHost: '192.168.10.5' });
  const invitation = decodeInvite((await relay.createInvite()).code);
  assert.equal(invitation.host, '192.168.10.5');
  assert.equal(invitation.port, relay.endpoint.port);
});

test('restarting an inferred LAN advertisement refreshes the actual bound port across relay instances', async t => {
  const { root, relay, identity, cleanup } = await relayFixture(t);
  await relay.listen({ host: '127.0.0.1', port: 0, advertiseHost: '192.168.10.5' });
  const oldPort = relay.endpoint.port;
  await relay.close();
  // Occupy the old port on loopback so the new ephemeral listener cannot accidentally reuse it.
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(oldPort, '127.0.0.1', resolve); });
  cleanup(() => new Promise(resolve => reservation.close(resolve)));
  const restarted = new RelayNode(root, identity, { log() {} });
  cleanup(() => restarted.close());
  await restarted.open();
  await restarted.listen({ host: '127.0.0.1', port: 0, advertiseHost: '192.168.10.5' });
  assert.notEqual(restarted.endpoint.port, oldPort);
  const invitation = decodeInvite((await restarted.createInvite()).code);
  assert.deepEqual({ host: invitation.host, port: invitation.port },
    { host: '192.168.10.5', port: restarted.endpoint.port }, 'inferred LAN route must follow the new listener, not the old port');
});

test('legacy non-loopback explicit advertisements retain their original host and port without provenance', async t => {
  const { root, relay } = await relayFixture(t);
  for (const host of ['group.example', '192.168.10.5']) {
    const advertised = { host, port: 8443 };
    await relay.listen({ host: '127.0.0.1', port: 0, advertise: advertised });
    await relay.close();
    const config = JSON.parse(await readFile(path.join(root, 'relay.json'), 'utf8'));
    delete config.advertiseSource;
    await writeFile(path.join(root, 'relay.json'), JSON.stringify(config));
    await relay.listen({ host: '127.0.0.1', port: 0, advertiseHost: host });
    const invitation = decodeInvite((await relay.createInvite()).code);
    assert.deepEqual({ host: invitation.host, port: invitation.port }, advertised);
    await relay.close();
  }
});

test('an invitation with a persisted explicit route promotes an inferred advertisement across restarts', async t => {
  const { relay } = await relayFixture(t);
  await relay.listen({ host: '127.0.0.1', port: 0, advertiseHost: '192.168.10.5' });
  const advertised = { host: 'group.example', port: 8443 };
  await relay.createInvite({ advertise: advertised });
  await relay.close();
  await relay.listen({ host: '127.0.0.1', port: 0, advertiseHost: '192.168.10.6' });
  const invitation = decodeInvite((await relay.createInvite()).code);
  assert.deepEqual({ host: invitation.host, port: invitation.port }, advertised);
});

function vault() {
  const key = randomBytes(32);
  return {
    encrypt(value) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, c.update(value), c.final(), c.getAuthTag()]); },
    decrypt(value) { const c = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); c.setAuthTag(value.subarray(-16)); return c.update(value.subarray(12, -16), undefined, 'utf8') + c.final('utf8'); },
  };
}
test('a partial pinned TLS frame header is an ambiguous disconnect, not a protocol refusal', async t => {
  const [serverIdentity, clientIdentity] = await Promise.all([createIdentity(), createIdentity()]);
  const listener = await listenPeer(serverIdentity, [clientIdentity.fingerprint], socket => {
    socket.end(Buffer.from([0, 0]));
  });
  t.after(() => listener.close());
  const socket = await connectPeer(clientIdentity, serverIdentity.fingerprint, listener.host, listener.port);
  t.after(() => socket.destroy());
  await assert.rejects(readFrame(socket), error => {
    assert.match(error.message, /Truncated frame header/);
    assert.equal(isRetryablePeerError(error), true, 'EOF before a complete header is transport ambiguity');
    return true;
  });
});

async function proxy(t, target, firstFault) {
  const sockets = new Set();
  let attempts = 0;
  const track = socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); };
  const server = createServer(inbound => {
    track(inbound);
    attempts++;
    if (firstFault === 'always-handshake' || (attempts === 1 && firstFault === 'handshake')) { inbound.resume(); return; }
    const outbound = connectTcp(target.port, target.host);
    track(outbound);
    inbound.pipe(outbound); outbound.pipe(inbound);
    inbound.once('close', () => outbound.destroy()); outbound.once('close', () => inbound.destroy());
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }));
  return { host: 'localhost', port: server.address().port, attempts: () => attempts };
}

test('accepting a username invitation retries one transient peer handshake timeout without changing its authority', { timeout: 20000 }, async t => {
  const { root, relay, cleanup } = await relayFixture(t);
  await relay.listen({ host: '127.0.0.1', port: 0 });
  const ingress = await proxy({ after: cleanup }, relay.endpoint, 'handshake');
  const [di, ai, bi] = await Promise.all([createIdentity(), createIdentity(), createIdentity()]);
  const directory = new AccountService(path.join(root, 'directory'), di);
  const a = new SeedHostApplication(path.join(root, 'alice'), ai);
  const b = new SeedHostApplication(path.join(root, 'bob'), bi);
  cleanup(async () => { await a.close(); await b.close(); await directory.close(); });
  await directory.listen({ host: '127.0.0.1' }); await a.open(); await b.open();
  await a.joinWithInvite({ code: (await relay.createInvite()).code, name: 'alice' });
  await relay.setOwner(ai.fingerprint);
  // Configure only the invitation metadata; the real proxy/listener remains loopback-only.
  await relay.createInvite({ advertise: { host: ingress.host, port: ingress.port } });
  const endpoint = { ...directory.endpoint, fingerprint: di.fingerprint };
  const alice = new AccountIntegration(path.join(root, 'alice'), ai, vault(), a, endpoint);
  const bob = new AccountIntegration(path.join(root, 'bob'), bi, vault(), b, endpoint);
  await alice.authenticate('register', { username: 'alice', password: 'abcd' });
  await bob.authenticate('register', { username: 'bob', password: 'efgh' });
  await alice.send('bob');
  const [request] = await bob.requests();
  assert.equal(request.from, 'alice', 'delivery via account directory works before relay acceptance');
  assert.deepEqual(await bob.accept(request.id), { joined: true, group: relay.name });
  assert.equal(ingress.attempts(), 3, 'one failed handshake, one join retry, one independent membership readback');
  assert.deepEqual(await bob.requests(), []);
  assert.equal((await b.getState()).server, null, 'enrollment must not download or start a world');
  await relay.reload();
  assert.equal(relay.trusted.filter(m => m.fingerprint === bi.fingerprint).length, 1);
  const receipts = Object.values(JSON.parse(await readFile(path.join(root, 'relay.json'), 'utf8')).redeemed);
  assert.equal(receipts.filter(r => r.fingerprint === bi.fingerprint).length, 1);
});

test('a lost relay join response is recovered with the same device-bound durable receipt', async t => {
  const { root, relay, cleanup } = await relayFixture(t);
  let repliesDropped = 0, attempts = 0;
  const handle = relay.handle.bind(relay);
  relay.handle = (socket, source) => {
    attempts++;
    const write = socket.write.bind(socket);
    // Inject loss at the actual response boundary, after real durable redemption; no membership is mocked.
    socket.write = (packet, ...args) => {
      if (Buffer.isBuffer(packet) && packet.includes(Buffer.from('"type":"relay-joined"')) && repliesDropped === 0) {
        repliesDropped++; socket.destroy(); return false;
      }
      return write(packet, ...args);
    };
    return handle(socket, source);
  };
  await relay.listen({ host: '127.0.0.1', port: 0 });
  const recipient = await createIdentity();
  const app = new SeedHostApplication(path.join(root, 'recipient'), recipient);
  cleanup(() => app.close()); await app.open();
  const invite = await relay.createInvite({ recipient: recipient.fingerprint });
  assert.equal((await app.joinWithInvite({ code: invite.code, name: 'bob' })).relayName, relay.name);
  assert.equal(attempts, 2, 'retry only the dropped reply, not unrelated operations');
  assert.equal(repliesDropped, 1);
  await relay.reload();
  assert.equal(relay.trusted.filter(m => m.fingerprint === recipient.fingerprint).length, 1);
  const config = JSON.parse(await readFile(path.join(root, 'relay.json'), 'utf8'));
  assert.equal(Object.values(config.redeemed).filter(r => r.fingerprint === recipient.fingerprint).length, 1);
  assert.equal((await app.getState()).relay.fingerprint, relay.identity.fingerprint);
});

test('invitation retries allow only typed transport or known socket failures, never authentication and protocol refusals', () => {
  for (const code of ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']) {
    assert.equal(isRetryablePeerError(Object.assign(new Error('socket failure'), { code })), true, code);
  }
  for (const code of ['EPROTO', 'ENOTFOUND', 'ERR_TLS_CERT_ALTNAME_INVALID', 'PEER_HANDSHAKE_TIMEOUT', 'UNKNOWN']) {
    assert.equal(isRetryablePeerError(Object.assign(new Error('Peer handshake timed out'), { code })), false, code);
  }
  assert.equal(isRetryablePeerError(new Error('Server certificate fingerprint does not match the expected pin')), false);
  assert.equal(isRetryablePeerError(new Error('Relay refused: Only the intended friend can accept')), false);
  assert.equal(isRetryablePeerError({ code: 'ECONNRESET' }), false);
});

test('permanent handshake failure stops after two attempts and names the separate relay endpoint without enrolling', { timeout: 20000 }, async t => {
  const { root, relay, cleanup } = await relayFixture(t);
  await relay.listen({ host: '127.0.0.1', port: 0 });
  const ingress = await proxy({ after: cleanup }, relay.endpoint, 'always-handshake');
  const invite = await relay.createInvite({ advertise: { host: ingress.host, port: ingress.port } });
  const decoded = decodeInvite(invite.code);
  const app = new SeedHostApplication(path.join(root, 'recipient'), await createIdentity());
  cleanup(() => app.close()); await app.open();
  await assert.rejects(app.joinWithInvite({ code: invite.code, name: 'bob' }), error => {
    assert.ok(error.message.includes(`${ingress.host}:${ingress.port}`));
    assert.match(error.message, /account directory/i);
    assert.match(error.message, /Minecraft player address/i);
    assert.match(error.message, /same invitation.*this PC/i);
    assert.match(error.cause?.message, /Peer handshake timed out/);
    assert.ok(!error.message.includes(invite.code));
    assert.ok(!error.message.includes(decoded.token.toString('hex')));
    return true;
  });
  assert.equal(ingress.attempts(), 2);
  assert.equal((await app.getState()).relay, null);
  await relay.reload(); assert.equal(relay.trusted.length, 0);
});

test('a failed acceptance of a private-address invitation names the private route and bounded retries without enrolling', { timeout: 40000 }, async t => {
  const { root, relay, cleanup } = await relayFixture(t);
  await relay.listen({ host: '127.0.0.1', port: 0 });
  // A closed loopback endpoint deterministically exercises the private-route diagnostic
  // without dialing another device on the user's LAN.
  const invite = await relay.createInvite();
  const endpoint = decodeInvite(invite.code);
  await relay.close();
  const app = new SeedHostApplication(path.join(root, 'recipient'), await createIdentity());
  cleanup(() => app.close()); await app.open();
  await assert.rejects(app.joinWithInvite({ code: invite.code, name: 'bob' }), error => {
    assert.ok(error.message.includes(`127.0.0.1:${endpoint.port}`));
    assert.match(error.message, /private address/);
    assert.match(error.message, /home network or VPN/i);
    assert.match(error.message, /Tailscale/);
    assert.match(error.message, /Retry the same invitation on this PC/);
    return true;
  });
  assert.equal((await app.getState()).relay, null);
  await relay.reload(); assert.equal(relay.trusted.length, 0);
});

test('accept verifies the exact inbox after a committed dismissal response is lost instead of stranding the joined friend', async t => {
  const { root, relay, cleanup } = await relayFixture(t);
  await relay.listen({ host: '127.0.0.1', port: 0 });
  const [di, ai, bi] = await Promise.all([createIdentity(), createIdentity(), createIdentity()]);
  const directory = new AccountService(path.join(root, 'directory'), di);
  let dismissRepliesDropped = 0;
  const handle = directory.handle.bind(directory);
  directory.handle = (socket, fp) => {
    const write = socket.write.bind(socket);
    socket.write = (packet, ...args) => {
      if (Buffer.isBuffer(packet) && packet.includes(Buffer.from('"dismissed":true')) && dismissRepliesDropped === 0) {
        dismissRepliesDropped++; socket.destroy(); return false;
      }
      return write(packet, ...args);
    };
    return handle(socket, fp);
  };
  const a = new SeedHostApplication(path.join(root, 'alice'), ai);
  const b = new SeedHostApplication(path.join(root, 'bob'), bi);
  cleanup(async () => { await a.close(); await b.close(); await directory.close(); });
  await directory.listen({ host: '127.0.0.1' }); await a.open(); await b.open();
  await a.joinWithInvite({ code: (await relay.createInvite()).code, name: 'alice' }); await relay.setOwner(ai.fingerprint);
  const endpoint = { ...directory.endpoint, fingerprint: di.fingerprint };
  const alice = new AccountIntegration(path.join(root, 'alice'), ai, vault(), a, endpoint);
  const bob = new AccountIntegration(path.join(root, 'bob'), bi, vault(), b, endpoint);
  await alice.authenticate('register', { username: 'alice', password: 'abcd' });
  await bob.authenticate('register', { username: 'bob', password: 'efgh' });
  await alice.send('bob'); const [request] = await bob.requests();
  assert.deepEqual(await bob.accept(request.id), { joined: true, group: relay.name });
  assert.equal(dismissRepliesDropped, 1);
  assert.deepEqual(await bob.requests(), []);
  assert.equal((await b.listFriends()).members.filter(m => m.you).length, 1);
});

test('accept reconciles a committed directory dismissal after a truncated pinned TLS reply', async t => {
  const { root, relay, cleanup } = await relayFixture(t);
  await relay.listen({ host: '127.0.0.1', port: 0 });
  const [di, ai, bi] = await Promise.all([createIdentity(), createIdentity(), createIdentity()]);
  const directory = new AccountService(path.join(root, 'directory'), di);
  let truncated = 0;
  const handle = directory.handle.bind(directory);
  directory.handle = (socket, fp) => {
    const write = socket.write.bind(socket);
    socket.write = (packet, ...args) => {
      if (Buffer.isBuffer(packet) && packet.includes(Buffer.from('"dismissed":true')) && truncated === 0) {
        truncated++;
        // The real service has deleted the request. Keep its valid length header, transmit only
        // five JSON bytes, then let the service close the authenticated TLS connection.
        return write(packet.subarray(0, 9), ...args);
      }
      return write(packet, ...args);
    };
    return handle(socket, fp);
  };
  const a = new SeedHostApplication(path.join(root, 'alice'), ai);
  const b = new SeedHostApplication(path.join(root, 'bob'), bi);
  cleanup(async () => { await a.close(); await b.close(); await directory.close(); });
  await directory.listen({ host: '127.0.0.1' }); await a.open(); await b.open();
  await a.joinWithInvite({ code: (await relay.createInvite()).code, name: 'alice' }); await relay.setOwner(ai.fingerprint);
  const endpoint = { ...directory.endpoint, fingerprint: di.fingerprint };
  const alice = new AccountIntegration(path.join(root, 'alice'), ai, vault(), a, endpoint);
  const bob = new AccountIntegration(path.join(root, 'bob'), bi, vault(), b, endpoint);
  await alice.authenticate('register', { username: 'alice', password: 'abcd' });
  await bob.authenticate('register', { username: 'bob', password: 'efgh' });
  await alice.send('bob'); const [request] = await bob.requests();
  assert.deepEqual(await bob.accept(request.id), { joined: true, group: relay.name });
  assert.equal(truncated, 1);
  assert.deepEqual(await bob.requests(), [], 'success requires authoritative absent-inbox readback');
  assert.equal((await b.listFriends()).members.filter(m => m.you).length, 1);
});

test('desktop always-on profiles apply an explicit relay-advertise file and refuse malformed routes before opening sockets', async t => {
  const { root, identity, cleanup } = await relayFixture(t);
  const { AlwaysOnHost } = await import('../dist/src/core/always-on.js');
  const file = path.join(root, 'relay-advertise.json');
  const publicEndpoint = { host: 'group.example', port: 8443 };
  await writeFile(file, JSON.stringify(publicEndpoint));
  const host = new AlwaysOnHost(root, identity, { host: '127.0.0.1', port: 0, gamePorts: [0], discoveryPort: 0 });
  cleanup(() => host.close());
  await host.enable();
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'relay.json'), 'utf8')).advertise, publicEndpoint);
  await host.close();
  for (const invalid of [{ host: '0.0.0.0', port: 8443 }, { host: 'group.example', port: 0 }, { host: 'group.example', port: 8443, fingerprint: identity.fingerprint }]) {
    const text = JSON.stringify(invalid); await writeFile(file, text);
    await assert.rejects(host.enable(), /relay-advertise.json/);
    assert.equal((await host.status()).running, false);
    assert.equal(await readFile(file, 'utf8'), text, 'bad configuration is left unchanged');
  }
});
