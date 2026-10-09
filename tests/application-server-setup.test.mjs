import test from 'node:test';
import { javaProbeFixture } from './java-probe-fixture.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, lstat, symlink, rename, link } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { SeedHostApplication } from '../dist/src/core/application.js';
import { ServerSetupClient } from '../dist/src/core/server-setup.js';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { readSnapshot, materializeSnapshot } from '../dist/src/core/snapshots.js';

async function fixture(t, { tamper = false, delay = 0, holdArtifact = false, chooseServerPort } = {}) {
  const dir = await mkdtemp(path.join(process.env.TMPDIR, 'ph-app-setup-'));
  const java = await javaProbeFixture(dir, { server: false });
  const jar = Buffer.from('Verified fixture bytes, NOT Minecraft');
  const hash = (bytes, algorithm = 'sha1') => createHash(algorithm).update(bytes).digest('hex');
  let origin;
  const metadata = () => JSON.stringify({ id: '1.21.1', javaVersion: { majorVersion: 21 }, downloads: { server: { url: origin + '/server.jar', size: jar.length, sha1: hash(jar) } } });
  const requests = [];
  let releaseArtifact, artifactRequested;
  const artifactGate = new Promise(resolve => { releaseArtifact = resolve; });
  const artifactRequest = new Promise(resolve => { artifactRequested = resolve; });
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
    if (holdArtifact && req.url === (holdArtifact === true ? '/server.jar' : holdArtifact)) { artifactRequested(); void artifactGate.then(() => res.end(body)); }
    else setTimeout(() => res.end(body), delay);
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${http.address().port}`;
  const root = path.join(dir, 'app');
  const app = new SeedHostApplication(root, await createIdentity(), { serverSetup: new ServerSetupClient({ testOnly: { origin } }), chooseServerPort }); await app.open();
  t.after(async () => { releaseArtifact(); await app.close(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { app, dir, root, requests, jar, artifactRequest, releaseArtifact, input: { name: 'Friends world', loader: 'vanilla', gameVersion: '1.21.1', javaExecutable: java, memoryMiB: 1024, eulaAccepted: true } };
}

test('download location rejects junctions and app storage before downloading anything',async t=>{
 const f=await fixture(t);const downloads=path.join(f.dir,'downloads');await mkdir(downloads);const link=path.join(f.dir,'link');
 await symlink(downloads,link,process.platform==='win32'?'junction':'dir');
 for(const folder of ['relative',f.root,path.join(f.root,'managed'),f.dir,link])await assert.rejects(f.app.createServer(f.input,folder),/absolute|ordinary|link|storage|ENOENT/);
 assert.deepEqual(f.requests,[]);assert.deepEqual(await readdir(downloads),[]);assert.equal((await f.app.getState()).server,null);
});
test('download publication refuses a replaced selected ancestor after the network await',async t=>{
 const f=await fixture(t,{holdArtifact:true});const downloads=path.join(f.dir,'downloads'),outside=path.join(f.dir,'outside');await mkdir(downloads);await mkdir(outside);
 const creating=f.app.createServer(f.input,downloads);creating.catch(()=>{});await f.artifactRequest;
 const [staging]=await readdir(downloads);assert.match(staging,/^server-setup-/);
 await rename(downloads,path.join(f.dir,'original-downloads'));await mkdir(path.join(outside,staging));await symlink(outside,downloads,process.platform==='win32'?'junction':'dir');
 f.releaseArtifact();const error=await creating.then(()=>null,e=>e);
 assert.deepEqual(await readdir(path.join(outside,staging)),[],'no official files or source directory may be published through the replacement junction');
 assert.match(error?.message??'',/changed|link|junction|staging/i);assert.equal((await f.app.getState()).server,null);
});
test('Fabric library publication refuses a replaced download ancestor during its artifact await',async t=>{
 const f=await fixture(t,{holdArtifact:'/net/fabricmc/fabric-loader/0.19.5/fabric-loader-0.19.5.jar'});const downloads=path.join(f.dir,'downloads'),outside=path.join(f.dir,'outside');await mkdir(downloads);await mkdir(outside);
 const creating=f.app.createServer({...f.input,loader:'fabric'},downloads);creating.catch(()=>{});await f.artifactRequest;
 const [staging]=await readdir(downloads),[source]=await readdir(path.join(downloads,staging));
 await rename(downloads,path.join(f.dir,'original-downloads'));const target=path.join(outside,staging,source,'libraries');await mkdir(target,{recursive:true});await symlink(outside,downloads,process.platform==='win32'?'junction':'dir');
 f.releaseArtifact();const error=await creating.then(()=>null,e=>e);
 assert.deepEqual(await readdir(target),[],'Fabric artifacts must not be published through a replaced ancestor');
 assert.match(error?.message??'',/changed|link|junction|staging/i);assert.equal((await f.app.getState()).server,null);
});
test('chosen download location retains verified source independently of the managed working copy', async t => {
  const f = await fixture(t);const downloads=path.join(f.dir,'chosen-downloads');await mkdir(downloads);
  await f.app.createServer(f.input,downloads);
  const folders=await readdir(downloads);assert.equal(folders.length,1,'verified download kept in chosen folder');
  const downloadedRoot=path.join(downloads,folders[0]);const children=await readdir(downloadedRoot);assert.equal(children.length,1);
  const source=path.join(downloadedRoot,children[0]);assert.deepEqual(await readFile(path.join(source,'server.jar')),f.jar);
  assert.notEqual((await f.app.getState()).server.serverDir,source);
});
test('post-download port selection refuses a replaced source without changing another world', async t => {
 let release,admitted,creating;const gate=new Promise(r=>release=r),waiting=new Promise(r=>admitted=r);
 t.after(async()=>{release();await creating?.catch(()=>{});});
 const f=await fixture(t,{chooseServerPort:async()=>{admitted();await gate;return 25566;}});
 const downloads=path.join(f.dir,'downloads'),outside=path.join(f.dir,'another-world');await mkdir(downloads);await mkdir(outside);
 const original='motd=Untouched other world\nserver-port=25599\n';await writeFile(path.join(outside,'server.properties'),original);
 creating=f.app.createServer(f.input,downloads);creating.catch(()=>{});await waiting;
 const [staging]=await readdir(downloads),[source]=await readdir(path.join(downloads,staging)),sourceDir=path.join(downloads,staging,source);
 await rename(sourceDir,sourceDir+'-original');await symlink(outside,sourceDir,process.platform==='win32'?'junction':'dir');
 release();const error=await creating.then(()=>null,e=>e);
 assert.equal(await readFile(path.join(outside,'server.properties'),'utf8'),original,'port editing must never follow a replaced download source into another world');
 assert.match(error?.message??'',/changed|link|junction|source/i);assert.equal((await f.app.getState()).server,null);
});
test('new source port publication refuses an existing aliased properties file without overwriting it', async t => {
 let release,admitted,creating;const gate=new Promise(r=>release=r),waiting=new Promise(r=>admitted=r);
 t.after(async()=>{release();await creating?.catch(()=>{});});
 const f=await fixture(t,{chooseServerPort:async()=>{admitted();await gate;return 25566;}});
 const downloads=path.join(f.dir,'downloads');await mkdir(downloads);
 const outside=path.join(f.dir,'other-server.properties'),original='server-port=25599\nmotd=untouched\n';await writeFile(outside,original);
 creating=f.app.createServer(f.input,downloads);creating.catch(()=>{});await waiting;
 const [staging]=await readdir(downloads),[source]=await readdir(path.join(downloads,staging));
 await link(outside,path.join(downloads,staging,source,'server.properties'));
 release();const error=await creating.then(()=>null,e=>e);
 assert.equal(await readFile(outside,'utf8'),original,'creating a source config must never truncate an existing alias');
 assert.match(error?.message??'',/exist|changed|source|link/i);assert.equal((await f.app.getState()).server,null);
});
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
  const index = JSON.parse(await readFile(path.join(restored, 'seedhost-mods.json'), 'utf8'));
  assert.deepEqual(index.target, { loader: 'fabric', gameVersion: '1.21.1' });
  assert.deepEqual(server.profile.args.slice(-3), ['-jar', 'fabric-server-launch.jar', 'nogui']);
});

test('failed adoption retains preparation evidence and fences possibly committed authority', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'state.json'));
  await assert.rejects(f.app.createServer(f.input), error =>
    process.platform === 'win32'
      ? error.code === 'EPERM' && error.syscall === 'rename' && error.dest === path.join(f.root, 'state.json')
      : /EISDIR|directory/i.test(error.message));
  assert.ok((await lstat(path.join(f.root, 'state.json'))).isDirectory(), 'the conflicting target remains untouched');
  const server = (await f.app.getState()).server;
  assert.equal(server.ownership.state, 'uncertain');
  const staging = (await readdir(f.root)).filter(x => x.startsWith('server-setup-'));
  assert.equal(staging.length, 1); assert.equal((await readdir(path.join(f.root, staging[0]))).length, 1);
  await assert.rejects(f.app.startServer(true), /ownership/i);
});

test('application creation locks preparation and adds a second server without disturbing the first', async t => {
  const f = await fixture(t, { delay: 30 });
  const pending = f.app.createServer(f.input);
  await assert.rejects(f.app.importExisting(f.dir, true), /operation.*progress/);
  await assert.rejects(f.app.createServer(f.input), /operation.*progress/);
  await pending;
  const before = (await f.app.getState()).server;
  await f.app.createServer(f.input);
  const library = await f.app.getState();
  assert.equal(library.servers.length, 2);
  assert.notEqual(library.server.id, before.id);
  assert.notEqual(library.server.playerPort, 25565, 'a newly created world has a distinct port for its own public tunnel');
  // The first server keeps its own lineage entry, folder and revision (group: null = not bound to a hosting group yet).
  assert.deepEqual(library.servers.find(entry => entry.id === before.id), { id: before.id, name: before.name, active: false, state: 'offline', ownerName: 'this PC', configured: true, playerPort: 25565, group: null });
  assert.ok((await readdir(before.serverDir)).includes('server.jar'), 'the first server keeps its own managed copy');
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
