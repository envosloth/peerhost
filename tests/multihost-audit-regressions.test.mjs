import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { SeedHostApplication } from '../dist/src/core/application.js';
import { OwnershipLedger } from '../dist/src/core/ownership.js';
import { RelayNode } from '../dist/src/core/relay.js';
import { AccountService } from '../dist/src/core/accounts.js';
import { AccountIntegration } from '../dist/src/core/account-integration.js';

// Regressions for the independent multihost audit: invitation-context binding, interrupted-claim recovery
// (journal + tolerant reads + retry) and modern-vs-legacy enrollment adoption.

const scratch = process.env.TMPDIR || process.env.TEMP || process.env.TMP || path.resolve('.test-data');

async function workspace(t, prefix, cleanup = true) {
  const base = path.isAbsolute(scratch) ? scratch : path.resolve(scratch);
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, prefix));
  if (cleanup) t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function relayIn(t, dir, name) {
  const relay = new RelayNode(dir, await createIdentity(), { log() {}, name });
  await relay.open();
  await relay.listen();
  t.after(() => relay.close());
  return relay;
}
async function appIn(t, dir, name, identity) {
  const app = new SeedHostApplication(path.join(dir, name), identity ?? await createIdentity());
  await app.open();
  t.after(() => app.close().catch(() => {}));
  return app;
}
const peerOf = (relay) => ({ name: relay.name, fingerprint: relay.identity.fingerprint, host: relay.endpoint.host, port: relay.endpoint.port });
async function world(dir, name, content) {
  const target = path.join(dir, name);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'eula.txt'), 'eula=true\n');
  await writeFile(path.join(target, 'world.bin'), content);
  return target;
}
function vault() {
  const key = randomBytes(32);
  return {
    encrypt(v) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, c.update(v), c.final(), c.getAuthTag()]); },
    decrypt(v) { const c = createDecipheriv('aes-256-gcm', key, v.subarray(0, 12)); c.setAuthTag(v.subarray(-16)); return c.update(v.subarray(12, -16), undefined, 'utf8') + c.final('utf8'); },
  };
}

test('a hosting invitation stays bound to the approved group while the selection changes mid-lookup', async (t) => {
  // The account service holds its SQLite file open until closed; clean up in one finalizer so the root can be
  // deleted after the handle is released regardless of hook ordering.
  const root = await workspace(t, 'invite-bind-', false);
  let service;
  t.after(async () => { await service?.close().catch(() => undefined); await rm(root, { recursive: true, force: true }).catch(() => undefined); });
  service = new AccountService(path.join(root, 'dir'), await createIdentity());
  await service.listen({ host: '127.0.0.1', port: 0 });
  const one = await relayIn(t, path.join(root, 'one'), 'Group One');
  const two = await relayIn(t, path.join(root, 'two'), 'Group Two');
  const alice = await appIn(t, root, 'alice');
  const bob = await appIn(t, root, 'bob');
  await one.trust('Alice', alice.identity.fingerprint);
  await two.trust('Alice', alice.identity.fingerprint);
  await one.setOwner(alice.identity.fingerprint);
  await two.setOwner(alice.identity.fingerprint);
  await alice.addPeer(peerOf(one));
  await alice.addPeer(peerOf(two));
  await alice.importExisting(await world(root, 'world-a', 'alpha'), true);
  const aId = (await alice.getState()).server.id;
  await alice.saveRelay({ fingerprint: one.identity.fingerprint, parkOnStop: false });
  await alice.importExisting(await world(root, 'world-b', 'bravo'), true);
  const bId = (await alice.getState()).server.id;
  await alice.saveRelay({ fingerprint: two.identity.fingerprint, parkOnStop: false });
  await alice.selectServer(aId);

  const endpoint = { ...service.endpoint, fingerprint: service.identity.fingerprint };
  const v = vault();
  const aliceI = new AccountIntegration(alice.root, alice.identity, v, alice, endpoint);
  const bobI = new AccountIntegration(bob.root, bob.identity, v, bob, endpoint);
  await aliceI.authenticate('register', { username: 'alice', password: 'fixture-alice-password' });
  await bobI.authenticate('register', { username: 'bob', password: 'fixture-bob-password' });

  // Pause the real directory lookup, switch the selected world, then let the lookup finish.
  let entered;
  let release;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const original = aliceI.client.call.bind(aliceI.client);
  aliceI.client.call = async (op, payload) => { const result = await original(op, payload); if (op === 'lookup') { entered(); await gate; } return result; };
  const sending = aliceI.send('bob', { fingerprint: one.identity.fingerprint, serverId: aId });
  await enteredPromise;
  await alice.selectServer(bId);
  release();
  const sent = await sending;
  assert.equal(sent.group, one.identity.fingerprint, 'the delivery reports the approved group');
  const requests = await bobI.requests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].group, 'Group One');
  assert.equal(requests[0].controlEndpoint.port, one.endpoint.port, 'the invitation targets the approved group, not the newly selected one');
  assert.notEqual(requests[0].controlEndpoint.port, two.endpoint.port);

  // A group this PC no longer records, or a server that no longer carries it, is refused — never re-resolved.
  await assert.rejects(aliceI.send('bob', { fingerprint: 'f'.repeat(64), serverId: null }), /changed|Refresh/i);
  await assert.rejects(aliceI.send('bob', { fingerprint: one.identity.fingerprint, serverId: bId }), /changed|Refresh/i);
  assert.equal((await bobI.requests()).length, 1, 'refused sends deliver nothing');
});

test('modern enrollment stays pending through an unrelated first import while the legacy join still adopts', async (t) => {
  const root = await workspace(t, 'enroll-origin-');
  const relay = await relayIn(t, path.join(root, 'relay'), 'Shared Group');
  const angel = await appIn(t, root, 'angel');
  await relay.trust('Angel', angel.identity.fingerprint);
  await angel.addPeer(peerOf(relay));
  await angel.importExisting(await world(root, 'alpha-source', 'alpha v1'), true);
  await angel.saveRelay({ fingerprint: relay.identity.fingerprint, parkOnStop: false });
  await angel.parkAtRelay();
  await relay.settled();

  // Modern enrollment (account/joinHostingGroup invitation): never attaches to a world that arrives later.
  const bob = await appIn(t, root, 'bob');
  const joined = await bob.joinHostingGroup({ code: (await relay.createInvite()).code, name: 'Bob' });
  assert.equal(joined.pending, true);
  await bob.importExisting(await world(root, 'bravo-source', 'bravo world'), true);
  let state = await bob.getState();
  assert.equal(state.server.group, null, 'an unrelated first import is never pulled into a joined group');
  assert.equal(state.pendingGroups.length, 1);
  assert.equal(await readFile(path.join(state.server.serverDir, 'world.bin'), 'utf8'), 'bravo world');
  const durable = JSON.parse(await readFile(path.join(bob.root, 'state.json'), 'utf8'));
  assert.equal(durable.pendingGroups[0].adoptable, false, 'modern enrollment is durably marked as non-adopting');

  // Membership survives a restart as a pending group, still without annexing the unrelated world.
  await bob.close();
  const resumed = new SeedHostApplication(bob.root, bob.identity);
  t.after(() => resumed.close().catch(() => {}));
  await resumed.open();
  state = await resumed.getState();
  assert.equal(state.pendingGroups.length, 1);
  assert.equal(state.server.group, null);
  const bravoDir = state.server.serverDir;

  // The explicit download appends the shared world as a NEW server; the unrelated world is untouched.
  await resumed.claimPendingGroup(relay.identity.fingerprint);
  await relay.settled();
  state = await resumed.getState();
  assert.equal(state.servers.length, 2);
  assert.equal(state.pendingGroups.length, 0);
  const claimed = state.server;
  assert.equal(claimed.group.fingerprint, relay.identity.fingerprint);
  assert.equal(await readFile(path.join(claimed.serverDir, 'world.bin'), 'utf8'), 'alpha v1');
  const kept = state.servers.find((entry) => entry.id !== claimed.id);
  assert.equal(kept.group, null);
  assert.equal(await readFile(path.join(bravoDir, 'world.bin'), 'utf8'), 'bravo world');

  // The legacy invite-code join keeps its documented continuity: the first world added adopts it.
  const carol = await appIn(t, root, 'carol');
  await carol.joinWithInvite({ code: (await relay.createInvite()).code, name: 'Carol' });
  await carol.importExisting(await world(root, 'carol-source', 'carol world'), true);
  const carolState = await carol.getState();
  assert.equal(carolState.server.group.fingerprint, relay.identity.fingerprint, 'the legacy path still attaches to the first world added');
  assert.equal(carolState.pendingGroups.length, 0);
});

async function parkedGroup(t, root, prefix) {
  const relay = await relayIn(t, path.join(root, prefix + '-relay'), 'Shared Group');
  const angel = await appIn(t, root, prefix + '-angel');
  await relay.trust('Angel', angel.identity.fingerprint);
  await angel.addPeer(peerOf(relay));
  await angel.importExisting(await world(root, prefix + '-source', 'alpha v1'), true);
  await angel.saveRelay({ fingerprint: relay.identity.fingerprint, parkOnStop: false });
  await angel.parkAtRelay();
  await relay.settled();
  const bob = await appIn(t, root, prefix + '-bob');
  await bob.joinHostingGroup({ code: (await relay.createInvite()).code, name: 'Bob' });
  return { relay, bob };
}
function injectAcceptTransferFailure(deviceId, holder) {
  const original = OwnershipLedger.prototype.acceptTransfer;
  OwnershipLedger.prototype.acceptTransfer = async function (...args) {
    if (this.deviceId === deviceId && !holder.injected) { holder.injected = true; throw new Error('test fault before the ownership transaction'); }
    return original.apply(this, args);
  };
  return () => { OwnershipLedger.prototype.acceptTransfer = original; };
}

test('a pre-commit claim failure is retried to one durable ownership application', async (t) => {
  const root = await workspace(t, 'claim-retry-');
  const { relay, bob } = await parkedGroup(t, root, 'retry');
  const holder = { injected: false };
  const restore = injectAcceptTransferFailure(bob.identity.fingerprint, holder);
  let claimError;
  try { claimError = await bob.claimPendingGroup(relay.identity.fingerprint).then(() => null, (error) => error); }
  finally { restore(); }
  assert.equal(holder.injected, true);
  assert.match(String(claimError?.message), /Claim did not complete/);
  await relay.settled();

  // State stays readable while the interrupted entry waits for reconciliation (nothing crashes).
  let state = await bob.getState();
  assert.equal(state.servers.length, 1, 'the interrupted entry is retained');
  assert.equal(state.pendingGroups.length, 0);
  const durable = JSON.parse(await readFile(path.join(bob.root, 'state.json'), 'utf8'));
  assert.ok(durable.activation, 'the append is journalled durably');
  assert.equal(durable.activation.serverId, state.server.id);

  // The ordinary retry completes the same offer exactly once.
  await bob.claimFromRelay();
  await relay.settled();
  state = await bob.getState();
  const claimed = state.server;
  assert.equal(claimed.ownership.state, 'owned');
  assert.equal(claimed.ownership.generation, 2, 'the offer is applied once, not twice');
  assert.equal(await readFile(path.join(claimed.serverDir, 'world.bin'), 'utf8'), 'alpha v1');
  const custody = await relay.custody();
  assert.equal(custody.state, 'transferred');
  assert.equal(custody.owner, bob.identity.fingerprint);
  await assert.rejects(bob.claimFromRelay(), /already holds|nothing to claim/i, 'a second claim never re-applies the offer');
});

test('an interrupted claim that survived a restart rolls back to the pending group and downloads again', async (t) => {
  const root = await workspace(t, 'claim-rollback-');
  const { relay, bob } = await parkedGroup(t, root, 'rollback');
  const holder = { injected: false };
  const restore = injectAcceptTransferFailure(bob.identity.fingerprint, holder);
  try { await bob.claimPendingGroup(relay.identity.fingerprint).catch(() => undefined); }
  finally { restore(); }
  assert.equal(holder.injected, true);
  await relay.settled();
  await bob.close();

  const resumed = new SeedHostApplication(bob.root, bob.identity);
  t.after(() => resumed.close().catch(() => {}));
  await resumed.open();
  let state = await resumed.getState();
  assert.equal(state.servers.length, 0, 'the pre-authority append is rolled back, not kept broken');
  assert.equal(state.server, null);
  assert.equal(state.pendingGroups.length, 1, 'the group returns and can be downloaded again');
  assert.ok(state.logs.some((line) => /rolled back/i.test(line)), 'the rollback is reported');
  const durable = JSON.parse(await readFile(path.join(bob.root, 'state.json'), 'utf8'));
  assert.equal(durable.activation, null, 'the spent journal is cleared');

  await resumed.claimPendingGroup(relay.identity.fingerprint);
  await relay.settled();
  state = await resumed.getState();
  assert.equal(state.pendingGroups.length, 0);
  const claimed = state.server;
  assert.equal(claimed.ownership.state, 'owned');
  assert.equal(claimed.ownership.generation, 2);
  assert.equal(await readFile(path.join(claimed.serverDir, 'world.bin'), 'utf8'), 'alpha v1');
  assert.equal((await relay.custody()).state, 'transferred');
});

test('a pre-journal interrupted claim from an older build stays readable and is completed by the ordinary retry', async (t) => {
  const root = await workspace(t, 'claim-prejournal-');
  const { relay, bob } = await parkedGroup(t, root, 'prejournal');
  const holder = { injected: false };
  const restore = injectAcceptTransferFailure(bob.identity.fingerprint, holder);
  try { await bob.claimPendingGroup(relay.identity.fingerprint).catch(() => undefined); }
  finally { restore(); }
  assert.equal(holder.injected, true);
  await relay.settled();

  // Imitate a state written before the activation journal existed: entry retained, pending consumed, no ledger.
  const file = path.join(bob.root, 'state.json');
  const value = JSON.parse(await readFile(file, 'utf8'));
  delete value.activation;
  await writeFile(file, JSON.stringify(value));
  await bob.close();

  const resumed = new SeedHostApplication(bob.root, bob.identity);
  t.after(() => resumed.close().catch(() => {}));
  await resumed.open();
  let state = await resumed.getState();
  assert.equal(state.servers.length, 1, 'without a journal the entry is retained, never silently deleted');
  assert.equal(state.pendingGroups.length, 0);
  await resumed.claimFromRelay();
  await relay.settled();
  state = await resumed.getState();
  assert.equal(state.server.ownership.state, 'owned');
  assert.equal(state.server.ownership.generation, 2);
  assert.equal(await readFile(path.join(state.server.serverDir, 'world.bin'), 'utf8'), 'alpha v1');
  assert.equal((await relay.custody()).state, 'transferred');
});

const waitFor = (promise, label) => Promise.race([promise, delay(5000).then(() => { throw new Error(label); })]);

test('revoking a member who holds the world cuts their access instead of being blocked by custody', async (t) => {
  const root = await workspace(t, 'revoke-holder-');
  const { relay, bob } = await parkedGroup(t, root, 'revoke');
  const bobFp = bob.identity.fingerprint;

  // The member claims the parked world and holds it.
  await bob.claimPendingGroup(relay.identity.fingerprint);
  await relay.settled();
  assert.equal((await relay.custody()).owner, bobFp);

  // Revocation is the blunt instrument: cutting a holder off must succeed (the gateway suites pin tunnel
  // disconnection), and the custody ledger is retained for an explicit re-trust or handback — never rewritten.
  await relay.untrust(bobFp);
  assert.equal(relay.trusted.some((member) => member.fingerprint === bobFp), false, 'the member is removed even while holding');
  assert.equal((await relay.custody()).owner, bobFp, 'the custody ledger is left untouched');

  // The removed device loses access immediately.
  await assert.rejects(bob.claimFromRelay(), /untrusted|refused/i);
});

test('a second-instance (CLI-style) removal serializes with an in-flight claim instead of removing the claimant mid-handoff', async (t) => {
  const root = await workspace(t, 'revoke-race-');
  const { relay, bob } = await parkedGroup(t, root, 'race');
  const bobFp = bob.identity.fingerprint;
  const cli = new RelayNode(relay.root, relay.identity, { log() {}, name: 'CLI' });
  await cli.open();
  t.after(() => cli.close().catch(() => undefined));

  // Pause the relay's claim preparation after admission. A separate RelayNode instance (its own queue, like the
  // real CLI process) then attempts the removal while the handoff decision is in flight.
  let entered; const reached = new Promise((resolve) => { entered = resolve; });
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let commitEntered; const confirmReached = new Promise((resolve) => { commitEntered = resolve; });
  let releaseConfirm; const confirmGate = new Promise((resolve) => { releaseConfirm = resolve; });
  const originalPrepare = OwnershipLedger.prototype.prepareTransfer;
  OwnershipLedger.prototype.prepareTransfer = async function (...args) {
    if (this.deviceId === relay.identity.fingerprint) { entered(); await gate; }
    return originalPrepare.apply(this, args);
  };
  const originalConfirm = OwnershipLedger.prototype.confirmTransfer;
  OwnershipLedger.prototype.confirmTransfer = async function (...args) {
    if (this.deviceId === relay.identity.fingerprint) { commitEntered(); await confirmGate; }
    return originalConfirm.apply(this, args);
  };
  t.after(() => { OwnershipLedger.prototype.prepareTransfer = originalPrepare; OwnershipLedger.prototype.confirmTransfer = originalConfirm; });
  const claiming = bob.claimPendingGroup(relay.identity.fingerprint);
  await waitFor(reached, 'the claim never reached preparation');
  const removal = cli.untrust(bobFp).then(() => ({ removed: true, message: '' }), (error) => ({ removed: false, message: String(error.message) }));
  try {
    assert.equal(await Promise.race([removal.then((outcome) => outcome.removed), delay(400).then(() => 'waiting')]), 'waiting',
      'the racing removal must not complete while the handoff decision is in flight');
  } finally { release(); }
  const outcome = await removal;
  assert.equal(outcome.removed, false, 'the removal refuses instead of deleting a member who is mid-handoff');
  assert.match(outcome.message, /handoff pending|locked/i);
  // Only now let the claim's commit run: the removal above was evaluated while the handoff was still pending.
  await waitFor(confirmReached, 'the claim never reached its commit');
  releaseConfirm();
  await claiming;
  await relay.settled();
  assert.equal((await relay.custody()).owner, bobFp, 'the claim itself completed cleanly');
  assert.equal(relay.trusted.some((member) => member.fingerprint === bobFp), true, 'the claimant was never removed mid-handoff');

  // Once the world is handed back, the same second-instance removal succeeds.
  await bob.parkAtRelay();
  await relay.settled();
  await cli.untrust(bobFp);
  await relay.reload();
  assert.equal(relay.trusted.some((member) => member.fingerprint === bobFp), false);
});

test('only the group owner establishes the first world lineage; a member park cannot claim it', async (t) => {
  const root = await workspace(t, 'first-lineage-');
  const relay = await relayIn(t, path.join(root, 'group'), 'Shared Group');
  const angel = await appIn(t, root, 'angel');
  const bob = await appIn(t, root, 'bob');
  await relay.trust('Angel', angel.identity.fingerprint);
  await relay.trust('Bob', bob.identity.fingerprint);
  await relay.setOwner(angel.identity.fingerprint);
  await angel.addPeer(peerOf(relay));
  await bob.addPeer(peerOf(relay));

  // A member's world arriving before any lineage exists must never become the group's world.
  await bob.importExisting(await world(root, 'bob-source', 'bob world'), true);
  await bob.saveRelay({ fingerprint: relay.identity.fingerprint, parkOnStop: false });
  await assert.rejects(bob.parkAtRelay(), /relay declined/i);
  assert.equal(await relay.custody(), null, 'nothing was accepted');
  assert.equal((await bob.getState()).server.ownership.state, 'owned', 'the member keeps their world, unfenced');

  // The owner establishes the lineage with the ordinary park flow.
  await angel.importExisting(await world(root, 'angel-source', 'angel world'), true);
  await angel.saveRelay({ fingerprint: relay.identity.fingerprint, parkOnStop: false });
  await angel.parkAtRelay();
  await relay.settled();
  const custody = await relay.custody();
  assert.equal(custody.state, 'owned');
  assert.equal(custody.owner, relay.identity.fingerprint);
  assert.equal(custody.generation, 1);
});
