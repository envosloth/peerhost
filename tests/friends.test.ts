import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createIdentity, type PeerIdentity } from '../src/core/peer-transport.js';
import { SeedHostApplication } from '../src/core/application.js';
import { RelayNode } from '../src/core/relay.js';
import { relayStatus } from '../src/core/relay-client.js';
import { decodeInvite, encodeInvite, type Invite } from '../src/core/invites.js';
import { validateCall } from '../src/core/ipc-policy.js';

const renderer = 'file:///app/index.html';
const trusted = { senderId: 1, expectedSenderId: 1, isMainFrame: true };
const quiet = { log: () => {} };

async function root(t: TestContext, prefix: string): Promise<string> {
  await mkdir('.test-data', { recursive: true });
  const dir = await mkdtemp(path.resolve('.test-data/' + prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function relayIn(t: TestContext, dir: string, options = {}) {
  const relay = new RelayNode(path.join(dir, 'relay'), await createIdentity(), { ...quiet, name: "Angel's relay", ...options });
  await relay.open();
  await relay.listen();
  t.after(() => relay.close());
  return relay;
}
async function pc(t: TestContext, dir: string, name: string, identity?: PeerIdentity) {
  const app = new SeedHostApplication(path.join(dir, name), identity ?? await createIdentity());
  t.after(() => app.close().catch(() => {}));
  await app.open();
  return app;
}
async function importServer(dir: string, app: SeedHostApplication, marker: string) {
  const source = path.join(dir, `source-${marker}`);
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'eula.txt'), 'eula=true\n');
  await writeFile(path.join(source, 'world.dat'), marker);
  await app.importExisting(source, true);
}

const sample = (): Invite => ({ relayFingerprint: 'a'.repeat(64), host: 'relay.tail1234.ts.net', port: 47625,
  token: Buffer.alloc(16, 7), expiresAt: Math.floor(Date.now() / 1000) + 3600, relayName: "Angel's relay" });

test('invite codes round-trip and reject damage, expiry and nonsense', () => {
  const invite = sample();
  const code = encodeInvite(invite);
  assert.match(code, /^SEEDHOST-[A-Za-z0-9_-]+$/);
  assert.ok(code.length < 160, 'short enough to paste into a chat message');
  assert.deepEqual(decodeInvite(code), invite);
  assert.deepEqual(decodeInvite(`  ${code}\n`), invite, 'surrounding whitespace from chat apps is ignored');
  const middle = 'SEEDHOST-'.length + 20;
  const damaged = code.slice(0, middle) + (code[middle] === 'A' ? 'B' : 'A') + code.slice(middle + 1);
  assert.throws(() => decodeInvite(damaged), /damaged|incomplete/i);
  assert.throws(() => decodeInvite(code.slice(0, -4)), /damaged|incomplete/i);
  assert.throws(() => decodeInvite('hello'), /not a seedhost invite/i);
  assert.throws(() => decodeInvite(encodeInvite({ ...invite, expiresAt: Math.floor(Date.now() / 1000) - 1 })), /expired/i);
  assert.throws(() => encodeInvite({ ...invite, host: '0.0.0.0' }), /address/i);
  assert.throws(() => encodeInvite({ ...invite, host: 'bad host!' }), /address/i);
});

test('a friend joins a relay with one invite code and no fingerprint exchange', async (t) => {
  const dir = await root(t, 'friends-join-');
  const relay = await relayIn(t, dir);
  const { code } = await relay.createInvite({ hours: 24 });
  const sam = await pc(t, dir, 'sam');
  assert.equal((await sam.joinWithInvite({ code, name: 'Sam' })).relayName, "Angel's relay");
  const state = await sam.getState();
  assert.deepEqual(state.relay, { fingerprint: relay.identity.fingerprint, parkOnStop: true, name: "Angel's relay" });
  assert.equal(state.peers[0]!.host, '127.0.0.1');
  assert.deepEqual(relay.trusted.map((host) => [host.name, host.fingerprint]), [['Sam', sam.identity.fingerprint]]);
  assert.equal(await sam.checkRelay(), null, 'Sam can talk to the relay straight away');
  assert.deepEqual(await readdir(path.join(relay.root, 'invites')), [], 'the invite is used up');
});

test('invites are single-use, expire, and are checked against the right relay', async (t) => {
  const dir = await root(t, 'friends-single-');
  const relay = await relayIn(t, dir);
  const { code } = await relay.createInvite({ hours: 1 });
  await (await pc(t, dir, 'first')).joinWithInvite({ code, name: 'First' });
  const second = await pc(t, dir, 'second');
  await assert.rejects(second.joinWithInvite({ code, name: 'Second' }), /already used|expired|not valid/i);
  assert.equal((await second.getState()).relay, null, 'a failed join changes nothing');
  assert.equal(relay.trusted.length, 1);

  const expired = await relay.createInvite({ hours: 1 });
  const record = (await readdir(path.join(relay.root, 'invites')))[0]!;
  const file = path.join(relay.root, 'invites', record);
  const { readFile } = await import('node:fs/promises');
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), expiresAt: Date.now() - 1000 }));
  await assert.rejects(second.joinWithInvite({ code: expired.code, name: 'Second' }), /expired/i);

  // A code that names this relay's address but another relay's fingerprint cannot be redeemed here.
  const other = new RelayNode(path.join(dir, 'other'), await createIdentity(), quiet);
  await other.open();
  const forged = encodeInvite({ ...decodeInvite((await relay.createInvite({ hours: 1 })).code), relayFingerprint: other.identity.fingerprint });
  await assert.rejects(second.joinWithInvite({ code: forged, name: 'Second' }), /fingerprint|certificate|identity|pin/i);
  await assert.rejects(relay.createInvite({ hours: 0 }), /hours/i);
  await assert.rejects(relay.createInvite({ hours: 24 * 31 }), /hours/i);
});

test('without an invite, an unknown device gets nothing from the relay', async (t) => {
  const dir = await root(t, 'friends-closed-');
  const relay = await relayIn(t, dir);
  const stranger = await createIdentity();
  const peer = { name: 'Relay', fingerprint: relay.identity.fingerprint, ...relay.endpoint! };
  await assert.rejects(relayStatus(stranger, peer), /disconnected|closed|reset|refused|EPIPE|ECONNRESET/i, 'no invites pending: closed before any frame');
  await relay.createInvite({ hours: 1 });
  await assert.rejects(relayStatus(stranger, peer), /invite|refused|disconnected/i, 'a pending invite does not open the relay to other requests');
  assert.equal(relay.trusted.length, 0);
});

test('friends invite friends, see each other, and take turns hosting through the relay', async (t) => {
  const dir = await root(t, 'friends-flow-');
  const relay = await relayIn(t, dir);
  const angel = await pc(t, dir, 'angel');
  await angel.joinWithInvite({ code: (await relay.createInvite({ hours: 24 })).code, name: 'Angel' });
  await importServer(dir, angel, 'angel-world');

  const invite = await angel.createInvite();
  assert.ok(invite.expiresAt > Date.now() + 23 * 3600 * 1000, 'member invites last a day');
  const sam = await pc(t, dir, 'sam');
  await sam.joinWithInvite({ code: invite.code, name: 'Sam' });

  const friends = await angel.listFriends();
  assert.deepEqual(friends.members.map((m) => [m.name, m.you]).sort(), [['Angel', true], ['Sam', false]]);
  assert.equal(friends.holder, null, 'before first park the relay cannot observe the holder');

  await angel.parkAtRelay();
  assert.equal((await sam.listFriends()).holder, null, 'parked: nobody holds it');
  await sam.claimFromRelay();
  assert.equal((await angel.listFriends()).holder, 'Sam');
  assert.equal((await sam.getState()).server!.ownership.owner, sam.identity.fingerprint);
});

test('the relay owner can turn off member invites and remove a friend', async (t) => {
  const dir = await root(t, 'friends-admin-');
  const relay = await relayIn(t, dir);
  const angel = await pc(t, dir, 'angel');
  await angel.joinWithInvite({ code: (await relay.createInvite({ hours: 24 })).code, name: 'Angel' });
  await relay.setMemberInvites(false);
  await assert.rejects(angel.createInvite(), /only the relay owner/i);
  await relay.setMemberInvites(true);
  await angel.createInvite();
  await relay.untrust(angel.identity.fingerprint);
  await assert.rejects(angel.checkRelay(), /disconnected|closed|reset|refused|ECONNRESET/i);
  await assert.rejects(relay.untrust(angel.identity.fingerprint), /not a trusted/i);
});

test('trust changes made by the CLI reach a running relay without a restart', async (t) => {
  const dir = await root(t, 'friends-reload-');
  const serving = await relayIn(t, dir);
  // A second process on the same folder, as `seedhost-relay invite` would be.
  const cli = new RelayNode(serving.root, serving.identity, quiet);
  await cli.open();
  const host = await createIdentity();
  await cli.trust('Desktop', host.fingerprint);
  assert.equal(await relayStatus(host, { name: 'Relay', fingerprint: serving.identity.fingerprint, ...serving.endpoint! }), null);
  const { code } = await cli.createInvite({ hours: 1, advertise: { host: '127.0.0.1', port: serving.endpoint!.port } });
  const friend = await pc(t, dir, 'friend');
  await friend.joinWithInvite({ code, name: 'Friend' });
  assert.ok((await cli.reload(), cli.trusted).some((entry) => entry.name === 'Friend'));
});

test('joining refuses to silently replace a different relay or join yourself', async (t) => {
  const dir = await root(t, 'friends-guard-');
  const relay = await relayIn(t, dir);
  const second = await relayIn(t, path.join(dir, 'b'));
  const angel = await pc(t, dir, 'angel');
  await angel.joinWithInvite({ code: (await relay.createInvite({ hours: 1 })).code, name: 'Angel' });
  await assert.rejects(angel.joinWithInvite({ code: (await second.createInvite({ hours: 1 })).code, name: 'Angel' }), /already uses.*relay/i);
  const self = await pc(t, dir, 'self', relay.identity);
  await assert.rejects(self.joinWithInvite({ code: (await relay.createInvite({ hours: 1 })).code, name: 'Me' }), /own/i);
  await assert.rejects(angel.joinWithInvite({ code: 'nope', name: 'Angel' }), /not a seedhost invite/i);
  await assert.rejects(angel.joinWithInvite({ code: (await relay.createInvite({ hours: 1 })).code, name: '  ' }), /name/i);
});

test('friend IPC payloads are validated', () => {
  const code = encodeInvite(sample());
  assert.deepEqual(validateCall('joinWithInvite', { code, name: 'Sam' }, renderer, renderer, trusted), { code, name: 'Sam' });
  assert.deepEqual(validateCall('createInvite', undefined, renderer, renderer, trusted), {});
  assert.deepEqual(validateCall('listFriends', undefined, renderer, renderer, trusted), {});
  for (const payload of [{ code }, { code: 'x'.repeat(2000), name: 'a' }, { code, name: 'x'.repeat(61) }, { code, name: 'Sam', extra: 1 }]) {
    assert.throws(() => validateCall('joinWithInvite', payload, renderer, renderer, trusted), /invite|name/i);
  }
});
