// Opt-in official Minecraft proof: helper and real Fabric server coexist on separate loopback ports.
// No live world/account reads, no native dialogs, no authenticated-player/WAN claim.
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {createServer,connect} from 'node:net';
import {ServerSetupClient,probeJava} from '../dist/src/core/server-setup.js';
import {SeedHostApplication} from '../dist/src/core/application.js';
import {AlwaysOnHost} from '../dist/src/core/always-on.js';
import {createIdentity} from '../dist/src/core/peer-transport.js';

const java=process.env.SEEDHOST_SMOKE_JAVA,version=process.env.SEEDHOST_SMOKE_VERSION??'26.3';
// Protocol 777 was read from the official 26.3 server JAR's version.json, not guessed.
const protocol=Number(process.env.SEEDHOST_SMOKE_PROTOCOL??(version==='26.3'?'777':''));
assert.ok(Number.isInteger(protocol)&&protocol>0,'Supply the verified Minecraft protocol for other game versions');
assert.ok(java&&path.isAbsolute(java),'Set an explicitly approved absolute SEEDHOST_SMOKE_JAVA');
assert.equal(process.env.SEEDHOST_SMOKE_ACCEPT_EULA,'true','Disposable-test EULA acceptance must be explicit');
assert.ok(process.env.TMPDIR,'All artifacts must stay in scratch');
const root=await mkdtemp(path.join(process.env.TMPDIR,'real-gateway-port-'));
const result={pass:false,artifactDir:root,loader:'fabric',gameVersion:version,limitations:['Loopback status and console/save proof only; no authenticated player login or WAN verification.','Core application path; visible packaged UI is checked separately.']};
let helper,app;
const varint=n=>{const bytes=[];do{let b=n&127;n>>>=7;if(n)b|=128;bytes.push(b);}while(n);return Buffer.from(bytes);};
const string=s=>{const b=Buffer.from(s);return Buffer.concat([varint(b.length),b]);};
const frame=b=>Buffer.concat([varint(b.length),b]);
function integer(b,offset=0){let value=0;for(let i=0;i<5;i++){if(offset+i>=b.length)return null;const c=b[offset+i];value|=(c&127)<<(7*i);if(!(c&128))return {value,bytes:i+1};}throw Error('Invalid Minecraft VarInt');}
async function freePort(){const probe=createServer();await new Promise((r,j)=>{probe.once('error',j);probe.listen(0,'127.0.0.1',r);});const port=probe.address().port;await new Promise(r=>probe.close(r));return port;}
async function status(port){return new Promise((resolve,reject)=>{
  const socket=connect({host:'127.0.0.1',port});let data=Buffer.alloc(0),done=false;
  const timer=setTimeout(()=>finish(Error('Minecraft status timed out')),15000);
  function finish(error,value){if(done)return;done=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);}
  socket.on('error',finish);socket.on('end',()=>finish(Error('Minecraft status ended before response')));
  socket.on('connect',()=>{const p=Buffer.alloc(2);p.writeUInt16BE(port);socket.write(Buffer.concat([frame(Buffer.concat([varint(0),varint(protocol),string('localhost'),p,varint(1)])),frame(varint(0))]));});
  socket.on('data',chunk=>{try{data=Buffer.concat([data,chunk]);assert.ok(data.length<=65536);const length=integer(data);if(!length)return;assert.ok(length.value>=0&&length.value<=65536);if(data.length<length.bytes+length.value)return;const body=data.subarray(length.bytes,length.bytes+length.value),id=integer(body);assert.equal(id?.value,0);const size=integer(body,id.bytes);assert.ok(size&&size.value>=0);assert.equal(id.bytes+size.bytes+size.value,body.length);finish(null,JSON.parse(body.subarray(id.bytes+size.bytes).toString('utf8')));}catch(e){finish(e);}});
});}
console.log('ARTIFACT_DIR='+root);
try{
  result.runtime=await probeJava(java);
  const gamePort=await freePort();result.minecraftPort=gamePort;
  const prepared=await new ServerSetupClient().prepare(root,{name:'Disposable gateway port proof',loader:'fabric',gameVersion:version,javaExecutable:java,memoryMiB:1024,eulaAccepted:true});
  await writeFile(path.join(prepared.sourceDir,'server.properties'),`server-ip=127.0.0.1\nserver-port=${gamePort}\nonline-mode=true\nlevel-seed=12345\nlevel-type=minecraft:flat\ngenerate-structures=false\nview-distance=2\nsimulation-distance=2\nmax-players=2\nmax-tick-time=120000\nenable-query=false\nenable-rcon=false\nmotd=Disposable SeedHost port proof\n`);
  app=new SeedHostApplication(path.join(root,'profile'),await createIdentity());await app.open();
  await app.importExisting(prepared.sourceDir,true);await app.saveProfile({...prepared.profile,startTimeoutSeconds:300,stopTimeoutSeconds:120});
  const before=await app.getState();assert.equal(before.settings.persistentAddress,false);assert.equal(before.relay,null);
  const reserved=before.servers.map(s=>s.playerPort);assert.ok(reserved.includes(gamePort));
  helper=new AlwaysOnHost(path.join(root,'helper'),await createIdentity(),{host:'127.0.0.1',port:0,gamePorts:[gamePort,0],discoveryPort:0,reservedGamePorts:reserved});
  const role=await helper.enable();assert.equal(role.running,true);assert.notEqual(role.gamePort,gamePort);result.gatewayPort=role.gamePort;
  await app.startServer(true);
  const running=await app.getState();assert.equal(running.server.state,'running');assert.equal(running.server.ownership.state,'hosting');
  // Stdout readiness and the server's first cached status response are separate observations.
  // Retry real packets for a bounded interval; never manufacture a response from the launch log.
  const statusDeadline=Date.now()+15000;let lastStatusError;
  result.statusAttempts=0;
  while(Date.now()<statusDeadline){
    result.statusAttempts++;
    try{result.minecraftStatus=await status(gamePort);break;}catch(error){lastStatusError=error;await new Promise(r=>setTimeout(r,100));}
  }
  if(!result.minecraftStatus)throw lastStatusError??new Error('Minecraft status did not become available');
  assert.ok(result.minecraftStatus.version.name.includes(version));assert.equal(result.minecraftStatus.version.protocol,protocol);
  app.sendCommand('say gateway-port-smoke-marker');
  const deadline=Date.now()+10000;let seen=false;
  while(Date.now()<deadline){if((await app.getState()).logs.some(line=>line.includes('gateway-port-smoke-marker'))){seen=true;break;}await new Promise(r=>setTimeout(r,100));}
  assert.equal(seen,true,'real server must handle console command');
  await app.stopServer();const stopped=await app.getState();assert.equal(stopped.server.state,'offline');assert.equal(stopped.server.ownership.state,'owned');
  assert.notEqual(stopped.server.snapshotId,before.server.snapshotId);
  assert.ok((await readFile(path.join(stopped.server.serverDir,'world','level.dat'))).length>0);
  assert.equal((await helper.status()).running,true);result.finalSnapshot=stopped.server.snapshotId;result.pass=true;
  console.log('PASS: official Fabric '+version+' on Java '+result.runtime.major+' reached real Minecraft status, executed console command, saved world and stopped cleanly while the helper stayed running on a different port.');
}catch(error){result.error=String(error);process.exitCode=1;console.error(error);}
finally{
  try{await app?.close();}catch(error){result.pass=false;result.cleanupError=String(error);process.exitCode=1;console.error('Owned process cleanup failed',error);}
  await helper?.close();await writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2));
  console.log('RESULT='+path.join(root,'result.json'));
}
