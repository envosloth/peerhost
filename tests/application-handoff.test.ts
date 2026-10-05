import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createIdentity } from '../src/core/peer-transport.js';
const mod:any=await import('../src/core/application.js');
async function waitIdle(app:any){for(let i=0;i<200;i++){if(!(await app.getState()).busy)return;await new Promise(r=>setTimeout(r,10));}throw new Error('Receiver did not finish its operation');}
test('two application instances replicate without authority, then explicitly hand ownership over and back',async()=>{
  await mkdir('.test-data',{recursive:true});
  const root=await mkdtemp(path.resolve('.test-data/app-handoff-'));
  const ia=await createIdentity(),ib=await createIdentity();let allow=false;let approvals=0;
  const a=new mod.SeedHostApplication(path.join(root,'a'),ia,{confirmIncomingHandoff:async()=>true});
  const b=new mod.SeedHostApplication(path.join(root,'b'),ib,{confirmIncomingHandoff:async()=>{approvals++;return allow;}});
  try{
    const source=path.join(root,'source');await mkdir(source);await writeFile(path.join(source,'eula.txt'),'eula=true\n');await writeFile(path.join(source,'world.bin'),'initial');
    await a.open();await b.open();await a.importExisting(source,true);
    await a.saveProfile({executable:process.execPath,args:[path.resolve('tools/fake-java-server.mjs')]});
    await a.startPeerListener();await b.startPeerListener();
    await a.addPeer({name:'B',fingerprint:ib.fingerprint,...(await b.getState()).peerEndpoint});
    await b.addPeer({name:'A',fingerprint:ia.fingerprint,...(await a.getState()).peerEndpoint});
    const replica=await a.sendSnapshot(ib.fingerprint);assert.equal(replica.ownershipAccepted,false);
    assert.equal((await b.getState()).server,null);assert.equal(approvals,0);
    assert.equal(typeof a.handoff,'function');
    await writeFile(path.join((await a.getState()).server.serverDir,'world.bin'),'stopped edits');
    allow=true;await a.handoff(ib.fingerprint);await waitIdle(b);
    const sa=await a.getState(),sb=await b.getState();
    assert.equal(sa.server.ownership.state,'transferred');assert.equal(sa.server.ownership.owner,ib.fingerprint);
    assert.equal(sb.server.ownership.state,'owned');assert.equal(sb.server.ownership.owner,ib.fingerprint);
    assert.equal(sb.server.profile.executable,'','never inherit the sender executable path');
    assert.equal(sb.server.snapshotId,sa.server.snapshotId);
    assert.equal(await readFile(path.join(sb.server.serverDir,'world.bin'),'utf8'),'stopped edits');
    await assert.rejects(a.startServer(true),/ownership/i);assert.equal(approvals,1);
    await b.saveProfile({executable:process.execPath,args:[path.resolve('tools/fake-java-server.mjs')]});
    await b.startServer(true);await assert.rejects(b.handoff(ia.fingerprint),/stop/i);await b.stopServer();
    await writeFile(path.join(sb.server.serverDir,'world.bin'),'B revision');
    await b.handoff(ia.fingerprint);await waitIdle(a);
    const returned=await a.getState();
    assert.equal(returned.server.ownership.owner,ia.fingerprint);assert.equal(returned.server.ownership.generation,2);
    assert.equal(await readFile(path.join(returned.server.serverDir,'world.bin'),'utf8'),'B revision');
    assert.equal(await readFile(path.join(sa.server.serverDir,'world.bin'),'utf8'),'stopped edits','old execution directory retained');
    await a.startServer(true);await a.stopServer();
    const previousOwnership=await a.getState();await a.close();await b.close();
    const reopenedA=new mod.SeedHostApplication(path.join(root,'a'),ia);await reopenedA.open();
    assert.equal((await reopenedA.getState()).server.ownership.generation,previousOwnership.server.ownership.generation);await reopenedA.close();
    assert.equal(await readFile(path.join(source,'world.bin'),'utf8'),'initial');
  }finally{await a.close();await b.close();await rm(root,{recursive:true,force:true});}
});
