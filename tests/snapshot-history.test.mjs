import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {PeerHostApplication} from '../dist/src/core/application.js';
import {createIdentity} from '../dist/src/core/peer-transport.js';

async function fixture(t){
 const root=await mkdtemp(path.join(process.env.TMPDIR,'ph-history-'));const source=path.join(root,'world');await mkdir(source);
 await writeFile(path.join(source,'level.txt'),'first');await writeFile(path.join(source,'eula.txt'),'eula=true\n');
 const app=new PeerHostApplication(path.join(root,'profile'),await createIdentity());await app.open();await app.importExisting(source,true);
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});return {app,root};
}
test('real snapshot history lists retained ancestry with current revision',async t=>{
 const {app}=await fixture(t);const initial=(await app.getState()).server;
 await writeFile(path.join(initial.serverDir,'level.txt'),'second');await app.createSnapshot();
 const rows=await app.listSnapshots();assert.equal(rows.length,2);
 assert.equal(rows[0].current,true);assert.equal(rows[1].id,initial.snapshotId);assert.equal(rows[1].current,false);
 assert.equal(rows[0].fileCount,2);assert.ok(rows[0].bytes>0);
});
test('restore keeps the previous world and safety revision without rewinding authority',async t=>{
 const {app}=await fixture(t);const initial=(await app.getState()).server;
 await writeFile(path.join(initial.serverDir,'level.txt'),'second');await app.createSnapshot();
 const previous=(await app.getState()).server;
 await app.restoreSnapshot(initial.snapshotId);
 const restored=(await app.getState()).server;
 assert.notEqual(restored.serverDir,previous.serverDir);
 assert.equal(await readFile(path.join(restored.serverDir,'level.txt'),'utf8'),'first');
 assert.equal(await readFile(path.join(previous.serverDir,'level.txt'),'utf8'),'second');
 assert.equal(restored.ownership.lineage,previous.ownership.lineage);
 assert.equal(restored.ownership.generation,previous.ownership.generation);
 assert.equal(restored.ownership.state,'owned');assert.equal(restored.ownership.snapshotId,restored.snapshotId);
 const rows=await app.listSnapshots();assert.equal(rows[0].current,true);
 assert.equal(rows[1].id,rows[0].parentId);assert.ok(rows.some(row=>row.id===previous.snapshotId));
});
test('restore refuses running, pending ownership, unknown history and interrupted installs',async t=>{
 const {app}=await fixture(t);const first=(await app.getState()).server;
 await assert.rejects(app.restoreSnapshot('f'.repeat(64)),/retained revision/);
 await app.saveProfile({executable:process.execPath,args:[path.resolve('tools/fake-java-server.mjs')]});
 await app.startServer(true);await assert.rejects(app.restoreSnapshot(first.snapshotId),/Stop the server/);await app.stopServer();
 const server=(await app.getState()).server;
 await writeFile(path.join(server.serverDir,'peerhost-mod-install.json'),'{}');
 await assert.rejects(app.restoreSnapshot(first.snapshotId),/mod install.*repair/i);
 await rm(path.join(server.serverDir,'peerhost-mod-install.json'));
 const {OwnershipLedger}=await import('../dist/src/core/ownership.js');const ledger=new OwnershipLedger(server.ledgerFile,app.identity.fingerprint);
 await ledger.prepareTransfer('a'.repeat(64),server.snapshotId);
 await assert.rejects(app.restoreSnapshot(first.snapshotId),/safely held ownership/);
 assert.equal((await app.getState()).server.serverDir,server.serverDir);
});
test('retention pruning produces a finite available history instead of breaking the history panel',async t=>{
 const {app}=await fixture(t);const server=(await app.getState()).server;
 for(let i=0;i<5;i++){await writeFile(path.join(server.serverDir,'level.txt'),String(i));await app.createSnapshot();}
 await app.cleanUp();const rows=await app.listSnapshots();assert.equal(rows.length,3);assert.equal(rows[0].current,true);
});
