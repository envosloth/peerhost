import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCall} from '../dist/src/core/ipc-policy.js';
const url='file:///trusted/peerhost/index.html';
const ctx={senderId:9,expectedSenderId:9,isMainFrame:true};
const call=(method,payload)=>validateCall(method,payload,url,url,ctx);
test('setup progress and retained-history IPC are narrow and main-frame only',()=>{
 const input={step:'friends',dismissed:false,completed:false,skipped:[],draft:{name:'World',loader:'vanilla',gameVersion:'1.21.1',memoryMiB:2048}};
 assert.deepEqual(call('saveOnboarding',input),input);
 assert.throws(()=>call('saveOnboarding',{...input,code:'never persist invitation'}),/Invalid/);
 assert.deepEqual(call('listSnapshots'),{});
 const id='a'.repeat(64);assert.deepEqual(call('restoreSnapshot',{snapshotId:id}),{snapshotId:id});
 assert.throws(()=>call('restoreSnapshot',{snapshotId:'../escape'}),/Invalid/);
 assert.throws(()=>call('restoreSnapshot',{snapshotId:id,path:'/arbitrary'}),/Invalid/);
 assert.throws(()=>validateCall('saveOnboarding',input,url,url,{...ctx,isMainFrame:false}),/Untrusted/);
});
test('new server and runtime setup IPC refuse URLs, filesystem destinations, shell text and implicit EULA',()=>{
 const input={name:'World',loader:'fabric',gameVersion:'1.21.1',javaExecutable:'/native/selected/java',memoryMiB:2048,eulaAccepted:true};
 assert.deepEqual(call('createServer',input),input);
 for(const extra of [{url:'https://evil.example/server.jar'},{destination:'/etc'},{args:['arbitrary']}])assert.throws(()=>call('createServer',{...input,...extra}),/Invalid/);
 assert.throws(()=>call('createServer',{...input,eulaAccepted:undefined}),/Invalid/);
 assert.throws(()=>call('createServer',{...input,loader:'forge'}),/Invalid/);
 assert.throws(()=>call('createServer',{...input,memoryMiB:12}),/Invalid/);
 assert.throws(()=>call('createServer',{...input,javaExecutable:'java\nrm -rf anything'}),/Invalid/);
 for(const method of ['listServerVersions','discoverJava','pickJava','checkGameGateway']){
  assert.deepEqual(call(method),{});
  assert.throws(()=>call(method,{url:'https://evil.example',path:'/arbitrary'}),/Invalid/);
 }
 assert.deepEqual(call('configureSimpleProfile',{javaExecutable:'/native/java',memoryMiB:2048}),{javaExecutable:'/native/java',memoryMiB:2048});
 assert.deepEqual(call('saveGameGateway',{enabled:true,localPort:25565}),{enabled:true,localPort:25565});
 assert.throws(()=>call('saveGameGateway',{enabled:true,localPort:25565,host:'internal-admin'}),/Invalid/);
 assert.deepEqual(call('openSetupLink',{page:'eula'}),{page:'eula'});
 assert.throws(()=>call('openSetupLink',{page:'https://evil.example'}),/Invalid/);
});
