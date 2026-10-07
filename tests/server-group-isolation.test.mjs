import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { SeedHostApplication } from '../dist/src/core/application.js';
import { RelayNode } from '../dist/src/core/relay.js';
import { decodeInvite, encodeInvite } from '../dist/src/core/invites.js';
import { relayStatus } from '../dist/src/core/relay-client.js';

const scratch = process.env.TMPDIR || process.env.TEMP || process.env.TMP || path.resolve('.test-data');

async function workspace(t, prefix) {
  const base = path.isAbsolute(scratch) ? scratch : path.resolve(scratch);
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
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
const worldOf = async (app) => (await app.getState()).server;

test('two loopback hosting groups stay attached to their own worlds across selection changes', async (t) => {
  const root = await workspace(t, 'group-switch-');
  const one = await relayIn(t, path.join(root, 'one'), 'Relay One');
  const two = await relayIn(t, path.join(root, 'two'), 'Relay Two');
  assert.notEqual(one.identity.fingerprint, two.identity.fingerprint);
  const app = await appIn(t, root, 'pc');
  await one.trust('PC', app.identity.fingerprint);
  await two.trust('PC', app.identity.fingerprint);
  await app.addPeer(peerOf(one));
  await app.addPeer(peerOf(two));

  await app.importExisting(await world(root, 'world-a', 'alpha world'), true);
  const a = (await app.getState()).server;
  await app.saveRelay({ fingerprint: one.identity.fingerprint, parkOnStop: false });
  await app.importExisting(await world(root, 'world-b', 'bravo world'), true);
  const b = (await app.getState()).server;
  assert.notEqual(a.id, b.id);

  // A world that was already there when the group was chosen keeps its own binding; the newer world stays out.
  let groups = Object.fromEntries((await app.getState()).servers.map((entry) => [entry.id, entry.group]));
  assert.equal(groups[a.id].fingerprint, one.identity.fingerprint);
  assert.equal(groups[b.id], null, 'a second world is never silently pulled into an existing group');
  assert.equal((await app.getState()).relay, null, 'the selected world is not in a hosting group');

  await app.saveRelay({ fingerprint: two.identity.fingerprint, parkOnStop: false });
  await app.selectServer(a.id);
  let state = await app.getState();
  assert.deepEqual(state.relay, { fingerprint: one.identity.fingerprint, parkOnStop: false, name: 'Relay One' });
  const pinA = decodeInvite((await app.createInvite()).code);
  assert.equal(pinA.relayFingerprint, one.identity.fingerprint);
  assert.deepEqual({ host: pinA.host, port: pinA.port }, { host: one.endpoint.host, port: one.endpoint.port });
  assert.equal(await app.checkRelay(), null);

  await app.selectServer(b.id);
  state = await app.getState();
  assert.deepEqual(state.relay, { fingerprint: two.identity.fingerprint, parkOnStop: false, name: 'Relay Two' });
  const pinB = decodeInvite((await app.createInvite()).code);
  assert.equal(pinB.relayFingerprint, two.identity.fingerprint);

  // Parking A lands only on A's relay; B's relay has never seen anything.
  await app.selectServer(a.id);
  await app.parkAtRelay();
  await one.settled();
  const parkedA = (await app.getState()).server;
  assert.deepEqual(await one.custody(), { owner: one.identity.fingerprint, state: 'owned', generation: 1, snapshotId: parkedA.snapshotId, pendingTarget: null });
  assert.equal(await two.custody(), null);
  await app.selectServer(b.id);
  assert.equal(await app.checkRelay(), null, 'B checks B\u2019s relay, not A\u2019s');
  await app.selectServer(a.id);
  assert.equal((await app.checkRelay()).snapshotId, parkedA.snapshotId);

  // A/B/A selection never rewrites either binding.
  await app.selectServer(b.id); await app.selectServer(a.id);
  assert.equal((await app.getState()).relay.fingerprint, one.identity.fingerprint);
  groups = Object.fromEntries((await app.getState()).servers.map((entry) => [entry.id, entry.group]));
  assert.equal(groups[a.id].fingerprint, one.identity.fingerprint);
  assert.equal(groups[b.id].fingerprint, two.identity.fingerprint);
  assert.deepEqual(await app.getServerGroup(a.id), { serverId: a.id, bound: true,
    relay: { fingerprint: one.identity.fingerprint, parkOnStop: false, name: 'Relay One', endpoint: { host: one.endpoint.host, port: one.endpoint.port } } });
  assert.deepEqual(await app.getServerGroup(b.id), { serverId: b.id, bound: true,
    relay: { fingerprint: two.identity.fingerprint, parkOnStop: false, name: 'Relay Two', endpoint: { host: two.endpoint.host, port: two.endpoint.port } } });
});

test('park and claim stay inside each world\u2019s own group', async (t) => {
  const root = await workspace(t, 'group-park-');
  const one = await relayIn(t, path.join(root, 'one'), 'Relay One');
  const two = await relayIn(t, path.join(root, 'two'), 'Relay Two');
  const app = await appIn(t, root, 'pc');
  await one.trust('PC', app.identity.fingerprint);
  await two.trust('PC', app.identity.fingerprint);
  await app.addPeer(peerOf(one));
  await app.addPeer(peerOf(two));
  await app.importExisting(await world(root, 'world-a', 'alpha v1'), true);
  const a = (await app.getState()).server;
  await app.saveRelay({ fingerprint: one.identity.fingerprint, parkOnStop: false });
  await app.importExisting(await world(root, 'world-b', 'bravo v1'), true);
  const b = (await app.getState()).server;
  await app.saveRelay({ fingerprint: two.identity.fingerprint, parkOnStop: false });

  await app.selectServer(a.id);
  await app.parkAtRelay();
  await one.settled();
  const parkedA = await worldOf(app);
  assert.equal((await one.custody()).snapshotId, parkedA.snapshotId);
  assert.equal(await two.custody(), null);

  await app.selectServer(b.id);
  await app.parkAtRelay();
  await two.settled();
  const parkedB = await worldOf(app);
  assert.equal((await two.custody()).snapshotId, parkedB.snapshotId);
  assert.equal((await one.custody()).snapshotId, parkedA.snapshotId, 'B\u2019s park never disturbs A\u2019s custody');

  await app.claimFromRelay();
  await two.settled();
  let claimed = await worldOf(app);
  assert.equal(claimed.id, b.id);
  assert.equal(claimed.ownership.state, 'owned');
  assert.equal(claimed.ownership.generation, 2);
  assert.equal(await readFile(path.join(claimed.serverDir, 'world.bin'), 'utf8'), 'bravo v1');
  assert.equal((await one.custody()).snapshotId, parkedA.snapshotId);
  const twoCustody = await two.custody();

  await app.selectServer(a.id);
  await app.claimFromRelay();
  await one.settled();
  claimed = await worldOf(app);
  assert.equal(claimed.id, a.id);
  assert.equal(claimed.ownership.generation, 2);
  assert.equal(await readFile(path.join(claimed.serverDir, 'world.bin'), 'utf8'), 'alpha v1');
  assert.deepEqual(await two.custody(), twoCustody, 'claiming A never touches B\u2019s relay');
});

test('an invitation to one world\u2019s group grants no authority over another local world', async (t) => {
  const root = await workspace(t, 'group-crossworld-');
  const group = await relayIn(t, path.join(root, 'group'), 'Alpha Group');
  const other = await relayIn(t, path.join(root, 'other'), 'Other Group');
  const angel = await appIn(t, root, 'angel');
  await group.trust('Angel', angel.identity.fingerprint);
  await angel.addPeer(peerOf(group));
  await angel.importExisting(await world(root, 'alpha-source', 'alpha world'), true);
  await angel.saveRelay({ fingerprint: group.identity.fingerprint, parkOnStop: false });
  await angel.parkAtRelay();
  await group.settled();

  const bob = await appIn(t, root, 'bob');
  await bob.importExisting(await world(root, 'bravo-source', 'bravo world'), true);
  const bravo = (await bob.getState()).server;
  const before = JSON.stringify(await bob.getState());
  const { code } = await angel.createInvite();

  const joined = await bob.joinHostingGroup({ code, name: 'Bob' });
  assert.deepEqual(joined, { relayName: 'Alpha Group', fingerprint: group.identity.fingerprint, serverId: null, pending: true });
  const afterJoin = await bob.getState();
  assert.equal(afterJoin.server.group, null, 'the unrelated local world is not bound');
  assert.equal(afterJoin.relay, null, 'the selected world reads as not in a group');
  assert.equal(afterJoin.servers.length, 1, 'joining never creates a world');
  assert.equal(afterJoin.pendingGroups.length, 1);
  assert.equal(afterJoin.pendingGroups[0].fingerprint, group.identity.fingerprint);
  assert.deepEqual(afterJoin.pendingGroups[0].endpoint, { host: group.endpoint.host, port: group.endpoint.port });
  const beforeState = JSON.parse(before);
  assert.deepEqual({ ...beforeState, peers: afterJoin.peers, pendingGroups: afterJoin.pendingGroups, logs: afterJoin.logs }, afterJoin,
    'only peers and the pending entry change');
  assert.equal(await readFile(path.join(bravo.serverDir, 'world.bin'), 'utf8'), 'bravo world');

  // The group's world can only ever be received; the local world can never be pushed into it.
  await assert.rejects(bob.parkAtRelay(), /not part of a hosting group/i);
  await assert.rejects(bob.createInvite(), /not part of a hosting group|no relay/i);
  assert.deepEqual(await group.custody(), { owner: group.identity.fingerprint, state: 'owned', generation: 1, snapshotId: (await angel.getState()).server.snapshotId, pendingTarget: null });
  assert.equal(await other.custody(), null);

  await bob.claimPendingGroup(group.identity.fingerprint);
  await group.settled();
  const bobState = await bob.getState();
  const received = bobState.server;
  const kept = bobState.servers.find((entry) => entry.id === bravo.id);
  assert.notEqual(received.id, bravo.id, 'claiming the group\u2019s world creates a new library server');
  assert.equal(received.group.fingerprint, group.identity.fingerprint);
  assert.equal(received.group.fingerprint, (await angel.getState()).server.group.fingerprint, 'the group pin is stable across different local server ids');
  assert.notEqual(received.id, (await angel.getState()).server.id, 'the claimed copy keeps its own local id');
  assert.equal(await readFile(path.join(received.serverDir, 'world.bin'), 'utf8'), 'alpha world');
  assert.equal(bobState.servers.length, 2, 'the existing world is still in the library');
  assert.equal(kept.group, null);
  assert.equal(await readFile(path.join(bravo.serverDir, 'world.bin'), 'utf8'), 'bravo world');
  const persisted = JSON.parse(await readFile(path.join(bob.root, 'state.json'), 'utf8'));
  assert.equal(persisted.servers.find((entry) => entry.id === bravo.id).snapshotId, bravo.snapshotId, 'the existing world is preserved byte for byte');
  assert.deepEqual((await bob.getState()).pendingGroups, []);
  assert.equal((await group.custody()).owner, bob.identity.fingerprint, 'the group\u2019s world moved to the member PC');
});

test('a recipient with no local copy joins without running anything and later claims a new library server', async (t) => {
  const root = await workspace(t, 'group-recipient-');
  const group = await relayIn(t, path.join(root, 'group'), 'Alpha Group');
  const angel = await appIn(t, root, 'angel');
  await group.trust('Angel', angel.identity.fingerprint);
  await angel.addPeer(peerOf(group));
  await angel.importExisting(await world(root, 'alpha-source', 'alpha v1'), true);
  const source = (await angel.getState()).server;
  await angel.saveRelay({ fingerprint: group.identity.fingerprint, parkOnStop: false });
  await writeFile(path.join(source.serverDir, 'world.bin'), 'alpha v2');
  await angel.parkAtRelay();
  await group.settled();
  const parked = (await angel.getState()).server;

  const bob = await appIn(t, root, 'bob');
  const { code } = await angel.createInvite();
  const joined = await bob.joinHostingGroup({ code, name: 'Bob' });
  assert.deepEqual(joined, { relayName: 'Alpha Group', fingerprint: group.identity.fingerprint, serverId: null, pending: true });
  let state = await bob.getState();
  assert.equal(state.server, null);
  assert.deepEqual(state.servers, []);
  assert.equal(state.pendingGroups.length, 1);
  assert.equal(state.busy, null);
  assert.ok(state.logs.some((line) => /nothing was downloaded or started/i.test(line)), 'enrollment reports that nothing ran');
  assert.ok(!(await readdir(bob.root)).some((name) => /^ownership-/.test(name)), 'no ownership journal is created by joining');
  assert.equal((await group.custody()).snapshotId, parked.snapshotId, 'joining transfers nothing');

  await bob.claimPendingGroup(group.identity.fingerprint);
  await group.settled();
  state = await bob.getState();
  assert.equal(state.servers.length, 1);
  assert.deepEqual(state.pendingGroups, []);
  const claimed = state.server;
  assert.equal(claimed.ownership.state, 'owned');
  assert.equal(claimed.ownership.generation, 2);
  assert.equal(claimed.profile.executable, '', 'a claimed world never inherits another PC\u2019s executable');
  assert.equal(claimed.state, 'offline', 'join and claim launch nothing');
  assert.equal(claimed.group.fingerprint, group.identity.fingerprint);
  assert.equal(await readFile(path.join(claimed.serverDir, 'world.bin'), 'utf8'), 'alpha v2');
  assert.equal((await group.custody()).state, 'transferred');
  assert.equal((await group.custody()).owner, bob.identity.fingerprint);
  await assert.rejects(bob.claimPendingGroup(group.identity.fingerprint), /already/i);
});

test('legacy state migrates the old global relay to the old active world only', async (t) => {
  const root = await workspace(t, 'group-migrate-');
  const group = await relayIn(t, path.join(root, 'group'), 'Relay One');
  const app = await appIn(t, root, 'pc');
  await group.trust('PC', app.identity.fingerprint);
  await app.addPeer(peerOf(group));
  await app.importExisting(await world(root, 'world-a', 'alpha'), true);
  const a = (await app.getState()).server;
  await app.importExisting(await world(root, 'world-b', 'bravo'), true);
  const b = (await app.getState()).server;
  await app.saveRelay({ fingerprint: group.identity.fingerprint, parkOnStop: true });
  await app.close();

  const file = path.join(app.root, 'state.json');
  const current = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(current.version, 2);
  assert.ok(!('relay' in current), 'groups are stored per server, never as one app-wide relay');
  assert.ok(current.servers.every((entry) => 'group' in entry));
  const { pendingGroups: _pending, ...rest } = current;
  const legacy = { ...rest, servers: current.servers.map(({ group, ...entry }) => entry),
    relay: { fingerprint: group.identity.fingerprint, parkOnStop: true } };
  await writeFile(file, JSON.stringify(legacy));

  const again = await appIn(t, root, 'pc', app.identity);
  const state = await again.getState();
  assert.deepEqual(state.relay, { fingerprint: group.identity.fingerprint, parkOnStop: true, name: 'Relay One' });
  const migrated = Object.fromEntries(state.servers.map((entry) => [entry.id, entry.group]));
  assert.equal(migrated[b.id].fingerprint, group.identity.fingerprint, 'the old global relay belongs to the old active world');
  assert.equal(migrated[a.id], null, 'other library worlds are not annexed by the migration');
  assert.deepEqual(state.pendingGroups, []);

  await again.selectServer(a.id);
  assert.equal((await again.getState()).relay, null);
  await assert.rejects(again.parkAtRelay(), /no relay/i);
  await again.selectServer(b.id);
  assert.equal((await again.getState()).relay.fingerprint, group.identity.fingerprint);
  await assert.rejects(again.claimFromRelay(), /holds no server/i, 'the migrated binding reaches the old relay');
});

test('an old global relay with no world becomes one pending group instead of disappearing', async (t) => {
  const root = await workspace(t, 'group-migrate-empty-');
  const group = await relayIn(t, path.join(root, 'group'), 'Relay One');
  const seed = await appIn(t, root, 'pc');
  const settings = (await seed.getState()).settings;
  await group.trust('PC', seed.identity.fingerprint);
  await seed.close();
  await writeFile(path.join(seed.root, 'state.json'), JSON.stringify({ version: 2, settings, activeServerId: null, servers: [],
    peers: [{ name: 'Relay One', fingerprint: group.identity.fingerprint, host: group.endpoint.host, port: group.endpoint.port }],
    relay: { fingerprint: group.identity.fingerprint, parkOnStop: true } }));

  const again = await appIn(t, root, 'pc', seed.identity);
  const state = await again.getState();
  assert.deepEqual(state.pendingGroups, [{ fingerprint: group.identity.fingerprint, parkOnStop: true, name: 'Relay One',
    endpoint: { host: group.endpoint.host, port: group.endpoint.port }, since: state.pendingGroups[0].since }]);
  assert.ok(Number.isSafeInteger(state.pendingGroups[0].since) && state.pendingGroups[0].since > 0);
  assert.deepEqual(state.relay, { fingerprint: group.identity.fingerprint, parkOnStop: true, name: 'Relay One' });
  assert.equal(state.server, null);
  await assert.rejects(again.claimFromRelay(), /holds no server/i, 'the pending group still reaches its relay');
});

test('a corrupt or foreign per-server group is rejected and the file is left unchanged', async (t) => {
  const root = await workspace(t, 'group-corrupt-');
  const group = await relayIn(t, path.join(root, 'group'), 'Relay One');
  const app = await appIn(t, root, 'pc');
  await group.trust('PC', app.identity.fingerprint);
  await app.addPeer(peerOf(group));
  await app.importExisting(await world(root, 'world-a', 'alpha'), true);
  await app.saveRelay({ fingerprint: group.identity.fingerprint, parkOnStop: false });
  await app.close();

  const file = path.join(app.root, 'state.json');
  for (const damaged of [
    (value) => { value.servers[0].group.fingerprint = 'f'.repeat(64); return value; },
    (value) => { value.servers[0].group = { fingerprint: 'x' }; return value; },
    (value) => { value.pendingGroups = [{ fingerprint: 'f'.repeat(64), parkOnStop: true, relayName: 'Ghost', since: Date.now() }]; return value; },
  ]) {
    const text = JSON.stringify(damaged(JSON.parse(await readFile(file, 'utf8'))));
    await writeFile(file, text);
    const reopened = new SeedHostApplication(app.root, app.identity);
    await assert.rejects(reopened.open(), /Invalid saved application state/);
    await reopened.close().catch(() => {});
    assert.equal(await readFile(file, 'utf8'), text, 'the damaged file is never rewritten');
  }
});

test('a stale target cannot rebind another world, and locking and pending fences survive', async (t) => {
  const root = await workspace(t, 'group-stale-');
  const one = await relayIn(t, path.join(root, 'one'), 'Relay One');
  const two = await relayIn(t, path.join(root, 'two'), 'Relay Two');
  const app = await appIn(t, root, 'pc');
  await one.trust('PC', app.identity.fingerprint);
  await two.trust('PC', app.identity.fingerprint);
  await app.addPeer(peerOf(one));
  await app.addPeer(peerOf(two));
  await app.importExisting(await world(root, 'world-a', 'alpha'), true);
  const a = (await app.getState()).server;
  await app.saveRelay({ fingerprint: one.identity.fingerprint, parkOnStop: false });
  await app.importExisting(await world(root, 'world-b', 'bravo'), true);
  const b = (await app.getState()).server;
  await app.saveRelay({ fingerprint: two.identity.fingerprint, parkOnStop: false });

  // A stale server id captured before a switch fails closed instead of rebinding the wrong world.
  await app.selectServer(b.id);
  const stale = decodeInvite((await one.createInvite()).code); // an invitation for A's group
  await assert.rejects(app.joinHostingGroup({ serverId: a.id, code: encodeInvite(stale), name: 'Stale' }), /selected server changed|Refresh/i);
  const groups = Object.fromEntries((await app.getState()).servers.map((entry) => [entry.id, entry.group]));
  assert.equal(groups[a.id].fingerprint, one.identity.fingerprint);
  assert.equal(groups[b.id].fingerprint, two.identity.fingerprint);
  assert.equal((await app.getState()).peers.length, 2, 'a refused join enrolls and stores nothing');
  assert.deepEqual(await app.getServerGroup(b.id), { serverId: b.id, bound: true,
    relay: { fingerprint: two.identity.fingerprint, parkOnStop: false, name: 'Relay Two', endpoint: { host: two.endpoint.host, port: two.endpoint.port } } });

  // One operation at a time: a second claim is refused while the first is in flight.
  const first = app.claimFromRelay().catch((error) => error);
  const second = await app.claimFromRelay().catch((error) => error);
  assert.match(second.message, /already in progress/i);
  assert.match((await first).message, /holds no server/i);

  // A pending handoff fences its own server against switching; the other world is unaffected.
  await app.selectServer(a.id);
  await app.addPeer({ name: 'Ghost', fingerprint: 'b'.repeat(64), host: '127.0.0.1', port: 1 });
  await assert.rejects(app.handoff('b'.repeat(64)), /did not complete|stays fenced/i);
  await assert.rejects(app.selectServer(b.id), /pending/i);
  assert.equal((await app.getServerGroup(a.id)).relay.fingerprint, one.identity.fingerprint);
  assert.equal((await app.getServerGroup(b.id)).relay.fingerprint, two.identity.fingerprint);
});

test('membership comes only from redeeming a group\u2019s pinned invitation, never from another group or a peer entry', async (t) => {
  const root = await workspace(t, 'group-membership-');
  const one = await relayIn(t, path.join(root, 'one'), 'Relay One');
  const two = await relayIn(t, path.join(root, 'two'), 'Relay Two');
  const bob = await appIn(t, root, 'bob');
  await bob.addPeer(peerOf(two));
  await assert.rejects(relayStatus(bob.identity, { fingerprint: two.identity.fingerprint, ...two.endpoint }), /disconnect|closed|reset|refused|EPIPE|ECONNRESET/i,
    'a locally trusted peer entry is not membership');

  // An invitation whose pin was swapped for another relay is refused and enrolls nowhere.
  const invitation = await one.createInvite();
  const forged = encodeInvite({ ...decodeInvite(invitation.code), relayFingerprint: two.identity.fingerprint });
  await assert.rejects(bob.joinHostingGroup({ code: forged, name: 'Bob' }), /fingerprint|certificate|identity|pin|refus/i);
  assert.deepEqual((await bob.getState()).pendingGroups, []);
  await one.reload(); await two.reload();
  assert.equal(one.trusted.length, 0);
  assert.equal(two.trusted.length, 0);

  await bob.joinHostingGroup({ code: invitation.code, name: 'Bob' });
  await one.reload(); await two.reload();
  assert.deepEqual(one.trusted.map((member) => [member.name, member.fingerprint]), [['Bob', bob.identity.fingerprint]]);
  assert.deepEqual(two.trusted, [], 'redeeming one group\u2019s invite never enrolls at another');
  assert.deepEqual((await bob.getState()).pendingGroups.map((entry) => entry.fingerprint), [one.identity.fingerprint]);
});

test('the legacy join protocol still refuses a different group and still attaches to the first world added', async (t) => {
  const root = await workspace(t, 'group-legacy-');
  const one = await relayIn(t, path.join(root, 'one'), 'Relay One');
  const two = await relayIn(t, path.join(root, 'two'), 'Relay Two');
  const app = await appIn(t, root, 'pc');
  await app.joinWithInvite({ code: (await one.createInvite()).code, name: 'Angel' });
  assert.deepEqual((await app.getState()).pendingGroups.map((entry) => entry.fingerprint), [one.identity.fingerprint]);
  await assert.rejects(app.joinWithInvite({ code: (await two.createInvite()).code, name: 'Angel' }), /already uses.*relay/i);

  await app.importExisting(await world(root, 'solo-source', 'solo world'), true);
  const state = await app.getState();
  assert.equal(state.servers[0].group.fingerprint, one.identity.fingerprint, 'the first world added continues the legacy binding');
  assert.deepEqual(state.pendingGroups, []);
  assert.equal(state.relay.fingerprint, one.identity.fingerprint);
  await app.parkAtRelay();
  await one.settled();
  assert.equal((await one.custody()).state, 'owned');
  assert.equal(await two.custody(), null);
});

test('per-server groups and pending groups persist across restart without one app-wide relay', async (t) => {
  const root = await workspace(t, 'group-persist-');
  const one = await relayIn(t, path.join(root, 'one'), 'Relay One');
  const two = await relayIn(t, path.join(root, 'two'), 'Relay Two');
  const app = await appIn(t, root, 'pc');
  await one.trust('PC', app.identity.fingerprint);
  await two.trust('PC', app.identity.fingerprint);
  await app.addPeer(peerOf(one));
  await app.addPeer(peerOf(two));
  await app.importExisting(await world(root, 'world-a', 'alpha'), true);
  const a = (await app.getState()).server;
  await app.saveRelay({ fingerprint: one.identity.fingerprint, parkOnStop: false });
  const joined = await app.joinHostingGroup({ code: (await two.createInvite()).code, name: 'Second group' });
  assert.deepEqual(joined, { relayName: 'Relay Two', fingerprint: two.identity.fingerprint, serverId: null, pending: true });
  await app.close();

  const again = await appIn(t, root, 'pc', app.identity);
  const state = await again.getState();
  assert.equal(state.servers[0].group.fingerprint, one.identity.fingerprint);
  assert.deepEqual(state.pendingGroups.map((entry) => entry.fingerprint), [two.identity.fingerprint], 'a second, separate group stays pending');
  assert.deepEqual(state.relay, { fingerprint: one.identity.fingerprint, parkOnStop: false, name: 'Relay One' }, 'the selected world reads its own group');
  assert.equal((await again.getServerGroup(a.id)).relay.fingerprint, one.identity.fingerprint);

  const file = JSON.parse(await readFile(path.join(again.root, 'state.json'), 'utf8'));
  assert.equal(file.version, 2);
  assert.ok(!('relay' in file), 'no app-wide relay is persisted');
  assert.equal(file.servers[0].group.fingerprint, one.identity.fingerprint);
  assert.equal(file.pendingGroups.length, 1);
});
