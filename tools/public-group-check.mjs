// Explicit live public-ingress check. All accounts/world bytes are disposable fixtures.
// Temporarily forwards only 8443/10000 to isolated loopback listeners, restores both in finally.
import assert from 'node:assert/strict';
import dns from 'node:dns';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {createIdentity} from '../dist/src/core/peer-transport.js';
import {AccountService,AccountClient} from '../dist/src/core/accounts.js';
import {AccountIntegration} from '../dist/src/core/account-integration.js';
import {RelayNode} from '../dist/src/core/relay.js';
import {SeedHostApplication} from '../dist/src/core/application.js';
import {publicIPv4} from '../dist/src/core/playit-network.js';

if(process.env.SEEDHOST_PUBLIC_GROUP_SMOKE!=='true')throw new Error('Set SEEDHOST_PUBLIC_GROUP_SMOKE=true for the explicitly scoped live check');
const run=promisify(execFile),host=process.env.SEEDHOST_PUBLIC_GROUP_HOST;
assert.ok(typeof host==='string' && /^[a-z0-9.-]+\.ts\.net$/.test(host),'Set SEEDHOST_PUBLIC_GROUP_HOST to the approved Funnel hostname');
const query=await fetch('https://dns.google/resolve?name='+host+'&type=A',{signal:AbortSignal.timeout(15000)}).then(r=>r.json());
const addresses=(query.Answer??[]).filter(x=>x.type===1).map(x=>x.data);
assert.ok(addresses.length&&addresses.every(publicIPv4),'Public Funnel DNS is not ready yet');
const originalLookup=dns.lookup;
dns.lookup=(...args)=>{if(args[0]!==host)return originalLookup(...args);const callback=args.at(-1);if(args[1]?.all)callback(null,[{address:addresses[0],family:4}]);else callback(null,addresses[0],4);};
const before=JSON.parse((await run('tailscale',['funnel','status','--json'])).stdout);
for(const port of ['8443','10000'])assert.ok(before.TCP?.[port]?.TCPForward,'Only replace and restore existing raw TCP forwarders');
const root=await mkdtemp(path.join(process.env.TMPDIR,'public-group-'));
const [di,ri,ai,bi]=await Promise.all([createIdentity(),createIdentity(),createIdentity(),createIdentity()]);
const directory=new AccountService(path.join(root,'directory'),di),relay=new RelayNode(path.join(root,'relay'),ri,{log:()=>{}});
const a=new SeedHostApplication(path.join(root,'alice'),ai),b=new SeedHostApplication(path.join(root,'bob'),bi);
let changed=false,cleaning;
const forward=(port,target)=>run('tailscale',['funnel','--bg','--tcp='+port,'tcp://'+target],{timeout:15000});
async function cleanup(){if(cleaning)return cleaning;cleaning=(async()=>{await a.close().catch(()=>{});await b.close().catch(()=>{});await relay.close().catch(()=>{});await directory.close().catch(()=>{});if(changed){await forward(8443,before.TCP['8443'].TCPForward);await forward(10000,before.TCP['10000'].TCPForward);const after=JSON.parse((await run('tailscale',['funnel','status','--json'])).stdout);assert.deepEqual(after,before,'all original ingress mappings restored');}dns.lookup=originalLookup;})();return cleaning;}
process.once('SIGTERM',()=>{void cleanup().then(()=>process.exit(143),e=>{console.error(e);process.exit(1);});});
function vault(){const key=randomBytes(32);return {encrypt(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(value),cipher.final(),cipher.getAuthTag()]);},decrypt(value){const cipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));cipher.setAuthTag(value.subarray(-16));return cipher.update(value.subarray(12,-16),undefined,'utf8')+cipher.final('utf8');}};}
try {
 await directory.listen();await relay.open();await relay.listen({advertise:{host,port:8443}});await a.open();await b.open();
 changed=true;await forward(8443,'127.0.0.1:'+relay.endpoint.port);await forward(10000,'127.0.0.1:'+directory.endpoint.port);
 const ep={host,port:10000,fingerprint:di.fingerprint};
 await assert.rejects(new AccountClient(ai,{...ep,fingerprint:ri.fingerprint}).call('me',{token:'0'.repeat(64)}),/fingerprint/);
 const alice=new AccountIntegration(path.join(root,'alice'),ai,vault(),a,ep),bob=new AccountIntegration(path.join(root,'bob'),bi,vault(),b,ep);
 await alice.authenticate('register',{username:'alicefixture',password:'fixture-alice-password'});await bob.authenticate('register',{username:'bobfixture',password:'fixture-bob-password'});
 await a.joinWithInvite({code:(await relay.createInvite({advertise:{host,port:8443}})).code,name:'alicefixture'});await relay.setOwner(ai.fingerprint);
 await alice.send('bobfixture');const inbox=await bob.requests();assert.equal(inbox[0].from,'alicefixture');await bob.accept(inbox[0].id);assert.equal((await b.listFriends()).members.length,2);
 const source=path.join(root,'source');await mkdir(source);const payload=randomBytes(2*1024*1024);await writeFile(path.join(source,'world-fixture.bin'),payload);await writeFile(path.join(source,'eula.txt'),'eula=true\n');
 await a.importExisting(source,true);await a.parkAtRelay();await b.claimFromRelay();
 const first=await readFile(path.join((await b.getState()).server.serverDir,'world-fixture.bin'));assert.deepEqual(first,payload);
 await assert.rejects(a.claimFromRelay(),/checked out/);
 const edited=Buffer.concat([payload,Buffer.from('edited-on-bob')]);await writeFile(path.join((await b.getState()).server.serverDir,'world-fixture.bin'),edited);await b.parkAtRelay();await a.claimFromRelay();
 assert.deepEqual(await readFile(path.join((await a.getState()).server.serverDir,'world-fixture.bin')),edited);
 assert.equal((await a.getState()).server.ownership.generation,4);assert.deepEqual(await readFile(path.join(source,'world-fixture.bin')),payload);
 await a.removeFriend(bi.fingerprint);assert.equal((await a.listFriends()).members.length,1);await assert.rejects(b.listFriends(),/disconnected|refused|handshake/);
 await writeFile(path.join(root,'result.json'),JSON.stringify({publicHost:host,publicIPv4:addresses[0],signup:true,usernameInvite:true,accept:true,worldBytes:edited.length,sha256:createHash('sha256').update(edited).digest('hex'),roundtripGeneration:4,removal:true,minecraftProcessRun:false},null,2));
 console.log('PASS: real public edge, pinned TLS, signup, username invite, acceptance, 2MiB file handoff both directions, exclusive custody and revocation. No Minecraft process was run.');
 console.log('ARTIFACT_DIR='+root);
} finally {await cleanup();}
