import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {SeedHostApplication} from '../dist/src/core/application.js';
import {RelayNode} from '../dist/src/core/relay.js';
import {createIdentity} from '../dist/src/core/peer-transport.js';
import * as client from '../dist/src/core/relay-client.js';
import {OwnershipLedger} from '../dist/src/core/ownership.js';
async function setup(t){const root=await mkdtemp(path.join(process.env.TMPDIR,'seed-disband-'));const identity=await createIdentity(),owner=await createIdentity(),member=await createIdentity();const relay=new RelayNode(root,identity,{log:()=>{}});await relay.open();await relay.trust('Owner',owner.fingerprint);await relay.setOwner(owner.fingerprint);await relay.trust('Member',member.fingerprint);await relay.listen();const peer={fingerprint:identity.fingerprint,...relay.endpoint};t.after(async()=>{await relay.close();await rm(root,{recursive:true,force:true});});return {root,identity,owner,member,relay,peer};}
test('selected server disband retains local world backups trusted peers and account bytes across reopen',async t=>{
 const {root,owner,relay,peer}=await setup(t);const source=path.join(root,'source');await mkdir(source);await writeFile(path.join(source,'eula.txt'),'eula=true\n');await writeFile(path.join(source,'world.dat'),'unchanged');
 const app=new SeedHostApplication(path.join(root,'profile'),owner);await app.open();t.after(()=>app.close());assert.equal(typeof app.disbandGroup,'function');await app.importExisting(source,true);const selected=(await app.getState()).server;
 const invitation=await relay.createInvite({recipient:owner.fingerprint});  await app.joinWithInvite({code:invitation.code,name:'Owner'});await app.saveRelay({fingerprint:peer.fingerprint,parkOnStop:false});assert.ok((await app.getState()).pendingGroups.some(g=>g.fingerprint===peer.fingerprint));await writeFile(path.join(root,'profile','account.enc'),'unchanged account');
 await assert.rejects(app.disbandGroup('f'.repeat(32),peer.fingerprint),/selected|changed/i);await assert.rejects(app.disbandGroup(selected.id,'e'.repeat(64)),/group|changed/i);
 await app.saveProfile({executable:process.execPath,args:[path.resolve('tools/fake-java-server.mjs'),'--lifetime-ms=30000']});await app.startServer(true);await assert.rejects(app.disbandGroup(selected.id,peer.fingerprint),/stop/i);await app.stopServer();
 // Stop may park on the relay: take local custody back before disbanding.
 if((await app.getState()).server.ownership.state!=='owned')await app.claimFromRelay();
 const before=await app.listSnapshots();const peers=(await app.getState()).peers;
 await app.disbandGroup(selected.id,peer.fingerprint);assert.equal((await app.getState()).relay,null);assert.equal((await app.getState()).pendingGroups.some(g=>g.fingerprint===peer.fingerprint),false,'a revoked pending group cannot attach to a later world');assert.deepEqual((await app.getState()).peers,peers);assert.deepEqual(await app.listSnapshots(),before);
 assert.equal(await readFile(path.join(selected.serverDir,'world.dat'),'utf8'),'unchanged');assert.equal(await readFile(path.join(root,'profile','account.enc'),'utf8'),'unchanged account');
 await app.close();const reopened=new SeedHostApplication(path.join(root,'profile'),owner);await reopened.open();t.after(()=>reopened.close());assert.equal((await reopened.getState()).relay,null);assert.equal((await reopened.getState()).server.ownership.state,'owned');
});

test('real group disband revokes members and every invitation durably without erasing stored files',async t=>{
 const {root,owner,member,relay,peer}=await setup(t);assert.equal(typeof client.relayDisbandGroup,'function');
 const invitation=await relay.createInvite();await mkdir(path.join(root,'store'),{recursive:true});await writeFile(path.join(root,'store','keep-backup'),'bytes');
 await assert.rejects(client.relayDisbandGroup(member,peer),/owner/i);
 await client.relayDisbandGroup(owner,peer);
 assert.equal((await client.relayDisbandStatus(owner,peer)).disbanded,true);
 assert.equal(await readFile(path.join(root,'store','keep-backup'),'utf8'),'bytes');
 await assert.rejects(client.relayFriends(member,peer),/denied|refused|untrusted/i);await assert.rejects(client.joinRelayInvite(await createIdentity(),invitation.code,'Late'),/expired|revoked|denied|unavailable/i);
 await relay.close();const again=new RelayNode(root,relay.identity,{log:()=>{}});await again.open();await again.listen();t.after(()=>again.close());
 assert.equal((await client.relayDisbandStatus(owner,{fingerprint:relay.identity.fingerprint,...again.endpoint})).disbanded,true);
 assert.deepEqual(JSON.parse(await readFile(path.join(root,'relay.json'),'utf8')).trusted,[]);
});
test('disband waits for admitted public mutations and refuses queued mutations after revocation',async t=>{
 const {owner,member,relay,peer}=await setup(t);await relay.listenGame({host:'127.0.0.1',port:0});
 let release,admitted;const started=new Promise(resolve=>admitted=resolve),blocked=new Promise(resolve=>release=resolve);let mutations=0;
 const status={state:'reachable',address:'fixture.tun.ply.gg',detail:'fixture',approveUrl:null};
 relay.publicAddress={close:async()=>{},enable:async()=>{admitted();await blocked;mutations++;return status;},disable:async()=>{mutations++;return status;},refresh:async()=>status};
 const first=client.relayPublic(member,peer,'public-enable');await started;t.after(()=>release());first.catch(()=>{});
 let acknowledged=false;const disband=client.relayDisbandGroup(owner,peer).then(()=>{acknowledged=true;});
 await new Promise(resolve=>setTimeout(resolve,100));const earlyAcknowledgement=acknowledged;
 const late=client.relayPublic(member,peer,'public-disable');const rejected=assert.rejects(late,/untrusted|refused|denied/i);
 release();await first;await disband;await rejected;assert.equal(mutations,1);
 assert.equal(earlyAcknowledgement,false,'revocation acknowledgement must drain admitted mutations');
 assert.equal((await client.relayDisbandStatus(owner,peer)).disbanded,true);
});

test('disband refuses relay-owned, remote-owned and pending handoff custody without revocation',async t=>{
 const {root,identity,owner,member,relay,peer}=await setup(t);assert.equal(typeof client.relayDisbandGroup,'function');
 const ledger=new OwnershipLedger(path.join(root,'ownership.sqlite'),identity.fingerprint);await ledger.initialize('a'.repeat(64));
 await assert.rejects(client.relayDisbandGroup(owner,peer),/world|custody|hand/i);
 const offer=await ledger.prepareTransfer(member.fingerprint,'a'.repeat(64));await assert.rejects(client.relayDisbandGroup(owner,peer),/world|custody|hand/i);await ledger.confirmTransfer(offer.id,member.fingerprint);
 await assert.rejects(client.relayDisbandGroup(owner,peer),/world|custody|hand/i);
 assert.equal((await client.relayFriends(member,peer)).members.length,2);
});
