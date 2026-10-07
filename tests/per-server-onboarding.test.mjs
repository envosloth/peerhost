import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { SeedHostApplication } from '../dist/src/core/application.js';
import { createIdentity } from '../dist/src/core/peer-transport.js';

const progress = (name, changes = {}) => ({
  step: 'friends', dismissed: false, completed: false, skipped: ['gateway'],
  draft: { name, loader: 'fabric', gameVersion: '1.21.1', memoryMiB: 4096 }, ...changes,
});
const readback = input => ({ version: 1, ...input, error: null });
async function fixture(t) {
  assert.ok(process.env.TMPDIR, 'Hermes scratch TMPDIR is required');
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'per-server-onboarding-'));
  const profile = path.join(root, 'profile');
  const identity = await createIdentity();
  const apps = [];
  const open = async () => { const app = new SeedHostApplication(profile, identity); apps.push(app); await app.open(); return app; };
  t.after(async () => { for (const app of apps) await app.close(); await rm(root, { recursive: true, force: true }); });
  const source = async name => {
    const dir = path.join(root, name); await mkdir(dir);
    await writeFile(path.join(dir, 'eula.txt'), 'eula=true\n');
    await writeFile(path.join(dir, 'world.bin'), name);
    return dir;
  };
  return { root, profile, open, source, app: await open() };
}

test('two imported worlds retain independent guide steps, drafts, skips and completion across A-B-A and reopen', async t => {
  const { app, profile, open, source } = await fixture(t);
  const alphaSource = await source('alpha'); const bravoSource = await source('bravo');
  await app.importExisting(alphaSource, true);
  const alpha = (await app.getState()).server;
  await app.saveProfile({ executable: process.execPath, args: [path.resolve('tools/fake-java-server.mjs')] });
  const alphaProgress = progress('Alpha draft', { step: 'ready', dismissed: true, completed: true, skipped: ['friends', 'gateway'] });
  const stateBeforeSave = await readFile(path.join(profile, 'state.json'), 'utf8');
  const ledgerBeforeSave = await readFile(alpha.ledgerFile, 'utf8');
  await app.saveOnboarding(alphaProgress);
  assert.equal(await readFile(path.join(profile, 'state.json'), 'utf8'), stateBeforeSave);
  assert.equal(await readFile(alpha.ledgerFile, 'utf8'), ledgerBeforeSave);
  await app.importExisting(bravoSource, true);
  const bravo = (await app.getState()).server;
  assert.equal((await app.getState()).onboarding.completed, false, 'a new world must not inherit another world\'s completion');
  await assert.rejects(app.saveOnboarding(alphaProgress, undefined, bravo.id), /configure.*server/i);
  const bravoProgress = progress('Bravo draft', { step: 'gateway', skipped: ['friends'] });
  await app.saveOnboarding(bravoProgress);
  await app.selectServer(alpha.id);
  assert.deepEqual((await app.getState()).onboarding, readback(alphaProgress));
  await app.selectServer(bravo.id);
  assert.deepEqual((await app.getState()).onboarding, readback(bravoProgress));
  await app.selectServer(alpha.id);
  assert.deepEqual((await app.getState()).onboarding, readback(alphaProgress));
  await app.close(); const reopened = await open();
  assert.deepEqual((await reopened.getState()).onboarding, readback(alphaProgress));
  await reopened.selectServer(bravo.id);
  assert.deepEqual((await reopened.getState()).onboarding, readback(bravoProgress));
  for (const [server, original, name] of [[alpha, alphaSource, 'alpha'], [bravo, bravoSource, 'bravo']]) {
    assert.equal(await readFile(path.join(server.serverDir, 'world.bin'), 'utf8'), name);
    assert.equal(await readFile(path.join(original, 'world.bin'), 'utf8'), name);
  }
});

test('explicit pending-new scope remains resumable while an existing world is selected and cannot borrow its completion', async t => {
  const { app, open, source } = await fixture(t);
  const pending = progress('Pending world', { step: 'runtime', skipped: [] });
  await app.saveOnboarding(pending, undefined, null);
  assert.deepEqual((await app.getState()).onboarding, readback(pending));
  await app.importExisting(await source('existing'), true);
  const existing = (await app.getState()).server;
  await app.saveProfile({ executable: process.execPath, args: [path.resolve('tools/fake-java-server.mjs')] });
  const completed = progress('Existing complete', { step: 'ready', dismissed: true, completed: true, skipped: ['friends', 'gateway'] });
  await app.saveOnboarding(completed);
  await assert.rejects(app.saveOnboarding(completed, { enabled: true, error: null }, null), /configure.*server/i);
  assert.deepEqual((await app.getState()).onboarding, readback(completed));
  assert.deepEqual((await app.getState()).newServerOnboarding, readback(pending));
  const updatedPending = progress('Next world', { step: 'gateway', skipped: ['friends'] });
  await app.saveOnboarding(updatedPending, undefined, null);
  assert.deepEqual((await app.getState()).onboarding, readback(completed));
  assert.deepEqual((await app.getState()).newServerOnboarding, readback(updatedPending));
  await app.close(); const reopened = await open();
  assert.equal((await reopened.getState()).server.id, existing.id);
  assert.deepEqual((await reopened.getState()).onboarding, readback(completed));
  assert.deepEqual((await reopened.getState()).newServerOnboarding, readback(updatedPending));
  // Import selects the new world, but never implicitly transfers or consumes the app's pending draft.
  await reopened.importExisting(await source('new-world'), true);
  const created = (await reopened.getState()).server;
  await reopened.saveOnboarding(updatedPending, undefined, created.id);
  assert.deepEqual((await reopened.getState()).onboarding, readback(updatedPending));
  assert.deepEqual((await reopened.getState()).newServerOnboarding, readback(updatedPending));
  await reopened.selectServer(existing.id);
  assert.deepEqual((await reopened.getState()).onboarding, readback(completed));
});

test('explicit server scope rejects malformed, unknown and nonselected ids without overwriting any guide or world', async t => {
  const { app, source, profile } = await fixture(t);
  await app.importExisting(await source('alpha'), true); const alpha = (await app.getState()).server;
  const alphaProgress = progress('Alpha'); await app.saveOnboarding(alphaProgress, undefined, alpha.id);
  await app.importExisting(await source('bravo'), true); const bravo = (await app.getState()).server;
  const bravoProgress = progress('Bravo'); await app.saveOnboarding(bravoProgress, undefined, bravo.id);
  const pending = progress('Pending'); await app.saveOnboarding(pending, undefined, null);
  const files = [path.join(profile, 'state.json'), alpha.ledgerFile, bravo.ledgerFile,
    path.join(alpha.serverDir, 'world.bin'), path.join(bravo.serverDir, 'world.bin'),
    path.join(profile, `onboarding-server-${alpha.id}.json`), path.join(profile, `onboarding-server-${bravo.id}.json`),
    path.join(profile, 'onboarding-new.json')];
  const before = await Promise.all(files.map(file => readFile(file, 'utf8')));
  for (const id of ['../outside', 'A'.repeat(32), '', 123, {}, 'f'.repeat(32), alpha.id]) {
    await assert.rejects(app.saveOnboarding(progress('Wrong world'), undefined, id), /invalid server id|no longer in the library|selected server changed/i);
  }
  assert.deepEqual(await Promise.all(files.map(file => readFile(file, 'utf8'))), before);
  assert.deepEqual((await app.getState()).onboarding, readback(bravoProgress));
  assert.deepEqual((await app.getState()).newServerOnboarding, readback(pending));
  const updated = progress('Bravo update', { step: 'runtime', skipped: [] });
  await app.saveOnboarding(updated, undefined, bravo.id);
  assert.deepEqual((await app.getState()).onboarding, readback(updated));
  await app.selectServer(alpha.id);
  assert.deepEqual((await app.getState()).onboarding, readback(alphaProgress));
});

test('legacy single-profile progress is preserved for only the initially selected world through switches, reopen and deletion', async t => {
  const { app, source, profile, open } = await fixture(t);
  await app.importExisting(await source('alpha'), true); const alpha = (await app.getState()).server;
  await app.importExisting(await source('bravo'), true); const bravo = (await app.getState()).server;
  await app.saveProfile({ executable: process.execPath, args: [path.resolve('tools/fake-java-server.mjs')] });
  await app.close();
  const legacy = progress('Legacy Bravo', { step: 'ready', completed: true, dismissed: true, skipped: ['friends', 'gateway'] });
  const legacyFile = path.join(profile, 'onboarding.json'); const legacyBytes = JSON.stringify({ version: 1, ...legacy });
  await writeFile(legacyFile, legacyBytes);
  const libraryBytes = await readFile(path.join(profile, 'state.json'), 'utf8');
  const reopened = await open();
  assert.deepEqual((await reopened.getState()).onboarding, readback(legacy));
  assert.equal((await reopened.getState()).newServerOnboarding.completed, false);
  assert.notEqual((await reopened.getState()).newServerOnboarding.draft.name, legacy.draft.name);
  assert.equal(await readFile(path.join(profile, 'state.json'), 'utf8'), libraryBytes);
  await reopened.selectServer(alpha.id);
  assert.equal((await reopened.getState()).onboarding.completed, false);
  assert.notEqual((await reopened.getState()).onboarding.draft.name, legacy.draft.name);
  await reopened.close(); const again = await open();
  assert.equal((await again.getState()).server.id, alpha.id);
  assert.notEqual((await again.getState()).onboarding.draft.name, legacy.draft.name);
  await again.selectServer(bravo.id);
  assert.deepEqual((await again.getState()).onboarding, readback(legacy));
  const update = progress('Bravo edited'); await again.saveOnboarding(update, undefined, bravo.id);
  assert.deepEqual((await again.getState()).onboarding, readback(update));
  assert.equal(await readFile(legacyFile, 'utf8'), legacyBytes, 'legacy source is retained byte-for-byte');
  await again.deleteServer(bravo.id);
  await again.close(); const afterDelete = await open();
  assert.notEqual((await afterDelete.getState()).onboarding.draft.name, legacy.draft.name);
  await afterDelete.importExisting(await source('charlie'), true);
  assert.equal((await afterDelete.getState()).onboarding.completed, false);
  assert.notEqual((await afterDelete.getState()).onboarding.draft.name, legacy.draft.name);
  assert.equal(await readFile(legacyFile, 'utf8'), legacyBytes);
});

test('serverless legacy draft stays pending through import and reopen even if a deleted world left completion behind', async t => {
  const { app, profile, open, source } = await fixture(t);
  await app.close();
  const legacy = progress('Legacy pending', { step: 'ready', completed: true, dismissed: true, skipped: ['friends', 'gateway'] });
  const legacyFile = path.join(profile, 'onboarding.json'); const bytes = JSON.stringify({ version: 1, ...legacy });
  await writeFile(legacyFile, bytes);
  const expected = readback({ ...legacy, completed: false });
  const reopened = await open();
  assert.deepEqual((await reopened.getState()).newServerOnboarding, expected);
  assert.deepEqual((await reopened.getState()).onboarding, expected);
  await reopened.importExisting(await source('first-world'), true);
  assert.notEqual((await reopened.getState()).onboarding.draft.name, legacy.draft.name);
  assert.deepEqual((await reopened.getState()).newServerOnboarding, expected);
  await reopened.close(); const again = await open();
  assert.deepEqual((await again.getState()).newServerOnboarding, expected);
  const update = progress('Pending edited', { step: 'server', skipped: [] });
  await again.saveOnboarding(update, undefined, null);
  assert.deepEqual((await again.getState()).newServerOnboarding, readback(update));
  assert.equal(await readFile(legacyFile, 'utf8'), bytes);
});

test('corrupt scoped progress refuses overwrites but leaves other guides, hosting, console, Stop and quit available', async t => {
  const { app, source, profile, open } = await fixture(t);
  await app.importExisting(await source('alpha'), true); const alpha = (await app.getState()).server;
  await app.saveProfile({ executable: process.execPath, args: [path.resolve('tools/fake-java-server.mjs')] });
  await app.saveOnboarding(progress('Alpha'));
  await app.importExisting(await source('bravo'), true); const bravo = (await app.getState()).server;
  const bravoProgress = progress('Bravo'); await app.saveOnboarding(bravoProgress);
  const pending = progress('Pending'); await app.saveOnboarding(pending, undefined, null);
  const damaged = path.join(profile, `onboarding-server-${alpha.id}.json`);
  const bytes = 'x'.repeat(20000); await writeFile(damaged, bytes);
  assert.deepEqual((await app.getState()).onboarding, readback(bravoProgress));
  assert.deepEqual((await app.getState()).newServerOnboarding, readback(pending));
  await app.selectServer(alpha.id);
  assert.match((await app.getState()).onboarding.error, /unreadable/);
  await assert.rejects(app.saveOnboarding(progress('Replacement'), undefined, alpha.id), /unreadable/);
  assert.equal(await readFile(damaged, 'utf8'), bytes);
  const pendingUpdate = progress('Pending still works'); await app.saveOnboarding(pendingUpdate, undefined, null);
  await app.startServer(true);
  assert.equal((await app.getState()).server.state, 'running');
  assert.match((await app.getState()).onboarding.error, /unreadable/);
  app.sendCommand('list'); await app.stopServer();
  assert.equal((await app.getState()).server.ownership.state, 'owned');
  await app.close(); const reopened = await open();
  assert.match((await reopened.getState()).onboarding.error, /unreadable/);
  assert.deepEqual((await reopened.getState()).newServerOnboarding, readback(pendingUpdate));
  await reopened.selectServer(bravo.id);
  assert.deepEqual((await reopened.getState()).onboarding, readback(bravoProgress));
  assert.equal(await readFile(damaged, 'utf8'), bytes);
});

test('corrupt legacy optional progress is bounded, retained and confined to its one attributed world', async t => {
  const { app, source, profile, open } = await fixture(t);
  await app.importExisting(await source('alpha'), true); const alpha = (await app.getState()).server;
  await app.importExisting(await source('bravo'), true); const bravo = (await app.getState()).server;
  await app.saveProfile({ executable: process.execPath, args: [path.resolve('tools/fake-java-server.mjs')] });
  await app.close();
  const file = path.join(profile, 'onboarding.json'); await writeFile(file, '{');
  const reopened = await open();
  const markerFile = path.join(profile, 'onboarding-legacy-scope.json');
  const markerBytes = await readFile(markerFile, 'utf8');
  assert.deepEqual(JSON.parse(markerBytes), { version: 1, serverId: bravo.id });
  for (const bytes of ['{', 'x'.repeat(20000), JSON.stringify({ version: 2, ...progress('Unsupported') }),
    JSON.stringify({ version: 1, ...progress('Secret'), inviteCode: 'never-retain-this' })]) {
    await writeFile(file, bytes);
    assert.match((await reopened.getState()).onboarding.error, /unreadable/);
    assert.equal((await reopened.getState()).newServerOnboarding.error, null);
    await assert.rejects(reopened.saveOnboarding(progress('Replacement'), undefined, bravo.id), /unreadable/);
    assert.equal(await readFile(file, 'utf8'), bytes);
    await reopened.selectServer(alpha.id);
    assert.equal((await reopened.getState()).onboarding.error, null);
    await reopened.selectServer(bravo.id);
    assert.equal(await readFile(markerFile, 'utf8'), markerBytes);
  }
  await reopened.startServer(true); reopened.sendCommand('list'); await reopened.stopServer();
  await reopened.close(); const again = await open();
  assert.match((await again.getState()).onboarding.error, /unreadable/);
  assert.equal(await readFile(markerFile, 'utf8'), markerBytes);
});

test('invalid legacy attribution is refused without blocking startup or already scoped guides', async t => {
  const { app, source, profile, open } = await fixture(t);
  await app.importExisting(await source('alpha'), true); const alpha = (await app.getState()).server;
  const alphaProgress = progress('Alpha safe'); await app.saveOnboarding(alphaProgress);
  const pending = progress('Pending safe'); await app.saveOnboarding(pending, undefined, null);
  await app.importExisting(await source('bravo'), true); const bravo = (await app.getState()).server;
  await app.close();
  const legacyFile = path.join(profile, 'onboarding.json'); const legacyBytes = JSON.stringify({ version: 1, ...progress('Legacy') });
  await writeFile(legacyFile, legacyBytes);
  const markerFile = path.join(profile, 'onboarding-legacy-scope.json');
  for (const bytes of ['{', 'x'.repeat(257), JSON.stringify({ version: 1, serverId: '../outside' }),
    JSON.stringify({ version: 1, serverId: bravo.id, extra: true })]) {
    await writeFile(markerFile, bytes);
    const reopened = await open();
    assert.equal((await reopened.getState()).server.id, bravo.id);
    assert.match((await reopened.getState()).onboarding.error, /unreadable/);
    await assert.rejects(reopened.saveOnboarding(progress('Replacement'), undefined, bravo.id), /unreadable/);
    assert.deepEqual((await reopened.getState()).newServerOnboarding, readback(pending));
    await reopened.selectServer(alpha.id);
    assert.deepEqual((await reopened.getState()).onboarding, readback(alphaProgress));
    await reopened.saveOnboarding(alphaProgress, undefined, alpha.id);
    await reopened.selectServer(bravo.id); await reopened.close();
    assert.equal(await readFile(markerFile, 'utf8'), bytes);
    assert.equal(await readFile(legacyFile, 'utf8'), legacyBytes);
  }
});

test('pre-library v1 state preserves its guide on repeated reopen without rewriting authoritative state', async t => {
  const { app, source, profile, open } = await fixture(t);
  await app.importExisting(await source('legacy-world'), true); const original = (await app.getState()).server;
  await app.close();
  const stateFile = path.join(profile, 'state.json'); const saved = JSON.parse(await readFile(stateFile, 'utf8'));
  const legacyState = { version: 1, settings: saved.settings, server: saved.servers[0], peers: saved.peers, relay: null };
  delete legacyState.server.id; delete legacyState.server.group;
  const stateBytes = JSON.stringify(legacyState); await writeFile(stateFile, stateBytes);
  const legacy = progress('Pre-library draft'); const legacyBytes = JSON.stringify({ version: 1, ...legacy });
  const legacyFile = path.join(profile, 'onboarding.json'); await writeFile(legacyFile, legacyBytes);
  const ledgerBytes = await readFile(original.ledgerFile, 'utf8');
  const first = await open(); assert.deepEqual((await first.getState()).onboarding, readback(legacy));
  await first.close();
  const second = await open(); assert.deepEqual((await second.getState()).onboarding, readback(legacy));
  const updated = progress('Pre-library edited', { step: 'gateway', skipped: ['friends'] });
  await second.saveOnboarding(updated, undefined, (await second.getState()).server.id);
  assert.equal(await readFile(stateFile, 'utf8'), stateBytes);
  assert.equal(await readFile(original.ledgerFile, 'utf8'), ledgerBytes);
  assert.equal(await readFile(legacyFile, 'utf8'), legacyBytes);
  await second.close(); const third = await open();
  assert.deepEqual((await third.getState()).onboarding, readback(updated));
  const legacyId = (await third.getState()).server.id;
  await third.importExisting(await source('bravo'), true);
  assert.notEqual((await third.getState()).onboarding.draft.name, updated.draft.name);
  await third.selectServer(legacyId);
  assert.deepEqual((await third.getState()).onboarding, readback(updated));
  await third.close(); const fourth = await open();
  assert.deepEqual((await fourth.getState()).onboarding, readback(updated));
});

test('a legacy storage alias cannot redirect the selected world into another library world\'s guide', async t => {
  const { app, source, profile, open } = await fixture(t);
  await app.importExisting(await source('alpha'), true); const alpha = (await app.getState()).server;
  const alphaProgress = progress('Alpha'); await app.saveOnboarding(alphaProgress);
  await app.importExisting(await source('bravo'), true); const bravo = (await app.getState()).server;
  const bravoProgress = progress('Bravo'); await app.saveOnboarding(bravoProgress);
  await app.close();
  await writeFile(path.join(profile, 'onboarding-legacy-scope.json'), JSON.stringify({
    version: 1, serverId: bravo.id, ledgerKey: createHash('sha256').update(alpha.ledgerFile).digest('hex'),
  }));
  const reopened = await open(); await reopened.selectServer(alpha.id);
  assert.deepEqual((await reopened.getState()).onboarding, readback(alphaProgress));
  const updated = progress('Alpha update'); await reopened.saveOnboarding(updated, undefined, alpha.id);
  assert.deepEqual((await reopened.getState()).onboarding, readback(updated));
  await reopened.selectServer(bravo.id);
  assert.deepEqual((await reopened.getState()).onboarding, readback(bravoProgress));
});
