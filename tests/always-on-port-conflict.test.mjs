import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { AlwaysOnHost } from '../dist/src/core/always-on.js';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { RelayNode } from '../dist/src/core/relay.js';
import { ServerProcess } from '../dist/src/core/launcher.js';

test('malformed reserved lists fail closed before listeners or relay files', async t => {
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'invalid-reservations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = await createIdentity();
  for (const [index, reservedGamePorts] of [null, '25565', {}, [0], [-1], [65536], [1.5], [NaN], [Infinity], ['123'], new Array(1)].entries()) {
    const target = path.join(root, String(index));
    let host;
    try {
      await assert.rejects(async () => {
        host = new AlwaysOnHost(target, identity, { host: '127.0.0.1', port: 0, gamePorts: [0], discoveryPort: 0, reservedGamePorts });
        await host.enable();
      }, /reservedGamePorts.*integer.*1.*65535/i);
    } finally { await host?.close(); }
    await assert.rejects(access(target), { code: 'ENOENT' });
  }
});

test('default gateway candidates leave conventional Minecraft port alone and fail actionably when reserved', async t => {
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'reserved-defaults-'));
  const target = path.join(root, 'role');
  const host = new AlwaysOnHost(target, await createIdentity(), { host: '127.0.0.1', port: 0, discoveryPort: 0, reservedGamePorts: [25566, 25567, 25568, 25569] });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  t.mock.method(RelayNode.prototype, 'listenGame', async () => { throw new Error('Unexpected fixed player-port bind'); });
  await assert.rejects(host.enable(), /player port.*reserved.*Minecraft.*configure/i);
  await assert.rejects(access(target), { code: 'ENOENT' });
});

const scratch = process.env.TMPDIR;
assert.ok(scratch, 'Tests require TMPDIR');
test('enabling after server configuration refreshes reserved ports without rebinding a running helper', async t => {
  const root = await mkdtemp(path.join(scratch, 'late-reservations-'));
  const preferred = await freeTcpPort();
  const host = new AlwaysOnHost(root, await createIdentity(), { host: '127.0.0.1', port: 0, discoveryPort: 0, gamePorts: [preferred, 0] });
  t.after(async () => { await host.close(); await rm(root, {recursive:true, force:true}); });
  const reservations = [preferred];
  const first = await host.enable(undefined, reservations);
  assert.notEqual(first.gamePort, preferred, 'late managed server configuration must be reserved before enabling');
  const lateReservations = [preferred, first.gamePort];
  const stable = await host.enable(undefined, lateReservations);
  assert.equal(stable.gamePort, first.gamePort, 'existing player endpoint must not silently change');
  assert.equal(stable.running, true);
  await host.close();
  lateReservations.length = 0;
  const restarted = await host.enable();
  assert.notEqual(restarted.gamePort, preferred, 'reservations must be copied, not held by caller reference');
});

test('malformed enable-time reservations fail before filesystem or listener effects', async t => {
  const root = await mkdtemp(path.join(scratch, 'late-invalid-reservations-'));
  const target = path.join(root, 'role');
  const host = new AlwaysOnHost(target, await createIdentity(), {host:'127.0.0.1',port:0,gamePorts:[0],discoveryPort:0});
  t.after(async () => {await host.close();await rm(root,{recursive:true,force:true});});
  await assert.rejects(host.enable(undefined, [0]), /reservedGamePorts.*integer/i);
  await assert.rejects(host.enable(undefined, new Array(1)), /reservedGamePorts.*integer/i);
  await assert.rejects(access(target), {code:'ENOENT'});
});
async function freeTcpPort() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

test('ephemeral allocation landing on a reserved port fails closed rather than reporting a conflicting gateway', async t => {
  const root = await mkdtemp(path.join(scratch, 'ephemeral-reserved-'));
  const reserved = await freeTcpPort();
  const host = new AlwaysOnHost(root, await createIdentity(), { host: '127.0.0.1', port: 0, discoveryPort: 0, gamePorts: [0], reservedGamePorts: [reserved] });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const listenGame = RelayNode.prototype.listenGame;
  t.mock.method(RelayNode.prototype, 'listenGame', function(options) { return listenGame.call(this, { ...options, port: reserved }); });
  await assert.rejects(host.enable(), /player port.*reserved.*Minecraft.*retry/i);
  assert.equal((await host.status()).running, false);
  await assert.rejects(access(path.join(root, 'always-on.json')), { code: 'ENOENT' });
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(reserved, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
});

test('enabled and restored helper leaves reserved Minecraft port free for a real child', async t => {
  const root = await mkdtemp(path.join(scratch, 'port-coordination-'));
  const identity = await createIdentity();
  const reserved = await freeTcpPort();
  let fallback = await freeTcpPort();
  while (fallback === reserved) fallback = await freeTcpPort();
  const options = { host: '127.0.0.1', port: 0, discoveryPort: 0, gamePorts: [reserved, fallback, 0], reservedGamePorts: [reserved] };
  const host = new AlwaysOnHost(root, identity, options);
  const restored = new AlwaysOnHost(root, identity, options);
  const child = new ServerProcess({ executable: process.execPath, cwd: root, startTimeoutMs: 2000, args: ['--input-type=module', '-e', `
    import { createServer } from 'node:net';
    import { createInterface } from 'node:readline';
    const server = createServer();
    server.on('error', error => { console.error(error.code); process.exit(1); });
    server.listen(${reserved}, '127.0.0.1', () => console.log('Done (socket fixture)'));
    createInterface({ input: process.stdin }).on('line', line => { if (line === 'stop') server.close(() => process.exit(0)); });
  `] });
  t.after(async () => { await child.forceStop(); await restored.close(); await host.close(); await rm(root, { recursive: true, force: true }); });
  const enabled = await host.enable();
  assert.equal(enabled.gamePort, fallback, 'gateway must skip the unoccupied reserved port');
  await child.start();
  assert.equal(child.state, 'running');
  await child.stop();
  await host.close();
  await restored.restore();
  const status = await restored.status();
  assert.equal(status.enabled, true);
  assert.equal(status.running, true);
  assert.notEqual(status.gamePort, reserved);
  await child.start();
  await child.stop();
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'always-on.json'), 'utf8')), { version: 1, enabled: true });
});
