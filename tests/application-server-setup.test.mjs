import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, chmod, rm, readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { PeerHostApplication } from '../dist/src/core/application.js';
import { ServerSetupClient } from '../dist/src/core/server-setup.js';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { readSnapshot, materializeSnapshot } from '../dist/src/core/snapshots.js';

async function fixture(t, { tamper = false, delay = 0 } = {}) {
  const dir = await mkdtemp(path.join(process.env.TMPDIR, 'ph-app-setup-'));
  const java = path.join(dir, 'java');
  await writeFile(java, `#!${process.execPath}\nprocess.stderr.write('openjdk version "21.0.4"\\n');\n`); await chmod(java, 0o700);
  const jar = Buffer.from('Verified fixture bytes, NOT Minecraft');
  const hash = (bytes, algorithm = 'sha1') => createHash(algorithm).update(bytes).digest('hex');
  let origin;
  const metadata = () => JSON.stringify({ id: '1.21.1', javaVersion: { majorVersion: 21 }, downloads: { server: { url: origin + '/server.jar', size: jar.length, sha1: hash(jar) } } });
  const requests = [];
  const http = createServer((req, res) => {
    requests.push(req.url);
    let body;
    if (req.url === '/mc/game/version_manifest_v2.json') body = JSON.stringify({ latest: { release: '1.21.1' }, versions: [{ id: '1.21.1', type: 'release', url: origin + '/version', sha1: hash(metadata()) }] });
    else if (req.url === '/version') body = metadata();
    else if (req.url === '/server.jar') body = tamper ? 'broken' : jar;
    else if (req.url === '/v2/versions/loader/1.21.1') body = JSON.stringify([{ loader: { version: '0.19.5' }, launcherMeta: { version: 2, min_java_version: 8 } }]);
    else if (req.url.endsWith('/server/json')) body = JSON.stringify({ id: 'fabric-loader-0.19.5-1.21.1', inheritsFrom: '1.21.1', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotServer', libraries: ['net.fabricmc:fabric-loader:0.19.5', 'net.fabricmc:intermediary:1.21.1'].map(name => ({ name, url: origin + '/', sha256: hash(jar, 'sha256'), size: jar.length })) });
    else if (req.url.endsWith('.jar')) body = jar;
    else { res.statusCode = 404; body = 'missing'; }
    setTimeout(() => res.end(body), delay);
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${http.address().port}`;
  const root = path.join(dir, 'app');
  const app = new PeerHostApplication(root, await createIdentity(), { serverSetup: new ServerSetupClient({ testOnly: { origin } }) }); await app.open();
  t.after(async () => { await app.close(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { app, dir, root, requests, jar, input: { name: 'Friends world', loader: 'vanilla', gameVersion: '1.21.1', javaExecutable: java, memoryMiB: 1024, eulaAccepted: true } };
}

test('application creation requires immutable explicit EULA consent before contacting sources', async t => {
  const f = await fixture(t);
  for (const eulaAccepted of [false, 'true', undefined]) await assert.rejects(f.app.createServer({ ...f.input, eulaAccepted }), /EULA/);
  assert.deepEqual(f.requests, []);
  const input = { ...f.input };
  const pending = f.app.createServer(input); input.name = 'Changed'; input.eulaAccepted = false;
  await pending;
  assert.equal((await f.app.getState()).server.name, f.input.name);
  assert.equal(await readFile(path.join((await f.app.getState()).server.serverDir, 'eula.txt'), 'utf8'), 'eula=true\n');
});

test('Fabric creation captures its mod target in the adopted first revision', async t => {
  const f = await fixture(t);
  await f.app.createServer({ ...f.input, loader: 'fabric' });
  const server = (await f.app.getState()).server;
  assert.equal(server.modTarget.loader, 'fabric'); assert.equal(server.modTarget.gameVersion, '1.21.1');
  const restored = path.join(f.dir, 'restored'); await materializeSnapshot(server.storeDir, server.snapshotId, restored);
  const index = JSON.parse(await readFile(path.join(restored, 'peerhost-mods.json'), 'utf8'));
  assert.deepEqual(index.target, { loader: 'fabric', gameVersion: '1.21.1' });
  assert.deepEqual(server.profile.args.slice(-3), ['-jar', 'fabric-server-launch.jar', 'nogui']);
});

test('failed adoption retains preparation evidence and fences possibly committed authority', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'state.json'));
  await assert.rejects(f.app.createServer(f.input), /EISDIR|directory/i);
  const server = (await f.app.getState()).server;
  assert.equal(server.ownership.state, 'uncertain');
  const staging = (await readdir(f.root)).filter(x => x.startsWith('server-setup-'));
  assert.equal(staging.length, 1); assert.equal((await readdir(path.join(f.root, staging[0]))).length, 1);
  await assert.rejects(f.app.startServer(true), /ownership/i);
});

test('application creation locks preparation and refuses replacement while retaining integrity failure evidence', async t => {
  const f = await fixture(t, { delay: 30 });
  const pending = f.app.createServer(f.input);
  await assert.rejects(f.app.importExisting(f.dir, true), /operation.*progress/);
  await assert.rejects(f.app.createServer(f.input), /operation.*progress/);
  await pending;
  const before = (await f.app.getState()).server;
  await assert.rejects(f.app.createServer(f.input), /already imported/);
  assert.equal((await f.app.getState()).server.snapshotId, before.snapshotId);
  const corrupt = await fixture(t, { tamper: true });
  await assert.rejects(corrupt.app.createServer(corrupt.input), /integrity/);
  assert.equal((await corrupt.app.getState()).server, null);
  assert.equal((await readdir(corrupt.root)).includes('managed'), false);
});

test('application creation adopts verified prepared bytes into normal ownership without starting', async t => {
  const f = await fixture(t);
  assert.equal(typeof f.app.createServer, 'function');
  await f.app.createServer(f.input);
  const state = await f.app.getState(), server = state.server;
  assert.equal(server.name, f.input.name); assert.equal(server.state, 'offline'); assert.equal(server.ownership.state, 'owned');
  assert.equal(server.ownership.owner, f.app.identity.fingerprint); assert.equal(server.ownership.snapshotId, server.snapshotId);
  assert.deepEqual(await readFile(path.join(server.serverDir, 'server.jar')), f.jar);
  assert.equal(await readFile(path.join(server.serverDir, 'eula.txt'), 'utf8'), 'eula=true\n');
  assert.deepEqual(server.profile.args, ['-Xms512M', '-Xmx1024M', '-jar', 'server.jar', 'nogui']);
  assert.equal((await f.app.listSnapshots()).length, 1);
  assert.deepEqual((await readSnapshot(server.storeDir, server.snapshotId)).files.map(x => x.path).sort(), ['eula.txt', 'server.jar']);
  assert.equal((await readdir(f.root)).some(x => x.startsWith('server-setup-')), false, 'own source cleaned after durable adoption');
});
