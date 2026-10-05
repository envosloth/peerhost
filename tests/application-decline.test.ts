import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {createIdentity} from '../src/core/peer-transport.js';
const mod:any=await import('../src/core/application.js');
test('closing is refused during recipient approval, and an explicit decline restores source ownership durably',async()=>{
  await mkdir('.test-data',{recursive:true});const root=await mkdtemp(path.resolve('.test-data/app-decline-'));const ia=await createIdentity(),ib=await createIdentity();
  let approve!:(v:boolean)=>void,notify!:()=>void;const decision=new Promise<boolean>(r=>approve=r),waiting=new Promise<void>(r=>notify=r);
  const a=new mod.SeedHostApplication(path.join(root,'a'),ia),b=new mod.SeedHostApplication(path.join(root,'b'),ib,{confirmIncomingHandoff:async()=>{notify();return decision;}});
  let pending:Promise<unknown>|undefined;
  try{
    const source=path.join(root,'source');await mkdir(source);await writeFile(path.join(source,'eula.txt'),'eula=true\n');await a.open();await b.open();await a.importExisting(source,true);await a.saveProfile({executable:process.execPath,args:[path.resolve('tools/fake-java-server.mjs')]});
    await a.startPeerListener();await b.startPeerListener();await a.addPeer({name:'B',fingerprint:ib.fingerprint,...(await b.getState()).peerEndpoint});await b.addPeer({name:'A',fingerprint:ia.fingerprint,...(await a.getState()).peerEndpoint});
    pending=a.handoff(ib.fingerprint).catch((e:Error)=>e);await waiting;
    await assert.rejects(b.close(),/operation|progress/i);approve(false);const error=await pending;assert.match(String(error),/declined/i);
    assert.equal((await a.getState()).server.ownership.state,'owned');assert.equal((await a.getState()).server.ownership.offer,undefined);assert.equal((await b.getState()).server,null);
    await a.close();
    const restarted=new mod.SeedHostApplication(path.join(root,'a'),ia);await restarted.open();assert.equal((await restarted.getState()).server.ownership.state,'owned');
    await restarted.startServer(true);await restarted.stopServer();await restarted.close();
  }finally{approve(false);await pending;if((await b.getState()).busy)await new Promise(r=>setTimeout(r,50));await a.close();await b.close();await rm(root,{recursive:true,force:true});}
});
