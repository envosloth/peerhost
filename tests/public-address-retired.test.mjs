import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {PerServerPublicAddresses} from '../dist/src/core/public-address.js';
const KEY='c'.repeat(64),AGENT='239a25b9-9377-4d34-be26-94f11ec1813e';
async function fixture(t,uncertain=false){
 const root=await mkdtemp(path.join(process.env.TMPDIR,'retired-public-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const tunnels=[];let servers=[];
 const deps={servers:async()=>servers,vault:{encrypt:v=>Buffer.from(v),decrypt:v=>v.toString()},externalAgent:true,adoptKey:async()=>KEY,claim:async()=>{throw Error('claim');},probe:async()=>true,
 api:async(key,route,p)=>{if(route==='/v1/agents/rundata')return {agent_id:AGENT};if(route==='/v1/tunnels/list')return {tunnels};if(route==='/tunnels/create'){tunnels.push({id:AGENT,name:p.name,tunnel_type:'minecraft-java',origin:{type:'agent',details:{agent_id:AGENT,config_data:{fields:[{name:'local_ip',value:'127.0.0.1'},{name:'local_port',value:String(p.origin.data.local_port)}]}}},connect_addresses:[{value:{address:'retired.tun.ply.gg'}}]});return {};}throw Error(route);}};
 let manager=new PerServerPublicAddresses(root,deps);t.after(()=>manager.close());
 const a={id:'a',playerPort:25565,state:'running'},b={id:'b',playerPort:25565,state:'offline'};servers=[a];
 if(uncertain){const original=deps.api;deps.api=async(...args)=>{const result=await original(...args);if(args[1]==='/tunnels/create')throw Error('lost acknowledgment');return result;};}
 await manager.enable(a,servers);for(let i=0;i<200&&!manager.status(a).address&&manager.status(a).state!=='error';i++)await new Promise(r=>setTimeout(r,5));if(uncertain)assert.equal(manager.status(a).state,'error');else assert.ok(manager.status(a).address);
 return {root,deps,a,b,tunnels,setServers:v=>servers=v,get manager(){return manager;},restart:async()=>{await manager.close();manager=new PerServerPublicAddresses(root,deps);await manager.restore(servers);}};
}
test('a reservation completing during launch guard filesystem awaits cannot evade the guard',async t=>{
 const f=await fixture(t);await f.manager.close();await rm(path.join(f.root,'public-servers'),{recursive:true,force:true});f.tunnels.length=0;
 const manager=new PerServerPublicAddresses(f.root,f.deps);t.after(()=>manager.close());
 let enter,release,paused=false;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r),original=fs.readFile;
 fs.readFile=async(...args)=>{if(!paused&&String(args[0])===path.join(f.root,'public-address','playit.json')){paused=true;enter();await gate;}return original(...args);};syncBuiltinESMExports();
 t.after(()=>{release();fs.readFile=original;syncBuiltinESMExports();});
 const check=manager.assertCanStart(f.b);await entered;
 await manager.enable(f.a,[f.a]);for(let i=0;i<200&&!manager.status(f.a).address;i++)await new Promise(r=>setTimeout(r,5));assert.ok(manager.status(f.a).address);await new Promise(r=>setTimeout(r,10));
 release();await assert.rejects(check,/reserv/i);
});
test('uncertain provider create retains durable port ownership after disconnect and restart',async t=>{
 const f=await fixture(t,true);await f.manager.disable(f.a);f.setServers([f.b]);await f.restart();
 await assert.rejects(f.manager.assertCanStart(f.b),/reserv/i);await assert.rejects(f.manager.enable(f.b,[f.b]),/reserv/i);assert.equal(f.tunnels.length,1);
});
for(const mode of ['delete','port edit','disconnect','restart after delete','restart after disconnect'])test(`${mode} retains A port ownership even while provider still enabled`,async t=>{
 const f=await fixture(t);
 if(mode.includes('disconnect'))await f.manager.disable(f.a);
 if(mode==='port edit'){f.a.playerPort=25567;f.setServers([f.a,f.b]);}else f.setServers([f.b]);
 if(mode.startsWith('restart'))await f.restart();
 await assert.rejects(f.manager.assertCanStart(f.b),/reserv/i);
 await assert.rejects(f.manager.enable(f.b,mode==='port edit'?[f.a,f.b]:[f.b]),/reserv/i);
 await f.manager.assertCanStart({...f.b,playerPort:25569});
 assert.equal(f.tunnels.length,1);
});

test('retired A tunnel prevents ordinary non-public B start and setup on reused port',async t=>{
 const f=await fixture(t);f.setServers([f.b]);
 await assert.rejects(f.manager.enable(f.b,[f.b]),/reserv|public.*port/i);
 await assert.rejects(f.manager.assertCanStart(f.b),/reserv|public.*port/i);
 assert.equal(f.tunnels.length,1);
});
