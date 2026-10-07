import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createIdentity} from '../dist/src/core/peer-transport.js';
import {AccountService,AccountClient} from '../dist/src/core/accounts.js';
import {AccountIntegration} from '../dist/src/core/account-integration.js';
import {encodeInvite} from '../dist/src/core/invites.js';
import {randomBytes} from 'node:crypto';
const password='fixture-only-password';
async function fixture(t){
 const root=await mkdtemp(path.join(process.env.TMPDIR,'social-'));
 const identities=await Promise.all(Array.from({length:4},()=>createIdentity()));
 let service=new AccountService(path.join(root,'directory'),identities[0]);await service.listen({host:'127.0.0.1'});
 const endpoint=()=>({...service.endpoint,fingerprint:identities[0].fingerprint});
 const app=new Proxy({}, {get(){return ()=>{throw new Error('Friendship must not call hosting application');};}});
 const vault={encrypt:v=>Buffer.from(v),decrypt:v=>v.toString()};
 const integrations=identities.slice(1).map((i,n)=>new AccountIntegration(path.join(root,'profile'+n),i,vault,app,endpoint()));
 for(const [n,username] of ['alice','bob','carol'].entries())await integrations[n].authenticate('register',{username,password});
 const db=new DatabaseSync(path.join(root,'directory','accounts.sqlite'));
 t.after(async()=>{db.close();await service.close();await rm(root,{recursive:true,force:true});});
 return {root,identities,integrations,db,get service(){return service;},endpoint,async restart(){await service.close();service=new AccountService(path.join(root,'directory'),identities[0]);await service.listen({host:'127.0.0.1'});return identities.slice(1).map((i,n)=>new AccountIntegration(path.join(root,'profile'+n),i,vault,app,endpoint()));}};
}
test('ordinary send persists an account request without hosting authority',async t=>{
 const f=await fixture(t),[alice,bob]=f.integrations;
 assert.deepEqual(await alice.socialFriends(),[]);
 const sent=await alice.socialSend('BOB');assert.equal(sent.sent,true);assert.equal(sent.username,'bob');assert.match(sent.id,/^[a-f0-9-]{36}$/);
 const inbox=await bob.socialRequests();assert.equal(inbox.length,1);assert.deepEqual(Object.keys(inbox[0]).sort(),['expiresAt','from','id']);assert.equal(inbox[0].from,'alice');assert.equal(inbox[0].id,sent.id);
 assert.deepEqual(await bob.socialFriends(),[]);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n,0);
 const [,restored]=await f.restart();assert.deepEqual(await restored.socialRequests(),inbox);
});
test('recipient accepts reciprocal durable friendship and can remove or decline independently',async t=>{
 const f=await fixture(t),[alice,bob,carol]=f.integrations;
 const sent=await alice.socialSend('bob');
 await assert.rejects(carol.socialAccept(sent.id),/not found/);
 assert.deepEqual(await bob.socialAccept(sent.id),{added:true,username:'alice'});
 const friends=await bob.socialFriends();assert.equal(friends[0].username,'alice');assert.equal(typeof friends[0].since,'number');
 assert.deepEqual(await alice.socialFriends(),[{username:'bob',since:friends[0].since}]);
 assert.deepEqual(await bob.socialRequests(),[]);
 const [ra,rb]=await f.restart();assert.deepEqual(await rb.socialFriends(),friends);
 assert.deepEqual(await ra.socialRemove('BOB'),{removed:true,username:'bob'});
 assert.deepEqual(await rb.socialFriends(),[]);
 const another=await ra.socialSend('bob');
 assert.deepEqual(await rb.socialDecline(another.id),{declined:true,id:another.id});
 assert.deepEqual(await rb.socialRequests(),[]);assert.deepEqual(await ra.socialFriends(),[]);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n,0);
});
test('rename atomically preserves reciprocal friends and pending requests in both directions',async t=>{
 const f=await fixture(t),[alice,bob,carol]=f.integrations;
 const sent=await alice.socialSend('bob');await bob.socialAccept(sent.id);
 const since=(await bob.socialFriends())[0].since;
 const outgoing=await alice.socialSend('carol');
 const incoming=await carol.socialSend('bob');
 await bob.updateProfile({username:'bob_new',currentPassword:password});
 assert.deepEqual(await alice.socialFriends(),[{username:'bob_new',since}]);
 assert.equal((await bob.socialRequests())[0].id,incoming.id);
 await alice.updateProfile({username:'alice_new',currentPassword:password});
 assert.deepEqual(await bob.socialFriends(),[{username:'alice_new',since}]);
 assert.deepEqual((await carol.socialRequests()).map(r=>[r.id,r.from]),[[outgoing.id,'alice_new']]);
 assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length,0);
 const before=['accounts','sessions','requests','friend_requests','account_friends'].map(table=>f.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all());
 f.db.exec("CREATE TRIGGER fail_social_rename BEFORE UPDATE OF friend ON account_friends BEGIN SELECT RAISE(ABORT,'fixture friend migration refusal'); END;");
 await assert.rejects(alice.updateProfile({username:'alice_again',currentPassword:password}),/may have changed/);
 assert.deepEqual(['accounts','sessions','requests','friend_requests','account_friends'].map(table=>f.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()),before);
});
test('authenticated social mutations are rate limited per account',async t=>{
 const f=await fixture(t),[alice]=f.integrations;
 for(let n=0;n<30;n++)await assert.rejects(alice.socialSend('alice'),/yourself/);
 await assert.rejects(alice.socialSend('bob'),/Too many requests/);
 assert.deepEqual(await alice.socialFriends(),[]);assert.deepEqual(await f.integrations[1].socialRequests(),[]);
});
test('unsigned integration rejects locally without an uncertain mutation claim',async t=>{
 const f=await fixture(t);
 const unsigned=new AccountIntegration(path.join(f.root,'unsigned'),f.identities[1],{encrypt:v=>Buffer.from(v),decrypt:v=>v.toString()},{},f.endpoint());
 await assert.rejects(unsigned.socialSend('bob'),/^Error: Sign in first$/);
});
test('self, duplicates, stolen-device tokens, wrong recipients and expired requests fail closed',async t=>{
 const f=await fixture(t),[alice,bob,carol]=f.integrations;
 const token=JSON.parse(await readFile(path.join(f.root,'profile0','account.enc'),'utf8')).token;
 const wrong=new AccountClient(f.identities[3],f.endpoint());
 for(const op of ['friend-list','friend-inbox','friend-send','friend-accept','friend-decline','friend-remove']){
  await assert.rejects(wrong.call(op,{token,username:'bob',id:'00000000-0000-0000-0000-000000000000'}),/Sign in again/);
  await assert.rejects(wrong.call(op,{}),/Sign in again/);
 }
 await assert.rejects(alice.socialSend('alice'),/yourself/);await assert.rejects(alice.socialSend('missing'),/does not exist/);
 const sent=await alice.socialSend('bob');
 await assert.rejects(alice.socialSend('bob'),/already waiting/);await assert.rejects(bob.socialSend('alice'),/already waiting/);
 const ct=JSON.parse(await readFile(path.join(f.root,'profile2','account.enc'),'utf8')).token;
 for(const op of ['friend-accept','friend-decline'])await assert.rejects(wrong.call(op,{token:ct,id:sent.id}),/not found/);
 f.db.prepare('UPDATE friend_requests SET expires=? WHERE id=?').run(Date.now()-1,sent.id);
 assert.deepEqual(await bob.socialRequests(),[]);
 const bt=JSON.parse(await readFile(path.join(f.root,'profile1','account.enc'),'utf8')).token;
 await assert.rejects(new AccountClient(f.identities[2],f.endpoint()).call('friend-accept',{token:bt,id:sent.id}),/not found/);
 const next=await alice.socialSend('bob');await bob.socialAccept(next.id);
 await assert.rejects(alice.socialSend('bob'),/Already friends/);
 await assert.rejects(bob.socialAccept(next.id),/not found/);
 await assert.rejects(carol.socialRemove('alice'),/Friend not found/);
});
test('lost or malformed TLS mutation acknowledgments never cause a replay or optimistic success',async t=>{
 for(const operation of ['send','accept','decline','remove'])for(const fault of ['lost','malformed'])await t.test(operation+' '+fault,async t=>{
  const f=await fixture(t),[alice,bob]=f.integrations;
  let id;if(operation!=='send')id=(await alice.socialSend('bob')).id;
  if(operation==='remove')await bob.socialAccept(id);
  const perform=f.service.perform.bind(f.service),handle=f.service.handle.bind(f.service);let socket,mutations=0;
  f.service.handle=(s,fp)=>{socket=s;return handle(s,fp);};
  const rpc='friend-'+operation;
  f.service.perform=async(op,...args)=>{const result=await perform(op,...args);if(op===rpc){mutations++;if(fault==='lost')socket.destroy();else return {bogus:true};}return result;};
  const action=operation==='send'?()=>alice.socialSend('bob'):operation==='accept'?()=>bob.socialAccept(id):operation==='decline'?()=>bob.socialDecline(id):()=>alice.socialRemove('bob');
  await assert.rejects(action(),/may have changed.*[Rr]efresh/);assert.equal(mutations,1);
  if(operation==='send')assert.equal((await bob.socialRequests()).length,1);
  else if(operation==='accept')assert.equal((await bob.socialFriends())[0].username,'alice');
  else if(operation==='decline')assert.deepEqual(await bob.socialRequests(),[]);
  else assert.deepEqual(await bob.socialFriends(),[]);
 });
});
test('successful mutation acknowledgment requires authoritative, shape-validated readback',async t=>{
 for(const fault of ['missing','malformed','error'])await t.test(fault,async t=>{
  const f=await fixture(t),[alice,bob]=f.integrations,perform=f.service.perform.bind(f.service);let mutations=0;
  f.service.perform=async(op,...args)=>{
   const result=await perform(op,...args);if(op==='friend-send')mutations++;
   if(op==='friend-inbox'&&args[0].token===JSON.parse(await readFile(path.join(f.root,'profile0','account.enc'),'utf8')).token){
    if(fault==='missing')return {requests:[],sent:[]};
    if(fault==='malformed')return {requests:[],sent:[{id:result.sent[0].id,username:'BOB',expiresAt:Date.now()+1000}]};
    throw new Error('fixture readback failure');
   }return result;
  };
  await assert.rejects(alice.socialSend('bob'),/may have changed.*verification failed/);assert.equal(mutations,1);assert.equal((await bob.socialRequests()).length,1);
 });
});
test('legacy SQLite migration retains all existing account, session and hosting request rows',async t=>{
 const f=await fixture(t);
 const token=JSON.parse(await readFile(path.join(f.root,'profile0','account.enc'),'utf8')).token;
 const code=encodeInvite({relayFingerprint:f.identities[0].fingerprint,host:'127.0.0.1',port:4567,token:randomBytes(16),expiresAt:Math.floor(Date.now()/1000)+3600,relayName:'Legacy fixture group'});
 await new AccountClient(f.identities[1],f.endpoint()).call('send',{token,username:'bob',fingerprint:f.identities[2].fingerprint,code});
 const before=['accounts','sessions','requests'].map(table=>f.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
 f.db.exec('DROP TABLE account_friends; DROP TABLE friend_requests;');
 const [alice]=await f.restart();assert.equal((await alice.status()).username,'alice');assert.deepEqual(await alice.socialFriends(),[]);
 assert.deepEqual(['accounts','sessions','requests'].map(table=>f.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()),before);
});
test('friends and pending requests are account-level across independently authenticated devices',async t=>{
 const f=await fixture(t),[alice,bob,carol]=f.integrations;
 const request=await alice.socialSend('bob');await bob.socialAccept(request.id);
 const pending=await carol.socialSend('alice');
 const identity=await createIdentity(),root=path.join(f.root,'second-alice');
 const second=new AccountIntegration(root,identity,{encrypt:v=>Buffer.from(v),decrypt:v=>v.toString()},new Proxy({},{get(){throw new Error('No device trust or hosting access');}}),f.endpoint());
 await second.authenticate('login',{username:'alice',password});
 assert.deepEqual(await second.socialFriends(),await alice.socialFriends());
 assert.equal((await second.socialRequests())[0].id,pending.id);
 await second.socialAccept(pending.id);assert.equal((await carol.socialFriends())[0].username,'alice');
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n,0);
 const before=await readFile(path.join(root,'account.enc'));
 await alice.updateProfile({username:'alice_new',currentPassword:password});
 assert.deepEqual(await second.socialFriends(),await alice.socialFriends());
 assert.deepEqual(await readFile(path.join(root,'account.enc')),before,'reads never overwrite a cached session after remote rename');
});