import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateCall} from '../dist/src/core/ipc-policy.js';
const url='file:///seedhost/index.html',id='a'.repeat(32);
// The desktop handler resolves helpers per group now, so the slice scope carries the registry and the
// selected-group lookup instead of one app-wide always-on host.
async function harness(backend,helpers,confirm=async()=>true,helperForSelected=async()=>({status:async()=>({running:false})})){
 const source=await readFile(new URL('../dist/apps/desktop/main.js',import.meta.url),'utf8');const start=source.indexOf("ipcMain.handle('seedhost:call',"),end=source.indexOf('tray = new Tray(',start);
 const mainFrame={url},window={webContents:{id:1,mainFrame}};let handler;
 new Function('ipcMain','validateCall','backend','helpers','helperForSelected','accounts','identity','confirm','window','rendererUrl',`let publicSelectionEpoch=0;${source.slice(start,end)}`)({handle(_c,cb){handler=cb;}},validateCall,backend,helpers,helperForSelected,{status:async()=>({signedIn:true,online:true,username:'alex'})},{fingerprint:'b'.repeat(64)},confirm,window,url);
 return (method,payload)=>handler({sender:{id:1},senderFrame:mainFrame},method,payload);
}
test('group creation starts group control without forcing always-on opt-in or touching another server',async()=>{
 const calls=[];const state={server:{id,name:'QA'},servers:[{id,playerPort:25565}],relay:null};
 const backend={getState:async()=>state,joinHostingGroup:async p=>calls.push(['join',p]),saveRelay:async p=>calls.push(['saveRelay',p])};
 const role={startGroup:async()=>{calls.push(['startGroup']);return {enabled:false};},enable:async()=>calls.push(['FORCED']),ownerInvite:async()=>({code:'test'})};
 const helpers={create:async()=>({root:'fresh',fingerprint:'c'.repeat(64),host:role}),list:()=>[],runningGamePorts:async()=>[]};
 const invoke=await harness(backend,helpers);assert.deepEqual(await invoke('accountStartGroup'),{created:true});assert.equal(calls.some(c=>c[0]==='FORCED'),false);assert.ok(calls.some(c=>c[0]==='startGroup'));
});
test('explicit disband validates the exact selected-server/group payload without a warning popup',async()=>{
 const fp='c'.repeat(64),calls=[];const state={server:{id,name:'QA'},relay:{fingerprint:fp}};
 const backend={getState:async()=>state,checkGroupDisband:async(...a)=>calls.push(['check',a]),disbandGroup:async(...a)=>calls.push(['disband',a])};
 const invoke=await harness(backend,{},async()=>{throw Error('No disband warning popup');});await invoke('disbandGroup',{id,fingerprint:fp});assert.deepEqual(calls,[['check',[id,fp]],['disband',[id,fp]]]);
 for(const payload of [{id,fingerprint:'bad'},{id:'bad',fingerprint:fp},{id,fingerprint:fp,extra:true}])await assert.rejects(invoke('disbandGroup',payload),/invalid/i);
 await assert.rejects(invoke('disbandGroup',{id:'d'.repeat(32),fingerprint:fp}),/selected|changed/i);
});
test('disband rechecks selection generation after backend preflight including A-B-A',async()=>{
 const fp='c'.repeat(64),other='d'.repeat(32),calls=[];const state={server:{id,name:'QA'},relay:{fingerprint:fp}};let invoke;
 const backend={getState:async()=>state,checkGroupDisband:async()=>{await invoke('selectServer',{id:other});await invoke('selectServer',{id});},selectServer:async selected=>{state.server.id=selected;},disbandGroup:async()=>calls.push('disband')};
 invoke=await harness(backend,{},async()=>{throw Error('No disband warning popup');});
 await assert.rejects(invoke('disbandGroup',{id,fingerprint:fp}),/selected|changed/i);assert.deepEqual(calls,[]);
});

export {harness,id};
