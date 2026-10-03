import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {createIdentity} from '../src/core/peer-transport.js';
const mod:any=await import('../src/core/application.js');
test('closing is refused during recipient approval, and a declined offer stays fenced across restart',async()=>{
  await mkdir('.test-data',{recursive:true});const root=await mkdtemp(path.resolve('.test-data/app-decline-'));const ia=await createIdentity(),ib=await createIdentity();
  let approve!:(v:boolean)=>void,notify!:()=>void;const decision=new Promise<boolean>(r=>approve=r),waiting=new Promise<void>(r=>notify=r);
  const a=new mod.PeerHostApplication(path.join(root,'a'),ia),b=new mod.PeerHostApplication(path.join(root,'b'),ib,{confirmIncomingHandoff:async()=>{notify();return decision;}});
  let pending:Promise<unknown>|undefined;
  try{
    const source=path.join(root,'source');await mkdir(source);await writeFile(path.join(source,'eula.txt'),'eula=true\n');await a.open();await b.open();await a.importExisting(source,true);await a.saveProfile({executable:process.execPath,args:[path.resolve('tools/fake-java-server.mjs')]});
    await a.startPeerListener();await b.startPeerListener();await a.addPeer({name:'B',fingerprint:ib.fingerprint,...(await b.getState()).peerEndpoint});await b.addPeer({name:'A',fingerprint:ia.fingerprint,...(await a.getState()).peerEndpoint});
    pending=a.handoff(ib.fingerprint).catch((e:Error)=>e);await waiting;
    await assert.rejects(b.close(),/operation|progress/i);approve(false);const error=await pending;assert.match(String(error),/accept|fenced/i);
    assert.equal((await a.getState()).server.ownership.state,'offered');assert.equal((await b.getState()).server,null);
    await assert.rejects(a.startServer(true),/ownership/i);await a.close();
    const restarted=new mod.PeerHostApplication(path.join(root,'a'),ia);await restarted.open();await assert.rejects(restarted.startServer(true),/ownership/i);await assert.rejects(restarted.recoverStopped(true),/reconcile|authority/i);await restarted.close();
  }finally{approve(false);await pending;if((await b.getState()).busy)await new Promise(r=>setTimeout(r,50));await a.close();await b.close();await rm(root,{recursive:true,force:true});}
});
