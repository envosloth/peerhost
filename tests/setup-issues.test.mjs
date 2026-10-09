import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { SeedHostApplication } from '../dist/src/core/application.js';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { validateCall } from '../dist/src/core/ipc-policy.js';
import { javaProbeFixture } from './java-probe-fixture.mjs';
import { createServer } from 'node:http';
import { ModrinthClient } from '../dist/src/core/modrinth.js';
import * as onboarding from '../dist/src/core/onboarding.js';

const url = 'file:///trusted/index.html';
const ctx = { senderId: 1, expectedSenderId: 1, isMainFrame: true };
const call = (method, payload) => validateCall(method, payload, url, url, ctx);
async function fixture(t, options = {}) {
  assert.ok(process.env.TMPDIR?.includes('hermes'), 'Tests require Hermes scratch');
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'seedhost-setup-core-'));
  const source = path.join(root, 'source'); await mkdir(source);
  await writeFile(path.join(source, 'server.jar'), 'NOT Minecraft');
  await writeFile(path.join(source, 'eula.txt'), 'eula=true\n');
  const identity = await createIdentity();
  const app = new SeedHostApplication(path.join(root, 'profile'), identity, options); await app.open(); await app.importExisting(source, true);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { root, app, identity, java: await javaProbeFixture(root) };
}

test('custom Java argv passes IPC, saves without shell, survives reopen and reaches the native process unchanged', async t => {
  const { app, root, java, identity } = await fixture(t);
  const input = { javaExecutable: java, memoryMiB: 3072, customJavaArgs: ['-XX:+UseG1GC', '-Dfixture.greeting=two words & literal'] };
  assert.deepEqual(call('configureSimpleProfile', input), input);
  await app.configureSimpleProfile(input);
  const expected = ['-Xms512M', '-Xmx3072M', ...input.customJavaArgs, '-jar', 'server.jar', 'nogui'];
  const saved = (await app.getState()).server;
  assert.equal(saved.state, 'offline'); assert.deepEqual(saved.profile.args, expected);
  await app.close();
  const reopened = new SeedHostApplication(path.join(root, 'profile'), identity); await reopened.open();
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.getState()).server.profile.args, expected);
  await reopened.startServer(true);
  assert.deepEqual((await readFile(path.join(saved.serverDir, 'fixture-argv.txt'), 'utf8')).trimEnd().split(/\r?\n/), expected, 'argv boundaries are preserved, no shell metacharacter expansion');
  await reopened.stopServer();
});

test('custom argv rejects heap/entrypoint/classpath/agent/hooks/control injection and bounds at IPC and core without touching the saved profile', async t => {
  const { app, java } = await fixture(t);
  await app.saveProfile({ executable: java, args: ['-Dimported=kept', '-jar', 'server.jar', 'nogui'], startTimeoutSeconds: 123, stopTimeoutSeconds: 45 });
  const before = (await app.getState()).server.profile;
  const invalid = [['-Xmx8G'], ['-Xms8G'], ['-XX:MaxHeapSize=8000000'], ['-XX:InitialHeapSize=8000000'], ['-jar', 'evil.jar'], ['-cp', 'evil'], ['--class-path=evil'], ['-Djava.class.path=evil'], ['-Djava.system.class.loader=Evil'], ['-m', 'evil/Main'], ['@evil.txt'], ['nogui'], ['java.exe'], ['-javaagent:evil.jar'], ['-XX:OnError=evil'], ['-XX:OnOutOfMemoryError=evil'], ['-Dvalue=control\nline'], ['-Dvalue=control\u007f'], ['-Dvalue=control\u0000'], Array(33).fill('-ea'), ['-Dlong=' + 'x'.repeat(1025)], Array(9).fill('-Dlong=' + 'x'.repeat(1000)), '-XX:+UseG1GC', null];
  for (const customJavaArgs of invalid) {
    const input = { javaExecutable: java, memoryMiB: 2048, customJavaArgs };
    assert.throws(() => call('configureSimpleProfile', input), /Custom Java arguments/i);
    await assert.rejects(app.configureSimpleProfile(input), /Custom Java arguments/i);
    assert.deepEqual((await app.getState()).server.profile, before);
  }
});

test('simple memory changes preserve imported JVM flags, unknown launcher options and program arguments until explicitly saved', async t => {
  const { app, java } = await fixture(t);
  const imported = { executable: java, args: ['-Xmx4G', '-Dimported=kept', '--add-opens=java.base/java.lang=ALL-UNNAMED', '-jar', 'server.jar', '-XmxProgramArgument', 'nogui'], startTimeoutSeconds: 123, stopTimeoutSeconds: 45 };
  await app.saveProfile(imported);
  await app.getState(); assert.deepEqual((await app.getState()).server.profile.args, imported.args, 'reading never rewrites imports');
  await app.configureSimpleProfile({ javaExecutable: java, memoryMiB: 2048 });
  const saved = (await app.getState()).server.profile;
  assert.deepEqual(saved.args, ['-Xms512M', '-Xmx2048M', ...imported.args.slice(1)]);
  assert.equal(saved.startTimeoutSeconds, 123); assert.equal(saved.stopTimeoutSeconds, 45);
  await app.configureSimpleProfile({ javaExecutable: java, memoryMiB: 2048, customJavaArgs: ['-Dreplacement=new'] });
  assert.deepEqual((await app.getState()).server.profile.args, ['-Xms512M', '-Xmx2048M', '-Dreplacement=new', '--add-opens=java.base/java.lang=ALL-UNNAMED', '-jar', 'server.jar', '-XmxProgramArgument', 'nogui']);
});

async function modrinthFixture(t) {
  const requests = [];
  const hits = ['Zulu', 'alpha', 'Beta'].map((title, i) => ({ project_id: 'fixture' + i, slug: 'fixture' + i, title, downloads: 100 - i, author: 'fixture', client_side: 'unsupported', server_side: 'required', icon_url: null }));
  const http = createServer((req, res) => { const url = new URL(req.url, 'http://127.0.0.1'); requests.push(url); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ hits, total_hits: 103 })); });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.closeAllConnections(); return new Promise(resolve => http.close(resolve)); });
  return { client: new ModrinthClient({ apiBase: 'http://127.0.0.1:' + http.address().port + '/v2' }), requests };
}
test('Modrinth selected sorting travels through both application paths and IPC; alphabetical ordering truthfully scopes itself to one page', async t => {
  const { client, requests } = await modrinthFixture(t);
  const target = { loader: 'fabric', gameVersion: '1.21.1' };
  const sorts = { popularity: 'follows', downloads: 'downloads', relevance: 'relevance', follows: 'follows', newest: 'newest', updated: 'updated', 'title-asc': 'downloads', 'title-desc': 'downloads' };
  for (const [sort, index] of Object.entries(sorts)) {
    const page = await client.search('fixture', 20, target, 20, sort);
    assert.equal(requests.at(-1).searchParams.get('index'), index);
    assert.equal(requests.at(-1).searchParams.get('offset'), '20');
    assert.equal(page.total, 103);
    assert.deepEqual(JSON.parse(requests.at(-1).searchParams.get('facets')), [['categories:fabric'], ['versions:1.21.1'], ['project_type:mod']]);
    assert.equal(page.sortScope, sort.startsWith('title-') ? 'page' : 'catalogue');
    assert.equal(page.sort, sort);
    if (sort === 'title-asc') assert.deepEqual(page.hits.map(h => h.title), ['alpha', 'Beta', 'Zulu']);
    if (sort === 'title-desc') assert.deepEqual(page.hits.map(h => h.title), ['Zulu', 'Beta', 'alpha']);
  }
  const { app } = await fixture(t, { modrinth: client }); await app.saveModTarget(target);
  for (const method of ['searchMods', 'searchSetupMods']) {
    const payload = { query: 'fixture', offset: 20, sort: 'updated', ...(method === 'searchSetupMods' ? { gameVersion: '1.21.1' } : {}) };
    assert.deepEqual(call(method, payload), payload);
    const page = await app[method](payload); assert.equal(page.sort, 'updated');
    assert.equal(requests.at(-1).searchParams.get('index'), 'updated');
    assert.throws(() => call(method, { ...payload, sort: 'alphabetical-global' }), /sort/i);
    await assert.rejects(app[method]({ ...payload, sort: 'alphabetical-global' }), /sort/i);
  }
});

test('setup completion requires saved configuration or explicit durable optional skips; arbitrary visit/check fields are not authority', async t => {
  const { app, java, root, identity } = await fixture(t);
  await app.saveProfile({ executable: java, args: ['-Xmx2048M', '-jar', 'server.jar', 'nogui'] });
  const { version, error, ...draft } = (await app.getState()).onboarding;
  const done = { ...draft, step: 'ready', dismissed: true, completed: true };
  await assert.rejects(app.saveOnboarding(done), /friends|optional/i, 'visiting the guide cannot mark unresolved optional steps complete');
  await app.saveOnboarding({ ...done, skipped: ['friends', 'gateway'] });
  await app.close(); const reopened = new SeedHostApplication(path.join(root, 'profile'), identity); await reopened.open(); t.after(() => reopened.close());
  let state = await reopened.getState();
  assert.deepEqual(state.onboarding.skipped, ['friends']);
  assert.deepEqual(onboarding.onboardingChecks(state.onboarding, state), { server: 'complete', runtime: 'complete', friends: 'skipped', ready: 'complete' });
  assert.throws(() => call('saveOnboarding', { ...done, checks: { friends: true } }), /Invalid/);
  await reopened.saveProfile({ executable: java, args: [] }); state = await reopened.getState();
  assert.equal(onboarding.onboardingChecks(state.onboarding, state).runtime, 'pending');
  assert.equal(onboarding.onboardingChecks(state.onboarding, state).ready, 'pending', 'stale completed metadata is not a configured command');
});
