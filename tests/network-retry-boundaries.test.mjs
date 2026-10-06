import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createServer as createTlsServer } from 'node:tls';
import { createIdentity, connectPeer, listenPeer, readFrame, isRetryablePeerError } from '../dist/src/core/peer-transport.js';
import { RelayNode } from '../dist/src/core/relay.js';
import { joinRelayInvite } from '../dist/src/core/relay-client.js';
import { AccountService } from '../dist/src/core/accounts.js';
import { AccountIntegration } from '../dist/src/core/account-integration.js';

test('a second device gets an explicit used-invitation refusal without membership or retry', async t => {
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'relay-used-diagnostic-'));
  const [ri, first, second] = await Promise.all([createIdentity(), createIdentity(), createIdentity()]);
  const relay = new RelayNode(root, ri, { log() {} });
  t.after(async () => { await relay.close(); await rm(root, { recursive: true, force: true }); });
  await relay.open(); await relay.listen({ host: '127.0.0.1', port: 0 });
  const invitation = await relay.createInvite();
  await joinRelayInvite(first, invitation.code, 'First');
  let admissions = 0;
  const reload = relay.reload.bind(relay);
  relay.reload = async () => { admissions++; await reload(); };
  await assert.rejects(joinRelayInvite(second, invitation.code, 'Second'), error => {
    assert.match(error.message, /already used/i);
    assert.doesNotMatch(error.message, /Retry the same invitation|must be reachable/i);
    assert.equal(isRetryablePeerError(error), false);
    return true;
  });
  assert.equal(admissions, 1, 'explicit used-token refusal does not retry');
  assert.deepEqual(relay.trusted.map(member => member.fingerprint), [first.fingerprint]);
});

test('pinned admission denial is terminal before any application frame or capability', async t => {
  const [si, ci] = await Promise.all([createIdentity(), createIdentity()]);
  let admissions = 0, callbacks = 0;
  const listener = await listenPeer(si, [], () => { callbacks++; }, {
    authorizeCertificate: async () => { admissions++; return false; },
  });
  t.after(() => listener.close());
  await assert.rejects(connectPeer(ci, si.fingerprint, listener.host, listener.port), error => {
    assert.equal(error.code, 'PEER_AUTHORIZATION_DENIED');
    assert.equal(isRetryablePeerError(error), false);
    return true;
  });
  assert.equal(admissions, 1);
  assert.equal(callbacks, 0);
});

async function handshakeServer(t, identity, response) {
  const sockets = new Set();
  const server = createTlsServer({ key: identity.keyPem, cert: identity.certPem }, socket => {
    socket.on('error', () => {});
    socket.end(response);
  });
  server.on('connection', socket => {
    sockets.add(socket); socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }));
  return server.address().port;
}

test('truncated pinned acceptance prefaces remain retryable transport ambiguity', async t => {
  const [si, ci] = await Promise.all([createIdentity(), createIdentity()]);
  for (const response of [Buffer.alloc(0), Buffer.from('SeedHost/'), Buffer.from('SeedHost/!')]) {
    const port = await handshakeServer(t, si, response);
    await assert.rejects(connectPeer(ci, si.fingerprint, '127.0.0.1', port), error => {
      assert.equal(error.code, 'PEER_DISCONNECTED');
      assert.equal(isRetryablePeerError(error), true);
      return true;
    });
  }
});

test('refusal prefaces cannot override certificate pin validation or complete protocol failures', async t => {
  const [si, ci, wrong] = await Promise.all([createIdentity(), createIdentity(), createIdentity()]);
  const refusal = await handshakeServer(t, si, Buffer.from('SeedHost/!\n'));
  await assert.rejects(connectPeer(ci, wrong.fingerprint, '127.0.0.1', refusal), error => {
    assert.match(error.message, /certificate fingerprint/);
    assert.notEqual(error.code, 'PEER_AUTHORIZATION_DENIED');
    assert.equal(isRetryablePeerError(error), false);
    return true;
  });
  const malformed = await handshakeServer(t, si, Buffer.from('SeedHost/?\n'));
  await assert.rejects(connectPeer(ci, si.fingerprint, '127.0.0.1', malformed), error => {
    assert.match(error.message, /transport protocol/);
    assert.equal(isRetryablePeerError(error), false);
    return true;
  });
});

test('an unreachable relay reports network recovery without implying an expired or used invitation', async t => {
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'relay-network-diagnostic-'));
  const [ri, ci] = await Promise.all([createIdentity(), createIdentity()]);
  const relay = new RelayNode(root, ri, { log() {} });
  t.after(async () => { await relay.close(); await rm(root, { recursive: true, force: true }); });
  await relay.open(); await relay.listen({ host: '127.0.0.1', port: 0 });
  const invitation = await relay.createInvite();
  await relay.close();
  await assert.rejects(joinRelayInvite(ci, invitation.code, 'Guest'), error => {
    assert.match(error.message, /relay must be reachable/i);
    assert.match(error.message, /retry the same invitation/i);
    assert.doesNotMatch(error.message, /expired|already used|revoked/i);
    return true;
  });
});

async function directoryRequest(t) {
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'retry-boundaries-'));
  const [di, ri, ai, bi] = await Promise.all(Array.from({ length: 4 }, () => createIdentity()));
  const directory = new AccountService(path.join(root, 'directory'), di);
  const relay = new RelayNode(path.join(root, 'relay'), ri, { log() {} });
  t.after(async () => { await directory.close(); await relay.close(); await rm(root, { recursive: true, force: true }); });
  await directory.listen({ host: '127.0.0.1' }); await relay.open(); await relay.listen({ host: '127.0.0.1', port: 0 });
  const endpoint = { ...directory.endpoint, fingerprint: di.fingerprint };
  // Only decline is exercised here: the local issuer adapter creates a real recipient-bound token.
  // Membership acceptance is covered with real applications in invitation-network.test.mjs.
  const issuer = { createInviteFor: fingerprint => relay.createInvite({ recipient: fingerprint }) };
  const vault = { encrypt: value => Buffer.from(value), decrypt: value => value.toString('utf8') };
  const alice = new AccountIntegration(path.join(root, 'alice'), ai, vault, issuer, endpoint);
  const bob = new AccountIntegration(path.join(root, 'bob'), bi, vault, {}, endpoint);
  await alice.authenticate('register', { username: 'alice', password: 'abcd' });
  await bob.authenticate('register', { username: 'bob', password: 'efgh' });
  await alice.send('bob');
  const [request] = await bob.requests();
  return { directory, bob, request };
}

function truncateDismissal(directory) {
  const handle = directory.handle.bind(directory);
  directory.handle = (socket, fp) => {
    const write = socket.write.bind(socket);
    socket.write = (packet, ...args) => write(Buffer.isBuffer(packet) && packet.includes(Buffer.from('"dismissed":true')) ? packet.subarray(0, 9) : packet, ...args);
    return handle(socket, fp);
  };
}

test('an ambiguous dismissal cannot succeed while the exact device inbox still contains the request', async t => {
  const { directory, bob, request } = await directoryRequest(t);
  const perform = directory.perform.bind(directory);
  let dismissals = 0, inboxReads = 0;
  directory.perform = (op, ...args) => {
    if (op === 'dismiss') { dismissals++; return { dismissed: true }; } // Inject no commit; real SQL inbox remains authoritative.
    if (op === 'inbox') inboxReads++;
    return perform(op, ...args);
  };
  truncateDismissal(directory);
  await assert.rejects(bob.decline(request.id), error => {
    assert.match(error.message, /Truncated frame body/); assert.equal(isRetryablePeerError(error), true); return true;
  });
  assert.equal(dismissals, 1, 'never replay a potentially committed mutation');
  assert.equal(inboxReads, 1, 'one authenticated authoritative readback');
  assert.deepEqual((await bob.requests()).map(r => r.id), [request.id], 'request remains available for retry');
});

test('a committed ambiguous dismissal cannot report success when authenticated inbox readback fails', async t => {
  const { directory, bob, request } = await directoryRequest(t);
  const perform = directory.perform.bind(directory);
  let failReadback = true;
  directory.perform = (op, ...args) => {
    if (op === 'inbox' && failReadback) throw new Error('Sign in again');
    return perform(op, ...args);
  };
  truncateDismissal(directory);
  await assert.rejects(bob.decline(request.id), /Sign in again/);
  failReadback = false;
  assert.deepEqual(await bob.requests(), [], 'deletion really committed, but could not be confirmed during decline');
});

test('explicit session and authorization refusals do not trigger dismissal reconciliation', async t => {
  const { directory, bob, request } = await directoryRequest(t);
  const perform = directory.perform.bind(directory);
  for (const message of ['Sign in again', 'Invitation not found', 'Unsupported account operation']) {
    let inboxReads = 0, dismissals = 0;
    directory.perform = (op, ...args) => {
      if (op === 'dismiss') { dismissals++; throw new Error(message); }
      if (op === 'inbox') inboxReads++;
      return perform(op, ...args);
    };
    await assert.rejects(bob.decline(request.id), error => error.message === message);
    assert.equal(dismissals, 1); assert.equal(inboxReads, 0, message);
  }
  directory.perform = perform;
  assert.deepEqual((await bob.requests()).map(r => r.id), [request.id]);
});

test('complete malformed pinned TLS frames remain terminal protocol failures', async t => {
  const [si, ci] = await Promise.all([createIdentity(), createIdentity()]);
  for (const [body, length, maxBytes] of [
    [Buffer.from('{bad'), 4, 1024],
    [Buffer.from([0xff]), 1, 1024],
    [Buffer.alloc(0), 0, 1024],
    [Buffer.from('{}'), 2, 1],
  ]) {
    const packet = Buffer.alloc(4 + body.length); packet.writeUInt32BE(length); body.copy(packet, 4);
    const listener = await listenPeer(si, [ci.fingerprint], socket => socket.end(packet));
    try {
      const socket = await connectPeer(ci, si.fingerprint, listener.host, listener.port);
      try {
        await assert.rejects(readFrame(socket, maxBytes), error => {
          assert.equal(isRetryablePeerError(error), false, error.message); return true;
        });
      } finally { socket.destroy(); }
    } finally { await listener.close(); }
  }
});
