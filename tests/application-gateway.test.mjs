import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { RelayNode } from '../dist/src/core/relay.js';
import { gatewayStatus, startHostGameGateway } from '../dist/src/core/game-gateway.js';
import { SeedHostApplication } from '../dist/src/core/application.js';
import { createIdentity } from '../dist/src/core/peer-transport.js';
async function fixture(t){
 const root=await mkdtemp(path.join(process.env.TMPDIR,'ph-runtime-gateway-')),source=path.join(root,'source');await mkdir(source);await writeFile(path.join(source,'eula.txt'),'eula=true\n');await writeFile(path.join(source,'world.bin'),'fixture');
 const relay=new RelayNode(path.join(root,'relay'),await createIdentity(),{log:()=>{},game:{host:'127.0.0.1',port:0}});await relay.open();await relay.listen();await relay.listenGame();
 const app=new SeedHostApplication(path.join(root,'app'),await createIdentity());await app.open();await relay.trust('Host',app.identity.fingerprint);await app.addPeer({name:'Relay',fingerprint:relay.identity.fingerprint,...relay.endpoint});await app.saveRelay({fingerprint:relay.identity.fingerprint,parkOnStop:false});await app.importExisting(source,true);await app.parkAtRelay();await app.claimFromRelay();
 await app.saveProfile({executable:process.execPath,args:[path.resolve('tools/fake-java-server.mjs'),'--lifetime-ms=30000']});
 const sockets=new Set(),echo=createServer(s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));s.on('error',()=>{});s.pipe(s);});await new Promise(r=>echo.listen(0,'127.0.0.1',r));
 t.after(async()=>{await app.close();await relay.close();for(const s of sockets)s.destroy();await new Promise(r=>echo.close(r));await rm(root,{recursive:true,force:true});});return{root,app,relay,localPort:echo.address().port};
}
async function until(check){const end=Date.now()+10000;while(Date.now()<end){if(await check())return;await delay(50);}throw Error('Gateway readiness timeout');}
async function echoThrough(port){return new Promise((resolve,reject)=>{const socket=connect({host:'127.0.0.1',port}),timer=setTimeout(()=>finish(Error('echo timeout')),3000);let done=false;function finish(error,data){if(done)return;done=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(data);}socket.on('error',e=>finish(e));socket.on('connect',()=>socket.write('fixture echo'));socket.on('data',b=>finish(null,b.toString()));socket.on('end',()=>finish(Error('closed without reply')));});}
test('application starts gateway only after explicit opt-in and confirmed running holder; stop revokes it',async t=>{
 const{app,relay,localPort}=await fixture(t);await app.startServer(true);assert.equal((await app.checkGameGateway()).ready,false);await app.stopServer();
 await app.saveGameGateway({enabled:true,localPort});assert.equal((await app.checkGameGateway()).ready,false);await app.startServer(true);
 await until(async()=>(await app.checkGameGateway()).ready);assert.equal(await echoThrough(relay.gameEndpoint.port),'fixture echo');
 await app.stopServer();await until(async()=>!(await app.checkGameGateway()).ready);await assert.rejects(echoThrough(relay.gameEndpoint.port));assert.equal((await app.getState()).gateway.state,'off');
});
test('host tunnel refuses an expected lineage different from confirmed relay route',async t=>{
 const{app,relay,localPort}=await fixture(t),ownership=(await app.getState()).server.ownership;let state;
 const tunnel=await startHostGameGateway(app.identity,{...relay.endpoint,fingerprint:relay.identity.fingerprint},localPort,{expectedRoute:{generation:ownership.generation,lineage:'other-lineage'},onStatus:s=>{state=s;}});t.after(()=>tunnel.close());
 await until(()=>state?.state==='error'||state?.state==='ready');assert.equal(state.state,'error');assert.equal((await app.checkGameGateway()).ready,false);await tunnel.close();
});
test('corrupt optional gateway metadata is visible and never blocks console/clean stop',async t=>{
 const{app,relay,localPort}=await fixture(t);await app.saveGameGateway({enabled:true,localPort});await app.startServer(true);await until(async()=>(await app.checkGameGateway()).ready);
 const file=path.join(app.root,'game-gateway.json');await writeFile(file,'broken optional metadata');
 const state=await app.getState();assert.match(state.gateway.detail,/unreadable/i);app.sendCommand('say metadata remains optional');await app.stopServer();
 assert.equal((await app.getState()).server.ownership.state,'owned');assert.equal(await readFile(file,'utf8'),'broken optional metadata');await assert.rejects(app.saveGameGateway({enabled:false,localPort}),/unreadable/i);assert.equal((await gatewayStatus(app.identity,{...relay.endpoint,fingerprint:relay.identity.fingerprint})).ready,false);
});
test('unreachable opted-in relay does not stop local hosting or graceful save',async t=>{
 const{app,relay,localPort}=await fixture(t);await app.saveGameGateway({enabled:true,localPort});await relay.close();await app.startServer(true);
 assert.equal((await app.getState()).server.state,'running');assert.equal((await app.getState()).gateway.state,'error');app.sendCommand('say direct hosting survives');await app.stopServer();assert.equal((await app.getState()).server.ownership.state,'owned');
});
test('unexpected process exit closes forwarding and fences ownership',async t=>{
 const{app,relay,localPort}=await fixture(t);await app.saveGameGateway({enabled:true,localPort});await app.saveProfile({executable:process.execPath,args:[path.resolve('tools/fake-java-server.mjs'),'--lifetime-ms=1500']});await app.startServer(true);
 await until(async()=>(await app.checkGameGateway()).ready);await until(async()=>(await app.getState()).server.ownership.state==='uncertain');await until(async()=>!(await app.checkGameGateway()).ready);assert.equal((await app.getState()).gateway.state,'off');
});
test('gateway is opt-in and refuses enabling without configured relay',async t=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR,'ph-app-gateway-'));
 const app=new SeedHostApplication(root,await createIdentity());await app.open();t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 assert.equal((await app.getState()).gateway.enabled,false);
 await assert.rejects(app.saveGameGateway({enabled:true,localPort:25565}),/relay/i);
 assert.equal((await app.checkGameGateway()).ready,false);
 await app.saveGameGateway({enabled:false,localPort:25566});assert.equal((await app.getState()).gateway.localPort,25566);
});
