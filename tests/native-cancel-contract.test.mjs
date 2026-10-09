// Native pickers/deletion retain null cancellation. Explicit labelled actions no longer add warning popups.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function handlerBody(start,end){const main=await readFile(new URL('../dist/apps/desktop/main.js',import.meta.url),'utf8');const body=main.match(new RegExp(`case '${start}':([\\s\\S]*?)case '${end}':`))?.[1];assert.ok(body);return body;}
test('cancelled download picker resolves null before backend or provider mutation',async()=>{
 const invoke=new AsyncFunction('p','dialog','window','backend','publicAddress','appNotice',await handlerBody('createServer','configureSimpleProfile'));
 let calls=0;const input={name:'Fixture world',loader:'vanilla',eulaAccepted:true};
 const backend={createServer:async p=>{calls++;return {serverId:'created'};},getState:async()=>({servers:[{id:'created',playerPort:25565,state:'offline'}]})};
 const provider={enable:async()=>{calls++;}};
 assert.equal(await invoke(input,{showOpenDialog:async()=>({canceled:true,filePaths:[]})},{},backend,provider,null),null);assert.equal(calls,0);
 assert.deepEqual(await invoke(input,{showOpenDialog:async()=>({canceled:false,filePaths:['C:/fixture-downloads']})},{},backend,provider,null),{serverId:'created'});assert.equal(calls,2);
 await assert.rejects(invoke({...input,eulaAccepted:false},{showOpenDialog:async()=>{throw Error('must not open');}},{},backend,provider,null),/EULA/);
});
test('explicit profile Save reaches validation without a redundant confirmation',async()=>{
 const invoke=new AsyncFunction('p','confirm','backend',await handlerBody('configureSimpleProfile','saveGameGateway'));
 let calls=0;const p={javaExecutable:'C:/fixture/java.exe',memoryMiB:2048};
 assert.deepEqual(await invoke(p,async()=>{throw Error('unexpected popup');},{configureSimpleProfile:async input=>{calls++;return {ok:true,input};}}),{ok:true,input:p});assert.equal(calls,1);
});
test('cancelled import picker resolves null and its explicit stopped-source action preserves core acknowledgment',async()=>{
 const invoke=new AsyncFunction('p','confirm','backend','dialog','window',await handlerBody('importServer','saveProfile'));
 let calls=0;const backend={importExisting:async(dir,acknowledged)=>{calls++;return {id:'imported',dir,acknowledged};}};
 const noPopup=async()=>{throw Error('unexpected popup');};
 assert.equal(await invoke({},noPopup,backend,{showOpenDialog:async()=>({canceled:true,filePaths:[]})},{}),null);assert.equal(calls,0);
 assert.deepEqual(await invoke({},noPopup,backend,{showOpenDialog:async(window,options)=>{assert.equal(options.buttonLabel,'Import stopped server');return {canceled:false,filePaths:['C:/fixture-source']};}},{}),{id:'imported',dir:'C:/fixture-source',acknowledged:true});assert.equal(calls,1);
});
