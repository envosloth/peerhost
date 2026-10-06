import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { AccountService, AccountClient } from '../dist/src/core/accounts.js';
import { AccountIntegration } from '../dist/src/core/account-integration.js';
import { encodeInvite } from '../dist/src/core/invites.js';

const password = 'fixture-current-password';
const replacement = 'fixture-replacement-password';
function vault() {
  const key = randomBytes(32);
  return {
    encrypt(v) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv,c.update(v),c.final(),c.getAuthTag()]); },
    decrypt(v) { const c = createDecipheriv('aes-256-gcm', key, v.subarray(0,12)); c.setAuthTag(v.subarray(-16)); return c.update(v.subarray(12,-16),undefined,'utf8')+c.final('utf8'); }
  };
}
async function fixture(t) {
  const root = await mkdtemp(path.join(process.env.TMPDIR,'account-profile-'));
  const identities = await Promise.all(Array.from({length:4},()=>createIdentity()));
  const service = new AccountService(path.join(root,'directory'),identities[0]);
  await service.listen({host:'127.0.0.1'});
  const endpoint = {...service.endpoint,fingerprint:identities[0].fingerprint};
  const clients = identities.slice(1).map(i=>new AccountClient(i,endpoint));
  const db = new DatabaseSync(path.join(root,'directory','accounts.sqlite'));
  t.after(async()=>{db.close();await service.close();await rm(root,{recursive:true,force:true});});
  return {root,identities,service,endpoint,clients,db};
}
function invite(f, host='127.0.0.1') {
  return encodeInvite({relayFingerprint:f.identities[0].fingerprint,host,port:4567,token:randomBytes(16),expiresAt:Math.floor(Date.now()/1000)+3600,relayName:'Fixture group'});
}
function snapshot(db) {
  return ['accounts','sessions','requests'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().map(r=>({...r})));
}
async function integration(f) {
  const v=vault(),root=path.join(f.root,'profile');
  const app=new AccountIntegration(root,f.identities[1],v,{},f.endpoint);
  await app.authenticate('register',{username:'alice',password});
  return {app,v,root};
}

test('a second signed-in PC follows an authenticated rename without treating it as offline',async t=>{
  const f=await fixture(t),first=await integration(f),v=vault(),root=path.join(f.root,'second-profile');
  const second=new AccountIntegration(root,f.identities[2],v,{},f.endpoint);
  await second.authenticate('login',{username:'alice',password});
  await first.app.updateProfile({username:'alice_new',currentPassword:password});
  const status=await second.status();
  assert.equal(status.online,true);
  assert.equal(status.username,'alice_new');
  assert.equal((await new AccountIntegration(root,f.identities[2],v,{},f.endpoint).status()).username,'alice_new');
});

test('integration persists a verified profile and returns status without secrets',async t=>{
  const f=await fixture(t),{app,v,root}=await integration(f);
  const before=JSON.parse(v.decrypt(await readFile(path.join(root,'account.enc'))));
  const status=await app.updateProfile({username:'ALICE_NEW',currentPassword:password,newPassword:replacement});
  assert.equal(status.username,'alice_new');
  assert.equal(status.signedIn,true);assert.equal(status.online,true);
  assert.equal('token' in status,false);assert.equal('password' in status,false);assert.equal('currentPassword' in status,false);
  const saved=JSON.parse(v.decrypt(await readFile(path.join(root,'account.enc'))));
  assert.deepEqual(saved,{...before,username:'alice_new'});
  assert.equal((await new AccountIntegration(root,f.identities[1],v,{},f.endpoint).status()).username,'alice_new');
  const bytes=await readFile(path.join(root,'account.enc'));
  for(const value of ['alice_new',password,replacement,before.token])assert.ok(!bytes.includes(Buffer.from(value)));
}
);

test('lost profile reply reports an uncertain outcome without replaying the mutation or claiming password success',async t=>{
  const f=await fixture(t),{app,root}=await integration(f);
  const before=await readFile(path.join(root,'account.enc'));
  const perform=f.service.perform.bind(f.service),handle=f.service.handle.bind(f.service);
  let mutations=0,socket;
  f.service.handle=(s,fp)=>{socket=s;return handle(s,fp);};
  f.service.perform=async(op,...args)=>{
    const result=await perform(op,...args);
    if(op==='update-profile'){mutations++;socket.destroy();}
    return result;
  };
  await assert.rejects(app.updateProfile({username:'alice_new',currentPassword:password,newPassword:replacement}),/may have changed.*sign in/i);
  assert.equal(mutations,1);
  assert.deepEqual(await readFile(path.join(root,'account.enc')),before);
  assert.equal(snapshot(f.db)[0][0].username,'alice_new','server committed before the real TLS socket lost its reply');
  const loggedIn=await f.clients[1].call('login',{username:'alice_new',password:replacement});
  assert.equal(loggedIn.username,'alice_new');
});

test('malformed raw TLS acknowledgments after commit are uncertain, never safe-to-retry refusals',async t=>{
  for(const kind of ['empty','oversized','utf8'])await t.test(kind,async t=>{
    const f=await fixture(t),{app}=await integration(f);
    const perform=f.service.perform.bind(f.service),handle=f.service.handle.bind(f.service);let socket,mutations=0;
    f.service.handle=(s,fp)=>{socket=s;return handle(s,fp);};
    f.service.perform=async(op,...args)=>{
      const result=await perform(op,...args);
      if(op==='update-profile'){
        mutations++;const header=Buffer.alloc(4);header.writeUInt32BE(kind==='empty'?0:kind==='oversized'?262145:1);
        socket.write(kind==='utf8'?Buffer.concat([header,Buffer.from([255])]):header);socket.end();
      }
      return result;
    };
    await assert.rejects(app.updateProfile({username:'alice_new',currentPassword:password}),/may have changed.*sign in/i);
    assert.equal(mutations,1);assert.equal(snapshot(f.db)[0][0].username,'alice_new');
  });
});

test('rename atomically migrates sessions and both invitation directions without changing device authority or credentials',async t=>{
  const f=await fixture(t),[alice,second,bob]=f.clients;
  const a=await alice.call('register',{username:'alice',password});
  const s=await second.call('login',{username:'alice',password});
  const b=await bob.call('register',{username:'bob',password});
  await alice.call('send',{token:a.token,username:'bob',fingerprint:f.identities[3].fingerprint,code:invite(f)});
  await bob.call('send',{token:b.token,username:'alice',fingerprint:f.identities[1].fingerprint,code:invite(f)});
  const before=snapshot(f.db);
  const result=await alice.call('update-profile',{token:a.token,username:'ALICE_NEW',currentPassword:password});
  assert.deepEqual(result,{username:'alice_new'});
  const after=snapshot(f.db);
  assert.deepEqual(after[0],before[0].map(r=>({...r,username:r.username==='alice'?'alice_new':r.username})).sort((a,b)=>a.username.localeCompare(b.username)));
  assert.deepEqual(after[1],before[1].map(r=>({...r,username:r.username==='alice'?'alice_new':r.username})));
  assert.deepEqual(after[2],before[2].map(r=>({...r,sender:r.sender==='alice'?'alice_new':r.sender,recipient:r.recipient==='alice'?'alice_new':r.recipient})));
  assert.equal((await second.call('me',{token:s.token})).username,'alice_new');
  assert.equal((await alice.call('inbox',{token:a.token})).requests[0].from,'bob');
  assert.equal((await bob.call('inbox',{token:b.token})).requests[0].from,'alice_new');
  assert.ok(!(await readFile(path.join(f.root,'directory','accounts.sqlite'))).includes(Buffer.from(password)));
});

test('password change salts a new hash, keeps only the updating session and rejects the previous password',async t=>{
  const f=await fixture(t),[alice,second]=f.clients;
  const a=await alice.call('register',{username:'alice',password});
  const s=await second.call('login',{username:'alice',password});
  const before=snapshot(f.db);
  assert.deepEqual(await alice.call('update-profile',{token:a.token,username:'alice_new',currentPassword:password,newPassword:replacement}),{username:'alice_new'});
  const after=snapshot(f.db);
  assert.notEqual(after[0][0].salt,before[0][0].salt);
  assert.notEqual(after[0][0].hash,before[0][0].hash);
  assert.match(after[0][0].salt,/^[a-f0-9]{64}$/);
  assert.match(after[0][0].hash,/^[a-f0-9]{128}$/);
  assert.deepEqual(after[1],before[1].filter(r=>r.fingerprint===f.identities[1].fingerprint).map(r=>({...r,username:'alice_new'})));
  assert.equal((await alice.call('me',{token:a.token})).username,'alice_new');
  await assert.rejects(second.call('me',{token:s.token}),/Sign in again/);
  await assert.rejects(second.call('login',{username:'alice_new',password}),/incorrect/);
  assert.equal((await second.call('login',{username:'alice_new',password:replacement})).username,'alice_new');
  const bytes=await readFile(path.join(f.root,'directory','accounts.sqlite'));
  for(const value of [password,replacement,a.token,s.token])assert.ok(!bytes.includes(Buffer.from(value)));
});

async function hashingStarted(service) {
  const deadline=Date.now()+2000;
  while(service.hashing===0) {
    if(Date.now()>deadline)throw new Error('Hashing did not start');
    await new Promise(resolve=>setTimeout(resolve,1));
  }
}

test('login rechecks credentials after async derivation instead of creating a stale-password session',async t=>{
  const f=await fixture(t),[alice,second]=f.clients;
  await alice.call('register',{username:'alice',password});
  const salt=randomBytes(32).toString('hex');
  const hash=scryptSync(replacement,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024}).toString('hex');
  const pending=second.call('login',{username:'alice',password});
  const rejection=assert.rejects(pending,/changed|incorrect/);
  await hashingStarted(f.service);
  // A second SQLite writer advances credentials at the exact async boundary; transport/auth are real.
  f.db.prepare('UPDATE accounts SET salt=?,hash=? WHERE username=?').run(salt,hash,'alice');
  await rejection;
  assert.equal(snapshot(f.db)[1].length,1,'stale password must never acquire a session after the change');
});

test('wrong current password, stolen-device token, taken name and invalid policy leave every directory row unchanged',async t=>{
  const f=await fixture(t),[alice,second,bob]=f.clients;
  const a=await alice.call('register',{username:'alice',password});
  await bob.call('register',{username:'bob',password});
  const before=snapshot(f.db);
  const base={token:a.token,username:'alice_new',currentPassword:password};
  await assert.rejects(alice.call('update-profile',{...base,currentPassword:'wrong-password'}),/Current password is incorrect/);
  await assert.rejects(second.call('update-profile',base),/Sign in again/);
  await assert.rejects(alice.call('update-profile',{...base,username:'bob',newPassword:replacement}),/taken/);
  for(const newPassword of ['', '123', 'a'.repeat(129), 'abcd\n'])await assert.rejects(alice.call('update-profile',{...base,newPassword}),/4–128/);
  await assert.rejects(alice.call('update-profile',{...base,username:'bad name'}),/Username/);
  await assert.rejects(alice.call('update-profile',{...base,fingerprint:f.identities[2].fingerprint}),/Invalid account request/);
  assert.deepEqual(snapshot(f.db),before);
});

test('four-character password is accepted for password-only changes',async t=>{
  const f=await fixture(t),[alice,second]=f.clients;
  const a=await alice.call('register',{username:'alice',password});
  assert.deepEqual(await alice.call('update-profile',{token:a.token,username:'alice',currentPassword:password,newPassword:'1234'}),{username:'alice'});
  assert.equal((await second.call('login',{username:'alice',password:'1234'})).username,'alice');
});

test('transaction rolls back all renamed rows and credentials when pending-request migration fails',async t=>{
  const f=await fixture(t),[alice,,bob]=f.clients;
  const a=await alice.call('register',{username:'alice',password});
  await bob.call('register',{username:'bob',password});
  await alice.call('send',{token:a.token,username:'bob',fingerprint:f.identities[3].fingerprint,code:invite(f)});
  const before=snapshot(f.db);
  f.db.exec("CREATE TRIGGER fail_rename BEFORE UPDATE OF sender ON requests BEGIN SELECT RAISE(ABORT,'fixture migration refusal'); END;");
  await assert.rejects(alice.call('update-profile',{token:a.token,username:'alice_new',currentPassword:password,newPassword:replacement}),/fixture migration refusal/);
  assert.deepEqual(snapshot(f.db),before);
  assert.equal((await alice.call('me',{token:a.token})).username,'alice');
});

test('logout during profile hashing fences the in-flight change',async t=>{
  const f=await fixture(t),[alice]=f.clients;
  const a=await alice.call('register',{username:'alice',password});
  const before=snapshot(f.db)[0];
  const pending=alice.call('update-profile',{token:a.token,username:'alice_new',currentPassword:password,newPassword:replacement});
  const rejection=assert.rejects(pending,/Sign in again/);
  await hashingStarted(f.service);
  await alice.call('logout',{token:a.token});
  await rejection;
  assert.deepEqual(snapshot(f.db)[0],before);
  assert.equal(snapshot(f.db)[1].length,0);
});

test('concurrent password mutations cannot both commit using the same old credentials',async t=>{
  const f=await fixture(t),[alice]=f.clients;
  const a=await alice.call('register',{username:'alice',password});
  const outcomes=await Promise.allSettled([replacement,'another-fixture-password'].map(newPassword=>alice.call('update-profile',{token:a.token,username:'alice',currentPassword:password,newPassword})));
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  const failed=outcomes.find(r=>r.status==='rejected');assert.match(failed.reason.message,/Account changed/);
  assert.equal(snapshot(f.db)[1].length,1);
});

test('profile hashing shares the two-job cap with login and enforces the authentication rate limit',async t=>{
  const f=await fixture(t),[alice,second]=f.clients;
  const a=await alice.call('register',{username:'alice',password});
  const base={token:a.token,username:'alice',currentPassword:password};
  const first=alice.call('update-profile',{...base,newPassword:replacement});
  await hashingStarted(f.service);
  const other=second.call('login',{username:'nobody',password});
  const otherRejected=assert.rejects(other,/incorrect/);
  const deadline=Date.now()+2000;
  while(f.service.hashing<2){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,1));}
  await assert.rejects(alice.call('update-profile',base),/busy/);
  await first;await otherRejected;
  f.service.rates.clear();
  for(let n=0;n<10;n++)await assert.rejects(alice.call('update-profile',{...base,currentPassword:'wrong-password'}),/Current password/);
  await assert.rejects(alice.call('update-profile',{...base,currentPassword:replacement}),/Too many requests/);
});

test('older directory explicitly reports unsupported profile updates and leaves the encrypted local session untouched',async t=>{
  const f=await fixture(t),{app,root}=await integration(f);
  const before=await readFile(path.join(root,'account.enc')),perform=f.service.perform.bind(f.service);
  f.service.perform=(op,...args)=>{if(op==='update-profile')throw new Error('Unsupported account operation');return perform(op,...args);};
  await assert.rejects(app.updateProfile({username:'alice_new',currentPassword:password}),/Unsupported account operation/);
  assert.deepEqual(await readFile(path.join(root,'account.enc')),before);
  assert.equal((await app.status()).username,'alice');
});

test('integration serializes profile mutations and sign-out',async t=>{
  const f=await fixture(t),{app}=await integration(f);
  const pending=app.updateProfile({username:'alice_new',currentPassword:password});
  await assert.rejects(app.updateProfile({username:'alice_other',currentPassword:password}),/already in progress/);
  await assert.rejects(app.logout(),/already in progress/);
  assert.equal((await pending).username,'alice_new');
});

test('request previews expose only unverified decoded endpoints, never invitation codes or bearer tokens',async t=>{
  const f=await fixture(t),{app}=await integration(f),bob=f.clients[2];
  const b=await bob.call('register',{username:'bob',password});
  const code=invite(f,'100.100.1.2');
  await bob.call('send',{token:b.token,username:'alice',fingerprint:f.identities[1].fingerprint,code});
  const [preview]=await app.requests();
  assert.deepEqual(preview.controlEndpoint,{host:'100.100.1.2',port:4567,privateRoute:true,reachability:'unverified'});
  assert.deepEqual(Object.keys(preview).sort(),['controlEndpoint','expiresAt','from','group','id']);
  const serialized=JSON.stringify(preview);
  assert.ok(!serialized.includes(code));assert.ok(!serialized.includes(b.token));
  await app.decline(preview.id);
  const publicCode=invite(f,'fixture.example');
  await bob.call('send',{token:b.token,username:'alice',fingerprint:f.identities[1].fingerprint,code:publicCode});
  assert.deepEqual((await app.requests())[0].controlEndpoint,{host:'fixture.example',port:4567,privateRoute:false,reachability:'unverified'});
});

test('a committed update followed by verification or local vault failure never looks like a safe-to-retry rejection',async t=>{
  for(const failure of ['verification','vault'])await t.test(failure,async t=>{
    const f=await fixture(t),{app,v,root}=await integration(f);
    const before=await readFile(path.join(root,'account.enc'));
    if(failure==='vault')v.encrypt=()=>{throw new Error('fixture vault failure');};
    else {
      const perform=f.service.perform.bind(f.service);
      f.service.perform=(op,...args)=>{if(op==='me')throw new Error('fixture readback failure');return perform(op,...args);};
    }
    await assert.rejects(app.updateProfile({username:'alice_new',currentPassword:password,newPassword:replacement}),/may have changed.*sign in/i);
    assert.deepEqual(await readFile(path.join(root,'account.enc')),before);
    assert.equal(snapshot(f.db)[0][0].username,'alice_new');
  });
});

test('malformed acknowledgment after a committed mutation reports uncertainty without saving or retrying',async t=>{
  const f=await fixture(t),{app,root}=await integration(f);
  const before=await readFile(path.join(root,'account.enc')),perform=f.service.perform.bind(f.service);
  let mutations=0;
  f.service.perform=async(op,...args)=>{
    const result=await perform(op,...args);
    if(op==='update-profile'){mutations++;return 'malformed acknowledgment';}
    return result;
  };
  await assert.rejects(app.updateProfile({username:'alice_new',currentPassword:password}),/may have changed.*sign in/i);
  assert.equal(mutations,1);assert.deepEqual(await readFile(path.join(root,'account.enc')),before);
  assert.equal(snapshot(f.db)[0][0].username,'alice_new');
});
