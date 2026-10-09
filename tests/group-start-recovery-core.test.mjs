import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

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

async function revokeInOtherProcess(relay, fingerprint) {
  const script = `import { RelayNode } from './dist/src/core/relay.js';
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
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { SeedHostApplication } from '../dist/src/core/application.js';
import { RelayNode } from '../dist/src/core/relay.js';
import { relayHostState, relayStatus } from '../dist/src/core/relay-client.js';
import { randomUUID } from 'node:crypto';

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


test('occupied configured Minecraft bind prevents admission without changing custody or spawning', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const dir = (await owner.getState()).server.serverDir;
  await writeFile(path.join(dir, 'server.properties'), `server-ip=127.0.0.1\nserver-port=${listener.address().port}\n`);
  await owner.parkAtRelay(); await member.claimPendingGroup(pin); await relay.settled();
  await member.saveProfile({ executable: process.execPath, args: [path.resolve('tools/fake-java-server.mjs'), '--lifetime-ms=30000'] });
  const before = await relay.custody();
  await assert.rejects(member.startServer(true), /Minecraft.*port.*unavailable/i);
  assert.deepEqual(await relay.custody(), before);
  assert.equal((await member.getState()).server.ownership.state, 'owned');
  assert.equal((await relayStatus(member.identity, {...relay.endpoint, fingerprint: pin})).pendingStart, false);
});

test('explicit recovery after application and relay restart retains child writes and original admission', async t => {
  const { root, owner, member, relay, pin } = await fixture(t);
  await writeFile(path.join((await owner.getState()).server.serverDir, 'server.properties'), 'server-port=0\n');
  await owner.parkAtRelay(); await member.claimPendingGroup(pin); await relay.settled();
  member.options.resolveGroupLaunchProfile = async () => ({ executable: process.execPath, args: ['-e', `require('node:fs').writeFileSync('world.bin', 'child-final'); process.exit(0)`] });
  await assert.rejects(member.startGroup(pin, true));
  const before = await member.getState(); assert.equal(before.server.ownership.state, 'uncertain');
  const endpoint = relay.endpoint;
  await member.close(); await relay.close();
  const restoredRelay = new RelayNode(relay.root, relay.identity, { log() {} }); await restoredRelay.open(); await restoredRelay.listen(endpoint);
  const restored = new SeedHostApplication(member.root, member.identity); await restored.open();
  t.after(async () => { await restored.close(); await restoredRelay.close(); });
  await restored.recoverStopped(true);
  const recovered = await restored.getState();
  assert.equal(recovered.server.ownership.state, 'owned');
  assert.notEqual(recovered.server.snapshotId, before.server.snapshotId);
  assert.equal(await readFile(path.join(recovered.server.serverDir, 'world.bin'), 'utf8'), 'child-final');
  assert.equal((await relayStatus(restored.identity, {...restoredRelay.endpoint, fingerprint: pin})).pendingStart, false);
  assert.equal(recovered.server.state, 'offline', 'recovery never executes');
});


test('lost Start acknowledgment journal permits only explicit confirmed recovery after restart', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await writeFile(path.join((await owner.getState()).server.serverDir, 'server.properties'), 'server-port=0\n');
  await owner.parkAtRelay(); await member.claimPendingGroup(pin); await relay.settled();
  const pause = pauseHostAcknowledgment(relay); t.after(() => pause.release());
  const start = member.startGroup(pin, true); start.catch(() => {});
  const socket = await pause.admitted; socket.destroy(); pause.release();
  await assert.rejects(start);
  await member.close();
  const restored = new SeedHostApplication(member.root, member.identity); await restored.open(); t.after(() => restored.close());
  await assert.rejects(restored.recoverStopped(false), /Confirm/);
  const recovery = await restored.groupRecoveryStatus();
  assert.equal(recovery.admission.acknowledged, false);
  assert.equal(recovery.remote.observation.reservation, recovery.admission.revision.reservation);
  assert.equal(recovery.remote.observation.state, 'starting');
  await restored.recoverStopped(true);
  assert.equal((await restored.getState()).server.ownership.state, 'owned');
  assert.equal((await relayStatus(restored.identity, {...relay.endpoint, fingerprint: pin})).pendingStart, false);
});


test('Park checks authoritative pending admission before snapshot or offer creation', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await writeFile(path.join((await owner.getState()).server.serverDir, 'server.properties'), 'server-port=0\n');
  await owner.parkAtRelay(); await member.claimPendingGroup(pin); await relay.settled();
  member.options.resolveGroupLaunchProfile = async () => ({ executable: process.execPath, args: ['-e', 'process.exit(0)'] });
  await assert.rejects(member.startGroup(pin, true));
  await member.ledger().recoverStopped(true); // reproduce old local-only recovery; relay admission remains fenced
  const before = (await member.getState()).server;
  await writeFile(path.join(before.serverDir, 'world.bin'), 'unsnapshotted');
  await assert.rejects(member.parkAtRelay(), /pending.*start|start.*pending/i);
  assert.deepEqual((await member.getState()).server.ownership, before.ownership);
  assert.equal((await member.getState()).server.snapshotId, before.snapshotId);
});


test('durable exact withdrawal rejects stranded offer replay after relay restart', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await owner.parkAtRelay(); await member.claimPendingGroup(pin); await relay.settled();
  const state = await member.getState(); const ledger = member.ledger();
  const offer = await ledger.prepareTransfer(pin, state.server.snapshotId);
  const { relayWithdrawOffer } = await import('../dist/src/core/relay-client.js');
  const remote = {...relay.endpoint, fingerprint: pin};
  const receipt = await relayWithdrawOffer(member.identity, remote, offer);
  assert.equal(receipt.disposition, 'withdrawn');
  assert.deepEqual(receipt.offer, offer);
  const endpoint = relay.endpoint; await relay.close();
  const second = new RelayNode(relay.root, relay.identity, {log() {}}); await second.open(); await second.listen(endpoint);
  t.after(() => second.close());
  const { sendSnapshotToPeer } = await import('../dist/src/core/transfers.js');
  const { relayRequest } = await import('../dist/src/core/relay-client.js');
  const result = await sendSnapshotToPeer(member.identity, {...second.endpoint, fingerprint: pin}, state.server.storeDir, offer.snapshotId, offer, {preface: relayRequest('park')});
  assert.equal(result.ownershipAccepted, false);
  assert.equal((await second.custody()).owner, member.identity.fingerprint);
  assert.equal((await second.custody()).generation, offer.generation - 1);
});


test('confirmed stopped recovery durably withdraws exact stranded offer before local restore', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await writeFile(path.join((await owner.getState()).server.serverDir, 'server.properties'), 'server-port=0\n');
  await owner.parkAtRelay(); await member.claimPendingGroup(pin); await relay.settled();
  member.options.resolveGroupLaunchProfile = async () => ({ executable: process.execPath, args: ['-e', `require('node:fs').writeFileSync('world.bin', 'final-write'); process.exit(0)`] });
  await assert.rejects(member.startGroup(pin, true));
  const ledger = member.ledger(); await ledger.recoverStopped(true);
  const state = await member.getState(); const offer = await ledger.prepareTransfer(pin, state.server.snapshotId); await ledger.markUncertain();
  await member.recoverStopped(true);
  const recovered = await member.getState(); assert.equal(recovered.server.ownership.state, 'owned');
  assert.equal(recovered.server.ownership.offer, undefined);
  assert.equal(await readFile(path.join(recovered.server.serverDir, 'world.bin'), 'utf8'), 'final-write');
  assert.equal(await relay.ledger().hasWithdrawn(offer.id), true);
  assert.equal((await relayStatus(member.identity, {...relay.endpoint, fingerprint: pin})).pendingStart, false);
});


test('Stop publication lost accepted ack retries after both restarts without restoring or duplicating custody', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await writeFile(path.join((await owner.getState()).server.serverDir, 'server.properties'), 'server-port=0\n');
  await owner.parkAtRelay(); await member.startGroup(pin, true); await relay.settled();
  const before = await member.getState(); await writeFile(path.join(before.server.serverDir, 'world.bin'), 'stop-final');
  const handle = relay.handle.bind(relay); let armed = true;
  relay.handle = (socket, source) => {
    const write = socket.write.bind(socket);
    socket.write = (packet, ...args) => {
      if (armed && Buffer.isBuffer(packet) && packet.subarray(4).toString().includes('"type":"ack"') && packet.subarray(4).toString().includes('"ownershipAccepted":true')) {
        armed = false; const result = write(packet.subarray(0, 8), ...args); setImmediate(() => socket.destroy()); return result;
      }
      return write(packet, ...args);
    };
    return handle(socket, source);
  };
  await assert.rejects(member.stopServer(), /Handoff did not complete/);
  const stopped = await member.getState(); assert.equal(stopped.server.ownership.state, 'offered');
  const accepted = await relay.custody(); assert.equal(accepted.state, 'owned');
  const endpoint = relay.endpoint; await member.close(); await relay.close();
  const second = new RelayNode(relay.root, relay.identity, { log() {} }); await second.open(); await second.listen(endpoint);
  const restored = new SeedHostApplication(member.root, member.identity); await restored.open();
  t.after(async () => { await restored.close(); await second.close(); });
  await restored.stopServer();
  assert.equal((await restored.getState()).server.ownership.state, 'transferred');
  assert.deepEqual(await second.custody(), accepted);
  assert.equal(await readFile(path.join(stopped.server.serverDir, 'world.bin'), 'utf8'), 'stop-final');
});


test('accepted receipt cannot authenticate a different snapshot under the same offer id', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await owner.parkAtRelay(); await member.claimPendingGroup(pin); await relay.settled();
  const state = await member.getState(); const offer = await member.ledger().prepareTransfer(pin, state.server.snapshotId);
  const { sendSnapshotToPeer } = await import('../dist/src/core/transfers.js');
  const { relayRequest, relayWithdrawOffer } = await import('../dist/src/core/relay-client.js');
  await sendSnapshotToPeer(member.identity, {...relay.endpoint, fingerprint: pin}, state.server.storeDir, offer.snapshotId, offer, {preface: relayRequest('park')});
  await assert.rejects(relayWithdrawOffer(member.identity, {...relay.endpoint, fingerprint: pin}, {...offer, snapshotId:'0'.repeat(64)}), /exact|mismatch/i);
});


// Both contenders use real pinned TLS; withdrawal is served by a distinct OS process
// sharing the durable relay root, so an instance-local queue cannot satisfy this test.
async function withdrawalProcess(relay) {
  const script = `
    import { RelayNode } from './dist/src/core/relay.js';
    const [root, identity] = JSON.parse(process.argv[1]);
    const node = new RelayNode(root, identity, { log() {} }); await node.open();
    const ledger = node.ledger(); node.ledger = () => ledger;
    const withdraw = ledger.withdrawIncoming.bind(ledger);
    let release; const gate = new Promise(resolve => { release = resolve; });
    ledger.withdrawIncoming = async (...args) => {
      process.send({ type: 'locked' }); await gate; return withdraw(...args);
    };
    const handle = node.handle.bind(node);
    node.handle = (socket, source) => { process.send({ type: 'request' }); return handle(socket, source); };
    process.on('message', async message => {
      if (message === 'release') release();
      if (message === 'close') { release(); await node.close(); process.disconnect(); }
    });
    await node.listen(); process.send({ type: 'ready', endpoint: node.endpoint });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify([relay.root, relay.identity])],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.resume();
  const seen = new Map(), waiters = new Map();
  child.on('message', message => { seen.set(message.type, message); waiters.get(message.type)?.(message); });
  const exit = new Promise(resolve => child.once('exit', resolve));
  function wait(type) {
    if (seen.has(type)) return Promise.resolve(seen.get(type));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Withdrawal child never reached ${type}: ${stderr}`)), 10000);
      waiters.set(type, value => { clearTimeout(timer); resolve(value); });
      exit.then(code => { clearTimeout(timer); reject(new Error(`Withdrawal child exited ${code}: ${stderr}`)); });
    });
  }
  async function close() {
    if (child.connected) child.send('close');
    let timer;
    try { await Promise.race([exit, new Promise(resolve => { timer = setTimeout(() => { child.kill(); resolve(); }, 3000); })]); }
    finally { clearTimeout(timer); if (child.exitCode === null) { child.kill(); await exit; } }
  }
  try { return { child, wait, seen, close, endpoint: (await wait('ready')).endpoint }; }
  catch (error) { await close(); throw error; }
}

test('cross-process acceptance versus withdrawal serializes both orders without restoring accepted authority', { timeout: 40000 }, async t => {
  for (const winner of ['withdrawal', 'acceptance']) await t.test(winner, async t => {
    const { owner, member, relay, pin } = await fixture(t);
    await owner.parkAtRelay(); await member.claimPendingGroup(pin); await relay.settled();
    const state = await member.getState();
    const local = member.ledger(); const offer = await local.prepareTransfer(pin, state.server.snapshotId);
    const before = await relay.custody();
    const worker = await withdrawalProcess(relay);
    const { relayRequest, relayWithdrawOffer } = await import('../dist/src/core/relay-client.js');
    const { sendSnapshotToPeer } = await import('../dist/src/core/transfers.js');
    const ledger = relay.ledger(); relay.ledger = () => ledger;
    let release, reached, inspected;
    const gate = new Promise(resolve => { release = resolve; });
    const locked = new Promise(resolve => { reached = resolve; });
    const streamed = new Promise(resolve => { inspected = resolve; });
    const accept = ledger.acceptTransfer.bind(ledger);
    ledger.acceptTransfer = async (...args) => { reached(); await gate; return accept(...args); };
    // The replay/acceptance decision now runs UNDER the relay cross-process lock, so the old pre-lock
    // `hasAccepted` probe can no longer fire while the withdrawal child holds that lock. Coordinate on park
    // dispatch (post-membership, before streaming) instead: serialization itself is guaranteed by the lock
    // and asserted below by the custody/park-completion checks plus the outcome assertions.
    const receivePark = relay.receivePark.bind(relay);
    relay.receivePark = (...args) => { inspected(); return receivePark(...args); };
    let park, withdrawal;
    const startPark = () => {
      park = sendSnapshotToPeer(member.identity, {...relay.endpoint, fingerprint: pin}, state.server.storeDir,
        offer.snapshotId, offer, {preface: relayRequest('park')}); park.catch(() => {}); return park;
    };
    const startWithdrawal = () => {
      withdrawal = relayWithdrawOffer(member.identity, {...worker.endpoint, fingerprint: pin}, offer);
      withdrawal.catch(() => {}); return withdrawal;
    };
    try {
      if (winner === 'acceptance') {
        startPark(); await locked; startWithdrawal(); await worker.wait('request');
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(worker.seen.has('locked'), false, 'other process must wait for the acceptance lock');
        release(); await worker.wait('locked'); worker.child.send('release');
      } else {
        startWithdrawal(); await worker.wait('locked');
        let settled = false; const observe = () => { settled = true; };
        startPark().then(observe, observe); await streamed;
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(settled, false, 'park cannot complete while the other process withdrawal lock is held');
        assert.deepEqual(await relay.custody(), before, 'acceptance cannot commit under the other process withdrawal lock');
        worker.child.send('release'); release();
      }
      const [result, receipt] = await Promise.all([park, withdrawal]);
      assert.equal(receipt.disposition, winner === 'acceptance' ? 'accepted' : 'withdrawn');
      assert.equal(result.ownershipAccepted, winner === 'acceptance');
      await local.reconcileRecoveryOffer(offer, pin, receipt.disposition);
      assert.equal((await local.status()).state, winner === 'acceptance' ? 'transferred' : 'uncertain');
      if (winner === 'withdrawal') {
        await assert.rejects(local.recoverStopped(false), /Confirm/);
        await local.recoverStopped(true);
        const restored = await local.status();
        assert.equal(restored.state, 'owned');
        assert.equal(restored.offer, undefined);
        assert.equal(restored.generation, offer.generation - 1);
        assert.equal(restored.snapshotId, offer.snapshotId);
      } else await assert.rejects(local.recoverStopped(true), /cannot be recovered/i);
      const durable = new RelayNode(relay.root, relay.identity, {log() {}}); await durable.open();
      try {
        assert.equal(await durable.ledger().hasWithdrawn(offer.id), winner === 'withdrawal');
        assert.equal(await durable.ledger().hasAccepted(offer.id), winner === 'acceptance');
        const replay = await sendSnapshotToPeer(member.identity, {...relay.endpoint, fingerprint: pin}, state.server.storeDir,
          offer.snapshotId, offer, {preface: relayRequest('park')});
        assert.equal(replay.ownershipAccepted, winner === 'acceptance', 'durable decline rejects replay; acceptance remains idempotent');
        if (winner === 'withdrawal') assert.deepEqual(await durable.custody(), before);
        else { assert.equal((await durable.custody()).owner, pin); assert.equal((await local.status()).state, 'transferred'); }
      } finally { await durable.close(); }
    } finally {
      release(); if (worker.child.connected) worker.child.send('release');
      await Promise.allSettled([park, withdrawal].filter(Boolean));
      await worker.close();
    }
  });
});

test('bind preflight preserves escaped Java bind scope rather than probing wildcard', async t => {
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'bind-scope-')); t.after(() => rm(root, {recursive:true,force:true}));
  const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  await writeFile(path.join(root, 'server.properties'), `server\\u002dip=127.0.0.2\nserver-port=${listener.address().port}\n`);
  const { preflightMinecraftPort } = await import('../dist/src/core/port-preflight.js');
  await preflightMinecraftPort(root);
});


test('blank Minecraft bind detects an occupied IPv4 listener', async t => {
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'bind-wildcard-')); t.after(() => rm(root, {recursive:true,force:true}));
  const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  await writeFile(path.join(root, 'server.properties'), `server-ip=\nserver-port=${listener.address().port}\n`);
  const { preflightMinecraftPort } = await import('../dist/src/core/port-preflight.js');
  await assert.rejects(preflightMinecraftPort(root), /Minecraft.*port.*unavailable/i);
});


test('Stop journals verified final snapshot before publishing local stopped authority', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  await writeFile(path.join((await owner.getState()).server.serverDir, 'server.properties'), 'server-port=0\n');
  await owner.parkAtRelay(); await member.startGroup(pin, true);
  const { readAdmission } = await import('../dist/src/core/recovery-journal.js');
  const ledger = member.ledger(); const original = ledger.stopHosting.bind(ledger);
  member.ledger = () => ledger;
  let observed, stoppedRevision;
  ledger.stopHosting = async snapshotId => { stoppedRevision = snapshotId; observed = await readAdmission(member.root, (await member.getState()).server.id); return original(snapshotId); };
  await member.stopServer();
  assert.equal(observed.phase, 'snapshot-retained');
  assert.equal(observed.stopped, true);
  assert.equal(observed.recoverySnapshot, stoppedRevision, 'Park may append a later revision, but Stop must journal its exact verified save');
});

test('port occupied after acknowledged admission cancels exact no-child start', async t => {
  const { owner, member, relay, pin } = await fixture(t);
  const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  t.after(() => listener.listening ? new Promise(resolve => listener.close(resolve)) : undefined);
  await writeFile(path.join((await owner.getState()).server.serverDir, 'server.properties'), `server-ip=127.0.0.1\nserver-port=${port}\n`);
  await owner.parkAtRelay(); await member.claimPendingGroup(pin); await relay.settled();
  await member.saveProfile({ executable: process.execPath, args: [path.resolve('tools/fake-java-server.mjs'), '--lifetime-ms=30000'] });
  const pause = pauseHostAcknowledgment(relay); t.after(() => pause.release());
  const starting = member.startServer(true); starting.catch(() => {});
  await pause.admitted;
  await new Promise(resolve => listener.listen(port, '127.0.0.1', resolve)); pause.release();
  await assert.rejects(starting, /Minecraft.*port.*unavailable/i);
  assert.equal((await member.getState()).server.ownership.state, 'owned');
  assert.equal((await relayStatus(member.identity, {...relay.endpoint, fingerprint: pin})).pendingStart, false);
});

