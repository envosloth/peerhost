import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { validateCall } from '../dist/src/core/ipc-policy.js';
import { AlwaysOnHost } from '../dist/src/core/always-on.js';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { SeedHostApplication } from '../dist/src/core/application.js';

test('renderer Start admits a stopped transferred group for backend acquisition and Stop admits publication retry', async () => {
  const renderer = await readFile('apps/desktop/renderer.js', 'utf8');
  const start = renderer.match(/\$\('start-server'\)\.disabled = ([^;]+);/)[1];
  const stop = renderer.match(/\$\('stop-server'\)\.disabled = ([^;]+);/)[1];
  const server = { state: 'offline', group: { fingerprint: 'a'.repeat(64) }, ownership: { state: 'owned', owner: 'me' }, profile: { executable: '', args: [] } };
  const evaluate = expression => new Function('blocked', 'server', 'active', 'ownsServer', 'profileDirty', 'ownership', 'state', 'isStopped', `return ${expression}`)(false, server, false, () => false, false, server.ownership, { deviceId: 'me' }, () => true);
  assert.equal(evaluate(start), false, 'the group backend, not a local transferred replica, decides Start');
  assert.equal(evaluate(stop), false, 'ordinary Stop must offer retry after failed publication');
});

test('desktop sources expose cohesive group Start instead of pending Download', async () => {
  const [main, preload, renderer, helpers] = await Promise.all(['apps/desktop/main.ts', 'apps/desktop/preload.cts', 'apps/desktop/renderer.js', 'apps/desktop/group-helpers.ts'].map(file => readFile(file, 'utf8')));
  const accounts = await readFile('apps/desktop/accounts.js', 'utf8');
  assert.ok(accounts.includes("g.pending?'Start server'"), 'pending group exposes execution action');
  assert.ok(!accounts.includes('Download as a new server'));
  // The ordinary Start action is one IPC that renders through the backend acquisition (never a pending Download).
  // The case body grew a captured-world public-address gate; pin the routing + validated fingerprint, not the literal shape.
  assert.match(main, /case 'startGroup':\{/);
  assert.match(main, /backend\.startGroupWithApproval\(p\.fingerprint,/);
  assert.match(preload, /'startGroup'/);
  assert.match(renderer, /runAction\('startGroup', \{ fingerprint: group\.fingerprint \}/);
  assert.match(main, /publishStoppedInitial:.*backend\.publishStoppedInitialGroup/);
  assert.match(helpers, /publishStoppedInitial: this\.deps\.publishStoppedInitial/);
  const alwaysOn = await readFile('src/core/always-on.ts', 'utf8');
  assert.ok(alwaysOn.includes('loadGroupIdentity: this.options.loadGroupIdentity, publishStoppedInitial: this.options.publishStoppedInitial'), 'rotated/restored group helper retains owner app callback');
});

const url = 'file:///fixture/index.html';
test('desktop group Start accepts only a pinned group target, not peer commands or paths', () => {
  const fingerprint = 'a'.repeat(64);
  assert.deepEqual(validateCall('startGroup', { fingerprint }, url, url, { senderId: 1, expectedSenderId: 1, isMainFrame: true }), { fingerprint });
  for (const extra of [{ executable: 'peer.exe' }, { serverDir: 'C:/peer' }, { args: ['evil'] }, { fingerprint: 'A'.repeat(64) }]) {
    assert.throws(() => validateCall('startGroup', { fingerprint, ...extra }, url, url, { senderId: 1, expectedSenderId: 1, isMainFrame: true }));
  }
});

test('running group-only helper binds initial publication to its owner app without enabling player gateway', async t => {
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'group-start-helper-'));
  const owner = new SeedHostApplication(path.join(root, 'owner'), await createIdentity());
  const member = new SeedHostApplication(path.join(root, 'member'), await createIdentity(), {
    resolveGroupLaunchProfile: async () => ({ executable: process.execPath, args: [path.resolve('tools/fake-java-server.mjs'), '--lifetime-ms=30000'] }),
  });
  const host = new AlwaysOnHost(path.join(root, 'helper'), await createIdentity(), {
    host: '127.0.0.1', port: 0, gamePorts: [0], discoveryPort: 0,
    publishStoppedInitial: (pin, identity) => owner.publishStoppedInitialGroup(pin, identity),
  });
  t.after(async () => { await member.close(); await owner.close(); await host.close(); await rm(root, { recursive: true, force: true }); });
  await owner.open(); await member.open();
  const source = path.join(root, 'source'); await mkdir(source);
  await writeFile(path.join(source, 'world.bin'), 'helper-bound synthetic world');
  await writeFile(path.join(source, 'eula.txt'), 'eula=true\n');
  await owner.importExisting(source, true);
  await host.startGroup('Fixture group');
  await owner.joinHostingGroup({ code: (await host.ownerInvite('Owner', owner.identity.fingerprint)).code, name: 'Owner', serverId: (await owner.getState()).server.id });
  await member.joinHostingGroup({ code: (await owner.createInvite()).code, name: 'Member' });
  const pin = (await member.getState()).pendingGroups[0].fingerprint;
  await member.startGroup(pin, true);
  assert.equal((await member.getState()).server.state, 'running');
  assert.equal(await readFile(path.join((await member.getState()).server.serverDir, 'world.bin'), 'utf8'), 'helper-bound synthetic world');
  assert.equal((await host.status()).gamePort, null);
  await member.stopServer();
});
