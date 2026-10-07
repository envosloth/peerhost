import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {SeedHostApplication} from '../dist/src/core/application.js';
import {createIdentity} from '../dist/src/core/peer-transport.js';
import {PerServerPublicAddresses} from '../dist/src/core/public-address.js';

test('ordinary backend start invokes durable public guard under launch operation lock, without public enable',async t=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR,'app-public-start-')),source=path.join(root,'source'),profile=path.join(root,'profile');
 await mkdir(source);await writeFile(path.join(source,'eula.txt'),'eula=true\n');await writeFile(path.join(source,'server.properties'),'server-port=25565\n');
 const tunnels=[],KEY='c'.repeat(64),AGENT='239a25b9-9377-4d34-be26-94f11ec1813e';
 const manager=new PerServerPublicAddresses(profile,{vault:{encrypt:v=>Buffer.from(v),decrypt:v=>v.toString()},externalAgent:true,adoptKey:async()=>KEY,servers:async()=>(await app.getState()).servers,probe:async()=>true,claim:async()=>{throw Error('claim');},api:async(key,route,p)=>{
  if(route==='/v1/agents/rundata')return {agent_id:AGENT};if(route==='/v1/tunnels/list')return {tunnels};
  if(route==='/tunnels/create'){tunnels.push({id:AGENT,name:p.name,tunnel_type:'minecraft-java',origin:{type:'agent',details:{agent_id:AGENT,config_data:{fields:[{name:'local_ip',value:'127.0.0.1'},{name:'local_port',value:String(p.origin.data.local_port)}]}}},connect_addresses:[{value:{address:'deleted-a.tun.ply.gg'}}]});return {};}
  throw Error(route);
 }});let guardCalls=0;let app;
 app=new SeedHostApplication(profile,await createIdentity(),{beforeServerStart:async server=>{guardCalls++;await assert.rejects(app.saveProfile({executable:process.execPath,args:[]}),/operation.*progress|busy/i);await manager.assertCanStart(server);}});
 t.after(async()=>{await app.close();await manager.close();await rm(root,{recursive:true,force:true});});
 await app.open();await app.importExisting(source,true);await app.saveProfile({executable:process.execPath,args:[path.resolve('tools/fake-java-server.mjs')]});
 const a=(await app.getState()).server;
 await manager.enable(a,(await app.getState()).servers);for(let i=0;i<200&&!manager.status(a).address;i++)await new Promise(r=>setTimeout(r,5));assert.ok(manager.status(a).address);
 await app.deleteServer(a.id);await app.importExisting(source,true);await app.saveProfile({executable:process.execPath,args:[path.resolve('tools/fake-java-server.mjs')]});
 const b=(await app.getState()).server;assert.notEqual(a.id,b.id);assert.equal(b.playerPort,25565);
 // B has never requested a public address. Ordinary Start must still be denied.
 await assert.rejects(app.startServer(true),/port is reserved/i);assert.equal(guardCalls,1);assert.equal(tunnels.length,1);
 const state=await app.getState();assert.equal(state.server.state,'offline');assert.equal(state.server.ownership.state,'owned');
});
