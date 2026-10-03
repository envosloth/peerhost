import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { PeerHostApplication } from '../src/core/application.js';
import { createIdentity } from '../src/core/peer-transport.js';
import { OwnershipLedger } from '../src/core/ownership.js';

const fixture = path.resolve('tools/fake-java-server.mjs');
for (const state of ['owned','offered','uncertain'] as const) {
  test('reimport preserves '+state+' lineage, ledger and files',async()=>{
    const {root,source}=await workspace('review-'+state+'-');
    const identity=await createIdentity(), app=new PeerHostApplication(path.join(root,'profile'),identity);
    try {
      await app.open(); await app.importExisting(source,true);
      const server=(await app.getState()).server!;
      const ledger=new OwnershipLedger(server.ledgerFile,identity.fingerprint);
      if(state==='offered')await ledger.prepareTransfer('b'.repeat(64),server.snapshotId);
      if(state==='uncertain')await ledger.markUncertain();
      const before=await app.getState();
      const disk=await readFile(path.join(root,'profile','state.json'),'utf8');
      const files=await readdir(path.join(root,'profile'));
      // A genuinely different source is also not an implicit profile replacement.
      const other=path.join(root,'different');await mkdir(other);await writeFile(path.join(other,'eula.txt'),'eula=true\n');
      for (const input of [source,other])await assert.rejects(app.importExisting(input,true),/already imported|separate.*profile/i);
      assert.deepEqual((await app.getState()).server,before.server);
      assert.equal(await readFile(path.join(root,'profile','state.json'),'utf8'),disk);
      assert.deepEqual(await readdir(path.join(root,'profile')),files);
      assert.equal(await readFile(path.join(server.serverDir,'world.bin'),'utf8'),'original world');
    }finally{await app.close();await rm(root,{recursive:true,force:true});}
  });
}
async function workspace(prefix:string) {
  await mkdir('.test-data', {recursive:true});
  const root = await mkdtemp(path.resolve('.test-data/'+prefix));
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'eula.txt'), 'eula=true\n');
  await writeFile(path.join(source, 'world.bin'), 'original world');
  return {root, source};
}
function deferred<T>() { let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve}; }

test('launch approval reserves backend lock and runs only the captured immutable profile',async()=>{
  const {root,source}=await workspace('review-approval-');
  const app=new PeerHostApplication(path.join(root,'profile'),await createIdentity());
  const decision=deferred<boolean>(), waiting=deferred<void>();
  let pending:Promise<void>|undefined;
  try {
    await app.open(); await app.importExisting(source,true);
    const approvedProfile={executable:process.execPath,args:[fixture,'--lifetime-ms=30000','approved original']};
    await app.saveProfile(approvedProfile);
    const original=(await app.getState()).server!;
    assert.equal(typeof (app as any).startServerWithApproval,'function');
    pending=(app as any).startServerWithApproval(async(captured:any)=>{
      assert.equal(captured.serverDir,original.serverDir);assert.equal(captured.snapshotId,original.snapshotId);
      assert.equal(captured.root,app.root);assert.deepEqual(captured.profile,approvedProfile);
      assert.ok(Object.isFrozen(captured));assert.ok(Object.isFrozen(captured.profile));assert.ok(Object.isFrozen(captured.profile.args));
      waiting.resolve();return decision.promise;
    });
    await waiting.promise;
    assert.equal((await app.getState()).busy,'startServer');
    assert.equal((await app.getState()).server!.state,'offline');
    await assert.rejects(app.saveProfile({executable:process.execPath,args:[fixture,'unapproved replacement']}),/operation|progress/i);
    await assert.rejects(app.importExisting(source,true),/operation|progress/i);
    await assert.rejects(app.close(),/operation|progress/i);
    decision.resolve(true);await pending;
    const state=await app.getState();assert.equal(state.busy,null);assert.equal(state.server!.state,'running');
    const launch=JSON.parse(state.logs.find(line=>line.startsWith('fixture '))!.slice('fixture '.length));
    assert.deepEqual(launch.args,approvedProfile.args.slice(1));assert.equal(launch.cwd,original.serverDir);
    await app.stopServer();assert.equal((await app.getState()).server!.ownership.state,'owned');
  }finally{decision.resolve(false);await pending?.catch(()=>{});await app.close();await rm(root,{recursive:true,force:true});}
});

for(const change of ['profile','snapshot'] as const)test('launch consent is revalidated before spawn after '+change+' metadata changes',async()=>{
  const {root,source}=await workspace('review-revalidate-');
  const app=new PeerHostApplication(path.join(root,'profile'),await createIdentity());
  const waiting=deferred<void>(),decision=deferred<boolean>();
  let pending:Promise<void>|undefined;
  try{
    await app.open();await app.importExisting(source,true);await app.saveProfile({executable:process.execPath,args:[fixture,'--lifetime-ms=30000']});
    const original=(await app.getState()).server!;
    pending=app.startServerWithApproval(async captured=>{waiting.resolve();await decision.promise;assert.equal(captured.snapshotId,original.snapshotId);assert.equal(captured.profile.args.length,2);return true;});
    await waiting.promise;
    // Deliberate in-memory invalidation models metadata changing outside the public operation API.
    if(change==='profile')(app as any).saved.server.profile.args.push('not approved');
    else (app as any).saved.server.snapshotId='f'.repeat(64);
    decision.resolve(true);await assert.rejects(pending,/changed.*approval|approve again/i);
    const state=await app.getState();assert.equal(state.server!.ownership.state,'owned');assert.equal(state.server!.state,'offline');
    assert.ok(!state.logs.some(line=>line.startsWith('fixture ')));
  }finally{decision.resolve(false);await pending?.catch(()=>{});await app.close();await rm(root,{recursive:true,force:true});}
});

test('actual child exit during settings persistence fences ownership before lock release and can recover',async()=>{
  const {root,source}=await workspace('review-exit-');
  const app=new PeerHostApplication(path.join(root,'profile'),await createIdentity());
  const persistEntered=deferred<void>(), releasePersist=deferred<void>(), exited=deferred<void>();
  let pending:Promise<void>|undefined;
  try{
    await app.open();await app.importExisting(source,true);
    await app.saveProfile({executable:process.execPath,args:[fixture,'--lifetime-ms=800','--exit-code=7']});
    await app.startServer(true);
    const child=(app as any).process;
    child.on('state',(state:string)=>{if(state==='failed'||state==='offline')exited.resolve();});
    // Synchronize the real persistence operation with actual fixture exit; do not replace process/ledger behavior.
    const persist=(app as any).persist.bind(app);
    (app as any).persist=async()=>{persistEntered.resolve();await releasePersist.promise;await persist();};
    pending=app.saveSettings({persistentAddress:false,gatewayAddress:'',startAtLogin:false});
    await persistEntered.promise;assert.equal((await app.getState()).busy,'saveSettings');
    await exited.promise;
    assert.equal(child.pid,undefined,'actual fixture exited, not a synthetic state event');
    releasePersist.resolve();await pending;
    (app as any).persist=persist;
    const state=await app.getState();
    assert.equal(state.busy,null);assert.equal(state.server!.ownership.state,'uncertain');
    await assert.rejects(app.startServer(true),/ownership/i);
    await app.recoverStopped(true);assert.equal((await app.getState()).server!.ownership.state,'owned');
    await app.saveProfile({executable:process.execPath,args:[fixture,'--lifetime-ms=30000']});
    await app.startServer(true);await app.stopServer();assert.equal((await app.getState()).server!.ownership.state,'owned');
  }finally{releasePersist.resolve();await pending?.catch(()=>{});await app.close();await rm(root,{recursive:true,force:true});}
});

test('approval completing after transport timeout cannot overwrite a newly imported hosting server',async(t)=>{
  const {root,source}=await workspace('review-late-');
  const ia=await createIdentity(),ib=await createIdentity();
  const decision=deferred<boolean>(),waiting=deferred<void>();
  const a=new PeerHostApplication(path.join(root,'a'),ia);
  const b=new PeerHostApplication(path.join(root,'b'),ib,{confirmIncomingHandoff:async()=>{waiting.resolve();return decision.promise;}});
  let pending:Promise<unknown>|undefined;
  try{
    await a.open();await b.open();await a.importExisting(source,true);
    await a.startPeerListener();await b.startPeerListener();
    await a.addPeer({name:'B',fingerprint:ib.fingerprint,...(await b.getState()).peerEndpoint!});
    await b.addPeer({name:'A',fingerprint:ia.fingerprint,...(await a.getState()).peerEndpoint!});
    t.mock.timers.enable({apis:['setTimeout']});
    pending=a.handoff(ib.fingerprint).catch((e:Error)=>e);
    await waiting.promise;await new Promise<void>(r=>setImmediate(r));
    assert.equal((await b.getState()).busy,'receiveSnapshot');
    t.mock.timers.tick(120000);t.mock.timers.reset();
    const failure=await pending;assert.match(String(failure),/timed out|disconnected/i);
    await idle(b);assert.equal((await b.getState()).server,null);
    const replacement=path.join(root,'replacement');await mkdir(replacement);
    await writeFile(path.join(replacement,'eula.txt'),'eula=true\n');await writeFile(path.join(replacement,'world.bin'),'new local lineage');
    await b.importExisting(replacement,true);await b.saveProfile({executable:process.execPath,args:[fixture,'--lifetime-ms=30000']});await b.startServer(true);
    const original=(await b.getState()).server!;
    const disk=await readFile(path.join(root,'b','state.json'),'utf8');
    decision.resolve(true);
    // Observe the actual late callback finishing (either unsafe activation or explicit refusal), not a fixed sleep.
    for(let i=0;i<500;i++){
      if((b as any).logs.some((line:string)=>line.includes('Accepted ownership')||line.includes('Incoming handoff activation refused')))break;
      await new Promise(r=>setTimeout(r,10));
    }
    const after=await b.getState();
    assert.equal(after.server!.serverDir,original.serverDir);
    assert.deepEqual(after.server!.ownership,original.ownership);
    assert.equal(after.server!.state,'running');
    assert.equal(await readFile(path.join(root,'b','state.json'),'utf8'),disk);
    assert.ok(after.logs.some(line=>line.includes('Incoming handoff activation refused')));
    assert.equal((await a.getState()).server!.ownership.state,'offered');
  }finally{
    t.mock.timers.reset();decision.resolve(false);await pending;await idle(b);await a.close();
    await b.close().catch(async()=>{await (b as any).process?.forceStop();await (b as any).listener?.close();});
    await rm(root,{recursive:true,force:true});
  }
});

test('transport timeout cannot release lock while candidate metadata persistence is still in flight',async(t)=>{
  const {root,source}=await workspace('review-activation-');
  const ia=await createIdentity(),ib=await createIdentity();
  const entered=deferred<void>(),release=deferred<void>();
  const a=new PeerHostApplication(path.join(root,'a'),ia);
  const b=new PeerHostApplication(path.join(root,'b'),ib,{confirmIncomingHandoff:async()=>true});
  let pending:Promise<unknown>|undefined;
  try{
    await a.open();await b.open();await a.importExisting(source,true);
    await a.startPeerListener();await b.startPeerListener();
    await a.addPeer({name:'B',fingerprint:ib.fingerprint,...(await b.getState()).peerEndpoint!});
    await b.addPeer({name:'A',fingerprint:ia.fingerprint,...(await a.getState()).peerEndpoint!});
    const persist=(b as any).persist.bind(b);
    (b as any).persist=async()=>{entered.resolve();await release.promise;await persist();};
    t.mock.timers.enable({apis:['setTimeout']});
    pending=a.handoff(ib.fingerprint).catch((e:Error)=>e);
    await entered.promise;await new Promise<void>(r=>setImmediate(r));
    t.mock.timers.tick(120000);t.mock.timers.reset();await pending;
    // Real transport staging cleanup has finished; a detached callback must not release the backend lock.
    for(let i=0;i<200;i++){
      if(!(await readdir(path.join(root,'b','managed','store'))).some(name=>name.startsWith('.transfer-')))break;
      await new Promise(r=>setTimeout(r,10));
    }
    await new Promise<void>(r=>setImmediate(r));
    assert.equal((b as any).busy,'receiveSnapshot');
    await assert.rejects(b.saveSettings({persistentAddress:false,gatewayAddress:'',startAtLogin:false}),/operation|progress/i);
    await assert.rejects(b.close(),/operation|progress/i);
    release.resolve();
    for(let i=0;i<500&&(b as any).busy;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal((b as any).busy,null);
    assert.equal((await b.getState()).server,null);
    assert.equal(JSON.parse(await readFile(path.join(root,'b','state.json'),'utf8')).server,null);
    assert.equal((await a.getState()).server!.ownership.state,'offered');
  }finally{
    t.mock.timers.reset();release.resolve();await pending;
    for(let i=0;i<200&&(b as any).busy;i++)await new Promise(r=>setTimeout(r,10));
    await a.close();await b.close().catch(async()=>{await (b as any).listener?.close();});
    await rm(root,{recursive:true,force:true});
  }
});

test('closed actual TLS session refuses approval even while its original backend operation remains live',async()=>{
  const {root,source}=await workspace('review-closed-');
  const ia=await createIdentity(),ib=await createIdentity();
  const waiting=deferred<void>(),decision=deferred<boolean>();
  const a=new PeerHostApplication(path.join(root,'a'),ia);
  const b=new PeerHostApplication(path.join(root,'b'),ib,{confirmIncomingHandoff:async()=>{waiting.resolve();return decision.promise;}});
  let incoming:any,pending:Promise<unknown>|undefined;
  const handle=(b as any).handleIncoming.bind(b);
  (b as any).handleIncoming=(socket:any,source:string)=>{incoming=socket;return handle(socket,source);};
  try{
    await a.open();await b.open();await a.importExisting(source,true);
    await a.startPeerListener();await b.startPeerListener();
    await a.addPeer({name:'B',fingerprint:ib.fingerprint,...(await b.getState()).peerEndpoint!});
    await b.addPeer({name:'A',fingerprint:ia.fingerprint,...(await a.getState()).peerEndpoint!});
    pending=a.handoff(ib.fingerprint).catch((e:Error)=>e);await waiting.promise;
    incoming.destroy();assert.equal(incoming.destroyed,true);
    assert.match(String(await pending),/disconnect|closed/i);
    assert.equal((await b.getState()).busy,'receiveSnapshot');
    decision.resolve(true);await idle(b);
    assert.equal((await b.getState()).server,null);
    assert.ok((await b.getState()).logs.some(line=>line.includes('Incoming handoff activation refused')));
  }finally{decision.resolve(false);await pending;await idle(b);await a.close();await b.close();await rm(root,{recursive:true,force:true});}
});

for(const rejectAfterCommit of [false,true])test('lost acknowledgment retains durable recipient authority'+(rejectAfterCommit?' even if acceptance result throws':''),async(t)=>{
  const {root,source}=await workspace('review-committed-');
  const ia=await createIdentity(),ib=await createIdentity();
  const committed=deferred<void>(),release=deferred<void>();
  const a=new PeerHostApplication(path.join(root,'a'),ia);
  const b=new PeerHostApplication(path.join(root,'b'),ib,{confirmIncomingHandoff:async()=>true});
  let pending:Promise<unknown>|undefined;
  const accept=OwnershipLedger.prototype.acceptTransfer;
  // The actual SQLite commit executes before this deterministic lost-ack barrier.
  OwnershipLedger.prototype.acceptTransfer=async function(...args:Parameters<OwnershipLedger['acceptTransfer']>){
    await accept.apply(this,args);
    if(this.deviceId===ib.fingerprint){committed.resolve();await release.promise;if(rejectAfterCommit)throw new Error('Fixture acceptance result lost after durable commit');}
  };
  try{
    await a.open();await b.open();await a.importExisting(source,true);
    await a.startPeerListener();await b.startPeerListener();
    await a.addPeer({name:'B',fingerprint:ib.fingerprint,...(await b.getState()).peerEndpoint!});
    await b.addPeer({name:'A',fingerprint:ia.fingerprint,...(await a.getState()).peerEndpoint!});
    t.mock.timers.enable({apis:['setTimeout']});
    pending=a.handoff(ib.fingerprint).catch((e:Error)=>e);await committed.promise;
    const durable=(await b.getState()).server!;assert.equal(durable.ownership.state,'owned');
    t.mock.timers.tick(120000);t.mock.timers.reset();await pending;
    assert.equal((await b.getState()).busy,'receiveSnapshot');
    release.resolve();await idle(b);
    assert.deepEqual((await b.getState()).server!.ownership,durable.ownership);
    assert.equal((await b.getState()).server!.serverDir,durable.serverDir);
    assert.equal((await a.getState()).server!.ownership.state,'offered');
    await b.close();
    const reopened=new PeerHostApplication(path.join(root,'b'),ib);await reopened.open();
    assert.deepEqual((await reopened.getState()).server!.ownership,durable.ownership);await reopened.close();
  }finally{
    t.mock.timers.reset();release.resolve();await pending;await idle(b);
    OwnershipLedger.prototype.acceptTransfer=accept;
    await a.close();await b.close();await rm(root,{recursive:true,force:true});
  }
});

async function idle(app:PeerHostApplication) {
  for (let i=0;i<500;i++) { if (!(await app.getState()).busy) return; await new Promise(r=>setTimeout(r,10)); }
  throw new Error('Application did not become idle');
}

test('real A to B handoff cannot be undone by reimporting A while B hosts', async()=>{
  const {root,source}=await workspace('review-reimport-');
  const ia=await createIdentity(), ib=await createIdentity();
  const a=new PeerHostApplication(path.join(root,'a'),ia);
  const b=new PeerHostApplication(path.join(root,'b'),ib,{confirmIncomingHandoff:async()=>true});
  try {
    await a.open(); await b.open(); await a.importExisting(source,true);
    await a.saveProfile({executable:process.execPath,args:[fixture,'--lifetime-ms=30000']});
    await a.startPeerListener(); await b.startPeerListener();
    await a.addPeer({name:'B',fingerprint:ib.fingerprint,...(await b.getState()).peerEndpoint!});
    await b.addPeer({name:'A',fingerprint:ia.fingerprint,...(await a.getState()).peerEndpoint!});
    await a.handoff(ib.fingerprint); await idle(b);
    await b.saveProfile({executable:process.execPath,args:[fixture,'--lifetime-ms=30000']});
    await b.startServer(true);
    const original=(await a.getState()).server!;
    const originalFiles=await readdir(path.join(root,'a'));
    const metadata=await readFile(path.join(root,'a','state.json'),'utf8');
    await assert.rejects(a.importExisting(source,true),/already imported|separate.*profile/i);
    const after=(await a.getState()).server!;
    assert.equal(after.ledgerFile,original.ledgerFile);
    assert.deepEqual(after.ownership,original.ownership);
    assert.equal(after.serverDir,original.serverDir);
    assert.equal(await readFile(path.join(root,'a','state.json'),'utf8'),metadata);
    assert.deepEqual(await readdir(path.join(root,'a')),originalFiles);
    assert.equal((await b.getState()).server!.state,'running');
    await assert.rejects(a.startServer(true),/ownership/i);
  } finally { await a.close(); await b.close(); await rm(root,{recursive:true,force:true}); }
});
