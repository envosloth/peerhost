import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {PublicAddress} from '../dist/src/core/public-address.js';
const KEY='c'.repeat(64),AGENT='239a25b9-9377-4d34-be26-94f11ec1813e',ID='493875ca-042a-49ea-87ce-0734209d40f8',HOST='mossy-hollow.tun.ply.gg';
async function fixture(t){
 const root=await mkdtemp(path.join(process.env.TMPDIR,'readiness-'));let tunnels=[],answer=true,providerFailure=false,port=25566,creates=0;
 const pa=new PublicAddress(root,{externalAgent:true,adoptKey:async()=>KEY,vault:{encrypt:v=>Buffer.from(v),decrypt:v=>v.toString()},target:()=>({host:'127.0.0.1',port}),claim:async()=>{throw Error('unused');},probe:async()=>answer,
 api:async(key,route,payload)=>{if(providerFailure)throw Error('secret '+KEY);if(route==='/v1/agents/rundata')return {agent_id:AGENT};if(route==='/v1/tunnels/list')return {tunnels};if(route==='/tunnels/create'){creates++;tunnels=[{id:ID,name:payload.name,tunnel_type:'minecraft-java',origin:{type:'agent',details:{agent_id:AGENT,config_data:{fields:[{name:'local_ip',value:'127.0.0.1'},{name:'local_port',value:String(port)}]}}},connect_addresses:[{value:{address:HOST}}]}];return {};}}});
 t.after(async()=>{await pa.close();await rm(root,{recursive:true,force:true});});await pa.enable();await pa.settled();
 return {pa,set answer(v){answer=v;},set providerFailure(v){providerFailure=v;},set port(v){port=v;},set tunnels(v){tunnels=v;},get creates(){return creates;}};
}
test('current join address is verified, then invalidated on failed recheck and provider uncertainty',async t=>{
 const f=await fixture(t);const ready=f.pa.status();assert.equal(ready.joinAddress,HOST);assert.equal(ready.readiness,'verified');assert.ok(Number.isSafeInteger(ready.verifiedAt));
 f.answer=false;await f.pa.refresh(true);assert.equal(f.pa.status().joinAddress,null);assert.equal(f.pa.status().reservedAddress,HOST);assert.equal(f.pa.status().readiness,'game-failure');
 f.answer=true;await f.pa.refresh(true);assert.equal(f.pa.status().joinAddress,HOST);
 f.providerFailure=true;await f.pa.refresh(true);assert.equal(f.pa.status().joinAddress,null);assert.equal(f.pa.status().readiness,'provider-failure');assert.equal(JSON.stringify(f.pa.status()).includes(KEY),false);
 await f.pa.disable();assert.equal(f.pa.status().joinAddress,null);
});
test('changed route invalidates cached success even before polling',async t=>{
 const f=await fixture(t);f.port=25567;assert.equal(f.pa.status().joinAddress,null);assert.equal(f.pa.status().readiness,'route-changed');
});
test('missing binding is actionable but never silently recreated',async t=>{
 const f=await fixture(t);f.tunnels=[];await f.pa.refresh(true);assert.equal(f.pa.status().readiness,'missing-binding');assert.equal(f.pa.status().repairAction,'provider-api-required');assert.equal(f.creates,1);
});
test('typed DNS failure stays distinct from a game failure',async t=>{
 const f=await fixture(t);f.answer={ok:false,failure:'dns-failure'};await f.pa.refresh(true);assert.equal(f.pa.status().readiness,'dns-failure');assert.equal(f.pa.status().joinAddress,null);
});
test('explicit provider missing-agent refusal requires fresh approval without creating or clearing reservations',async t=>{
 const {PlayitApiRefusal}=await import('../dist/src/core/playit-network.js');
 const f=await fixture(t);f.pa.deps.api=async()=>{throw new PlayitApiRefusal('secret '+KEY,'AgentNotFound');};await f.pa.refresh(true);
 assert.equal(f.pa.status().readiness,'agent-failure');assert.equal(f.pa.status().repairAction,'approve-new-agent');assert.equal(f.pa.status().joinAddress,null);assert.equal(f.creates,1);assert.equal(JSON.stringify(f.pa.status()).includes(KEY),false);
});
test('per-world host lifecycle invalidation is exposed through the manager',async t=>{
 const {PerServerPublicAddresses}=await import('../dist/src/core/public-address.js');
 const f=await fixture(t),manager=new PerServerPublicAddresses('unused-fixture-root',f.pa.deps);
 manager.bindings.set('world',{port:25566,public:f.pa,generation:0});
 assert.equal(typeof manager.invalidateVerification,'function');manager.invalidateVerification('world','game-failure');
 assert.equal(manager.status({id:'world',playerPort:25566,state:'running'}).joinAddress,null);
});
test('explicit lifecycle invalidation fences an older pending successful recheck',async t=>{
 const f=await fixture(t);let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 t.after(()=>release());f.pa.deps.probe=async()=>{entered();await gate;return true;};
 const checking=f.pa.refresh(true);await started;
 assert.equal(typeof f.pa.invalidateVerification,'function');f.pa.invalidateVerification('game-failure');release();await checking;
 assert.equal(f.pa.status().joinAddress,null);
});
