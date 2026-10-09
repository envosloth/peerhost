import test from 'node:test';
import { spawn } from 'node:child_process';
const buildRoot = (process.env.REVIEW_BUILD ?? new URL('../dist', import.meta.url).href).replace(/\/$/, '');
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';


// Pause the actual pinned TLS reply after admission commits, not an earlier status read.
function pauseHostAcknowledgment(relay) {
  let reached, release;
  const admitted = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const handle = relay.handle.bind(relay);
  let armed = true;
  relay.handle = (socket, source) => {
    const write = socket.write.bind(socket);
    socket.write = (packet, ...args) => {
      if (armed && Buffer.isBuffer(packet) && packet.subarray(4).toString() === '{"type":"relay-host-accepted"}') {
        armed = false; reached(socket);
        void gate.then(() => { if (!socket.destroyed) write(packet, ...args); });
        return true;
      }
      return write(packet, ...args);
    };
    return handle(socket, source);
  };
  return { admitted, release };
}

const { createIdentity } = await import(buildRoot + '/src/core/peer-transport.js');
const { SeedHostApplication } = await import(buildRoot + '/src/core/application.js');
const { RelayNode } = await import(buildRoot + '/src/core/relay.js');
const { relayHostState, relayStatus } = await import(buildRoot + '/src/core/relay-client.js');
import { randomUUID } from 'node:crypto';
const { sendSnapshotToPeer } = await import(buildRoot + '/src/core/transfers.js');
const { relayRequest } = await import(buildRoot + '/src/core/relay-client.js');
const { createSnapshot } = await import(buildRoot + '/src/core/snapshots.js');
const { OwnershipLedger } = await import(buildRoot + '/src/core/ownership.js');

async function fixture(t) {
  const scratch = process.env.TMPDIR;
  assert.ok(scratch?.replaceAll('\\', '/').toLowerCase().includes('hermes/cache/scratch'), 'disposable scratch root required');
  const root = await mkdtemp(path.join(scratch, 'seedhost-member-download-'));
  const relay = new RelayNode(path.join(root, 'relay'), await createIdentity(), { log() {}, name: 'Shared world' });
  const owner = new SeedHostApplication(path.join(root, 'owner'), await createIdentity(), {
    resolveGroupLaunchProfile: async () => ({ executable: process.execPath, args: [path.resolve('tools/fake-java-server.mjs'), '--lifetime-ms=30000'] }),
  });
  const member = new SeedHostApplication(path.join(root, 'member'), await createIdentity(), {
    // Locally approved synthetic process, NEVER received from the peer or a renderer.
    resolveGroupLaunchProfile: async () => ({ executable: process.execPath, args: [path.resolve('tools/fake-java-server.mjs'), '--lifetime-ms=30000'] }),
  });
  t.after(async () => {
    await member.close(); await owner.close(); await relay.close();
    await rm(root, { recursive: true, force: true });
  });
  await relay.open(); await relay.listen(); await owner.open(); await member.open();
  await relay.trust('Owner', owner.identity.fingerprint);
  await relay.setOwner(owner.identity.fingerprint);
  await owner.addPeer({ name: relay.name, fingerprint: relay.identity.fingerprint, ...relay.endpoint });
  const source = path.join(root, 'source');
  await mkdir(source); await writeFile(path.join(source, 'world.bin'), 'initial');
  await writeFile(path.join(source, 'eula.txt'), 'eula=true\n');
  await owner.importExisting(source, true);
  await owner.saveRelay({ fingerprint: relay.identity.fingerprint, parkOnStop: false });
  await member.joinHostingGroup({ code: (await owner.createInvite()).code, name: 'Member' });
  return { root, source, owner, member, relay, pin: relay.identity.fingerprint };
}

async function acceptedPark(t) {
 const f = await fixture(t); await f.owner.parkAtRelay(); await f.member.claimPendingGroup(f.pin); await f.relay.settled();
 const server = (await f.member.getState()).server;
 const offer = await f.member.ledger().prepareTransfer(f.pin, server.snapshotId);
 const send = (identity, offered, snapshot = offered.snapshotId) => sendSnapshotToPeer(identity, {...f.relay.endpoint, fingerprint:f.pin}, server.storeDir, snapshot, offered, {preface:relayRequest('park')});
 assert.equal((await send(f.member.identity, offer)).ownershipAccepted, true);
 return {...f, server, offer, send};
}

async function revokeInOtherProcess(relay, fingerprint) {
  const script = `import { RelayNode } from '${buildRoot}/src/core/relay.js';
    const [root, identity, fingerprint] = JSON.parse(process.argv[1]);
    const node = new RelayNode(root, identity, { log() {} }); await node.open();
    try { await node.untrust(fingerprint); console.log(JSON.stringify({ revoked: true })); }
    catch (error) { console.log(JSON.stringify({ revoked: false, message: error.message })); }
    await node.close();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify([relay.root, relay.identity, fingerprint])], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, err);
  return JSON.parse(out.trim());
}

test('accepted Park replay authenticates every durable detail and never reapplies historical custody', async t => {
 const f = await acceptedPark(t); const before = await f.relay.custody();
 const changed = await createSnapshot(f.server.serverDir, f.server.storeDir, f.server.snapshotId);
 for (const offer of [{...f.offer, source:f.owner.identity.fingerprint}, {...f.offer, snapshotId:changed.id}, {...f.offer, lineage:randomUUID()}, {...f.offer, generation:f.offer.generation+1}, {...f.offer, target:f.owner.identity.fingerprint}]) {
   const identity = offer.source === f.owner.identity.fingerprint ? f.owner.identity : f.member.identity;
   assert.equal((await f.send(identity, offer)).ownershipAccepted, false, 'changed accepted offer must be refused');
 }
 assert.deepEqual(await f.relay.custody(), before);
 await f.owner.claimFromRelay(); await f.relay.settled(); const advanced = await f.relay.custody();
 assert.equal((await f.send(f.member.identity, f.offer)).ownershipAccepted, true);
 assert.deepEqual(await f.relay.custody(), advanced);
});

function dropHostAcknowledgment(relay, occurrence) {
  const handle = relay.handle.bind(relay); let seen = 0;
  relay.handle = (socket, source) => {
    const write = socket.write.bind(socket);
    socket.write = (packet, ...args) => {
      if (Buffer.isBuffer(packet) && packet.subarray(4).toString() === '{"type":"relay-host-accepted"}') {
        seen += 1;
        if (seen === occurrence) { const result = write(packet.subarray(0, 8), ...args); setImmediate(() => socket.destroy()); return result; }
      }
      return write(packet, ...args);
    };
    return handle(socket, source);
  };
}

test('a member revoked mid-stream cannot re-acknowledge an accepted park replay', async t => {
  const f = await acceptedPark(t);
  const before = await f.relay.custody();
  // The admission-time membership check has already passed; revoke from a separate OS process sharing the
  // durable root while the replayed payload has not yet been read, then let the replay decision proceed.
  const receivePark = f.relay.receivePark.bind(f.relay);
  f.relay.receivePark = async (socket, source, who) => { await revokeInOtherProcess(f.relay, f.member.identity.fingerprint); return receivePark(socket, source, who); };
  const result = await f.send(f.member.identity, f.offer);
  assert.equal(result.ownershipAccepted, false, 'revoked mid-stream replay must be refused');
  assert.deepEqual(await f.relay.custody(), before);
});

test('unresolved stopped admission journal blocks replacement until explicit recovery finishes it', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await writeFile(path.join((await owner.getState()).server.serverDir, 'server.properties'), 'server-port=0\n');
  await owner.parkAtRelay(); await member.claimPendingGroup(pin); await relay.settled();
  const before = await member.getState(); const serverId = before.server.id;
  member.options.resolveGroupLaunchProfile = async () => ({ executable: process.execPath, args: [path.resolve('tools/fake-java-server.mjs'), '--lifetime-ms=30000'] });
  dropHostAcknowledgment(relay, 3); // host-start and host-running acks arrive; the host-stopped ack is lost after its durable write
  await member.startGroup(pin, true);
  await assert.rejects(member.stopServer(), /retry stop/i);
  const journalPath = path.join(member.root, 'admissions', serverId + '.json');
  const unresolved = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(unresolved.phase, 'snapshot-retained'); assert.equal(unresolved.stopped, true);
  const custody = await relay.custody();
  await assert.rejects(member.startGroup(pin, true), /unresolved/i);
  const after = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(after.revision.reservation, unresolved.revision.reservation);
  assert.deepEqual(await relay.custody(), custody);
  await member.close();
  const restored = new SeedHostApplication(member.root, member.identity); await restored.open(); t.after(() => restored.close());
  await restored.stopServer();
  const final = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(final.phase, 'stopped'); assert.equal(final.revision.reservation, unresolved.revision.reservation);
  assert.equal((await restored.getState()).server.ownership.state, 'transferred');
});

test('lost host-cancel acknowledgment keeps the exact cancelled admission recoverable across both restarts', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await writeFile(path.join((await owner.getState()).server.serverDir, 'server.properties'), 'server-port=0\n');
  await owner.parkAtRelay(); await member.claimPendingGroup(pin); await relay.settled();
  const before = await member.getState(); const serverId = before.server.id; const dir = before.server.serverDir;
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const conflictPort = probe.address().port; await new Promise(resolve => probe.close(resolve));
  await writeFile(path.join(dir, 'server.properties'), `server-ip=127.0.0.1\nserver-port=${conflictPort}\n`);
  await writeFile(path.join(dir, 'world.bin'), 'pre-conflict');
  // The bind only appears after admission: a genuinely late port conflict with no child process.
  const conflict = createServer(); let approvals = 0;
  member.options.beforeServerStart = async () => { approvals += 1; if (approvals === 2) await new Promise(resolve => conflict.listen(conflictPort, '127.0.0.1', resolve)); };
  t.after(() => new Promise(resolve => conflict.close(() => resolve())));
  dropHostAcknowledgment(relay, 2); // host-start ack #1 arrives; the follow-up host-cancel ack #2 is lost after its durable write
  await assert.rejects(member.startGroup(pin, true), /cancellation is unverified|explicit recovery/i);
  const journalPath = path.join(member.root, 'admissions', serverId + '.json');
  const admission = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(admission.acknowledged, true); assert.equal(admission.stopped, false);
  assert.equal((await member.getState()).server.ownership.state, 'uncertain');
  const status = await member.groupRecoveryStatus();
  assert.equal(status.remote.observation.state, 'cancelled');
  assert.equal(status.remote.observation.reservation, admission.revision.reservation);
  const exact = await relay.custody(); const endpoint = relay.endpoint;
  await member.close(); await relay.close();
  const second = new RelayNode(relay.root, relay.identity, { log() {} }); await second.open(); await second.listen(endpoint);
  const restored = new SeedHostApplication(member.root, member.identity); await restored.open();
  t.after(async () => { await restored.close(); await second.close(); });
  await restored.recoverStopped(true);
  const recovered = await restored.getState();
  assert.equal(recovered.server.ownership.state, 'owned');
  assert.equal(await readFile(path.join(recovered.server.serverDir, 'world.bin'), 'utf8'), 'pre-conflict');
  assert.deepEqual(await second.custody(), exact);
  const final = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(final.phase, 'cancelled'); assert.equal(final.revision.reservation, admission.revision.reservation);
  const settled = await restored.groupRecoveryStatus();
  assert.equal(settled.remote.observation.state, 'cancelled'); assert.equal(settled.remote.observation.reservation, admission.revision.reservation);
});

function wreckSecondConnection(relay) {
  const handle = relay.handle.bind(relay); let seen = 0;
  relay.handle = (socket, source) => {
    seen += 1;
    if (seen === 2) { socket.destroy(); return; }
    return handle(socket, source);
  };
}

// A cancelled recovery can lose its host-cancel re-ack after the durable ledger already committed the fresh
// snapshot. The journaled recoverySnapshot must keep that exact admission retryable; tampering must refuse.
test('cancelled recovery whose host-cancel re-ack is lost stays retryable with the retained fresh snapshot', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await writeFile(path.join((await owner.getState()).server.serverDir, 'server.properties'), 'server-port=0\n');
  await owner.parkAtRelay(); await member.claimPendingGroup(pin); await relay.settled();
  const before = await member.getState(); const serverId = before.server.id; const dir = before.server.serverDir;
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const conflictPort = probe.address().port; await new Promise(resolve => probe.close(resolve));
  await writeFile(path.join(dir, 'server.properties'), `server-ip=127.0.0.1\nserver-port=${conflictPort}\n`);
  await writeFile(path.join(dir, 'world.bin'), 'pre-conflict');
  const conflict = createServer(); let approvals = 0;
  member.options.beforeServerStart = async () => { approvals += 1; if (approvals === 2) await new Promise(resolve => conflict.listen(conflictPort, '127.0.0.1', resolve)); };
  t.after(() => new Promise(resolve => conflict.close(() => resolve())));
  dropHostAcknowledgment(relay, 2); // host-start ack arrives; the host-cancel ack is lost after its durable write
  await assert.rejects(member.startGroup(pin, true), /cancellation is unverified|explicit recovery/i);
  const journalPath = path.join(member.root, 'admissions', serverId + '.json');
  const admission = JSON.parse(await readFile(journalPath, 'utf8'));
  const exact = await relay.custody();
  // First post-arm connection: the recovery-status read (pass through). Second: the host-cancel re-ack,
  // destroyed before processing, so only the acknowledgment is lost and the recovery outcome is unresolved.
  wreckSecondConnection(relay);
  await assert.rejects(member.recoverStopped(true), /unresolved/i);
  const stuck = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(stuck.phase, 'cancelled'); assert.equal(stuck.stopped, false);
  assert.deepEqual(stuck.revision, admission.revision);
  assert.ok(typeof stuck.recoverySnapshot === 'string' && /^[a-f0-9]{64}$/.test(stuck.recoverySnapshot),
    'the fresh retained snapshot must be journaled as recoverySnapshot');
  const retained = stuck.recoverySnapshot;
  assert.notEqual(retained, admission.revision.snapshotId);
  const uncertain = await member.getState();
  assert.equal(uncertain.server.ownership.state, 'uncertain');
  assert.equal(uncertain.server.snapshotId, retained);
  assert.equal(await readFile(path.join(dir, 'world.bin'), 'utf8'), 'pre-conflict');
  await member.close();
  const restored = new SeedHostApplication(member.root, member.identity); await restored.open();
  t.after(() => restored.close());
  const honest = JSON.parse(await readFile(journalPath, 'utf8'));
  await writeFile(journalPath, JSON.stringify({ ...honest, recoverySnapshot: 'f'.repeat(64) }));
  await assert.rejects(restored.recoverStopped(true), /unavailable|blocked/i);
  await writeFile(journalPath, JSON.stringify({ ...honest, revision: { ...honest.revision, snapshotId: 'e'.repeat(64) } }));
  await assert.rejects(restored.recoverStopped(true), /unavailable|blocked/i);
  await writeFile(journalPath, JSON.stringify(honest));
  await restored.recoverStopped(true);
  const recovered = await restored.getState();
  assert.equal(recovered.server.ownership.state, 'owned');
  assert.equal(await readFile(path.join(recovered.server.serverDir, 'world.bin'), 'utf8'), 'pre-conflict');
  const final = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(final.phase, 'cancelled'); assert.equal(final.stopped, false);
  assert.deepEqual(final.revision, admission.revision);
  assert.notEqual(final.recoverySnapshot, retained); // the retry retained its own fresh snapshot
  assert.equal(recovered.server.snapshotId, final.recoverySnapshot);
  assert.ok((await restored.listSnapshots()).some(row => row.id === retained && !row.current), 'the first retained snapshot stays in history');
  assert.deepEqual(await relay.custody(), exact);
  const settled = await restored.groupRecoveryStatus();
  assert.equal(settled.remote.observation.state, 'cancelled');
  assert.equal(settled.remote.observation.snapshotId, admission.revision.snapshotId);
  assert.equal(settled.remote.observation.reservation, admission.revision.reservation);
});

// readState(db) can be absent while the durable acceptance details remain (partial/legacy relay database).
// That must fail closed as the typed null so the relay refuses the replay instead of crashing on undefined custody.
test('replay of a durable acceptance with no ownership row is refused instead of crashing on undefined custody', async t => {
  const f = await acceptedPark(t);
  const ledgerFile = path.join(f.relay.root, 'ownership.sqlite');
  const db = new DatabaseSync(ledgerFile);
  db.exec('DELETE FROM ownership WHERE id = 1'); db.close();
  assert.equal(await new OwnershipLedger(ledgerFile, f.member.identity.fingerprint).acceptedOfferDetails(f.offer.id), null,
    'a details row without an ownership row must fail closed with the typed null');
  const result = await f.send(f.member.identity, f.offer);
  assert.equal(result.ownershipAccepted, false, 'the replay must take the refuse path, not throw');
  const check = new DatabaseSync(ledgerFile);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM ownership').get().n, 0, 'refusal must not invent ownership');
  check.close();
});
