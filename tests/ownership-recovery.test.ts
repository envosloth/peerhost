import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { OwnershipLedger } from '../src/core/ownership.js';

const source = 'a'.repeat(64), target = 'b'.repeat(64), other = 'c'.repeat(64), snapshot = 'd'.repeat(64);
async function ledgers(t: import('node:test').TestContext) {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(path.resolve('.test-data/ownership-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = new OwnershipLedger(path.join(root, 'a.sqlite'), source);
  await a.initialize(snapshot);
  return { root, a, b: new OwnershipLedger(path.join(root, 'b.sqlite'), target) };
}

test('an accepted transfer records its offer id so a retry can be re-acknowledged', async (t) => {
  const { a, b } = await ledgers(t);
  const offer = await a.prepareTransfer(target, snapshot);
  await b.acceptTransfer(offer, source, snapshot);
  const state = await b.status();
  assert.equal(state.state, 'owned');
  assert.equal(state.acceptedOfferId, offer.id);
  await assert.rejects(b.acceptTransfer(offer, source, snapshot), /stale|conflict/i, 'a second commit is never applied');
});

test('cancelTransfer restores the source only for the exact pending offer and target', async (t) => {
  const { a } = await ledgers(t);
  const offer = await a.prepareTransfer(target, snapshot);
  await assert.rejects(a.cancelTransfer('wrong-offer', target), /mismatch/i);
  await assert.rejects(a.cancelTransfer(offer.id, other), /mismatch/i);
  assert.equal((await a.status()).state, 'offered');
  await a.cancelTransfer(offer.id, target);
  const state = await a.status();
  assert.equal(state.state, 'owned');
  assert.equal(state.offer, undefined);
  assert.equal(state.generation, 0, 'a declined offer does not consume a generation');
  await assert.rejects(a.cancelTransfer(offer.id, target), /mismatch/i, 'cancel is not repeatable');
  assert.equal((await a.prepareTransfer(target, snapshot)).generation, 1);
});

test('a confirmed transfer can never be cancelled', async (t) => {
  const { a } = await ledgers(t);
  const offer = await a.prepareTransfer(target, snapshot);
  await a.confirmTransfer(offer.id, target);
  await assert.rejects(a.cancelTransfer(offer.id, target), /mismatch/i);
  assert.equal((await a.status()).state, 'transferred');
});

test('a device that gave the server away accepts a newer generation from any trusted source, never a replay', async (t) => {
  const { a, b } = await ledgers(t);
  const toB = await a.prepareTransfer(target, snapshot);
  await b.acceptTransfer(toB, source, snapshot);
  await a.confirmTransfer(toB.id, target);
  // B moves the server on (say via a relay) while A is off; A comes back holding generation 1.
  await assert.rejects(a.acceptTransfer({ ...toB, id: 'replay', source: target, target: source, generation: 1 }, target, snapshot), /stale|conflict/i);
  const lineage = toB.lineage;
  await a.acceptTransfer({ id: 'from-relay', lineage, source: other, target: source, generation: 4, snapshotId: snapshot }, other, snapshot);
  assert.deepEqual(await a.status(), { version: 1, lineage, owner: source, generation: 4, snapshotId: snapshot, state: 'owned', acceptedOfferId: 'from-relay' });
});

test('a pending offer is implicitly confirmed when its target hands back a newer generation', async (t) => {
  const { a, b } = await ledgers(t);
  const toB = await a.prepareTransfer(target, snapshot);
  await b.acceptTransfer(toB, source, snapshot); // A never hears the acknowledgment.
  const back = await b.prepareTransfer(source, snapshot);
  await assert.rejects(a.acceptTransfer({ ...back, source: other }, other, snapshot), /stale|conflict/i, 'only the pending target can prove acceptance');
  await assert.rejects(a.acceptTransfer({ ...back, generation: 1 }, target, snapshot), /stale|conflict/i);
  await a.acceptTransfer(back, target, snapshot);
  assert.equal((await a.status()).state, 'owned');
  assert.equal((await a.status()).generation, 2);
});

test('a different server never passes as a newer version of this one, however high its generation', async (t) => {
  const { root, a, b } = await ledgers(t);
  const toB = await a.prepareTransfer(target, snapshot);
  await b.acceptTransfer(toB, source, snapshot);
  await a.confirmTransfer(toB.id, target);
  const unrelated = new OwnershipLedger(path.join(root, 'c.sqlite'), other);
  await unrelated.initialize(snapshot);
  const foreignLineage = (await unrelated.status()).lineage!;
  assert.notEqual(foreignLineage, toB.lineage, 'every import starts its own lineage');
  await assert.rejects(a.acceptTransfer({ id: 'foreign', lineage: foreignLineage, source: other, target: source, generation: 99, snapshotId: snapshot }, other, snapshot), /stale|conflict/i);
  assert.equal((await a.status()).state, 'transferred');
});

test('a ledger written before lineages existed gets one on its next handoff and keeps strict checks meanwhile', async (t) => {
  const { root } = await ledgers(t);
  const legacy = new OwnershipLedger(path.join(root, 'legacy.sqlite'), source);
  await legacy.initialize(snapshot);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(root, 'legacy.sqlite'));
  db.prepare('UPDATE ownership SET data = ? WHERE id = 1').run(JSON.stringify({ version: 1, owner: source, generation: 0, snapshotId: snapshot, state: 'owned' }));
  db.close();
  const offer = await legacy.prepareTransfer(target, snapshot);
  assert.match(offer.lineage, /^[0-9a-f-]{36}$/);
  assert.equal((await legacy.status()).lineage, offer.lineage);
});

test('a device that owns, hosts or is uncertain never accepts an offer', async (t) => {
  const { a } = await ledgers(t);
  const offer = { id: 'x', lineage: (await a.status()).lineage!, source: other, target: source, generation: 9, snapshotId: snapshot };
  await assert.rejects(a.acceptTransfer(offer, other, snapshot), /stale|conflict/i);
  await a.startHosting();
  await assert.rejects(a.acceptTransfer(offer, other, snapshot), /stale|conflict/i);
  await a.markUncertain();
  await assert.rejects(a.acceptTransfer(offer, other, snapshot), /stale|conflict/i);
});
