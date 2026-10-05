import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { RelayNode } from '../dist/src/core/relay.js';
import { OwnershipLedger } from '../dist/src/core/ownership.js';
import { createIdentity, connectPeer, listenPeer, readFrame, writeFrame } from '../dist/src/core/peer-transport.js';
import { relayFriends, relayRequest } from '../dist/src/core/relay-client.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(process.env.TMPDIR || path.resolve('.test-data'), 'friends-status-'));
  const relay = new RelayNode(root, await createIdentity(), { log() {} });
  await relay.open();
  const identity = await createIdentity();
  await relay.trust('Sam', identity.fingerprint);
  await relay.listen();
  t.after(async () => { await relay.close(); await rm(root, { recursive: true, force: true }); });
  return { root, relay, identity, peer: { fingerprint: relay.identity.fingerprint, ...relay.endpoint } };
}
async function wireFriends(identity, peer) {
  const socket = await connectPeer(identity, peer.fingerprint, peer.host, peer.port);
  try {
    await writeFrame(socket, relayRequest('friends'));
    return await readFrame(socket);
  } finally { socket.destroy(); }
}

test('wire and typed friends report unknown, parked, pending and held from relay ledger, not null-holder guesses', async t => {
  const { root, relay, identity, peer } = await fixture(t);
  const members = [{ name: 'Sam', fingerprint: identity.fingerprint, you: true }];
  async function expectCustody(custody, holder) {
    assert.deepEqual(await wireFriends(identity, peer), { type: 'relay-friends', members, canManage: false, owner: null, custody, holder });
    assert.deepEqual(await relayFriends(identity, peer), { members, canManage: false, owner: null, custody, holder });
  }
  await expectCustody('unknown', null);
  const ledger = new OwnershipLedger(path.join(root, 'ownership.sqlite'), relay.identity.fingerprint);
  const snapshot = 'b'.repeat(64);
  await ledger.initialize(snapshot);
  await expectCustody('parked', null);
  const offer = await ledger.prepareTransfer(identity.fingerprint, snapshot);
  await expectCustody('pending', null);
  await ledger.confirmTransfer(offer.id, identity.fingerprint);
  await expectCustody('held', 'Sam');
});

test('typed friends refuse missing/invalid custody and contradictory holder claims from a pinned peer', async t => {
  const server = await createIdentity(), client = await createIdentity();
  let status;
  const listener = await listenPeer(server, [client.fingerprint], socket => {
    void (async () => {
      try {
        await readFrame(socket);
        await writeFrame(socket, { type: 'relay-friends', members: [{ name: 'Sam', fingerprint: client.fingerprint, you: true }], ...status });
      } finally { socket.destroy(); }
    })();
  });
  t.after(() => listener.close());
  const peer = { fingerprint: server.fingerprint, host: listener.host, port: listener.port };
  for (const invalid of [{ holder: null }, { custody: 'empty', holder: null }, { custody: 'held', holder: null },
    { custody: 'unknown', holder: 'Sam' }, { custody: 'parked', holder: 'Sam' }, { custody: 'pending', holder: 'Sam' }]) {
    status = invalid;
    await assert.rejects(relayFriends(client, peer), /Invalid relay friends reply/, JSON.stringify(invalid));
  }
});
