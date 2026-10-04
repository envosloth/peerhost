import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { PeerHostApplication } from '../dist/src/core/application.js';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { writeZip } from '../dist/src/core/zip.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'ph-mod-state-'));
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'eula.txt'), 'eula=true\n');
  const app = new PeerHostApplication(path.join(root, 'profile'), await createIdentity());
  t.after(async () => { await app.close(); await rm(root, {recursive:true, force:true}); });
  await app.open(); await app.importExisting(source, true);
  await app.saveProfile({executable:process.execPath,args:[path.resolve('tools/fake-java-server.mjs')]});
  return {app, server:(await app.getState()).server};
}

test('malformed mod metadata does not disable running state, commands, or graceful Stop', async t => {
  const {app, server} = await fixture(t);
  await app.startServer(true);
  await writeFile(path.join(server.serverDir,'peerhost-mods.json'), '{');
  const running = await app.getState();
  assert.equal(running.server.state, 'running');
  assert.match(running.server.modsError, /mod/i);
  app.sendCommand('say recovery probe');
  await app.stopServer();
  const stopped = await app.getState();
  assert.equal(stopped.server.state,'offline');
  assert.equal(stopped.server.ownership.state,'owned');
  assert.notEqual(stopped.server.snapshotId,server.snapshotId);
  assert.equal(stopped.server.snapshotId,stopped.server.ownership.snapshotId);
  assert.equal(await readFile(path.join(server.serverDir,'peerhost-mods.json'),'utf8'),'{', 'bad metadata is preserved for repair');
});

test('oversized mod index leaves safe-quit state accessible and close commits the stopped snapshot', async t => {
  const {app, server} = await fixture(t);
  await app.startServer(true);
  await writeFile(path.join(server.serverDir,'peerhost-mods.json'), ' '.repeat(1024*1024+1));
  assert.equal((await app.getState()).server.state,'running');
  await app.close();
  const state = await app.getState();
  assert.equal(state.server.state,'offline');
  assert.equal(state.server.ownership.state,'owned');
  assert.notEqual(state.server.snapshotId,server.snapshotId);
});

test('invalid mod metadata blocks local jar mutations instead of discarding broken provenance', async t => {
  const {app, server} = await fixture(t);
  await writeFile(path.join(server.serverDir,'peerhost-mods.json'), '{');
  const jar = path.join(path.dirname(server.serverDir),'probe.jar');
  await writeZip(jar,[{name:'fabric.mod.json',data:Buffer.from('{"id":"probe"}')}]);
  t.after(() => rm(jar,{force:true}));
  await assert.rejects(app.addMods('server',[jar]));
  const state = await app.getState();
  assert.match(state.server.modsError,/mod/i);
  assert.equal(await readFile(path.join(server.serverDir,'peerhost-mods.json'),'utf8'),'{');
});

test('client pack export refuses a broken provenance index instead of bypassing the scoped guard', async t => {
  const {app, server}=await fixture(t);
  const jar=path.join(path.dirname(server.serverDir),'client.jar');
  await writeZip(jar,[{name:'fabric.mod.json',data:Buffer.from('{"id":"probe"}')}]);
  t.after(()=>rm(jar,{force:true}));
  await app.addMods('client',[jar]);
  await writeFile(path.join(server.serverDir,'peerhost-mods.json'),'{');
  await assert.rejects(app.exportClientPack(path.join(path.dirname(server.serverDir),'pack.zip')));
});

test('unsafe mod directory yields scoped error, while hosting Stop remains available', async t => {
  const {app, server} = await fixture(t);
  await app.startServer(true);
  await rm(path.join(server.serverDir,'mods'),{recursive:true,force:true});
  await writeFile(path.join(server.serverDir,'mods'),'not a folder');
  const state = await app.getState();
  assert.equal(state.server.state,'running');
  assert.match(state.server.modsError,/mod/i);
  await app.stopServer();
  assert.equal((await app.getState()).server.ownership.state,'owned');
});
