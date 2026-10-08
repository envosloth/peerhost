import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createIdentity} from '../dist/src/core/peer-transport.js';
import {AccountService,AccountClient} from '../dist/src/core/accounts.js';
import {encodeInvite,decodeInvite} from '../dist/src/core/invites.js';
async function fixture(t){
 const root=await mkdtemp(path.join(process.env.TMPDIR,'invite-delivery-'));
 const [di,ai,bi]=await Promise.all([createIdentity(),createIdentity(),createIdentity()]);
 const service=new AccountService(root,di);await service.listen();
 t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
 const ep={...service.endpoint,fingerprint:di.fingerprint};
 const alice=new AccountClient(ai,ep),bob=new AccountClient(bi,ep);
 const a=await alice.call('register',{username:'alice',password:randomBytes(16).toString('hex')});
 const b=await bob.call('register',{username:'bob',password:randomBytes(16).toString('hex')});
 // Synthetic invitation envelopes: these tests verify real directory delivery, not relay redemption.
 const code=(pin,host='127.0.0.1')=>encodeInvite({relayFingerprint:pin,relayName:'Fixture group',host,port:8443,token:randomBytes(16),expiresAt:Math.floor(Date.now()/1000)+3600});
 return {service,alice,bob,a,b,bi,code,send:code=>alice.call('send',{token:a.token,username:'bob',fingerprint:bi.fingerprint,code}),inbox:()=>bob.call('inbox',{token:b.token})};
}
test('independent hosting groups can have simultaneous invitations for the same friend device',async t=>{
 const f=await fixture(t),codeA=f.code('a'.repeat(64)),codeB=f.code('b'.repeat(64));
 const a=await f.send(codeA),b=await f.send(codeB);
 assert.notEqual(a.id,b.id);
 const rows=(await f.inbox()).requests;
 assert.deepEqual(new Set(rows.map(r=>decodeInvite(r.code).relayFingerprint)),new Set(['a'.repeat(64),'b'.repeat(64)]));
});
test('resending after a route correction replaces only the same group request with a fresh ID',async t=>{
 const f=await fixture(t),pin='a'.repeat(64);
 const old=await f.send(f.code(pin)),other=await f.send(f.code('b'.repeat(64)));
 const replacementCode=f.code(pin,'public.example');
 const fresh=await f.send(replacementCode);
 assert.notEqual(fresh.id,old.id,'cached old acceptance must not redeem a silently changed invitation');
 const rows=(await f.inbox()).requests;
 assert.equal(rows.length,2);assert(rows.some(r=>r.id===other.id));
 assert.equal(rows.find(r=>r.id===fresh.id).code,replacementCode);
 await assert.rejects(f.bob.call('request',{token:f.b.token,id:old.id}),/not found/);
 assert.deepEqual(await f.send(replacementCode),fresh,'retrying the exact delivery is idempotent');
});
