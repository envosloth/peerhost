import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {SeedHostApplication} from '../dist/src/core/application.js';
import {createIdentity} from '../dist/src/core/peer-transport.js';
import {MOD_INSTALL_FENCE_FILE} from '../dist/src/core/mod-transaction.js';

async function fixture(t){
 const root=await mkdtemp(path.join(process.env.TMPDIR,'ph-app-install-fence-'));
 const source=path.join(root,'source');await mkdir(source);await writeFile(path.join(source,'eula.txt'),'eula=true\n');
 const app=new SeedHostApplication(path.join(root,'profile'),await createIdentity());
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 await app.open();await app.importExisting(source,true);
 await app.saveProfile({executable:process.execPath,args:[path.resolve('tools/fake-java-server.mjs')]});
 const server=(await app.getState()).server;
 return {app,server,fence:path.join(server.serverDir,MOD_INSTALL_FENCE_FILE)};
}
test('interrupted install refuses hosting before spawning and surfaces a scoped fence',async t=>{
 const {app,server,fence}=await fixture(t);await writeFile(fence,'{');
 await assert.rejects(app.startServer(true),/mod install.*repair/i);
 const state=await app.getState();
 assert.equal(state.server.state,'offline');assert.equal(state.server.ownership.state,'owned');
 assert.match(state.server.modInstallError,/repair/i);assert.match(state.server.modsError,/repair/i);
 assert.equal(state.server.snapshotId,server.snapshotId);
});
test('install fence is checked again after native launch approval',async t=>{
 const {app,fence}=await fixture(t);
 await assert.rejects(app.startServerWithApproval(async()=>{await writeFile(fence,'{}');return true;}),/mod install.*repair/i);
 assert.equal((await app.getState()).server.ownership.state,'owned');
});
test('interrupted install refuses ordinary snapshot and new handoff without changing revision or authority',async t=>{
 const {app,server,fence}=await fixture(t);await writeFile(fence,'{}');
 const peer={name:'unreachable fixture',host:'127.0.0.1',port:1,fingerprint:'a'.repeat(64)};
 await app.addPeer(peer);
 await assert.rejects(app.createSnapshot(),/mod install.*repair/i);
 await assert.rejects(app.handoff(peer.fingerprint),/mod install.*repair/i);
 await app.saveRelay({fingerprint:peer.fingerprint,parkOnStop:true});
 await assert.rejects(app.parkAtRelay(),/mod install.*repair/i);
 const state=await app.getState();assert.equal(state.server.snapshotId,server.snapshotId);assert.equal(state.server.ownership.state,'owned');
});
test('install fence cannot be bypassed by local mods or client-pack export',async t=>{
 const {app,fence}=await fixture(t);await writeFile(fence,'{}');
 await assert.rejects(app.saveModTarget({loader:'fabric',gameVersion:'1.21.1'}),/mod install.*repair/i);
 await assert.rejects(app.exportClientPack(fence+'.zip'),/mod install.*repair/i);
});
test('install fence never blocks a clean Stop and its final local snapshot',async t=>{
 const {app,server,fence}=await fixture(t);await app.startServer(true);await writeFile(fence,'{}');
 assert.equal((await app.getState()).server.state,'running');await app.stopServer();
 const state=await app.getState();assert.equal(state.server.state,'offline');assert.equal(state.server.ownership.state,'owned');assert.notEqual(state.server.snapshotId,server.snapshotId);
 await assert.rejects(app.startServer(true),/mod install.*repair/i);
});
