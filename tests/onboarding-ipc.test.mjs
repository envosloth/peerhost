import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCall} from '../dist/src/core/ipc-policy.js';
import {validateOnboarding} from '../dist/src/core/onboarding.js';
import {readFile} from 'node:fs/promises';

test('desktop setup handler strips routing metadata and forwards null, explicit and compatibility scopes',async()=>{
 const main=await readFile(new URL('../dist/apps/desktop/main.js',import.meta.url),'utf8');
 const body=main.match(/case 'saveOnboarding':([\s\S]*?)case 'listSnapshots':/)?.[1];
 assert.ok(body,'compiled setup handler must be present');
 const invoke=new (Object.getPrototypeOf(async function(){}).constructor)('p','backend','alwaysOn',body);
 const input={step:'server',dismissed:false,completed:false,skipped:[],draft:{name:'Pending world',loader:'vanilla',gameVersion:'',memoryMiB:2048}};
 const calls=[]; const helper={enabled:false,error:null};
 const backend={saveOnboarding:async(progress,alwaysOn,serverId)=>{validateOnboarding(progress);calls.push({progress,alwaysOn,serverId});}};
 for(const serverId of [null,'a'.repeat(32),undefined]){
  await invoke(serverId===undefined?input:{...input,serverId},backend,{status:async()=>helper});
  assert.deepEqual(calls.at(-1),{progress:input,alwaysOn:helper,serverId});
 }
});
const url='file:///trusted/seedhost/index.html';
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
test('setup progress routes only to an explicitly validated server or independent new-world draft',()=>{
 const input={step:'server',dismissed:false,completed:false,skipped:[],draft:{name:'Another world',loader:'vanilla',gameVersion:'',memoryMiB:2048}};
 for(const serverId of [null,'a'.repeat(32)])assert.deepEqual(call('saveOnboarding',{...input,serverId}),{...input,serverId});
 for(const serverId of ['../escape','',42,{},undefined,'A'.repeat(32)])assert.throws(()=>call('saveOnboarding',{...input,serverId}),/Invalid/);
 assert.throws(()=>call('saveOnboarding',{...input,serverId:null,path:'/arbitrary'}),/Invalid/);
 assert.throws(()=>call('saveOnboarding',{...input,serverId:null,code:'not a secret draft store'}),/Invalid/);
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
 // Custom JVM arguments are a bounded, supported single-token subset; the memory profile alone stays valid.
 assert.deepEqual(call('configureSimpleProfile',{javaExecutable:'/native/java',memoryMiB:2048,customJavaArgs:['-XX:+UseG1GC','-Dmy.setting=value']}),{javaExecutable:'/native/java',memoryMiB:2048,customJavaArgs:['-XX:+UseG1GC','-Dmy.setting=value']});
 for(const customJavaArgs of [['-Xmx8G'],['-Xms8G'],['-jar','evil.jar'],['-cp','evil'],['--class-path=evil'],['-Djava.class.path=evil'],['-Djava.system.class.loader=Evil'],['@evil.txt'],['nogui'],['java'],['-javaagent:evil.jar'],['-XX:OnError=evil'],['-XX:OnOutOfMemoryError=evil'],['-Dx=a\nb'],['-D' + 'x'.repeat(400) + '=1'],Array(33).fill('-ea'),null])
  assert.throws(()=>call('configureSimpleProfile',{javaExecutable:'/native/java',memoryMiB:2048,customJavaArgs}),/Custom Java arguments/i);
 // Sorting accepts the documented upstream indexes plus visibly page-scoped alphabetical; nothing free-form.
 for(const method of ['searchSetupMods','searchMods']){
  const base=method==='searchSetupMods'?{query:'x',gameVersion:'1.21.1',offset:0}:{query:'x',offset:0};
  assert.deepEqual(call(method,{...base,sort:'title-asc'}),{...base,sort:'title-asc'});
  assert.deepEqual(call(method,{...base,sort:'newest'}),{...base,sort:'newest'});
  for(const sort of ['alphabetical-global','downloads desc','',42])assert.throws(()=>call(method,{...base,sort}),/sort/i);
 }
 assert.deepEqual(call('saveGameGateway',{enabled:true,localPort:25565}),{enabled:true,localPort:25565});
 assert.throws(()=>call('saveGameGateway',{enabled:true,localPort:25565,host:'internal-admin'}),/Invalid/);
 assert.deepEqual(call('openSetupLink',{page:'eula'}),{page:'eula'});
 assert.throws(()=>call('openSetupLink',{page:'https://evil.example'}),/Invalid/);
});
