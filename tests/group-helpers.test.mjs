import {relayDisbandGroup,joinRelayInvite} from '../dist/src/core/relay-client.js';
import {decodeInvite} from '../dist/src/core/invites.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { GroupHelpers } from '../dist/apps/desktop/group-helpers.js';
import { loadIdentity } from '../dist/src/core/identity-store.js';
import { SeedHostApplication } from '../dist/src/core/application.js';

// Per-group helpers: every hosting group gets its own durable root, identity, listeners and relay store, so
// two worlds never alias onto one group lineage, and the registry survives restarts without rebinding.

const scratch = process.env.TMPDIR || process.env.TEMP || process.env.TMP || path.resolve('.test-data');
const vault = { encrypt: (v) => Buffer.from(v, 'utf8'), decrypt: (b) => b.toString('utf8') };

async function workspace(t, prefix) {
  const base = path.isAbsolute(scratch) ? scratch : path.resolve(scratch);
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function world(dir, name, content) {
  const target = path.join(dir, name);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'eula.txt'), 'eula=true\n');
  await writeFile(path.join(target, 'world.bin'), content);
  return target;
}
const deps = () => ({
  loadIdentity: (root) => loadIdentity(root, vault),
  role: () => ({ host: '127.0.0.1', port: 0, gamePorts: [0], discoveryPort: 0 }),
});
async function waitCustody(host, expected) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = await host.status();
    if (status.custody === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('helper custody did not settle to ' + expected);
}

test('each group gets its own helper identity and root, and both park their own world independently', async (t) => {
  const root = await workspace(t, 'group-helpers-');
  const helpers = new GroupHelpers(path.join(root, 'always-on'), deps());
  t.after(() => helpers.closeAll());
  await helpers.restoreAll(() => true);

  const first = await helpers.create();
  const second = await helpers.create();
  assert.notEqual(first.fingerprint, second.fingerprint, 'each group gets its own relay identity');
  assert.equal(first.root, path.join(root, 'always-on'), 'the first group reuses the primary helper root');
  assert.equal(second.root.startsWith(path.join(root, 'always-on', 'groups') + path.sep), true, 'later groups live under their own durable root');
  await first.host.enable('Group One');
  await second.host.enable('Group Two');
  assert.equal((await first.host.status()).running, true);
  assert.equal((await second.host.status()).running, true);

  const app = new SeedHostApplication(path.join(root, 'pc'), await createIdentity());
  t.after(() => app.close().catch(() => undefined));
  await app.open();
  await app.importExisting(await world(root, 'world-a', 'alpha'), true);
  const aId = (await app.getState()).server.id;
  await app.joinHostingGroup({ code: (await first.host.ownerInvite('Owner', app.identity.fingerprint)).code, name: 'Owner', serverId: aId });
  await app.importExisting(await world(root, 'world-b', 'bravo'), true);
  const bId = (await app.getState()).server.id;
  await app.joinHostingGroup({ code: (await second.host.ownerInvite('Owner', app.identity.fingerprint)).code, name: 'Owner', serverId: bId });
  const groups = Object.fromEntries((await app.getState()).servers.map((entry) => [entry.id, entry.group.fingerprint]));
  assert.equal(groups[aId], first.fingerprint);
  assert.equal(groups[bId], second.fingerprint, 'a second world binds to its own group, never the first group');

  // Parking each world lands only on its own helper; a shared helper would refuse the second lineage.
  await app.selectServer(aId);
  await app.parkAtRelay();
  await waitCustody(first.host, 'owned');
  assert.equal((await second.host.status()).custody, 'empty', 'parking world A never touches world B’s group');
  await app.selectServer(bId);
  await app.parkAtRelay();
  await waitCustody(second.host, 'owned');
  assert.equal((await first.host.status()).custody, 'owned', 'parking world B never disturbs world A’s custody');
});

test('helpers restore from disk by identity without rebinding, and unreferenced roots are left alone', async (t) => {
  const root = await workspace(t, 'group-helpers-restart-');
  const baseRoot = path.join(root, 'always-on');
  const first = new GroupHelpers(baseRoot, deps());
  await first.restoreAll(() => true);
  const a = await first.create();
  const b = await first.create();
  const unreferenced = await first.create();
  await a.host.enable('Group A');
  await b.host.enable('Group B');
  await unreferenced.host.enable('Spare');
  const owner = (await createIdentity()).fingerprint;
  await a.host.ownerInvite('Owner', owner);
  await b.host.ownerInvite('Owner', owner);
  await unreferenced.host.ownerInvite('Owner', owner);
  const fingerprints = { a: a.fingerprint, b: b.fingerprint, spare: unreferenced.fingerprint };
  assert.equal(new Set(Object.values(fingerprints)).size, 3, 'every group has a distinct identity');
  await first.closeAll();

  const resumed = new GroupHelpers(baseRoot, deps());
  t.after(() => resumed.closeAll());
  await resumed.restoreAll((fingerprint) => fingerprint === fingerprints.a || fingerprint === fingerprints.b);
  const restored = new Set(resumed.list().map((entry) => entry.fingerprint));
  assert.equal(restored.has(fingerprints.a), true);
  assert.equal(restored.has(fingerprints.b), true);
  assert.equal(restored.has(fingerprints.spare), false, 'a root no world references is not restarted');
  assert.equal((await resumed.forFingerprint(fingerprints.a).host.status()).running, true);
  assert.equal((await resumed.forFingerprint(fingerprints.b).host.status()).running, true);
  assert.equal(resumed.forFingerprint(fingerprints.spare), undefined, 'the unreferenced root is not even loaded');

  // A helper that serves a group is never handed out again for a different one.
  for (let attempt = 0; attempt < 3; attempt++) {
    const again = await resumed.create();
    assert.equal(Object.values(fingerprints).includes(again.fingerprint), false, 'new groups always get fresh roots, never a used one');
    await again.host.close();
  }
});
test('registry resolves and restores a replacement group identity inside an extra helper',async t=>{
 const root=await workspace(t,'group-registry-replacement-'),base=path.join(root,'always-on');
 const registry=new GroupHelpers(base,deps());t.after(()=>registry.closeAll());await registry.restoreAll(()=>true);
 await registry.create();const extra=await registry.create(),owner=await createIdentity();await extra.host.startGroup('Old');
 const invite=await extra.host.ownerInvite('Owner',owner.fingerprint),pin=decodeInvite(invite.code);await joinRelayInvite(owner,invite.code,'Owner');
 await relayDisbandGroup(owner,{fingerprint:pin.relayFingerprint,host:pin.host,port:pin.port});
 const fresh=await extra.host.startGroup('Fresh',true);await extra.host.ownerInvite('Owner',owner.fingerprint);
 assert.equal(registry.forFingerprint(fresh.fingerprint),extra,'selected replacement resolves its own helper, not primary');
 await registry.closeAll();const reopened=new GroupHelpers(base,deps());t.after(()=>reopened.closeAll());await reopened.restoreAll(fp=>fp===fresh.fingerprint);
 const found=reopened.forFingerprint(fresh.fingerprint);assert.ok(found,'referencing the replacement pin keeps its parent helper');assert.equal((await found.host.status()).fingerprint,fresh.fingerprint);
});
