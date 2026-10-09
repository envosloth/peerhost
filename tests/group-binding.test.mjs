import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { SeedHostApplication } from '../dist/src/core/application.js';
import { RelayNode } from '../dist/src/core/relay.js';
import { createIdentity } from '../dist/src/core/peer-transport.js';

for (const binding of ['saveRelay', 'joinHostingGroup']) {
  test(`explicit ${binding} consumes pending membership without replacing the selected world`, async t => {
    const root = await mkdtemp(path.join(process.env.TMPDIR, 'seed-binding-'));
    const owner = await createIdentity();
    const app = new SeedHostApplication(path.join(root, 'profile'), owner);
    const relay = new RelayNode(path.join(root, 'relay'), await createIdentity(), { log() {} });
    t.after(async () => { await app.close(); await relay.close(); await rm(root, { recursive: true, force: true }); });
    await app.open(); await relay.open(); await relay.trust('Owner', owner.fingerprint); await relay.setOwner(owner.fingerprint); await relay.listen();
    const source = path.join(root, 'source'); await mkdir(source); await writeFile(path.join(source, 'world.dat'), 'retain local world');
    await app.importExisting(source, true);
    const before = (await app.getState()).server, snapshots = await app.listSnapshots();
    const invitation = await relay.createInvite({ recipient: owner.fingerprint });
    await app.joinWithInvite({ code: invitation.code, name: 'Owner' });
    assert.ok((await app.getState()).pendingGroups.some(g => g.fingerprint === relay.identity.fingerprint));
    if (binding === 'saveRelay') await app.saveRelay({ fingerprint: relay.identity.fingerprint, parkOnStop: false });
    else await app.joinHostingGroup({ code: invitation.code, name: 'Owner', serverId: before.id, parkOnStop: false });
    const state = await app.getState();
    assert.equal(state.pendingGroups.some(g => g.fingerprint === relay.identity.fingerprint), false, 'explicit binding must not leave a conflicting pending copy');
    assert.equal(state.server.id, before.id); assert.equal(state.server.serverDir, before.serverDir);
    assert.equal(state.relay.fingerprint, relay.identity.fingerprint);
    assert.deepEqual(await app.listSnapshots(), snapshots);
    assert.equal(await readFile(path.join(before.serverDir, 'world.dat'), 'utf8'), 'retain local world');
    await app.close();
    const again = new SeedHostApplication(path.join(root, 'profile'), owner); await again.open(); t.after(() => again.close());
    assert.equal((await again.getState()).pendingGroups.length, 0);
    assert.equal((await again.getState()).relay.fingerprint, relay.identity.fingerprint);
  });
}
