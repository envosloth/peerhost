import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createSocket } from 'node:dgram';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { SeedHostApplication } from '../dist/src/core/application.js';
import { AlwaysOnHost, findAlwaysOnPC, newPairingCode, normalizePairingCode, pairingSecrets } from '../dist/src/core/always-on.js';

// One-click always-on PC: real relay, real UDP discovery and real TLS join, all on loopback.
const scratch = process.env.TMPDIR;
assert.ok(scratch, 'Tests require TMPDIR');
async function freeUdpPort() {
  const s = createSocket('udp4'); await new Promise(r => s.bind(0, '127.0.0.1', r)); const { port } = s.address(); await new Promise(r => s.close(r)); return port;
}
async function setup(t) {
  const root = await mkdtemp(path.join(scratch, 'always-on-'));
  const discoveryPort = await freeUdpPort();
  const host = new AlwaysOnHost(path.join(root, 'always-on'), await createIdentity(), { host: '127.0.0.1', port: 0, gamePorts: [0], discoveryPort });
  const app = new SeedHostApplication(path.join(root, 'gaming'), await createIdentity());
  await app.open();
  t.after(async () => { await app.close(); await host.close(); await rm(root, { recursive: true, force: true }); });
  const find = (code) => findAlwaysOnPC(code, { targets: ['127.0.0.1'], port: discoveryPort, timeoutMs: 3000 });
  return { root, host, app, find };
}

test('creating a hosting group keeps always-on off, restores control only, and preserves an existing opt-in', async t => {
  const {host,app}=await setup(t);
  assert.equal(typeof host.startGroup,'function');
  await host.startGroup('Friends group');
  const status=await host.status();assert.equal(status.enabled,false);assert.equal(status.running,false);assert.equal(status.gamePort,null);assert.ok(status.port>0);
  const invitation=await host.ownerInvite('Owner',app.identity.fingerprint);
  await app.joinHostingGroup({code:invitation.code,name:'Owner',parkOnStop:false});
  assert.equal((await app.getState()).relay.parkOnStop,false,'new group does not silently opt into parking');
  assert.equal((await app.listFriends()).canManage,true);
  await host.close();await host.restore();assert.equal((await host.status()).enabled,false);assert.equal((await host.status()).gamePort,null);assert.ok((await host.status()).port>0);
  await host.enable('Opt-in PC');await host.startGroup('Friends group');assert.equal((await host.status()).enabled,true);assert.ok((await host.status()).gamePort>0);
  await host.disable();assert.equal((await host.status()).enabled,false);assert.ok((await host.status()).port>0,'explicit disable retains group control');
});

test('pairing codes are short, readable and forgiving to type', async () => {
  const code = newPairingCode();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(normalizePairingCode(code.toLowerCase().replaceAll('-', ' ')), code);
  assert.equal(normalizePairingCode('o1il-0000-0000'), '0111-0000-0000');
  for (const bad of ['', 'ABCD-EFGH', 'ABCD-EFGH-IJKU', 42]) assert.throws(() => normalizePairingCode(bad), /12-character code/);
  const a = await pairingSecrets(code), b = await pairingSecrets(code.toLowerCase());
  assert.equal(a.id, b.id); assert.deepEqual(a.token, b.token);
  assert.notEqual((await pairingSecrets(newPairingCode())).id, a.id);
});

test('one click on the always-on PC, one code on the gaming PC: joined and player address on', async t => {
  const { host, app, find } = await setup(t);
  let status = await host.enable('Living room PC');
  assert.equal(status.running, true); assert.equal(status.name, 'Living room PC');
  assert.ok(status.port > 0 && status.gamePort > 0, 'relay and player listeners are up');
  status = await host.newCode();
  assert.match(status.code, /^.{4}-.{4}-.{4}$/);
  assert.ok(status.codeExpiresAt > Date.now() + 25 * 60_000, 'code lasts about 30 minutes');
  const paired = await app.pairAlwaysOn({ code: status.code.toLowerCase(), name: 'Angel' }, find);
  assert.equal(paired.relayName, 'Living room PC');
  assert.equal(paired.gatewayOn, true, 'shared player address is turned on automatically');
  const state = await app.getState();
  assert.equal(state.relay.fingerprint, host['identity'].fingerprint, 'pinned to the always-on PC certificate');
  assert.equal(state.relay.parkOnStop, true);
  assert.equal(state.gateway.enabled, true);
  assert.deepEqual((await host.status()).members.map(m => m.name), ['Angel']);
  // Single use: a second gaming PC cannot reuse the code.
  const other = new SeedHostApplication(path.join(host.root, '..', 'other'), await createIdentity()); await other.open();
  t.after(() => other.close());
  await assert.rejects(other.pairAlwaysOn({ code: status.code, name: 'Mallory' }, find), /already used|expired|not valid|disconnected/i);
});

test('a wrong code finds nothing and changes nothing', async t => {
  const { host, app, find } = await setup(t);
  await host.enable(); await host.newCode();
  await assert.rejects(app.pairAlwaysOn({ code: newPairingCode(), name: 'Angel' }, find), /No always-on PC answered/);
  assert.equal((await app.getState()).relay, null);
  assert.deepEqual((await host.status()).members, []);
});

test('the always-on choice survives a restart and can be turned off', async t => {
  const { host, root } = await setup(t);
  await host.enable('Den PC');
  await host.close();
  const again = new AlwaysOnHost(host.root, host['identity'], { host: '127.0.0.1', port: 0, gamePorts: [0], discoveryPort: await freeUdpPort() });
  t.after(() => again.close());
  await again.restore();
  assert.equal((await again.status()).running, true, 'restarts with the app');
  assert.equal((await again.status()).name, 'Den PC');
  await again.disable();
  assert.equal((await again.status()).running, false);
  assert.deepEqual(JSON.parse(await readFile(path.join(host.root, 'always-on.json'), 'utf8')), { version: 1, enabled: false });
});
