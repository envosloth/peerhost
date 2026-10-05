// Real official downloads, JVM servers, pinned custody transfer and Minecraft status. No fixture servers.
// Application opt-in/lifecycle is exercised; visible UI has separate checks.
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ServerSetupClient, probeJava } from '../dist/src/core/server-setup.js';
import { SeedHostApplication } from '../dist/src/core/application.js';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { RelayNode } from '../dist/src/core/relay.js';


const java=process.env.SEEDHOST_SMOKE_JAVA;
assert.ok(java&&path.isAbsolute(java),'Set absolute SEEDHOST_SMOKE_JAVA to an explicitly approved disposable runtime');
assert.equal(process.env.SEEDHOST_SMOKE_ACCEPT_EULA,'true','Explicit disposable-test EULA acceptance is required');
assert.ok(process.env.TMPDIR,'All artifacts must stay in scratch');
const root=await mkdtemp(path.join(process.env.TMPDIR,'seedhost-real-minecraft-'));
const results={artifactDir:root,java,gameVersion:'1.21.1',loaders:[],limitations:['Loopback only; profiles simulate two hosts on one machine, not physical PCs.','Minecraft status response, not authenticated player login/gameplay.','Application gateway lifecycle exercised; visible UI and authenticated gameplay are separate checks.']};
console.log('ARTIFACT_DIR='+root);
function vi(value){const out=[];do{let b=value&127;value>>>=7;if(value)b|=128;out.push(b);}while(value);return Buffer.from(out);}
function str(value){const b=Buffer.from(value);return Buffer.concat([vi(b.length),b]);}
function frame(b){return Buffer.concat([vi(b.length),b]);}
function integer(b,offset=0){let n=0;for(let i=0;i<5;i++){if(offset+i>=b.length)return null;const c=b[offset+i];n|=(c&127)<<(i*7);if(!(c&128))return{value:n,bytes:i+1};}throw Error('Invalid Minecraft VarInt');}
async function status(port){
 return new Promise((resolve,reject)=>{
  const s=connect({host:'127.0.0.1',port});let data=Buffer.alloc(0),done=false;
  const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);s.destroy();error?reject(error):resolve(result);};
  const timer=setTimeout(()=>finish(Error('Minecraft status timed out')),15000);
  s.on('error',error=>finish(error));s.on('end',()=>finish(Error('Minecraft status closed before complete response')));
  s.on('connect',()=>{const p=Buffer.alloc(2);p.writeUInt16BE(port);s.write(Buffer.concat([frame(Buffer.concat([vi(0),vi(767),str('localhost'),p,vi(1)])),frame(vi(0))]));});
  s.on('data',chunk=>{try{
   data=Buffer.concat([data,chunk]);if(data.length>65536)throw Error('Oversized Minecraft status');
   const len=integer(data);if(!len||data.length<len.bytes+len.value)return;
   const payload=data.subarray(len.bytes,len.bytes+len.value),id=integer(payload);assert.equal(id.value,0);
   const size=integer(payload,id.bytes);assert.ok(size);assert.equal(id.bytes+size.bytes+size.value,payload.length);
   const result=JSON.parse(payload.subarray(id.bytes+size.bytes).toString());assert.equal(result.version.protocol,767);assert.match(result.version.name,/1\.21\.1/);finish(null,result);
  }catch(error){finish(error);}});
 });
}
async function port(){const s=createServer();await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r);});const n=s.address().port;await new Promise(r=>s.close(r));return n;}
async function until(check,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(100);}throw Error('Timed out waiting for verified gateway readiness');}
async function host(folder,relay){
 const identity=await createIdentity(),app=new SeedHostApplication(folder,identity,{confirmIncomingHandoff:async()=>true});await app.open();
 await relay.trust(path.basename(folder),identity.fingerprint);
 await app.addPeer({name:'Disposable relay',fingerprint:relay.identity.fingerprint,...relay.endpoint});
 await app.saveRelay({fingerprint:relay.identity.fingerprint,parkOnStop:false});
 return{identity,app};
}
async function configure(app,prepared,localPort){
 const server=(await app.getState()).server;
 let props=await readFile(path.join(server.serverDir,'server.properties'),'utf8');
 props=props.replace(/^server-port=.*$/m,'server-port='+localPort).replace(/^server-ip=.*$/m,'server-ip=127.0.0.1');
 await writeFile(path.join(server.serverDir,'server.properties'),props);
 await app.saveProfile({...prepared.profile,startTimeoutSeconds:300,stopTimeoutSeconds:120});
}
try{
 results.runtime=await probeJava(java);
 for(const loader of ['vanilla','fabric']){
  const work=path.join(root,loader);await mkdir(work);
  const record={loader,steps:[]};results.loaders.push(record);
  let relay,a,b;const localPort=await port();
  try{
   const prepared=await new ServerSetupClient().prepare(work,{name:'Disposable '+loader,loader,gameVersion:'1.21.1',javaExecutable:java,memoryMiB:1024,eulaAccepted:true});
   // Loopback, online-mode remains true; small generated world avoids resource-heavy spawn preparation.
   await writeFile(path.join(prepared.sourceDir,'server.properties'),`server-ip=127.0.0.1\nserver-port=${localPort}\nonline-mode=true\nlevel-seed=12345\nlevel-type=minecraft:flat\ngenerate-structures=false\nview-distance=2\nsimulation-distance=2\nmax-players=2\nmax-tick-time=120000\nmotd=SeedHost disposable ${loader}\n`);
   record.steps.push('Official checked downloads and explicit EULA');
   relay=new RelayNode(path.join(work,'relay'),await createIdentity(),{log:line=>{void appendFile(path.join(work,'relay.log'),line+'\n');},game:{host:'127.0.0.1',port:0}});
   await relay.open();await relay.listen();await relay.listenGame();
   record.playerPort=relay.gameEndpoint.port;
   a=await host(path.join(work,'host-a'),relay);b=await host(path.join(work,'host-b'),relay);
   await a.app.importExisting(prepared.sourceDir,true);await configure(a.app,prepared,localPort);
   await a.app.startServer(true);record.directStatus=await status(localPort);
   a.app.sendCommand('scoreboard objectives add seedhostSmoke dummy');
   await a.app.stopServer();const saved=(await a.app.getState()).server;
   const marker=path.join('world','data','scoreboard.dat');
   const markerBytes=await readFile(path.join(saved.serverDir,marker));assert.ok(markerBytes.length>0);
   record.savedScoreboardHash=createHash('sha256').update(markerBytes).digest('hex');record.initialSnapshot=saved.snapshotId;
   record.steps.push('Actual Minecraft ready/status, console mutation and graceful save/snapshot');
   await a.app.parkAtRelay();await a.app.claimFromRelay();await configure(a.app,prepared,localPort);
   await a.app.saveGameGateway({enabled:true,localPort});await a.app.startServer(true);
   await until(async()=>(await a.app.checkGameGateway()).ready);
   record.hostAStatus=await status(record.playerPort);record.steps.push('Confirmed holder A: real Minecraft status through pinned TLS player gateway');
   await a.app.stopServer();
   await until(async()=>!(await a.app.checkGameGateway()).ready);
   await assert.rejects(status(record.playerPort));record.steps.push('Stopped gateway refuses players');
   await a.app.parkAtRelay();await assert.rejects(a.app.startServer(true),/ownership/i);
   await a.app.close();a.app=null;
   await b.app.claimFromRelay();await configure(b.app,prepared,localPort);
   const claimed=(await b.app.getState()).server;
   const moved=await readFile(path.join(claimed.serverDir,marker));
   assert.equal(createHash('sha256').update(moved).digest('hex'),record.savedScoreboardHash,'Saved scoreboard survives verified custody transfer');
   record.hostBGeneration=claimed.ownership.generation;
   await b.app.saveGameGateway({enabled:true,localPort});await b.app.startServer(true);
   await until(async()=>(await b.app.checkGameGateway()).ready);
   record.hostBStatus=await status(record.playerPort);assert.equal(relay.gameEndpoint.port,record.playerPort);
   record.steps.push('Original profile closed; B claimed saved world and serves actual Minecraft status at same player port');
   await b.app.stopServer();
   record.finalSnapshot=(await b.app.getState()).server.snapshotId;
   assert.notEqual(record.finalSnapshot,record.initialSnapshot);record.steps.push('B graceful stop captures new revision');
   await writeFile(path.join(work,'host-b-console.json'),JSON.stringify((await b.app.getState()).logs,null,2));
   record.pass=true;console.log('PASS '+loader+': '+record.steps.join('; '));
  }finally{
   for(const h of [a,b])if(h?.app){try{await h.app.close();}catch(error){console.error('Cleanup failed',error);record.pass=false;process.exitCode=1;}}
   await relay?.close().catch(()=>{});
   await writeFile(path.join(root,'result.json'),JSON.stringify(results,null,2));
  }
 }
 assert.equal(results.loaders.length,2);assert.ok(results.loaders.every(r=>r.pass));results.pass=true;
}catch(error){results.pass=false;results.error=error.stack;console.error(error);process.exitCode=1;}
finally{await writeFile(path.join(root,'result.json'),JSON.stringify(results,null,2));console.log('RESULT_FILE='+path.join(root,'result.json'));}
