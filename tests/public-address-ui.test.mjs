import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {validateCall} from '../dist/src/core/ipc-policy.js';

const methods=['publicAddressStatus','publicAddressEnable','publicAddressDisable','publicAddressOpenApproval'];
test('desktop library projects each server binding instead of repeating the helper address',async()=>{
 const source=await readFile(new URL('../dist/apps/desktop/main.js',import.meta.url),'utf8');
 const begin=source.indexOf("case 'getState':"),end=source.indexOf("case 'alwaysOnStatus':",begin);
 const state={servers:[{id:'a',playerPort:25565,state:'running',group:null},{id:'b',playerPort:25567,state:'offline',group:null}],onboarding:{}};
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const run=new AsyncFunction('backend','helperForSelected','helpers','onboardingChecks','publicAddress','app','appNotice','incomingHandoff',`switch('getState'){${source.slice(begin,end)}}`);
 const result=await run({getState:async()=>state},async()=>({status:async()=>({running:true,fingerprint:'helper'})}),{runningGamePorts:async()=>[]},()=>({ready:'incomplete'}),{status:server=>({state:server?.id==='a'?'reachable':'reserved',address:server?.id?server.id+'.tun.ply.gg':'legacy-helper.tun.ply.gg'})},{getVersion:()=> '0.6.1-alpha'},null,{status:()=>null});
 assert.deepEqual(result.servers.map(s=>s.publicJoinAddress?.address),['a.tun.ply.gg','b.tun.ply.gg']);
 assert.deepEqual(result.servers.map(s=>s.publicJoinAddress?.targetServerId),['a','b']);
});
test('public address IPC requires an explicit captured server id',()=>{
 for(const method of methods){
  assert.deepEqual(validateCall(method,{id:'a'.repeat(32)},'file:///app','file:///app',{senderId:1,expectedSenderId:1,isMainFrame:true}),{id:'a'.repeat(32)});
  assert.throws(()=>validateCall(method,undefined,'file:///app','file:///app',{senderId:1,expectedSenderId:1,isMainFrame:true}));
 }
});

test('desktop enable rechecks captured selection after helper status await',async()=>{
 const source=await readFile(new URL('../dist/apps/desktop/main.js',import.meta.url),'utf8');
 const begin=source.indexOf("case 'publicAddressStatus':"),end=source.indexOf("case 'pairAlwaysOn':",begin);
 const a={id:'a',playerPort:25565,state:'running'},b={id:'b',playerPort:25567,state:'offline'};let selected=a,mutations=0;
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 // The awaited preflight now reads the per-group helper ports; the captured selection must still be rechecked after it.
 const run=new AsyncFunction('method','p','backend','helpers','publicAddress','shell',`let publicSelectionEpoch=0;switch(method){${source.slice(begin,end)}}`);
 await assert.rejects(run('publicAddressEnable',{id:'a'},{getState:async()=>({server:selected,servers:[a,b]})},{runningGamePorts:async()=>{selected=b;return [];}},{enable:async()=>{mutations++;}},{}),/selected server changed/i);
 assert.equal(mutations,0);
});

test('public address polling fences A/B/A and overlapping requests, and sends captured ids',async()=>{
 const source=await readFile(new URL('../apps/desktop/renderer.js',import.meta.url),'utf8');
 const block=source.slice(source.indexOf('  let publicStatus ='),source.indexOf('  async function refreshAlwaysOn()'));
 const elements=new Map(),calls=[];let release;
 const element=id=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,textContent:'',dataset:{},handlers:{},addEventListener(k,v){this.handlers[k]=v;},querySelectorAll(){return [];}});return elements.get(id);};
 const ctx={state:{server:{id:'a'}},bridgeReady:true,isBusy:()=>false,$:element,setInterval:()=>1,clearInterval(){},setTimeout(){},navigator:{clipboard:{writeText:async()=>{}}},runAction:async()=>true,
  window:{seedhost:{call:async(method,payload)=>{calls.push({method,payload});if(calls.length===1)return new Promise(r=>release=r);return {state:'reserved',address:payload?.id==='b'?'b.tun.ply.gg':'new-a.tun.ply.gg',detail:'Not reachable',approveUrl:null};}}}};
 vm.createContext(ctx);vm.runInContext(block,ctx);
 const first=vm.runInContext('refreshPublicAddress()',ctx);await new Promise(r=>setImmediate(r));
 ctx.state={server:{id:'b'}};await vm.runInContext('refreshPublicAddress()',ctx);
 ctx.state={server:{id:'a'}};await vm.runInContext('refreshPublicAddress()',ctx);
 release({state:'reachable',address:'obsolete-a.tun.ply.gg',detail:'old',approveUrl:null});await first;
 assert.equal(vm.runInContext('publicStatus.address',ctx),'new-a.tun.ply.gg');
 assert.deepEqual(calls.map(c=>c.payload?.id),['a','b','a']);
 assert.match(element('public-detail').textContent,/not reachable/i);
});

test('a poll while a public mutation is pending does not invalidate the mutation result',async()=>{
 const source=await readFile(new URL('../apps/desktop/renderer.js',import.meta.url),'utf8');const block=source.slice(source.indexOf('  let publicStatus ='),source.indexOf('  async function refreshAlwaysOn()'));
 let release;const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,textContent:'',dataset:{},addEventListener(){},querySelectorAll(){return [];}});return elements.get(id);};
 const ctx={state:{server:{id:'a'}},bridgeReady:true,isBusy:()=>false,$:get,setInterval:()=>1,clearInterval(){},setTimeout(){},window:{seedhost:{call:()=>new Promise(r=>release=r)}},navigator:{clipboard:{}}};vm.createContext(ctx);vm.runInContext(block,ctx);
 const action=vm.runInContext("publicAction('publicAddressEnable')",ctx);await vm.runInContext('refreshPublicAddress()',ctx);release({state:'reserved',address:'a.tun.ply.gg',detail:'not reachable',approveUrl:null});await action;
 assert.equal(vm.runInContext('publicStatus?.address',ctx),'a.tun.ply.gg');assert.equal(vm.runInContext('publicBusy',ctx),false);
});

test('public status from an old Minecraft port cannot populate the edited server context',async()=>{
 const source=await readFile(new URL('../apps/desktop/renderer.js',import.meta.url),'utf8');const block=source.slice(source.indexOf('  let publicStatus ='),source.indexOf('  async function refreshAlwaysOn()'));
 let release;const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,textContent:'',dataset:{},addEventListener(){},querySelectorAll(){return [];}});return elements.get(id);};
 const ctx={state:{server:{id:'a',playerPort:25565,state:'running'}},bridgeReady:true,isBusy:()=>false,$:get,setInterval:()=>1,clearInterval(){},setTimeout(){},window:{seedhost:{call:()=>new Promise(r=>release=r)}},navigator:{clipboard:{}}};vm.createContext(ctx);vm.runInContext(block,ctx);
 const first=vm.runInContext('refreshPublicAddress()',ctx);ctx.state={server:{id:'a',playerPort:25567,state:'running'}};vm.runInContext('syncPublicContext()',ctx);release({state:'reachable',address:'old-port.tun.ply.gg',detail:'Live.',approveUrl:null});await first;
 assert.equal(vm.runInContext('publicStatus',ctx),null);assert.equal(get('public-value').textContent,'');
});

test('port conflicts expose a direct route to the selected server port setting',async()=>{
 const source=await readFile(new URL('../apps/desktop/renderer.js',import.meta.url),'utf8');
 const block=source.slice(source.indexOf('  let publicStatus ='),source.indexOf('  async function refreshAlwaysOn()'));
 const elements=new Map(),routes=[];
 const get=id=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,textContent:'',dataset:{},handlers:{},focused:false,focus(){this.focused=true;},addEventListener(k,v){this.handlers[k]=v;},querySelectorAll(){return [];}});return elements.get(id);};
 const ctx={state:{server:{id:'a',playerPort:25565,state:'offline'}},bridgeReady:true,isBusy:()=>false,$:get,selectPage:name=>routes.push(name),setInterval:()=>1,clearInterval(){},setTimeout(){},window:{seedhost:{call:async()=>({state:'error',address:null,detail:'This Minecraft port is used by another server. Set a distinct server-port in Server settings first.',approveUrl:null})}},navigator:{clipboard:{}}};
 vm.createContext(ctx);vm.runInContext(block,ctx);await vm.runInContext('refreshPublicAddress()',ctx);
 assert.equal(get('public-port-settings').hidden,false);
 assert.equal(typeof get('public-port-settings').handlers.click,'function');
 get('public-port-settings').handlers.click();assert.deepEqual(routes,['server-settings']);assert.equal(get('property-server-port').focused,true);
 const html=await readFile(new URL('../apps/desktop/index.html',import.meta.url),'utf8');assert.match(html,/id="public-port-settings"/);
 const dashboard=await readFile(new URL('../apps/desktop/dashboard.js',import.meta.url),'utf8');assert.doesNotMatch(dashboard,/not an independent tunnel for every library card/);
});

test('stopping selected Minecraft immediately removes a cached Live claim',async()=>{
 const source=await readFile(new URL('../apps/desktop/renderer.js',import.meta.url),'utf8');const block=source.slice(source.indexOf('  let publicStatus ='),source.indexOf('  async function refreshAlwaysOn()'));
 const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,textContent:'',dataset:{},addEventListener(){},querySelectorAll(){return [];}});return elements.get(id);};
 const ctx={state:{server:{id:'a',state:'offline'}},bridgeReady:true,isBusy:()=>false,$:get,setInterval:()=>1,clearInterval(){},setTimeout(){},window:{seedhost:{call:async()=>({state:'reachable',address:'a.tun.ply.gg',detail:'Live.',approveUrl:null})}},navigator:{clipboard:{}}};vm.createContext(ctx);vm.runInContext(block,ctx);
 await vm.runInContext('refreshPublicAddress()',ctx);assert.equal(get('public-card').dataset.state,'reserved');assert.match(get('public-detail').textContent,/no running|not running|not reachable/i);assert.doesNotMatch(get('public-title').textContent,/open to friends/i);
});
