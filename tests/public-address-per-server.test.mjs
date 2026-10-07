import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import * as publicModule from '../dist/src/core/public-address.js';
import {playitApi,PlayitApiRefusal} from '../dist/src/core/playit-network.js';
const {PublicAddress}=publicModule;

const KEY='c'.repeat(64), AGENT='239a25b9-9377-4d34-be26-94f11ec1813e';
const ids=['493875ca-042a-49ea-87ce-0734209d40f8','593875ca-042a-49ea-87ce-0734209d40f8'];
export async function fixture(t){
 const root=await mkdtemp(path.join(process.env.TMPDIR,'public-bindings-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const tunnels=[],creates=[];let reachable=true, fail=false;
 const deps={vault:{encrypt:v=>Buffer.from('encrypted:'+v),decrypt:v=>v.toString().slice(10)},externalAgent:true,adoptKey:async()=>KEY,
 claim:async()=>{throw Error('unexpected claim');},probe:async()=>reachable,
 api:async(key,route,payload)=>{assert.equal(key,KEY);if(fail)throw Error('quota exhausted');if(route==='/v1/agents/rundata')return {agent_id:AGENT};if(route==='/v1/tunnels/list')return {tunnels};if(route==='/tunnels/create'){
 creates.push(payload);const n=creates.length-1;tunnels.push({id:ids[n],name:payload.name,tunnel_type:'minecraft-java',origin:{type:'agent',details:{agent_id:AGENT,config_data:{fields:[{name:'local_ip',value:payload.origin.data.local_ip},{name:'local_port',value:String(payload.origin.data.local_port)}]}}},connect_addresses:[{value:{address:`server-${n}.tun.ply.gg`}}]});return {}; }throw Error(route);}};
 const settle=async pa=>{for(let i=0;i<100;i++){const s=pa.status();if(['reachable','reserved','error'].includes(s.state))return s;await new Promise(r=>setTimeout(r,5));}return pa.status();};
 return {root,deps,tunnels,creates,settle,setReachable:v=>reachable=v,setFail:v=>fail=v};
}

test('a saved binding never borrows another tunnel at its target after its own tunnel disappears',async t=>{
 const f=await fixture(t),pa=new PublicAddress(f.root,{...f.deps,target:()=>({host:'127.0.0.1',port:25565})});t.after(()=>pa.close());
 await pa.enable();assert.equal((await f.settle(pa)).state,'reachable');
 f.tunnels[0]={...f.tunnels[0],id:ids[1],connect_addresses:[{value:{address:'someone-else.tun.ply.gg'}}]};
 const status=await pa.refresh(true);assert.equal(status.address,null);assert.equal(status.state,'error');assert.equal(f.creates.length,1);
});

test('two ordinary servers reserve independent stable tunnels through one approved agent and restart without new claims',async t=>{
 assert.equal(typeof publicModule.PerServerPublicAddresses,'function','per-server binding manager is available');
 const f=await fixture(t),a={id:'world-a',playerPort:25565,state:'running'},b={id:'world-b',playerPort:25567,state:'stopped'},servers=[a,b];
 let approvals=0;const deps={...f.deps,adoptKey:async()=>{approvals++;return KEY;}};
 let manager=new publicModule.PerServerPublicAddresses(f.root,deps);t.after(()=>manager.close());
 const settle=async(id)=>{for(let i=0;i<100;i++){const s=manager.status(servers.find(x=>x.id===id));if(['reachable','reserved','error'].includes(s.state))return s;await new Promise(r=>setTimeout(r,5));}return manager.status(servers.find(x=>x.id===id));};
 await Promise.all([manager.enable(a,servers),manager.enable(b,servers)]);
 const addressA=(await settle(a.id)).address,addressB=(await settle(b.id)).address;
 assert.ok(addressA);assert.ok(addressB);assert.notEqual(addressA,addressB);
 assert.equal(manager.status(b).state,'reserved','stopped server is not advertised live even if probe answers');
 assert.equal(approvals,1);assert.deepEqual(f.creates.map(c=>c.origin.data.local_port).sort((a,b)=>a-b),[25565,25567]);
 await manager.close();manager=new publicModule.PerServerPublicAddresses(f.root,deps);await manager.restore(servers);
 assert.equal((await settle(a.id)).address,addressA);assert.equal((await settle(b.id)).address,addressB);assert.equal(f.creates.length,2);assert.equal(approvals,1);
 await manager.disable(a);assert.equal(manager.status(a).address,null);assert.equal(manager.status(b).address,addressB);
});

test('duplicate Minecraft ports are rejected before approval or tunnel creation',async t=>{
 const f=await fixture(t),manager=new publicModule.PerServerPublicAddresses(f.root,f.deps);t.after(()=>manager.close());
 const a={id:'a',playerPort:25565,state:'stopped'},b={id:'b',playerPort:25565,state:'running'};
 await assert.rejects(manager.enable(a,[a,b]),/port.*another server/i);assert.equal(f.creates.length,0);assert.equal(f.tunnels.length,0);
});

test('failed recheck clears previously verified live state',async t=>{
 const f=await fixture(t),pa=new PublicAddress(f.root,{...f.deps,target:()=>({host:'127.0.0.1',port:25565})});t.after(()=>pa.close());
 await pa.enable();assert.equal((await f.settle(pa)).state,'reachable');f.setFail(true);
 const status=await pa.refresh(true);assert.equal(status.state,'reserved');assert.match(status.detail,/couldn.t reach/i);
});

test('disabling while a public probe is pending cannot resurrect its address',async t=>{
 const f=await fixture(t);let release,entered;const pending=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const pa=new PublicAddress(f.root,{...f.deps,target:()=>({host:'127.0.0.1',port:25565}),probe:async()=>{entered();await pending;return true;}});t.after(()=>pa.close());
 await pa.enable();await started;await pa.disable();release();await pa.settled();await new Promise(r=>setTimeout(r,5));
 assert.equal(pa.status().state,'off');assert.equal(pa.status().address,null);
});

test('restoring colliding ports stays available without starting any external reservation',async t=>{
 const f=await fixture(t),a={id:'a',playerPort:25565,state:'running'},b={id:'b',playerPort:25567,state:'offline'};
 let manager=new publicModule.PerServerPublicAddresses(f.root,f.deps);await manager.enable(a,[a,b]);
 for(let i=0;i<100&&!manager.status(a).address;i++)await new Promise(r=>setTimeout(r,5));
 await manager.close();manager=new publicModule.PerServerPublicAddresses(f.root,f.deps);t.after(()=>manager.close());b.playerPort=a.playerPort;
 await manager.restore([a,b]);assert.equal(manager.status(a).state,'error');assert.equal(manager.status(a).address,null);assert.equal(f.creates.length,1);
});

test('damaged saved credential/binding is not treated as permission for a new agent and tunnel',async t=>{
 const f=await fixture(t),pa=new PublicAddress(f.root,{...f.deps,target:()=>({host:'127.0.0.1',port:25565})});t.after(()=>pa.close());
 await pa.enable();await f.settle(pa);await pa.close();
 await writeFile(path.join(f.root,'public-address','playit.json'),'{broken');
 const restored=new PublicAddress(f.root,{...f.deps,target:()=>({host:'127.0.0.1',port:25565})});t.after(()=>restored.close());
 await assert.rejects(restored.enable(),/saved.*damaged|cannot be read/i);assert.equal(f.creates.length,1);
});

test('external tunnel disabled flags never advertise reachable even when a probe answers',async t=>{
 const f=await fixture(t),pa=new PublicAddress(f.root,{...f.deps,target:()=>({host:'127.0.0.1',port:25565})});t.after(()=>pa.close());
 await pa.enable();await f.settle(pa);f.tunnels[0].disabled_by_admin=true;
 assert.equal((await pa.refresh(true)).state,'pending');
});

test('disconnecting one shared-agent binding truthfully warns that the external tunnel remains',async t=>{
 const f=await fixture(t),a={id:'a',playerPort:25565,state:'running'},manager=new publicModule.PerServerPublicAddresses(f.root,f.deps);t.after(()=>manager.close());
 await manager.enable(a,[a]);for(let i=0;i<100&&!manager.status(a).address;i++)await new Promise(r=>setTimeout(r,5));
 const status=await manager.disable(a);assert.equal(status.state,'off');assert.match(status.detail,/tunnel.*may still|external.*remains/i);assert.equal(f.tunnels.length,1);
});

test('a server can cancel its pending claim without waiting for another server approval',async t=>{
 const f=await fixture(t),a={id:'a',playerPort:25565,state:'offline'};let release;const pending=new Promise(r=>release=r);
 const manager=new publicModule.PerServerPublicAddresses(f.root,{...f.deps,adoptKey:async()=>{await pending;return KEY;}});t.after(()=>manager.close());
 await manager.enable(a,[a]);
 const disabling=manager.disable(a);const finished=await Promise.race([disabling.then(()=>true),new Promise(r=>setTimeout(()=>r(false),100))]);
 release();await disabling;assert.equal(finished,true);await new Promise(r=>setTimeout(r,30));assert.equal(f.creates.length,0);assert.equal(manager.status(a).state,'off');
});

test('Playit quota refusal is explicit and does not expose the agent credential',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({status:'fail',data:{type:'TunnelLimitReached',secret:KEY}}),{status:200});
 try { await assert.rejects(playitApi(KEY,'/tunnels/create',{}),error=>{assert.match(error.message,/TunnelLimitReached|quota|limit/i);assert.equal(error.message.includes(KEY),false);assert.equal(error.definitiveRefusal,true);return true;}); }
 finally {globalThis.fetch=original;}
});

test('cancel after tunnel-list await fences external create and keeps saved enabled false',async t=>{
 const f=await fixture(t);let release,entered;const pending=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const pa=new PublicAddress(f.root,{...f.deps,target:()=>({host:'127.0.0.1',port:25565}),api:async(...args)=>{if(args[1]==='/v1/tunnels/list'){entered();await pending;}return f.deps.api(...args);}});t.after(()=>pa.close());
 await pa.enable();await started;await pa.disable();release();await new Promise(r=>setTimeout(r,30));
 assert.equal(f.creates.length,0);assert.equal(JSON.parse(await readFile(path.join(f.root,'public-address','playit.json'),'utf8')).enabled,false);assert.equal(pa.status().state,'off');
});

test('an unnamed new tunnel at the same origin cannot be adopted after create',async t=>{
 const f=await fixture(t),pa=new PublicAddress(f.root,{...f.deps,target:()=>({host:'127.0.0.1',port:25565}),api:async(...args)=>{const result=await f.deps.api(...args);if(args[1]==='/tunnels/create')delete f.tunnels[0].name;return result;}});t.after(()=>pa.close());
 await pa.enable();const status=await f.settle(pa);assert.equal(status.state,'error');assert.equal(status.address,null);
});

test('a definitive provider refusal allows a later explicit retry without claiming a successful reservation',async t=>{
 const f=await fixture(t);let refused=true;
 const pa=new PublicAddress(f.root,{...f.deps,target:()=>({host:'127.0.0.1',port:25565}),api:async(...args)=>{if(args[1]==='/tunnels/create'&&refused)throw new PlayitApiRefusal('Tunnel quota reached');return f.deps.api(...args);}});t.after(()=>pa.close());
 await pa.enable();assert.equal((await f.settle(pa)).state,'error');assert.equal(pa.status().address,null);refused=false;
 await pa.enable();assert.equal((await f.settle(pa)).state,'reachable');assert.equal(f.creates.length,1);
});

test('lost create acknowledgment is recovered by exact reservation name after restart, never recreated',async t=>{
 const f=await fixture(t);let lost=true;
 const deps={...f.deps,target:()=>({host:'127.0.0.1',port:25565}),api:async(...args)=>{const result=await f.deps.api(...args);if(args[1]==='/tunnels/create'&&lost){lost=false;throw Error('acknowledgment lost');}return result;}};
 const pa=new PublicAddress(f.root,deps);await pa.enable();assert.equal((await f.settle(pa)).state,'error');await pa.close();
 const restored=new PublicAddress(f.root,deps);t.after(()=>restored.close());await restored.restore();await restored.settled();assert.equal(restored.status().state,'reachable');assert.equal(f.creates.length,1);
});

test('port edits during agent approval are fenced before tunnel mutation',async t=>{
 const f=await fixture(t),a={id:'a',playerPort:25565,state:'offline'};let release;const pending=new Promise(r=>release=r);
 const manager=new publicModule.PerServerPublicAddresses(f.root,{...f.deps,servers:async()=>[a],adoptKey:async()=>{await pending;return KEY;}});t.after(()=>manager.close());
 await manager.enable({...a},[a]);a.playerPort=25567;release();await new Promise(r=>setTimeout(r,50));
 assert.equal(f.creates.length,0);assert.equal(manager.status(a).address,null);assert.equal(manager.status(a).state,'error');
});

test('a copied binding cannot migrate a retired server address onto another server with the same port',async t=>{
 const f=await fixture(t),a={id:'a',playerPort:25565,state:'running'},b={id:'b',playerPort:25565,state:'running'};
 let manager=new publicModule.PerServerPublicAddresses(f.root,f.deps);await manager.enable(a,[a]);for(let i=0;i<100&&!manager.status(a).address;i++)await new Promise(r=>setTimeout(r,5));await manager.close();
 const filename=id=>path.join(f.root,'public-servers',createHash('sha256').update(id).digest('hex'),'public-address','playit.json');
 await (await import('node:fs/promises')).mkdir(path.dirname(filename(b.id)),{recursive:true});await writeFile(filename(b.id),await readFile(filename(a.id)));
 manager=new publicModule.PerServerPublicAddresses(f.root,f.deps);t.after(()=>manager.close());await manager.restore([b]);await new Promise(r=>setTimeout(r,50));
 assert.equal(manager.status(b).state,'error');assert.equal(manager.status(b).address,null);assert.equal(f.creates.length,1);
});

test('duplicate provider addresses are never advertised as distinct server bindings',async t=>{
 const f=await fixture(t),a={id:'a',playerPort:25565,state:'running'},b={id:'b',playerPort:25567,state:'running'},manager=new publicModule.PerServerPublicAddresses(f.root,f.deps);t.after(()=>manager.close());
 await manager.enable(a,[a,b]);await manager.enable(b,[a,b]);for(let i=0;i<100&&(!manager.status(a).address||!manager.status(b).address);i++)await new Promise(r=>setTimeout(r,5));
 for(const tunnel of f.tunnels)tunnel.connect_addresses=[{value:{address:'duplicate.tun.ply.gg'}}];await manager.refresh(a,true);await manager.refresh(b,true);
 assert.equal(manager.status(a).address,null);assert.equal(manager.status(b).address,null);assert.equal(manager.status(a).state,'error');assert.equal(manager.status(b).state,'error');
});

test('closing during deferred native agent startup never launches a late process',async t=>{
 let pa;t.after(()=>pa?.close());const f=await fixture(t);let release,entered;const pending=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const bytes=process.platform==='win32'?await (await import('./windows-agent-fixture.mjs')).windowsAgentFixture():Buffer.from(`#!${process.execPath}\nrequire('fs').writeFileSync(require('path').join(require('path').dirname(process.argv[process.argv.indexOf('--secret-path')+1]),'agent-saw-key'),'yes');setInterval(()=>{},1000);`);
 pa=new PublicAddress(f.root,{...f.deps,externalAgent:false,target:()=>({host:'127.0.0.1',port:25565}),binary:{url:'https://github.com/fixture/playit',file:process.platform==='win32'?'fixture.exe':'fixture',sha256:createHash('sha256').update(bytes).digest('hex')},fetchBinary:async()=>bytes});
 const original=pa.startAgent.bind(pa);pa.startAgent=async(...args)=>{entered();await pending;return original(...args);};
 await pa.enable();await started;await pa.close();release();await new Promise(r=>setTimeout(r,1800));
 await assert.rejects(readFile(path.join(f.root,'public-address','agent-saw-key')),{code:'ENOENT'});assert.equal(f.creates.length,0);
});

test('an older successful probe cannot overwrite a newer failed probe for the same binding',async t=>{
 const f=await fixture(t);let calls=0,release,entered;const pending=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const pa=new PublicAddress(f.root,{...f.deps,target:()=>({host:'127.0.0.1',port:25565}),probe:async()=>{if(++calls===2){entered();await pending;return true;}return calls===1;}});t.after(()=>pa.close());
 await pa.enable();await f.settle(pa);const older=pa.refresh(true);await started;await pa.refresh(true);release();await older;
 assert.equal(pa.status().state,'reserved');
});

test('cancelled refresh cannot publish an obsolete missing-tunnel error',async t=>{
 const f=await fixture(t);let delay=false,release,entered;const pending=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const pa=new PublicAddress(f.root,{...f.deps,target:()=>({host:'127.0.0.1',port:25565}),api:async(...args)=>{if(delay&&args[1]==='/v1/tunnels/list'){entered();await pending;}return f.deps.api(...args);}});t.after(()=>pa.close());
 await pa.enable();await f.settle(pa);delay=true;const refreshing=pa.refresh(true);await started;await pa.disable();f.tunnels.length=0;release();await refreshing;
 assert.equal(pa.status().state,'off');assert.equal(pa.status().address,null);
});

