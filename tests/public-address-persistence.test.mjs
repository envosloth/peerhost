import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {PublicAddress} from '../dist/src/core/public-address.js';
const KEY='c'.repeat(64),AGENT='239a25b9-9377-4d34-be26-94f11ec1813e';
async function paused(t,phase){
 const root=await fs.mkdtemp(path.join(process.env.TMPDIR,'public-write-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 let release,enter;const gate=new Promise(r=>release=r),entered=new Promise(r=>enter=r);const original=fs.rename;
 let stopped=false,calls=0,creates=0;
 fs.rename=async(from,to)=>{if(!stopped&&String(to)===path.join(root,'public-address','playit.json')){const value=JSON.parse(await fs.readFile(from,'utf8'));if((phase==='credentials'&&!value.tunnelName)||(phase==='binding'&&value.tunnelName)){stopped=true;enter();await gate;}}return original(from,to);};syncBuiltinESMExports();
 t.after(()=>{release();fs.rename=original;syncBuiltinESMExports();});
 const deps={vault:{encrypt:v=>Buffer.from(v),decrypt:v=>v.toString()},externalAgent:true,target:()=>({host:'127.0.0.1',port:25565}),adoptKey:async()=>KEY,claim:async()=>{throw Error('claim');},probe:async()=>true,api:async(key,route)=>{calls++;if(route==='/v1/agents/rundata')return {agent_id:AGENT};if(route==='/v1/tunnels/list')return {tunnels:[]};if(route==='/tunnels/create'){creates++;return {};}throw Error(route);}};
 const pa=new PublicAddress(root,deps);t.after(()=>pa.close());await pa.enable();await entered;
 return {root,pa,deps,release,get calls(){return calls;},get creates(){return creates;}};
}
test('close drains an already-issued rename, remembers enabled choice, and publishes nothing after return',async t=>{
 const f=await paused(t,'credentials'),work=f.pa.settled();let finished=false;
 const closing=f.pa.close().then(()=>{finished=true;});await new Promise(r=>setTimeout(r,20));
 const returnedEarly=finished;f.release();await closing;await work;
 assert.equal(returnedEarly,false,'runtime close must drain a pending filesystem publication');
 assert.equal(f.pa.status().state,'off');assert.equal(f.creates,0);
 const saved=JSON.parse(await fs.readFile(path.join(f.root,'public-address','playit.json'),'utf8'));assert.equal(saved.enabled,true,'app exit remembers the enabled choice; unlike disable');
});
for(const phase of ['credentials','binding'])test(`disable wins paused first ${phase} rename and fresh restore remains off`,async t=>{
 const f=await paused(t,phase),work=f.pa.settled();const disabling=f.pa.disable();await new Promise(r=>setTimeout(r,20));f.release();await disabling;await work;
 const saved=await fs.readFile(path.join(f.root,'public-address','playit.json'),'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return null;throw e;});assert.notEqual(saved?.enabled,true);
 assert.equal(f.pa.status().state,'off');assert.equal(f.creates,0);
 const calls=f.calls,restored=new PublicAddress(f.root,f.deps);t.after(()=>restored.close());await restored.restore();await restored.settled();assert.equal(f.calls,calls);assert.equal(restored.status().state,'off');
});
