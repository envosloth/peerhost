import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function body(start,end){const main=await readFile(new URL('../dist/apps/desktop/main.js',import.meta.url),'utf8');const match=main.match(new RegExp(`case '${start}':([\\s\\S]*?)case '${end}':`));assert.ok(match);return match[1];}
test('profile save uses the explicit action, never a native warning popup',async()=>{
 let calls=0;const input={javaExecutable:'C:/fixture/java.exe',memoryMiB:2048};
 const invoke=new AsyncFunction('p','confirm','backend',await body('configureSimpleProfile','saveGameGateway'));
 const result=await invoke(input,async()=>{throw Error('Unexpected confirmation popup');},{configureSimpleProfile:async p=>{calls++;return {saved:true,input:p};}});
 assert.deepEqual(result,{saved:true,input});assert.equal(calls,1);
});
test('new server asks for a destination before creation and binds automatic Playit setup to returned world id',async()=>{
 const invoke=new AsyncFunction('p','dialog','window','backend','publicAddress','appNotice',await body('createServer','configureSimpleProfile'));
 const input={name:'World',eulaAccepted:true};let called=0;
 const backend={createServer:async(p,folder)=>{called++;assert.deepEqual(p,input);assert.equal(folder,'C:/fixture/downloads');return {serverId:'created-world'};},getState:async()=>({server:{id:'another-world'},servers:[{id:'created-world',playerPort:25565,state:'offline'},{id:'another-world',playerPort:25566,state:'offline'}]})};
 const enabled=[];const publicAddress={enable:async (server,all)=>{assert.equal(all.length,2);enabled.push(server.id);}};
 const cancelled=await invoke(input,{showOpenDialog:async()=>({canceled:true,filePaths:[]})},{},backend,publicAddress,null);
 assert.equal(cancelled,null);assert.equal(called,0);assert.deepEqual(enabled,[]);
 const result=await invoke(input,{showOpenDialog:async()=>({canceled:false,filePaths:['C:/fixture/downloads']})},{},backend,publicAddress,null);
 assert.deepEqual(result,{serverId:'created-world'});assert.deepEqual(enabled,['created-world']);
});
test('folder open validates the exact selected managed server and propagates shell failure',async()=>{
 const invoke=new AsyncFunction('p','backend','shell',await body('openServerFolder','listServerFiles'));
 const paths=[];let selected='alpha';
 const backend={resolveServerFolder:async id=>{if(id!==selected)throw Error('selected server changed');return 'C:/fixture/managed/servers/alpha';}};
 assert.deepEqual(await invoke({id:'alpha'},backend,{openPath:async path=>{paths.push(path);return '';}}),{opened:true,serverId:'alpha'});
 assert.deepEqual(paths,['C:/fixture/managed/servers/alpha']);
 selected='bravo';await assert.rejects(invoke({id:'alpha'},backend,{openPath:async()=>{throw Error('must not open');}}),/changed/);
 selected='alpha';await assert.rejects(invoke({id:'alpha'},backend,{openPath:async()=> 'Windows could not open this folder'}),/could not open/);
});
test('only server deletion retains a native confirmation call',async()=>{
 const main=await readFile(new URL('../dist/apps/desktop/main.js',import.meta.url),'utf8');
 const calls=[...main.matchAll(/await confirm\(/g)];
 assert.equal(calls.length,1,'all other actions use explicit controls or inline consent, not warning popups');
 const deletion=await body('deleteServer','getServerDashboard');assert.match(deletion,/await confirm\(/);
});
test('quit refuses a busy operation inline without closing services or showing a popup',async()=>{
 const main=await readFile(new URL('../dist/apps/desktop/main.js',import.meta.url),'utf8');const code=main.slice(main.indexOf('async function quit()'),main.indexOf('if (!app.requestSingleInstanceLock()'));
 assert.ok(code.includes('async function quit()'));
 const invoke=new AsyncFunction('backend','publicAddress','helpers','incomingHandoff','app','show','dialog',`let quitting=false,appNotice=null,quitAllowed=false;${code};await quit();return {appNotice,quitAllowed};`);
 const mustNotClose=async()=>{throw Error('busy operation must not close services');};
 const result=await invoke({getState:async()=>({busy:'receiveSnapshot'}),close:mustNotClose},{close:mustNotClose},{closeAll:mustNotClose},{close:mustNotClose},{quit:mustNotClose},()=>{},new Proxy({},{get(){throw Error('No warning popup permitted');}}));
 assert.equal(result.quitAllowed,false);assert.match(result.appNotice,/operation.*progress/i);
});
