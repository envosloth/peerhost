import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {createIdentity} from '../dist/src/core/peer-transport.js';
import {SeedHostApplication} from '../dist/src/core/application.js';
import {AccountIntegration} from '../dist/src/core/account-integration.js';
import {AccountService} from '../dist/src/core/accounts.js';
import {RelayNode} from '../dist/src/core/relay.js';
import {relayFriends} from '../dist/src/core/relay-client.js';
const vault={encrypt:s=>Buffer.from(s),decrypt:b=>b.toString()};
async function fixture(t){
 const root=await mkdtemp(path.join(process.env.TMPDIR,'username-accept-'));
 const [di,ri,ai,bi]=await Promise.all(Array.from({length:4},()=>createIdentity()));
 const directory=new AccountService(path.join(root,'directory'),di),relay=new RelayNode(path.join(root,'relay'),ri,{log(){},name:'Invited group'});
 const a=new SeedHostApplication(path.join(root,'a'),ai),b=new SeedHostApplication(path.join(root,'b'),bi);
 t.after(async()=>{await a.close();await b.close();await relay.close();await directory.close();await rm(root,{recursive:true,force:true});});
 await directory.listen();await relay.open();await relay.listen();await a.open();await b.open();
 await a.joinHostingGroup({code:(await relay.createInvite()).code,name:'Alice'});await relay.setOwner(ai.fingerprint);
 const endpoint={...directory.endpoint,fingerprint:di.fingerprint};
 const alice=new AccountIntegration(path.join(root,'a'),ai,vault,a,endpoint),bob=new AccountIntegration(path.join(root,'b'),bi,vault,b,endpoint);
 await alice.authenticate('register',{username:'alice',password:'fixture-alice-password'});await bob.authenticate('register',{username:'bob',password:'fixture-bob-password'});
 await alice.send('bob',{fingerprint:ri.fingerprint,serverId:null});const request=(await bob.requests())[0];
 return {root,a,b,bob,relay,request,ri,bi,di};
}
test('real username acceptance verifies exact pending membership, keeps unrelated worlds, and survives lost directory dismissal acknowledgement',async t=>{
 const {root,b,bob,relay,request,ri,bi,di}=await fixture(t);
 assert.equal((await bob.status()).directoryFingerprint,di.fingerprint,'notification scope must carry the exact pinned directory identity');
 const source=path.join(root,'unrelated');await mkdir(source);await writeFile(path.join(source,'eula.txt'),'eula=true');await writeFile(path.join(source,'world.dat'),'unrelated bytes');await b.importExisting(source,true);
 const before=(await b.getState()).server;
 const call=bob.client.call.bind(bob.client);bob.client.call=async(op,p)=>{const reply=await call(op,p);if(op==='dismiss')throw Object.assign(new Error('ack lost'),{code:'ECONNRESET'});return reply;};
 assert.deepEqual(await bob.accept(request.id),{joined:true,group:'Invited group',fingerprint:ri.fingerprint,serverId:null,requestId:request.id});
 const state=await b.getState();assert.equal(state.server.id,before.id);assert.equal(state.server.group,null);assert.equal(state.pendingGroups[0].fingerprint,ri.fingerprint);
 assert.equal(await readFile(path.join(before.serverDir,'world.dat'),'utf8'),'unrelated bytes');assert.equal((await bob.requests()).length,0);
 assert.ok((await relayFriends(bi,{...relay.endpoint,fingerprint:ri.fingerprint})).members.some(m=>m.fingerprint===bi.fingerprint&&m.you));
 await b.close();const reopened=new SeedHostApplication(path.join(root,'b'),bi);t.after(()=>reopened.close());await reopened.open();assert.equal((await reopened.listHostingGroups())[0].fingerprint,ri.fingerprint);
});
test('acceptance refuses a mismatched join identity even when that other group is durably recorded and reachable',async t=>{
 const {root,b,bob,request}=await fixture(t);
 const other=new RelayNode(path.join(root,'other'),await createIdentity(),{log(){},name:'Other'});await other.open();await other.listen();t.after(()=>other.close());
 const joined=await b.joinHostingGroup({code:(await other.createInvite()).code,name:'Bob'});
 b.joinHostingGroup=async()=>joined;
 await assert.rejects(bob.accept(request.id),/exact invitation|membership.*verified/i);
 assert.equal((await bob.requests())[0].id,request.id,'a mismatched readback never dismisses the invitation');
});
test('acceptance refuses mismatched saved helper endpoint without dropping durable membership or the request',async t=>{
 const {b,bob,request,ri}=await fixture(t);
 const read=b.getState.bind(b);b.getState=async()=>{const state=await read();state.peers=state.peers.map(p=>p.fingerprint===ri.fingerprint?{...p,host:'localhost'}:p);return state;};
 await assert.rejects(bob.accept(request.id),/membership.*verified/i);
 assert.equal((await bob.requests())[0].id,request.id);
 assert.equal((await read()).pendingGroups[0].fingerprint,ri.fingerprint,'enrollment stays durable despite rejected readback');
});
test('pre-fix pending membership without adoption provenance remains pending after reopen and unrelated import',async t=>{
 const {root,b,bob,request,bi}=await fixture(t);
 await bob.accept(request.id);
 delete b.saved.pendingGroups[0].adoptable;await b.persist();await b.close();
 const reopened=new SeedHostApplication(path.join(root,'b'),bi);t.after(()=>reopened.close());await reopened.open();
 const source=path.join(root,'later-import');await mkdir(source);await writeFile(path.join(source,'eula.txt'),'eula=true');await writeFile(path.join(source,'world.dat'),'unrelated');await reopened.importExisting(source,true);
 assert.equal((await reopened.getState()).server.group,null,'absence of provenance never authorizes attachment to a different world');
 assert.equal((await reopened.getState()).pendingGroups.length,1);
});
test('the claim this PC starts completes over a missing ownership record and applies the offer exactly once',async t=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR,'missing-ledger-claim-'));
 const [ri,ai,bi]=await Promise.all([createIdentity(),createIdentity(),createIdentity()]);
 const relay=new RelayNode(path.join(root,'relay'),ri,{log(){},name:'Invited group'});
 const a=new SeedHostApplication(path.join(root,'a'),ai),b=new SeedHostApplication(path.join(root,'b'),bi);
 t.after(async()=>{await a.close().catch(()=>{});await b.close().catch(()=>{});await relay.close().catch(()=>{});await rm(root,{recursive:true,force:true});});
 await relay.open();await relay.listen();await a.open();await b.open();
 const world=async(name,bytes)=>{const dir=path.join(root,name);await mkdir(dir);await writeFile(path.join(dir,'eula.txt'),'eula=true');await writeFile(path.join(dir,'world.dat'),bytes);return dir;};
 // The owner binds its world to the group and parks it there for another member to claim.
 await a.importExisting(await world('owner-world','owner bytes'),true);
 const ownerServer=(await a.getState()).server.id;
 await a.joinHostingGroup({code:(await relay.createInvite()).code,name:'Alice',serverId:ownerServer});
 await relay.setOwner(ai.fingerprint);
 await a.parkAtRelay();
 // The recipient's own world is bound to the same group, but its ownership record is gone.
 await b.importExisting(await world('local-world','local bytes'),true);
 const localServer=(await b.getState()).server.id;
 await b.joinHostingGroup({code:(await relay.createInvite()).code,name:'Bob',serverId:localServer});
 const active=b.saved.servers.find(entry=>entry.id===b.saved.activeServerId);
 await rm(active.ledgerFile,{force:true});
 // The tolerant read keeps state readable, and the claim the user started is the documented recovery path:
 // it completes exactly once into the already-selected world instead of stranding it.
 assert.equal((await b.getState()).servers.length,1);
 await b.claimFromRelay();
 const claimed=await b.getState();
 assert.equal(claimed.servers.length,1,'the claim does not append a second entry');
 assert.equal(claimed.server.ownership.state,'owned');
 assert.equal(claimed.server.ownership.generation,2,'the offer is applied once');
 assert.equal(await readFile(path.join(claimed.server.serverDir,'world.dat'),'utf8'),'owner bytes');
 await assert.rejects(b.claimFromRelay(),/already holds|nothing to claim/i,'a second claim never re-applies the offer');
});

test('an unsolicited handoff cannot manufacture authority when the selected world has no ownership record',async t=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR,'unsolicited-missing-ledger-'));
 const ia=await createIdentity(),ib=await createIdentity();let approvals=0;
 const a=new SeedHostApplication(path.join(root,'a'),ia);
 const b=new SeedHostApplication(path.join(root,'b'),ib,{confirmIncomingHandoff:async()=>{approvals++;return true;}});
 t.after(async()=>{await a.close().catch(()=>{});await b.close().catch(()=>{});await rm(root,{recursive:true,force:true});});
 const world=async(name,bytes)=>{const dir=path.join(root,name);await mkdir(dir);await writeFile(path.join(dir,'eula.txt'),'eula=true');await writeFile(path.join(dir,'world.bin'),bytes);return dir;};
 await a.open();await b.open();
 await a.importExisting(await world('a-source','alpha v1'),true);
 await b.importExisting(await world('b-source','bob local'),true);
 const localServer=(await b.getState()).server;
 await rm(b.saved.servers.find(entry=>entry.id===localServer.id).ledgerFile,{force:true});
 await a.startPeerListener();await b.startPeerListener();
 await a.addPeer({name:'B',fingerprint:ib.fingerprint,...(await b.getState()).peerEndpoint});
 await b.addPeer({name:'A',fingerprint:ia.fingerprint,...(await a.getState()).peerEndpoint});
 await assert.rejects(a.handoff(ib.fingerprint));
 assert.equal(approvals,0,'no approval is even offered for a handoff that cannot be verified');
 const after=await b.getState();
 assert.equal(after.servers.length,1,'nothing is appended or replaced');
 assert.equal(after.server.id,localServer.id);
 assert.equal(await readFile(path.join(localServer.serverDir,'world.bin'),'utf8'),'bob local','the local world is untouched');
 assert.equal(await readFile(path.join((await a.getState()).server.serverDir,'world.bin'),'utf8'),'alpha v1','the sender keeps its world');
});
test('recovery from an interrupted claim restores the world selected before it, not merely the first library entry',async t=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR,'activation-rollback-'));
 const identity=await createIdentity();
 const app=new SeedHostApplication(path.join(root,'profile'),identity);
 t.after(async()=>{await app.close().catch(()=>{});await rm(root,{recursive:true,force:true});});
 await app.open();
 const first=path.join(root,'first-world'),second=path.join(root,'second-world');
 for(const source of [first,second]){await mkdir(source);await writeFile(path.join(source,'eula.txt'),'eula=true');await writeFile(path.join(source,'world.dat'),path.basename(source));}
 // Import the world that must END UP second in the library first, so "restore entry 0" and
 // "restore the previous selection" are observably different behaviours.
 await app.importExisting(second,true);
 await app.importExisting(first,true);
 const before=await app.getState();
 const previousActiveId=before.server.id;
 assert.notEqual(before.servers[0].id,previousActiveId,'precondition: the selection is not the first entry');
 // Publish a claimed entry with a journal and no ownership record, exactly as an interrupted claim leaves it.
 const previousEntry=app.saved.servers.find(entry=>entry.id===previousActiveId);
 const pending={fingerprint:'a'.repeat(64),parkOnStop:false,relayName:'Invited group',since:Date.now(),adoptable:false};
 const candidate={...structuredClone(previousEntry),id:'f'.repeat(32),serverDir:path.join(root,'managed','servers','claimed'),ledgerFile:path.join(root,'ownership-interrupted.sqlite'),group:{fingerprint:pending.fingerprint,parkOnStop:false}};
 // A bound group and a pending group both require their relay to be a trusted peer in the same state file.
 app.saved.peers=[...app.saved.peers,{name:'Invited group',fingerprint:pending.fingerprint,host:'127.0.0.1',port:47627}];
 app.saved.servers.push(candidate);app.saved.activeServerId=candidate.id;
 app.saved.activation={serverId:candidate.id,pending,previousActiveServerId:previousActiveId};
 await app.persist();await app.close();
 const reopened=new SeedHostApplication(path.join(root,'profile'),identity);t.after(()=>reopened.close());await reopened.open();
 const state=await reopened.getState();
 assert.equal(state.servers.some(entry=>entry.id===candidate.id),false,'the uncredentialed append is rolled back');
 assert.equal(state.pendingGroups.some(entry=>entry.fingerprint===pending.fingerprint),true,'the pending group is restored for a later download');
 assert.equal(state.server.id,previousActiveId,'the world selected before the interrupted claim is active again');
});
test('an interrupted claim whose ledger file exists but holds no record still rolls back',async t=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR,'activation-empty-ledger-'));
 const identity=await createIdentity();
 const app=new SeedHostApplication(path.join(root,'profile'),identity);
 t.after(async()=>{await app.close().catch(()=>{});await rm(root,{recursive:true,force:true});});
 await app.open();
 const source=path.join(root,'only-world');await mkdir(source);await writeFile(path.join(source,'eula.txt'),'eula=true');await writeFile(path.join(source,'world.dat'),'world bytes');
 await app.importExisting(source,true);
 const previousActiveId=(await app.getState()).server.id;
 const previousEntry=app.saved.servers.find(entry=>entry.id===previousActiveId);
 const pending={fingerprint:'b'.repeat(64),parkOnStop:false,relayName:'Invited group',since:Date.now(),adoptable:false};
 // The created-but-uncommitted window: the ledger FILE exists (sqlite created its schema) with no acceptance row.
 const ledgerFile=path.join(root,'ownership-schema-only.sqlite');await writeFile(ledgerFile,'');
 const candidate={...structuredClone(previousEntry),id:'e'.repeat(32),serverDir:path.join(root,'managed','servers','claimed'),ledgerFile,group:{fingerprint:pending.fingerprint,parkOnStop:false}};
 app.saved.peers=[...app.saved.peers,{name:'Invited group',fingerprint:pending.fingerprint,host:'127.0.0.1',port:47627}];
 app.saved.servers.push(candidate);app.saved.activeServerId=candidate.id;
 app.saved.activation={serverId:candidate.id,pending,previousActiveServerId:previousActiveId};
 await app.persist();await app.close();
 const reopened=new SeedHostApplication(path.join(root,'profile'),identity);t.after(()=>reopened.close());await reopened.open();
 const state=await reopened.getState();
 assert.equal(state.servers.some(entry=>entry.id===candidate.id),false,'a ledger with no acceptance row is not a recorded acceptance');
 assert.equal(state.pendingGroups.some(entry=>entry.fingerprint===pending.fingerprint),true);
 assert.equal(state.server.id,previousActiveId);
});

test('an unreadable ownership record for a journaled claim never aborts startup and keeps the journal',async t=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR,'activation-unreadable-'));
 const identity=await createIdentity();
 const app=new SeedHostApplication(path.join(root,'profile'),identity);
 t.after(async()=>{await app.close().catch(()=>{});await rm(root,{recursive:true,force:true});});
 await app.open();
 const source=path.join(root,'healthy-world');await mkdir(source);await writeFile(path.join(source,'eula.txt'),'eula=true');await writeFile(path.join(source,'world.dat'),'healthy bytes');
 await app.importExisting(source,true);
 const healthyId=(await app.getState()).server.id;
 const healthyEntry=app.saved.servers.find(entry=>entry.id===healthyId);
 const pending={fingerprint:'c'.repeat(64),parkOnStop:false,relayName:'Invited group',since:Date.now(),adoptable:false};
 // A journaled append whose ledger cannot be read at all (here: legacy JSON bytes, refused by design) while the
 // user's selected world is healthy. Startup must survive and keep the journal rather than fail to open.
 const ledgerFile=path.join(root,'ownership-unreadable.sqlite');await writeFile(ledgerFile,'{"legacy":true}');
 const candidate={...structuredClone(healthyEntry),id:'d'.repeat(32),serverDir:path.join(root,'managed','servers','claimed'),ledgerFile,group:{fingerprint:pending.fingerprint,parkOnStop:false}};
 app.saved.peers=[...app.saved.peers,{name:'Invited group',fingerprint:pending.fingerprint,host:'127.0.0.1',port:47627}];
 app.saved.servers.push(candidate);app.saved.activeServerId=candidate.id;
 app.saved.activation={serverId:candidate.id,pending,previousActiveServerId:healthyId};
 await app.persist();await app.close();
 const reopened=new SeedHostApplication(path.join(root,'profile'),identity);t.after(()=>reopened.close());
 await reopened.open();
 assert.ok(reopened.saved.activation,'the journal is kept for a later attempt instead of being discarded');
 assert.equal(reopened.saved.servers.some(entry=>entry.id===candidate.id),true,'nothing is invented and nothing is destroyed while the record is unreadable');
 assert.equal((await reopened.getState()).server.ownership.state,'unknown','corrupt active authority stays fenced');
 await assert.rejects(reopened.startServer(true));
 await reopened.selectServer(healthyId);
 assert.equal((await reopened.getState()).server.id,healthyId,'healthy worlds remain accessible');
});
test('recovery never lists the same pending group twice when the state file already carried it',async t=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR,'activation-duplicate-pending-'));
 const identity=await createIdentity();
 const app=new SeedHostApplication(path.join(root,'profile'),identity);
 t.after(async()=>{await app.close().catch(()=>{});await rm(root,{recursive:true,force:true});});
 await app.open();
 const source=path.join(root,'world');await mkdir(source);await writeFile(path.join(source,'eula.txt'),'eula=true');await writeFile(path.join(source,'world.dat'),'bytes');
 await app.importExisting(source,true);
 const activeId=(await app.getState()).server.id;
 const entry=app.saved.servers.find(item=>item.id===activeId);
 const pending={fingerprint:'d'.repeat(64),parkOnStop:false,relayName:'Invited group',since:Date.now(),adoptable:false};
 // A hand-edited or partially written file can already list the group the journal is about to restore.
 const ledgerFile=path.join(root,'ownership-absent.sqlite');
 const candidate={...structuredClone(entry),id:'a'.repeat(32),serverDir:path.join(root,'managed','servers','claimed'),ledgerFile,group:{fingerprint:pending.fingerprint,parkOnStop:false}};
 app.saved.peers=[...app.saved.peers,{name:'Invited group',fingerprint:pending.fingerprint,host:'127.0.0.1',port:47627}];
 app.saved.pendingGroups=[...app.saved.pendingGroups,pending];
 app.saved.servers.push(candidate);app.saved.activeServerId=candidate.id;
 app.saved.activation={serverId:candidate.id,pending,previousActiveServerId:activeId};
 await app.persist();await app.close();
 const reopened=new SeedHostApplication(path.join(root,'profile'),identity);t.after(()=>reopened.close());await reopened.open();
 const state=await reopened.getState();
 assert.equal(state.pendingGroups.filter(group=>group.fingerprint===pending.fingerprint).length,1,'the restored group is listed exactly once');
 assert.equal(state.server.id,activeId);
});



