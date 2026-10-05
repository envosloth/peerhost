import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import path from 'node:path';
import {createIdentity} from '../src/core/peer-transport.js';
import {OwnershipLedger} from '../src/core/ownership.js';
const mod:any=await import('../src/core/application.js');
async function setup(){await mkdir('.test-data',{recursive:true});const root=await mkdtemp(path.resolve('.test-data/app-safety-'));const source=path.join(root,'source');await mkdir(source);await writeFile(path.join(source,'eula.txt'),'eula=true\n');await writeFile(path.join(source,'world.bin'),'safe');const identity=await createIdentity();const app=new mod.SeedHostApplication(path.join(root,'profile'),identity);await app.open();await app.importExisting(source,true);await app.saveProfile({executable:process.execPath,args:[path.resolve('tools/fake-java-server.mjs')]});return {root,source,identity,app};}
test('metadata revision mismatch cannot start a process or silently change ledger authority',async()=>{
  const {root,app,identity}=await setup();
  try{
    await app.close();const file=path.join(root,'profile','state.json');const saved=JSON.parse(await readFile(file,'utf8'));const original=saved.servers[0].snapshotId;saved.servers[0].snapshotId='f'.repeat(64);await writeFile(file,JSON.stringify(saved));
    const reopened=new mod.SeedHostApplication(path.join(root,'profile'),identity);await reopened.open();
    try{await assert.rejects(reopened.startServer(true),/revision|snapshot|mismatch/i);assert.equal((await new OwnershipLedger(saved.servers[0].ledgerFile,identity.fingerprint).status()).snapshotId,original);assert.equal((await reopened.getState()).server.state,'offline');}finally{await reopened.close();}
  }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
test('uncertain ownership requires explicit stopped-process recovery and a new verified snapshot',async()=>{
  const {root,app,identity}=await setup();
  try{
    const server=(await app.getState()).server;const ledger=new OwnershipLedger(server.ledgerFile,identity.fingerprint);await ledger.markUncertain();
    assert.equal(typeof app.recoverStopped,'function');
    await assert.rejects(app.recoverStopped(false),/confirm|stopped/i);
    await app.recoverStopped(true);const recovered=await app.getState();
    assert.equal(recovered.server.ownership.state,'owned');assert.equal(recovered.server.snapshotId,recovered.server.ownership.snapshotId);
    await app.startServer(true);await app.stopServer();
  }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
