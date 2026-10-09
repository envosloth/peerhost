import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {validateCall} from '../dist/src/core/ipc-policy.js';

// Public-state workflow integration: captured-world automatic public setup, honest copy gating,
// scoped recovery IPC/consent and the inline first-use provider approval. Fixtures drive the real
// compiled main slices and the real renderer/dashboard source under an isolated shadow tree.
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
let mainCache;
const mainSource=async()=>mainCache??=await readFile(new URL('../dist/apps/desktop/main.js',import.meta.url),'utf8');
const rendererSource=()=>readFile(new URL('../apps/desktop/renderer.js',import.meta.url),'utf8');
function slice(source,begin,end){
  const a=source.indexOf(begin),b=source.indexOf(end,a);
  assert.ok(a>=0,`start marker missing: ${begin}`);
  assert.ok(b>a,`end marker missing after: ${begin}`);
  return source.slice(a,b);
}
const trusted={senderId:1,expectedSenderId:1,isMainFrame:true};
const id32=c=>c.repeat(32);

function backendFixture(world,other=null,overrides={}){
  let reads=0;
  return {getState:async()=>{reads++;return reads===1?{server:world,servers:[world,other].filter(Boolean)}:{server:overrides.lateSelection??world,servers:[world,other].filter(Boolean)}},reads:()=>reads,...overrides};
}

// ---------- main process: captured-world public setup ----------

test('ordinary Start enables the public address for the world captured under approval, never the later selection',async()=>{
  const source=await mainSource(),block=slice(source,"case 'startServer':","case 'stopServer':");
  const world={id:id32('a'),serverDir:'C:/worlds/a',playerPort:25565,state:'running'};
  const other={id:id32('b'),serverDir:'C:/worlds/b',playerPort:25567,state:'offline'};
  let reads=0;const calls=[];
  const backend={getState:async()=>{reads++;return reads===1?{server:world,servers:[world,other]}:{server:other,servers:[world,other]};},
    startServerWithApproval:async confirm=>{assert.equal(await confirm({serverDir:world.serverDir}),true);}};
  const helpers={runningGamePorts:async()=>[]};
  const publicAddress={invalidateVerification:id=>calls.push(['invalidate',id]),
    enable:async(server,servers)=>calls.push(['enable',server.id,server.serverDir,servers.length])};
  const run=new AsyncFunction('backend','helpers','publicAddress','readServerPort','appNotice',`const publishHolderEndpointNow=async()=>{};switch('startServer'){${block}}`);
  await run(backend,helpers,publicAddress,async()=>25565,null);
  assert.deepEqual(calls[0],['invalidate',world.id]);
  assert.deepEqual(calls[1],['enable',world.id,world.serverDir,2]);
  assert.equal(calls.filter(call=>call[0]==='enable').length,1,'exactly one captured world is enabled, not the newly selected server');
});

test('a failed public enable leaves the successful local start running and reported',async()=>{
  const source=await mainSource(),block=slice(source,"case 'startServer':","case 'stopServer':");
  const world={id:id32('a'),serverDir:'C:/worlds/a',playerPort:25565,state:'running'};
  let starts=0,invalidations=0;
  const backend={getState:async()=>({server:world,servers:[world]}),
    startServerWithApproval:async confirm=>{starts++;await confirm({serverDir:world.serverDir});}};
  const publicAddress={invalidateVerification:()=>{invalidations++;},enable:async()=>{throw new Error('provider unreachable')}};
  const run=new AsyncFunction('backend','helpers','publicAddress','readServerPort','appNotice',`const publishHolderEndpointNow=async()=>{};switch('startServer'){${block}}`);
  await run(backend,{runningGamePorts:async()=>[]},publicAddress,async()=>25565,null);
  assert.equal(starts,1,'the local start is not undone or repeated when public setup fails');
  assert.equal(invalidations,1);
});

test('the start path never enables the always-on gateway or any helper role on its own',async()=>{
  const source=await mainSource(),block=slice(source,"case 'startServer':","case 'stopServer':");
  const world={id:id32('a'),serverDir:'C:/worlds/a',playerPort:25565,state:'running'};
  const helperAccess=[],publicAccess=[];
  const helpers=new Proxy({runningGamePorts:async()=>[]},{get(target,key){helperAccess.push(String(key));return target[key];}});
  const publicAddress=new Proxy({invalidateVerification(){},enable:async()=>{}},{get(target,key){publicAccess.push(String(key));return target[key];}});
  const backend={getState:async()=>({server:world,servers:[world]}),startServerWithApproval:async confirm=>{await confirm({serverDir:world.serverDir});}};
  const run=new AsyncFunction('backend','helpers','publicAddress','readServerPort','appNotice',`const publishHolderEndpointNow=async()=>{};switch('startServer'){${block}}`);
  await run(backend,helpers,publicAddress,async()=>25565,null);
  assert.deepEqual(helperAccess,['runningGamePorts'],'only the port-collision read may touch the helper layer');
  assert.deepEqual([...new Set(publicAccess)].sort(),['enable','invalidateVerification']);
});

test('isolated test-loopback harnesses never initiate real provider setup on Start',async()=>{
  const source=await mainSource(),block=slice(source,"case 'startServer':","case 'stopServer':");
  const world={id:id32('a'),serverDir:'C:/worlds/a',playerPort:25565,state:'running'};
  const events=[];
  const backend={getState:async()=>({server:world,servers:[world]}),startServerWithApproval:async confirm=>{await confirm({serverDir:world.serverDir});}};
  const publicAddress={invalidateVerification:()=>events.push('invalidate'),enable:async()=>events.push('enable')};
  const run=new AsyncFunction('backend','helpers','publicAddress','readServerPort','appNotice',`const publishHolderEndpointNow=async()=>{};switch('startServer'){${block}}`);
  process.env.SEEDHOST_TEST_LOOPBACK='1';
  try{ await run(backend,{runningGamePorts:async()=>[]},publicAddress,async()=>25565,null); }
  finally{ delete process.env.SEEDHOST_TEST_LOOPBACK; }
  assert.deepEqual(events,['invalidate'],'no provider mutation in the isolated harness');
});

test('group Start enables the public address for the exact claimed world captured under approval',async()=>{
  const source=await mainSource(),block=slice(source,"case 'startGroup':","case 'claimPendingGroup':");
  const world={id:id32('c'),serverDir:'C:/worlds/g',playerPort:25570,state:'running'};
  const calls=[];
  const backend={getState:async()=>({server:world,servers:[world]}),
    startGroupWithApproval:async(fingerprint,confirm)=>{assert.equal(fingerprint,'f'.repeat(64));await confirm({serverDir:world.serverDir});}};
  const publicAddress={invalidateVerification:id=>calls.push(['invalidate',id]),enable:async server=>calls.push(['enable',server.id,server.serverDir])};
  const run=new AsyncFunction('p','backend','helpers','publicAddress','readServerPort','appNotice',`const publishHolderEndpointNow=async()=>{};switch('startGroup'){${block}}`);
  await run({fingerprint:'f'.repeat(64)},backend,{runningGamePorts:async()=>[]},publicAddress,async()=>25570,null);
  assert.deepEqual(calls,[['invalidate',world.id],['enable',world.id,world.serverDir]]);
});

test('Stop invalidates the captured world immediately; a refused stop leaves verification alone',async()=>{
  const source=await mainSource(),block=slice(source,"case 'stopServer':","case 'createSnapshot':");
  const world={id:id32('d')};
  const events=[];
  const backend={getState:async()=>({server:world}),stopServer:async()=>{events.push('stop');return {stopped:true};}};
  const publicAddress={invalidateVerification:id=>events.push(['invalidate',id])};
  const run=new AsyncFunction('backend','publicAddress',`const publishHolderEndpoint=()=>{};switch('stopServer'){${block}}`);
  await run(backend,publicAddress);
  assert.deepEqual(events,['stop',['invalidate',world.id]]);

  const refused={getState:async()=>({server:world}),stopServer:async()=>{throw new Error('still publishing')}};
  await assert.rejects(run(refused,publicAddress),/still publishing/);
  assert.deepEqual(events,['stop',['invalidate',world.id]],'no invalidation for a stop that did not complete');
});

// ---------- main process: scoped recovery consent ----------

test('recoverStopped refuses a stale or switched captured world before the core method is reached',async()=>{
  const source=await mainSource(),block=slice(source,"case 'recoverStopped':","default:");
  const run=new AsyncFunction('p','backend','selectionEpochNow',`switch('recoverStopped'){${block}}`);
  let recoveries=0;
  const switched={getState:async()=>({server:{id:id32('b')}}),recoverStopped:async()=>{recoveries++;}};
  await assert.rejects(run({confirmed:true,id:id32('a')},switched,()=>0),/selected server changed/i);
  assert.equal(recoveries,0);

  let epochCalls=0;
  const same={getState:async()=>({server:{id:id32('a')}}),recoverStopped:async()=>{recoveries++;}};
  await assert.rejects(run({confirmed:true,id:id32('a')},same,()=>epochCalls++===0?0:1),/selected server changed/i,'an A→B→A selection epoch change refuses the stale click');
  assert.equal(recoveries,0);

  const current={getState:async()=>({server:{id:id32('a')}}),recoverStopped:async()=>{recoveries++;}};
  await run({confirmed:true,id:id32('a')},current,()=>7);
  assert.equal(recoveries,1);

  // Legacy id-less callers reach the core only while the current world is not bound to a hosting group.
  await run({confirmed:true},current,()=>7);
  assert.equal(recoveries,2);

  // A group-bound world refuses the id-less legacy path and recovers only for its matching captured id.
  const groupWorld={getState:async()=>({server:{id:id32('a'),group:{fingerprint:'f'.repeat(64)}}}),recoverStopped:async()=>{recoveries++;}};
  await assert.rejects(run({confirmed:true},groupWorld,()=>7),/captured world id|hosting group/i,'an id-less recovery never authorizes a group world');
  assert.equal(recoveries,2);
  await assert.rejects(run({confirmed:true,id:id32('b')},groupWorld,()=>7),/selected server changed/i);
  assert.equal(recoveries,2);
  await run({confirmed:true,id:id32('a')},groupWorld,()=>7);
  assert.equal(recoveries,3);
});

test('read-only groupRecoveryStatus IPC is validated, payload-free and present in the preload allowlist',async()=>{
  const source=await mainSource(),block=slice(source,"case 'groupRecoveryStatus':","default:");
  const evidence={serverId:id32('a'),groupFingerprint:'f'.repeat(64),admission:null,remote:null};
  const run=new AsyncFunction('backend',`switch('groupRecoveryStatus'){${block}}`);
  assert.deepEqual(await run({groupRecoveryStatus:async()=>evidence}),evidence);
  assert.deepEqual(validateCall('groupRecoveryStatus',undefined,'file:///app','file:///app',trusted),{});
  assert.throws(()=>validateCall('groupRecoveryStatus',{id:id32('a')},'file:///app','file:///app',trusted),/no arguments|Invalid/i);
  const preload=await readFile(new URL('../dist/apps/desktop/preload.cjs',import.meta.url),'utf8');
  assert.match(preload,/groupRecoveryStatus/);
});

test('recoverStopped policy carries and validates the captured world binding',()=>{
  assert.deepEqual(validateCall('recoverStopped',{confirmed:true,id:id32('a')},'file:///app','file:///app',trusted),{confirmed:true,id:id32('a'),epoch:null});
  assert.deepEqual(validateCall('recoverStopped',{confirmed:true},'file:///app','file:///app',trusted),{confirmed:true,id:null,epoch:null});
  assert.deepEqual(validateCall('recoverStopped',{confirmed:true,id:id32('a'),epoch:3},'file:///app','file:///app',trusted),{confirmed:true,id:id32('a'),epoch:3});
  assert.throws(()=>validateCall('recoverStopped',{confirmed:true,id:'not-an-id'},'file:///app','file:///app',trusted),/recovery server binding/i);
  assert.throws(()=>validateCall('recoverStopped',{confirmed:true,id:id32('a'),extra:true},'file:///app','file:///app',trusted),/Invalid recovery request/i);
  assert.throws(()=>validateCall('recoverStopped',{confirmed:true,epoch:'3'},'file:///app','file:///app',trusted),/recovery context/i);
  assert.throws(()=>validateCall('recoverStopped',{confirmed:true,epoch:-1},'file:///app','file:///app',trusted),/recovery context/i);
  assert.throws(()=>validateCall('recoverStopped',{confirmed:false},'file:///app','file:///app',trusted),/confirm/i);
});

// ---------- main process: inline first-use provider approval ----------

test('first-use provider approval opens inline inside the same enable action',async()=>{
  const source=await mainSource();
  const begin=source.indexOf("case 'publicAddressStatus'"),end=source.indexOf("case 'pairAlwaysOn':",begin);
  assert.ok(begin>=0&&end>begin,'public address case markers');
  const run=new AsyncFunction('method','p','backend','helpers','publicAddress','shell',`let publicSelectionEpoch=0;switch(method){${source.slice(begin,end)}}`);
  const world={id:id32('a'),serverDir:'C:/w',playerPort:25565,state:'running'};
  const opened=[];let refreshes=0;
  const backend={getState:async()=>({server:world,servers:[world]})};
  const helpers={runningGamePorts:async()=>[]};
  const publicAddress={enable:async()=>({state:'starting',address:null,detail:'',approveUrl:null}),
    refresh:async()=>{refreshes++;return {state:'approve',address:null,detail:'',approveUrl:'https://playit.gg/claim/0123456789'};}};
  const shell={openExternal:async url=>{opened.push(url);}};
  const status=await run('publicAddressEnable',{id:world.id},backend,helpers,publicAddress,shell);
  assert.deepEqual(opened,['https://playit.gg/claim/0123456789'],'the approval page opens without a second click');
  assert.equal(status.state,'approve');
  assert.ok(refreshes>=1&&refreshes<=10,'the approval wait is bounded');

  opened.length=0;
  const disabled=await run('publicAddressDisable',{id:world.id},backend,helpers,{disable:async()=>({state:'off',address:null,detail:'',approveUrl:null})},shell);
  assert.deepEqual(opened,[],'disconnect never opens an approval page');
  assert.equal(disabled.state,'off');
});

// ---------- renderer: public card copy gating and distinct readiness messages ----------

async function publicFixture(status,serverState='running'){
  const source=await rendererSource();
  const block=slice(source,'  let publicStatus = null','  async function refreshAlwaysOn()');
  const elements=new Map(),copies=[];
  const get=id=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,textContent:'',dataset:{},handlers:{},classList:{toggle(){}},querySelectorAll(){return [];},addEventListener(k,v){this.handlers[k]=v;}});return elements.get(id);};
  const ctx={state:{server:{id:id32('a'),playerPort:25565,state:serverState}},bridgeReady:true,isBusy:()=>false,$:get,setInterval:()=>1,clearInterval(){},setTimeout(){},window:{seedhost:{call:async()=>status}},navigator:{clipboard:{writeText:async v=>copies.push(v)}}};
  vm.createContext(ctx);vm.runInContext(block,ctx);await vm.runInContext('refreshPublicAddress()',ctx);
  return {get,ctx,copies};
}

test('a typed DNS failure is explained distinctly and the reserved address stays unbuyable',async()=>{
  const {get,copies}=await publicFixture({state:'reserved',address:'r.tun.ply.gg',joinAddress:null,reservedAddress:'r.tun.ply.gg',verifiedAt:null,readiness:'dns-failure',detail:'Address reserved; not verified.'});
  assert.doesNotMatch(get('public-title').textContent,/open to friends/i);
  assert.match(get('public-detail').textContent,/DNS/i);
  assert.equal(get('public-copy').disabled,true);
  assert.equal(get('public-reserved').hidden,false);
  assert.equal(get('public-reserved-value').textContent,'r.tun.ply.gg');
  await get('public-copy').handlers.click();assert.deepEqual(copies,[]);
});

test('a missing provider binding is explained distinctly and cannot be copied',async()=>{
  const {get,copies}=await publicFixture({state:'reserved',address:'r.tun.ply.gg',joinAddress:null,reservedAddress:'r.tun.ply.gg',verifiedAt:null,readiness:'missing-binding',detail:'Address reserved; not verified.'});
  assert.match(get('public-detail').textContent,/missing|provider review|rebound/i);
  assert.equal(get('public-copy').disabled,true);
  await get('public-copy').handlers.click();assert.deepEqual(copies,[]);
});

test('a route change and an unverified route never offer the join copy',async()=>{
  const {get,copies}=await publicFixture({state:'reserved',address:'old.tun.ply.gg',joinAddress:null,reservedAddress:'old.tun.ply.gg',verifiedAt:null,readiness:'route-changed',detail:'Address reserved; not verified.'});
  assert.match(get('public-detail').textContent,/route/i);
  assert.equal(get('public-copy').disabled,true);
  await get('public-copy').handlers.click();assert.deepEqual(copies,[]);
});

test('only a fresh verified join address while running is copyable; a stopped world drops it at once',async()=>{
  const status={state:'reachable',address:'v.tun.ply.gg',joinAddress:'v.tun.ply.gg',reservedAddress:'v.tun.ply.gg',verifiedAt:Date.now(),readiness:'verified',detail:'Verified'};
  const {get,ctx,copies}=await publicFixture(status);
  assert.equal(get('public-copy').disabled,false);
  assert.equal(get('public-reserved').hidden,true);
  await get('public-copy').handlers.click();assert.deepEqual(copies,['v.tun.ply.gg']);

  const stopped=await publicFixture(status,'offline');
  assert.equal(stopped.get('public-copy').disabled,true);
  assert.equal(stopped.get('public-value').textContent,'');
  assert.match(stopped.get('public-detail').textContent,/no running|not running|not reachable/i);
  await stopped.get('public-copy').handlers.click();assert.deepEqual(stopped.copies,[]);
});

// ---------- renderer: scoped recovery evidence and consent ----------

async function recoveryFixture(call,{server={id:id32('a'),group:{fingerprint:'f'.repeat(64)},ownership:{state:'owned',owner:'me'}},deviceId='me',relay=null}={}){
  const source=await rendererSource();
  const block=slice(source,'  let recoveryStatus','  // ---------- Public address');
  const elements=new Map();
  const get=id=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,textContent:'',dataset:{},handlers:{},classList:{toggle(){}},querySelectorAll(){return [];},addEventListener(k,v){this.handlers[k]=v;}});return elements.get(id);};
  const ctx={state:{server,deviceId,relay},bridgeReady:true,isBusy:()=>false,isStopped:()=>true,$:get,window:{seedhost:{call}}};
  vm.createContext(ctx);vm.runInContext(block,ctx);
  return {get,ctx};
}
const revision=(over={})=>({generation:2,snapshotId:'d'.repeat(64),lineage:'lineage',reservation:'11111111-2222-3333-4444-555555555555',...over});

test('a missing recovery journal is honestly blocked and offers no automatic action',async()=>{
  const {get,ctx}=await recoveryFixture(async()=>({serverId:id32('a'),groupFingerprint:'f'.repeat(64),admission:null,remote:null}));
  await vm.runInContext('refreshGroupRecovery()',ctx);
  assert.match(get('group-recovery-status').textContent,/journal|blocked/i);
  assert.equal(get('group-recovery-status').dataset.state,'blocked');
  assert.equal(get('group-recovery-actions').hidden,true);
});

test('a remote holder is refused while local reserved data can never authorize recovery',async()=>{
  const {get,ctx}=await recoveryFixture(async()=>({serverId:id32('a'),groupFingerprint:'f'.repeat(64),
    admission:{stopped:false,revision:revision()},remote:{custody:null,observation:{owner:'peer'.padEnd(64,'a'),state:'hosting',...revision()}}}));
  await vm.runInContext('refreshGroupRecovery()',ctx);
  assert.match(get('group-recovery-status').textContent,/another PC|refused/i);
  assert.equal(get('group-recovery-status').dataset.state,'refused');
});

test('an unresolved stop publication points at the inline same-PC Stop and Park controls',async()=>{
  const meFp='me'.padEnd(64,'m');
  const server={id:id32('a'),group:{fingerprint:'f'.repeat(64)},ownership:{state:'owned',owner:meFp}};
  const {get,ctx}=await recoveryFixture(async()=>({serverId:id32('a'),groupFingerprint:'f'.repeat(64),
    admission:{stopped:true,revision:revision()},remote:{custody:null,observation:{owner:meFp,state:'hosting',...revision()}}}),{server,deviceId:meFp});
  await vm.runInContext('refreshGroupRecovery()',ctx);
  assert.match(get('group-recovery-status').textContent,/stop again|hand the world/i);
  assert.equal(get('group-recovery-status').dataset.state,'publication-pending');
  assert.equal(get('group-recovery-actions').hidden,false);
  assert.equal(get('recovery-stop').disabled,false);
  assert.equal(get('recovery-park').disabled,true,'park needs a configured always-on PC');
});

test('matching local and relay evidence still requires the explicit confirmation click',async()=>{
  const meFp='me'.padEnd(64,'m');
  const {get,ctx}=await recoveryFixture(async()=>({serverId:id32('a'),groupFingerprint:'f'.repeat(64),
    admission:{stopped:true,revision:revision()},remote:{custody:null,observation:{owner:meFp,state:'stopped',...revision()}}}),{deviceId:meFp});
  await vm.runInContext('refreshGroupRecovery()',ctx);
  assert.match(get('group-recovery-status').textContent,/confirm every previous|Confirm stopped|recover/i);
  assert.equal(get('group-recovery-status').dataset.state,'ready');
  assert.equal(get('group-recovery-actions').hidden,true,'no automatic publication action is offered');
});

test('A→B→A selection returns ignore a stale recovery reading instead of authorizing recovery',async()=>{
  let release;const queue=[];
  const first=new Promise(resolve=>{release=resolve;});
  const call=()=>queue.shift()??first;
  const {get,ctx}=await recoveryFixture(async()=>{const next=queue.shift()??first;return next;});
  queue.length=0;
  const pending=vm.runInContext('refreshGroupRecovery()',ctx);
  await new Promise(r=>setImmediate(r));
  ctx.state.server={id:id32('b'),group:{fingerprint:'f'.repeat(64)},ownership:{state:'owned',owner:'me'}};
  queue.push(Promise.resolve({serverId:id32('b'),groupFingerprint:'f'.repeat(64),admission:null,remote:null}));
  await vm.runInContext('refreshGroupRecovery()',ctx);
  ctx.state.server={id:id32('a'),group:{fingerprint:'f'.repeat(64)},ownership:{state:'owned',owner:'me'}};
  queue.push(Promise.resolve({serverId:id32('a'),groupFingerprint:'f'.repeat(64),admission:null,remote:null}));
  await vm.runInContext('refreshGroupRecovery()',ctx);
  release({serverId:id32('a'),groupFingerprint:'f'.repeat(64),admission:{stopped:true,revision:revision()},remote:{custody:null,observation:{owner:'peer'.padEnd(64,'a'),state:'hosting',...revision()}}});
  await pending;
  assert.equal(get('group-recovery-status').dataset.state,'blocked','the obsolete reading for A is ignored after A→B→A');
  assert.match(get('group-recovery-status').textContent,/journal|blocked/i);
});

test('the recovery click sends the captured world id, never auto-runs, and re-reads evidence after each attempt',async()=>{
  const source=await rendererSource();
  const block=slice(source,"$('recover-ownership').addEventListener('click'","async function checkRelay");
  const calls=[],refetches=[],elements=new Map();
  const get=id=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,textContent:'',dataset:{},handlers:{},addEventListener(k,v){this.handlers[k]=v;}});return elements.get(id);};
  const ctx={state:{server:{id:id32('a')}},runAction:async(method,payload)=>{calls.push({method,payload});return true;},$:get,refreshGroupRecovery:()=>refetches.push('evidence')};
  vm.createContext(ctx);vm.runInContext(block,ctx);
  const button=get('recover-ownership');
  assert.equal(calls.length,0,'opening the workspace never runs recovery');
  button.handlers.click();
  await new Promise(r=>setImmediate(r));
  assert.equal(calls.length,1);
  assert.equal(calls[0].method,'recoverStopped');
  assert.deepEqual({...calls[0].payload},{confirmed:true,id:id32('a')});
  assert.equal(refetches.length,1,'the verdict is re-read after the attempt, not left stale');
  // Same-PC publication retries (Stop again / Park) also re-read the evidence once they complete.
  get('recovery-stop').handlers.click();
  await new Promise(r=>setImmediate(r));
  assert.deepEqual(calls.at(-1),{method:'stopServer',payload:undefined});
  assert.equal(refetches.length,2);
  get('recovery-park').handlers.click();
  await new Promise(r=>setImmediate(r));
  assert.deepEqual(calls.at(-1),{method:'parkAtRelay',payload:undefined});
  assert.equal(refetches.length,3);
  calls.length=0;button.disabled=true;button.handlers.click();
  assert.equal(calls.length,0);
});

// ---------- renderer: the real refresh() path owns the recovery evidence cache ----------

test('the real refresh() path refetches evidence across a group-world switch and never reuses another world verdict',async()=>{
  const source=await rendererSource();
  const recoveryBlock=slice(source,'  let recoveryStatus','  // ---------- Public address');
  const handlersBlock=slice(source,"$('recover-ownership').addEventListener('click'","async function checkRelay");
  const refreshBlock=slice(source,'  function refresh()','  function schedulePoll()');
  const elements=new Map();
  const get=id=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,textContent:'',dataset:{},handlers:{},classList:{toggle(){}},querySelectorAll(){return [];},addEventListener(k,v){this.handlers[k]=v;}});return elements.get(id);};
  const meFp='me'.padEnd(64,'m');
  const A={id:id32('a'),group:{fingerprint:'f'.repeat(64)},ownership:{state:'owned',owner:meFp},state:'offline'};
  const B={id:id32('b'),group:{fingerprint:'f'.repeat(64)},ownership:{state:'owned',owner:meFp},state:'offline'};
  let selected=A;
  let evidenceB={serverId:id32('b'),groupFingerprint:'f'.repeat(64),admission:{stopped:true,revision:revision()},remote:{custody:null,observation:{owner:'peer'.padEnd(64,'a'),state:'hosting',...revision()}}};
  const calls=[];
  const evidenceA={serverId:id32('a'),groupFingerprint:'f'.repeat(64),admission:{stopped:true,revision:revision()},remote:{custody:null,observation:{owner:meFp,state:'stopped',...revision()}}};
  const ctx={state:null,isBusy:()=>false,isStopped:()=>true,$:get,bridgeReady:true,refreshInFlight:null,publicStatus:null,errorKind:null,friendCheckedAt:Date.now(),
    CustomEvent:class{constructor(type,init){this.type=type;this.detail=init?.detail;}},
    render(){},refreshFriends(){},syncPublicContext(){return selected?.id??'';},refreshPublicAddress(){},runAction:async()=>false,
    window:{seedhost:{call:async method=>{calls.push({method,id:selected.id});
      if(method==='getState')return {settings:{},peers:[],logs:[],deviceId:meFp,relay:null,server:selected};
      if(method==='groupRecoveryStatus')return selected.id===id32('a')?evidenceA:evidenceB;
      throw new Error('unexpected '+method);}},dispatchEvent(){},seedNotifications:null}};
  ctx.state={server:selected,deviceId:meFp,relay:null};
  vm.createContext(ctx);
  vm.runInContext(recoveryBlock+'\n'+handlersBlock+'\n'+refreshBlock,ctx);
  await vm.runInContext('refresh()',ctx);
  await new Promise(r=>setImmediate(r));
  assert.equal(get('group-recovery-status').dataset.state,'ready','world A shows its own evidence');
  assert.equal(calls.filter(c=>c.method==='groupRecoveryStatus').length,1);
  // Switch to world B through the real refresh(): the cached A verdict must be dropped and B's own evidence fetched.
  selected=B;
  await vm.runInContext('refresh()',ctx);
  await new Promise(r=>setImmediate(r));
  assert.equal(calls.filter(c=>c.method==='groupRecoveryStatus').length,2,'switching group worlds refetches the evidence');
  assert.equal(get('group-recovery-status').dataset.state,'refused','world B never shows world A stale ready verdict');
  assert.match(get('group-recovery-status').textContent,/another PC|refused/i);
  // A failed confirm-recovery attempt re-reads the same world's evidence instead of keeping the old verdict.
  evidenceB={serverId:id32('b'),groupFingerprint:'f'.repeat(64),admission:null,remote:null};
  get('recover-ownership').handlers.click();
  await new Promise(r=>setImmediate(r));
  assert.equal(calls.filter(c=>c.method==='groupRecoveryStatus').length,3,'the failed attempt re-reads the verdict');
  assert.equal(get('group-recovery-status').dataset.state,'blocked','the old verdict is not left standing after a failed attempt');
  // An ordinary unchanged refresh does not churn extra evidence reads.
  await vm.runInContext('refresh()',ctx);
  await new Promise(r=>setImmediate(r));
  assert.equal(calls.filter(c=>c.method==='groupRecoveryStatus').length,3);
});

test('a reachable reading without a fresh joinAddress never promotes the legacy reserved address to a copyable join',async()=>{
  const {get,copies}=await publicFixture({state:'reachable',address:'legacy.tun.ply.gg',detail:'The old provider reading said reachable.',approveUrl:null});
  assert.equal(get('public-copy').disabled,true,'the legacy status.address fallback is gone');
  await get('public-copy').handlers.click();assert.deepEqual(copies,[]);
});

// ---------- dashboard: copy only from a freshly re-read verified join address ----------

function dashboardJoinHarness(){
  return readFile(new URL('../apps/desktop/dashboard.js',import.meta.url),'utf8').then(source=>{
    const block=slice(source,'const validJoinAddress','function renderServers');
    const run=new AsyncFunction('el','button','state','window','navigator',`${block}\nreturn {joinAddressRow,copyJoinAddress};`);
    const el=(tag,cls,text)=>({tag,cls,text,children:[],dataset:{},attrs:{},append(...items){this.children.push(...items);},setAttribute(key,value){this.attrs[key]=value;}});
    const button=(label,cls)=>({tag:'button',label,cls,dataset:{},disabled:false,attrs:{},setAttribute(key,value){this.attrs[key]=value;}});
    return {run,el,button};
  });
}

test('an unverified join record renders as honest secondary text and offers no copy control',async()=>{
  const {run,el,button}=await dashboardJoinHarness();
  const {joinAddressRow}=await run(el,button,{deviceId:'me'});
  const row=joinAddressRow({id:'alpha',name:'A',publicJoinAddress:{address:'sky.tun.ply.gg',reachability:'unverified',source:'playit',targetServerId:'alpha'}});
  const json=JSON.stringify(row);
  assert.match(json,/sky\.tun\.ply\.gg/);
  assert.match(json,/Reachability unverified/);
  assert.doesNotMatch(json,/server-address-copy/,'an unverified address never renders a copy control');
});

test('the copy action re-reads live state, re-verifies the exact address, and never claims success from stale evidence',async()=>{
  const {run,el,button}=await dashboardJoinHarness();
  const cardState={deviceId:'me',servers:[{id:'alpha',name:'A',publicJoinAddress:{address:'stale.tun.ply.gg',reachability:'verified',source:'playit',targetServerId:'alpha'}}]};
  const status={textContent:''},row={querySelector:sel=>sel==='.server-address-status'?status:null},copy={dataset:{copyAddress:'alpha'},disabled:false,closest:sel=>sel==='.server-card-address'?row:null};
  const live=reachability=>({servers:[{id:'alpha',publicJoinAddress:{address:'fresh.tun.ply.gg',reachability,source:'playit',targetServerId:'alpha'}}]});
  const writes=[];let reads=[];
  const win={seedhost:{call:async method=>{assert.equal(method,'getState');return reads.shift();}}};
  const navigator={clipboard:{writeText:async v=>{writes.push(v);},readText:async()=>writes[writes.length-1]??''}};
  const {copyJoinAddress}=await run(el,button,cardState,win,navigator);
  // The rendered card said verified, but live state says the address is no longer verified: refuse without copying.
  reads=[live('unverified')];
  await copyJoinAddress(copy);
  assert.deepEqual(writes,[],'no clipboard write without a live verified re-read');
  assert.match(status.textContent,/no longer available|Refresh data/i);
  // A live verified address copies and may claim clipboard verification.
  status.textContent='';
  reads=[live('verified'),live('verified')];
  await copyJoinAddress(copy);
  assert.deepEqual(writes,['fresh.tun.ply.gg']);
  assert.match(status.textContent,/Copied and verified/);
  // If the verdict drops between the write and the completion claim, no stale success is claimed.
  status.textContent='';writes.length=0;
  reads=[live('verified'),live('unverified')];
  await copyJoinAddress(copy);
  assert.deepEqual(writes,['fresh.tun.ply.gg']);
  assert.doesNotMatch(status.textContent,/Copied and verified/,'a claim is never made from a stale polled reading');
});

// ---------- dashboard: remote holder stays unknown; local reserved address is secondary ----------

test('home cards hold a remote endpoint unknown instead of repeating this PC’s old address',async()=>{
  const source=await readFile(new URL('../apps/desktop/dashboard.js',import.meta.url),'utf8');
  const block=slice(source,'const validJoinAddress','let addressCopyToken');
  const run=new AsyncFunction('el','button','state',`${block}\nreturn joinAddressRow;`);
  const el=(tag,cls,text)=>({tag,cls,text,children:[],dataset:{},attrs:{},append(...items){this.children.push(...items);},setAttribute(key,value){this.attrs[key]=value;}});
  const button=(label,cls)=>({tag:'button',label,cls,dataset:{},attrs:{},setAttribute(key,value){this.attrs[key]=value;}});
  const render=async(entry,state={deviceId:'me'})=>JSON.stringify((await run(el,button,state))(entry));
  const remote=await render({id:'w',name:'World',group:{fingerprint:'f'.repeat(64)},ownership:{state:'hosting',owner:'peer'}});
  assert.match(remote,/Playit address not set/,'the card never fabricates an address');
  assert.match(remote,/another PC/i);
  assert.doesNotMatch(remote,/server-address-copy/,'no copy control for an unknown remote endpoint');
  const withReserved=await render({id:'w',name:'World',group:{fingerprint:'f'.repeat(64)},ownership:{state:'hosting',owner:'peer'},publicReservedAddress:'old-local.tun.ply.gg'});
  assert.match(withReserved,/secondary/i);
  assert.match(withReserved,/old-local\.tun\.ply\.gg/);
  assert.doesNotMatch(withReserved,/server-address-copy/,'the local reserved address is never a copyable join address');
  const plain=await render({id:'x',name:'Local'});
  assert.match(plain,/Playit address not set/);
  assert.doesNotMatch(plain,/another PC/i);
  const mine=await render({id:'y',name:'Mine',group:{fingerprint:'f'.repeat(64)},ownership:{state:'hosting',owner:'me'}});
  assert.doesNotMatch(mine,/another PC/i);
});
