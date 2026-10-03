import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createIdentity } from '../src/core/peer-transport.js';
const mod:any=await import('../src/core/'+'application.js').catch(()=>({}));
test('application imports only confirmed-stopped copies and keeps gateway optional',async()=>{
  assert.equal(typeof mod.PeerHostApplication,'function');
  await mkdir('.test-data',{recursive:true});
  const root=await mkdtemp(path.resolve('.test-data/app-'));
  try{
    const source=path.join(root,'source');await mkdir(path.join(source,'world'),{recursive:true});
    await writeFile(path.join(source,'world','fixture.bin'),Buffer.from([0,1,254,255]));
    await writeFile(path.join(source,'eula.txt'),'eula=true\n');
    const app=new mod.PeerHostApplication(path.join(root,'managed'),await createIdentity());
    await app.open();
    assert.equal((await app.getState()).settings.persistentAddress,false);
    await assert.rejects(app.importExisting(source,false),/stopped/i);
    await app.importExisting(source,true);
    const state=await app.getState();
    assert.equal(state.server.ownership.state,'owned');
    assert.deepEqual(await readFile(path.join(state.server.serverDir,'world','fixture.bin')),await readFile(path.join(source,'world','fixture.bin')));
    assert.notEqual(state.server.serverDir,source);
    await app.close();
  }finally{await rm(root,{recursive:true,force:true});}
});
test('application actually runs and gracefully stops its owned process without a gateway',async()=>{
  const root=await mkdtemp(path.resolve('.test-data/app-process-'));
  const app=new mod.PeerHostApplication(path.join(root,'managed'),await createIdentity());
  try{
    const source=path.join(root,'source');await mkdir(source);
    await writeFile(path.join(source,'eula.txt'),'eula=true\n');
    await writeFile(path.join(source,'world-fixture.bin'),'original');
    await app.open();await app.importExisting(source,true);
    assert.equal(typeof app.saveProfile,'function');
    await app.saveProfile({executable:process.execPath,args:[path.resolve('tools/fake-java-server.mjs')]});
    await assert.rejects(app.startServer(false),/trust|confirm/i);
    await app.startServer(true);
    assert.equal((await app.getState()).server.state,'running');
    assert.equal((await app.getState()).server.ownership.state,'hosting');
    await assert.rejects(app.createSnapshot(),/stop/i);
    await assert.rejects(app.importExisting(source,true),/stop/i);
    app.sendCommand('say integration fixture');
    await app.stopServer();
    const state=await app.getState();
    assert.equal(state.server.state,'offline');assert.equal(state.server.ownership.state,'owned');
    assert.equal(state.settings.persistentAddress,false);
    assert.ok(state.logs.some((line:string)=>line.includes('Done (')));
    assert.equal(await readFile(path.join(source,'world-fixture.bin'),'utf8'),'original');
    await app.createSnapshot();
    assert.equal((await app.getState()).server.snapshotId,(await app.getState()).server.ownership.snapshotId);
  }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
test('settings and manually trusted peers survive a fresh application instance',async()=>{
  const root=await mkdtemp(path.resolve('.test-data/app-settings-'));const identity=await createIdentity();
  try{
    const app=new mod.PeerHostApplication(root,identity);await app.open();
    assert.equal(typeof app.saveSettings,'function');
    await app.saveSettings({persistentAddress:true,gatewayAddress:'mini-pc.example:25565',startAtLogin:false});
    const peer={name:'Friend',fingerprint:'a'.repeat(64),host:'127.0.0.1',port:12345};
    await app.addPeer(peer);await app.close();
    const reopened=new mod.PeerHostApplication(root,identity);await reopened.open();
    assert.equal((await reopened.getState()).settings.persistentAddress,true);
    assert.deepEqual((await reopened.getState()).peers,[peer]);
    await assert.rejects(reopened.addPeer({...peer,fingerprint:identity.fingerprint}),/self|own/i);
    await assert.rejects(reopened.addPeer({...peer,host:'..'}),/peer|endpoint/i);
    await reopened.saveSettings({persistentAddress:false,gatewayAddress:'',startAtLogin:false});
    assert.equal((await reopened.getState()).settings.persistentAddress,false);await reopened.close();
  }finally{await rm(root,{recursive:true,force:true});}
});
test('application peer listener is real, loopback-only, and closes cleanly',async()=>{
  const root=await mkdtemp(path.resolve('.test-data/app-peer-'));const app=new mod.PeerHostApplication(root,await createIdentity());
  try{
    await app.open();assert.equal(typeof app.startPeerListener,'function');
    await app.startPeerListener();
    const endpoint=(await app.getState()).peerEndpoint;
    assert.equal(endpoint.host,'127.0.0.1');assert.ok(endpoint.port>0);
    await assert.rejects(app.startPeerListener(),/active/i);
  }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
