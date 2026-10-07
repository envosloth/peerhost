// Explicitly authorized public account-ingress verification. No live accounts are mutated.
// Uses a disposable directory and restores ONLY the existing account TCP forwarding rule.
import assert from 'node:assert/strict';
import dns from 'node:dns';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createIdentity} from '../dist/src/core/peer-transport.js';
import {AccountService,AccountClient} from '../dist/src/core/accounts.js';
import {publicIPv4} from '../dist/src/core/playit-network.js';
import {installInterruptCleanup} from './interrupt-cleanup.mjs';

assert.equal(process.env.SEEDHOST_PUBLIC_FRIENDS_SMOKE,'true','Public ingress must be explicitly authorized');
const host=process.env.SEEDHOST_PUBLIC_ACCOUNT_HOST;
assert.ok(typeof host==='string' && /^[a-z0-9.-]+\.ts\.net$/.test(host),'Provide the approved public account hostname');
const cli=process.env.SEEDHOST_TAILSCALE_BIN || 'tailscale';
const run=promisify(execFile);
const before=JSON.parse((await run(cli,['funnel','status','--json'],{timeout:15000})).stdout);
assert.equal(before.TCP?.['10000']?.TCPForward,'127.0.0.1:47640','Refuse to alter any unrelated public listener');
const dnsReply=await fetch('https://dns.google/resolve?name='+encodeURIComponent(host)+'&type=A',{signal:AbortSignal.timeout(15000)}).then(r=>{assert.ok(r.ok);return r.json();});
const addresses=(dnsReply.Answer||[]).filter(r=>r.type===1).map(r=>r.data);
assert.ok(addresses.length && addresses.every(publicIPv4),'Independent public DNS is not ready');
const originalLookup=dns.lookup;
const root=await mkdtemp(path.join(process.env.TMPDIR || process.cwd(),'public-friends-'));
const [directoryIdentity,aliceIdentity,bobIdentity]=await Promise.all([createIdentity(),createIdentity(),createIdentity()]);
const directory=new AccountService(path.join(root,'directory'),directoryIdentity);
let changed=false;
let forwarding=Promise.resolve();
const forward=target=>{
  const operation=forwarding.then(()=>run(cli,['funnel','--bg','--yes','--tcp=10000','tcp://'+target],{timeout:20000}));
  forwarding=operation.catch(()=>{});
  return operation;
};
let cleaning;
async function cleanup(){
  if(cleaning)return cleaning;
  cleaning=(async()=>{
    if(changed){
      await forward(before.TCP['10000'].TCPForward);
      const restored=JSON.parse((await run(cli,['funnel','status','--json'],{timeout:15000})).stdout);
      assert.deepEqual(restored,before,'Restore all ingress configuration exactly');
    }
    await directory.close();
    dns.lookup=originalLookup;
  })();
  return cleaning;
}
const removeSignalHandlers=installInterruptCleanup({cleanup});
try {
  await directory.listen({host:'127.0.0.1',port:0});
  changed=true;
  await forward('127.0.0.1:'+directory.endpoint.port);
  // Only this explicitly scoped test process overrides DNS. TLS SNI remains the hostname;
  // the TCP connection goes to independently resolved public ingress, never MagicDNS.
  dns.lookup=(...args)=>{
    if(args[0]!==host)return originalLookup(...args);
    const cb=args.at(-1);
    if(args[1]?.all)cb(null,[{address:addresses[0],family:4}]);else cb(null,addresses[0],4);
  };
  const ep={host,port:10000,fingerprint:directoryIdentity.fingerprint};
  await assert.rejects(new AccountClient(aliceIdentity,{...ep,fingerprint:aliceIdentity.fingerprint}).call('me',{token:'0'.repeat(64)}),/fingerprint/i);
  const alice=new AccountClient(aliceIdentity,ep),bob=new AccountClient(bobIdentity,ep);
  const passwordA=randomBytes(24).toString('base64url'),passwordB=randomBytes(24).toString('base64url');
  const a=await alice.call('register',{username:'alicefixture',password:passwordA});
  const b=await bob.call('register',{username:'bobfixture',password:passwordB});
  const a2=await alice.call('login',{username:'alicefixture',password:passwordA});
  const b2=await bob.call('login',{username:'bobfixture',password:passwordB});
  assert.equal(a.username,a2.username);assert.equal(b.username,b2.username);
  const acall=(op,p={})=>alice.call(op,{...p,token:a2.token});
  const bcall=(op,p={})=>bob.call(op,{...p,token:b2.token});
  await assert.rejects(bob.call('me',{token:a2.token}),/Sign in again/,'Tokens must remain device-bound through public forwarding');
  const sent=await acall('friend-send',{username:'bobfixture'});
  assert.equal(sent.sent,true);
  const inbox=await bcall('friend-inbox');
  assert.ok(inbox.requests.some(r=>r.id===sent.id && r.from==='alicefixture'));
  const accepted=await bcall('friend-accept',{id:sent.id});assert.equal(accepted.added,true);
  assert.ok((await acall('friend-list')).friends.some(f=>f.username==='bobfixture'));
  assert.ok((await bcall('friend-list')).friends.some(f=>f.username==='alicefixture'));
  assert.ok(!(await bcall('friend-inbox')).requests.some(r=>r.id===sent.id));
  await bcall('friend-remove',{username:'alicefixture'});
  assert.equal((await acall('friend-list')).friends.length,0);
  assert.equal((await bcall('friend-list')).friends.length,0);
  await writeFile(path.join(root,'result.json'),JSON.stringify({publicHost:host,publicIPv4:addresses[0],signup:true,login:true,friendSend:true,accept:true,bilateralReadback:true,removal:true,pinMismatchRejected:true,deviceBindingPreserved:true,liveAccountsChanged:false,secondPhysicalPC:false},null,2));
  await cleanup();
  removeSignalHandlers();
  console.log('PASS: public IPv4 ingress, pinned TLS, signup/login, friend request/accept/readback/remove and device-bound sessions; ingress restoration verified. Disposable accounts only; not a second-PC test.');
  console.log('ARTIFACT_DIR='+root);
} finally {try{await cleanup();}finally{removeSignalHandlers();}}
