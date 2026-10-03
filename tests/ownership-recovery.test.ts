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
