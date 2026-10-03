import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
const mod:any=await import('../src/core/'+'ownership.js').catch(()=>({}));
test('metadata commits use SQLite DELETE journaling and synchronous EXTRA',async t=>{
  const dir=await mkdtemp(path.resolve('.test-data/ownership-'));
  const configurations:any[]=[];
  const statements:string[]=[];
  const exec=DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype,'exec',function(this:DatabaseSync,sql:string){
    statements.push(sql);
    if(/^BEGIN\b/i.test(sql))configurations.push({
      journalMode:this.prepare('PRAGMA journal_mode').get()?.journal_mode,
      synchronous:this.prepare('PRAGMA synchronous').get()?.synchronous,
    });
    return exec.call(this,sql);
  });
  try{
    const file=path.join(dir,'a.json'); // The supplied extension does not determine the storage format.
    const ledger=new mod.OwnershipLedger(file,'a');
    await ledger.initialize("revision';--");
    await ledger.startHosting();
    assert.equal((await readFile(file)).subarray(0,16).toString(),'SQLite format 3\0');
    assert.deepEqual(configurations,[{journalMode:'delete',synchronous:3},{journalMode:'delete',synchronous:3}]);
    assert.equal(statements.filter(sql=>/^BEGIN IMMEDIATE$/i.test(sql)).length,2);
    assert.equal(statements.filter(sql=>/^COMMIT$/i.test(sql)).length,2);
    assert.equal((await new mod.OwnershipLedger(file,'a').status()).snapshotId,"revision';--");
    assert.equal((await ledger.status()).state,'hosting');
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('unsupported durability settings fail closed before ownership changes',async t=>{
  for(const unsupported of ['journal','synchronous'])await t.test(unsupported,async t=>{
    const dir=await mkdtemp(path.resolve('.test-data/ownership-'));
    try{
      const ledger=new mod.OwnershipLedger(path.join(dir,'a.json'),'a');
      await ledger.initialize('r1');
      const before=await ledger.status();
      const exec=DatabaseSync.prototype.exec;
      let began=false;
      const fault=t.mock.method(DatabaseSync.prototype,'exec',function(this:DatabaseSync,sql:string){
        if(/^BEGIN\b/i.test(sql))began=true;
        const replaced=unsupported==='journal'?sql.replace(/journal_mode=DELETE/gi,'journal_mode=MEMORY'):sql.replace(/synchronous=EXTRA/gi,'synchronous=OFF');
        return exec.call(this,replaced);
      });
      await assert.rejects(ledger.prepareTransfer('b','r1'),/durability|journal|synchronous/i);
      assert.equal(began,false);
      fault.mock.restore();
      assert.deepEqual(await ledger.status(),before);
    }finally{await rm(dir,{recursive:true,force:true});}
  });
});
test('failed commit rejects the offer and explicitly rolls back metadata',async t=>{
  const dir=await mkdtemp(path.resolve('.test-data/ownership-'));
  try{
    const ledger=new mod.OwnershipLedger(path.join(dir,'a.json'),'a');
    await ledger.initialize('r1');
    const before=await ledger.status();
    const failure=new Error('injected COMMIT failure');
    const exec=DatabaseSync.prototype.exec;
    let rollbacks=0;
    const fault=t.mock.method(DatabaseSync.prototype,'exec',function(this:DatabaseSync,sql:string){
      if(sql==='COMMIT')throw failure;
      if(sql==='ROLLBACK')rollbacks++;
      return exec.call(this,sql);
    });
    await assert.rejects(ledger.prepareTransfer('b','r1'),error=>error===failure);
    assert.equal(rollbacks,1);
    fault.mock.restore();
    assert.deepEqual(await ledger.status(),before);
    assert.equal((await ledger.prepareTransfer('b','r1')).target,'b');
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('rollback failure reports both errors and never returns an offer',async t=>{
  const dir=await mkdtemp(path.resolve('.test-data/ownership-'));
  try{
    const ledger=new mod.OwnershipLedger(path.join(dir,'a.json'),'a');
    await ledger.initialize('r1');
    const before=await ledger.status();
    const commitError=new Error('injected COMMIT failure');
    const rollbackError=new Error('injected ROLLBACK failure');
    const exec=DatabaseSync.prototype.exec;
    const fault=t.mock.method(DatabaseSync.prototype,'exec',function(this:DatabaseSync,sql:string){
      if(sql==='COMMIT')throw commitError;
      if(sql==='ROLLBACK')throw rollbackError;
      return exec.call(this,sql);
    });
    await assert.rejects(ledger.prepareTransfer('b','r1'),error=>{
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors,[commitError,rollbackError]);
      return true;
    });
    fault.mock.restore();
    // Closing the real SQLite connection rolls back the still-open transaction.
    assert.deepEqual(await ledger.status(),before);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('preexisting JSON metadata is refused with explicit migration guidance and unchanged bytes',async()=>{
  const dir=await mkdtemp(path.resolve('.test-data/ownership-'));
  try{
    const file=path.join(dir,'a.json');
    const legacy=JSON.stringify({version:1,owner:'a',generation:0,snapshotId:'r1',state:'uncertain'});
    await writeFile(file,legacy);
    const ledger=new mod.OwnershipLedger(file,'a');
    await assert.rejects(ledger.status(),/legacy JSON.*explicit migration/i);
    await assert.rejects(ledger.initialize('r2'),/explicit migration/i);
    await assert.rejects(ledger.startHosting(),/explicit migration/i);
    await assert.rejects(ledger.acceptTransfer({id:'offer',lineage:'L',source:'b',target:'a',generation:1,snapshotId:'r2'},'b','r2'),/explicit migration/i);
    assert.equal(await readFile(file,'utf8'),legacy);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('hosting ownership is durable and needs no gateway',async()=>{
  assert.equal(typeof mod.OwnershipLedger,'function');
  const dir=await mkdtemp(path.resolve('.test-data/ownership-'));
  try{
    const ledger=new mod.OwnershipLedger(path.join(dir,'ownership.json'),'device-a');
    await ledger.initialize('revision-a');
    await ledger.startHosting();
    assert.equal((await ledger.status()).state,'hosting');
    assert.equal((await new mod.OwnershipLedger(path.join(dir,'ownership.json'),'device-a').status()).state,'hosting');
    await assert.rejects(ledger.prepareTransfer('device-b','revision-a'),/stop/i);
    await ledger.stopHosting('revision-b');
    const offer=await ledger.prepareTransfer('device-b','revision-b');
    assert.equal(offer.target,'device-b');
    assert.equal((await ledger.status()).state,'offered');
    await assert.rejects(ledger.startHosting(),/ownership/i);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('handoff grants only the intended verified recipient and fences the source',async()=>{
  const dir=await mkdtemp(path.resolve('.test-data/ownership-'));
  try{
    const a=new mod.OwnershipLedger(path.join(dir,'a.json'),'device-a');
    const b=new mod.OwnershipLedger(path.join(dir,'b.json'),'device-b');
    await a.initialize('revision-a');
    const offer=await a.prepareTransfer('device-b','revision-a');
    assert.equal(typeof b.acceptTransfer,'function');
    await assert.rejects(b.acceptTransfer(offer,'intruder','revision-a'),/source/i);
    await assert.rejects(b.acceptTransfer(offer,'device-a','wrong-revision'),/revision/i);
    await b.acceptTransfer(offer,'device-a','revision-a');
    await b.startHosting();
    await a.confirmTransfer(offer.id,'device-b');
    await assert.rejects(a.startHosting(),/ownership/i);
    assert.equal((await a.status()).owner,'device-b');
    await assert.rejects(b.acceptTransfer(offer,'device-a','revision-a'),/stale|ownership/i);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('incoming self-transfer cannot manufacture ownership',async t=>{
  for(const uncertain of [false,true])await t.test(uncertain?'uncertain self-transfer':'owned self-transfer',async()=>{
    const dir=await mkdtemp(path.resolve('.test-data/ownership-'));
    try{
      const a=new mod.OwnershipLedger(path.join(dir,'a.json'),'a');
      await a.initialize('r1');
      if(uncertain)await a.markUncertain();
      const before=await a.status();
      await assert.rejects(a.acceptTransfer({id:'self',lineage:'L',source:'a',target:'a',generation:1,snapshotId:'r1'},'a','r1'),/self|source|target/i);
      assert.deepEqual(await a.status(),before);
    }finally{await rm(dir,{recursive:true,force:true});}
  });
});
test('incoming transfer cannot clear uncertain ownership',async()=>{
  const dir=await mkdtemp(path.resolve('.test-data/ownership-'));
  try{
    const file=path.join(dir,'a.json');
    const previous=new mod.OwnershipLedger(file,'a');
    await previous.initialize('r1');await previous.markUncertain();
    const recipient=new mod.OwnershipLedger(file,'b');
    const before=await recipient.status();
    await assert.rejects(recipient.acceptTransfer({id:'incoming',lineage:'L',source:'a',target:'b',generation:1,snapshotId:'r1'},'a','r1'),/uncertain|conflicting|ownership/i);
    assert.deepEqual(await recipient.status(),before);
    await assert.rejects(recipient.startHosting(),/ownership/i);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('prepare returns its committed offer even if confirmation wins before return',async()=>{
  const dir=await mkdtemp(path.resolve('.test-data/ownership-'));
  try{
    const file=path.join(dir,'a.json');
    const source=new mod.OwnershipLedger(file,'a');
    const confirmer=new mod.OwnershipLedger(file,'a');
    await source.initialize('r1');
    const transaction=source.transaction.bind(source);
    let committedOffer:any;
    // Force confirmation in the gap after commit and before prepareTransfer resumes.
    source.transaction=async(...args:any[])=>{
      const value=await transaction(...args);
      committedOffer=(await confirmer.status()).offer;
      await confirmer.confirmTransfer(committedOffer.id,'b');
      return value;
    };
    const offer=await source.prepareTransfer('b','r1');
    assert.deepEqual(offer,committedOffer);
    assert.equal((await source.status()).state,'transferred');
    await assert.rejects(source.startHosting(),/ownership/i);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('lost hosting session stays blocked until explicit stopped-process recovery',async()=>{
  const dir=await mkdtemp(path.resolve('.test-data/ownership-'));
  try{
    const a=new mod.OwnershipLedger(path.join(dir,'a.json'),'a');
    await a.initialize('r1');await a.startHosting();
    assert.equal(typeof a.markUncertain,'function');
    await a.markUncertain();
    await assert.rejects(a.startHosting(),/ownership/i);
    await assert.rejects(a.recoverStopped(false),/confirm/i);
    await a.recoverStopped(true);
    assert.equal((await a.status()).snapshotId,'r1');
    await a.startHosting();
    assert.equal((await a.status()).state,'hosting');
  }finally{await rm(dir,{recursive:true,force:true});}
});
