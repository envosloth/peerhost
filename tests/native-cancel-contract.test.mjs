// Strict contract: the compiled main process must resolve native dialog cancellation as null.
// The renderer treats null as "user cancelled" (runAction: `result === null` -> quiet false);
// a bare `return;` (undefined) falls through to confirmation guards and shows false failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function handlerBody(start, end) {
  const main = await readFile(new URL('../dist/apps/desktop/main.js', import.meta.url), 'utf8');
  const body = main.match(new RegExp(`case '${start}':([\\s\\S]*?)case '${end}':`))?.[1];
  assert.ok(body, `compiled ${start} handler must be present`);
  return body;
}

test('cancelled create dialog resolves null and never reaches the backend', async () => {
  const invoke = new AsyncFunction('p', 'confirm', 'backend', await handlerBody('createServer', 'configureSimpleProfile'));
  let calls = 0;
  const backend = { createServer: async input => { calls += 1; return { id: 'created', input }; } };
  const input = { name: 'Fixture world', loader: 'vanilla', eulaAccepted: true };
  assert.equal(await invoke(input, async () => false, backend), null, 'Cancel must resolve null, not undefined');
  assert.equal(calls, 0, 'cancelled create must not call the backend');
  const created = await invoke(input, async () => true, backend);
  assert.equal(calls, 1);
  assert.deepEqual(created, { id: 'created', input });
  await assert.rejects(invoke({ ...input, eulaAccepted: false }, async () => true, backend), /EULA/);
});

test('cancelled profile confirmation resolves null and never reaches the backend', async () => {
  const invoke = new AsyncFunction('p', 'confirm', 'backend', await handlerBody('configureSimpleProfile', 'saveGameGateway'));
  let calls = 0;
  const backend = { configureSimpleProfile: async input => { calls += 1; return { ok: true, input }; } };
  const p = { javaExecutable: 'C:/fixture/java.exe', memoryMiB: 2048 };
  assert.equal(await invoke(p, async () => false, backend), null, 'Cancel must resolve null, not undefined');
  assert.equal(calls, 0, 'cancelled profile save must not call the backend');
  assert.deepEqual(await invoke(p, async () => true, backend), { ok: true, input: p });
  assert.equal(calls, 1);
});

test('cancelled import resolves null at both the picker and the stopped-source confirmation', async () => {
  const invoke = new AsyncFunction('p', 'confirm', 'backend', 'dialog', 'window', await handlerBody('importServer', 'saveProfile'));
  let calls = 0;
  const backend = { importExisting: async (dir, acknowledged) => { calls += 1; return { id: 'imported', dir, acknowledged }; } };
  const canceledPicker = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
  const okPicker = { showOpenDialog: async () => ({ canceled: false, filePaths: ['C:/fixture-source'] }) };
  assert.equal(await invoke({}, async () => true, backend, canceledPicker, {}), null, 'cancelled folder picker must resolve null');
  assert.equal(calls, 0);
  assert.equal(await invoke({}, async () => false, backend, okPicker, {}), null, 'declined stopped-source confirmation must resolve null');
  assert.equal(calls, 0);
  assert.deepEqual(await invoke({}, async () => true, backend, okPicker, {}), { id: 'imported', dir: 'C:/fixture-source', acknowledged: true });
  assert.equal(calls, 1);
});
