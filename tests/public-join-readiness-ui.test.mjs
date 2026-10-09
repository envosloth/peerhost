import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
async function fixture(status,serverState='running'){
 const source=await readFile(new URL('../apps/desktop/renderer.js',import.meta.url),'utf8');
 const block=source.slice(source.indexOf('  let publicStatus ='),source.indexOf('  async function refreshAlwaysOn()'));
 const elements=new Map(),copies=[];
 const get=id=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,textContent:'',dataset:{},handlers:{},addEventListener(k,v){this.handlers[k]=v;},querySelectorAll(){return [];}});return elements.get(id);};
 const ctx={state:{server:{id:'a',playerPort:25565,state:serverState}},bridgeReady:true,isBusy:()=>false,$:get,setInterval:()=>1,clearInterval(){},setTimeout(){},window:{seedhost:{call:async()=>status}},navigator:{clipboard:{writeText:async v=>copies.push(v)}}};
 vm.createContext(ctx);vm.runInContext(block,ctx);await vm.runInContext('refreshPublicAddress()',ctx);return {get,ctx,copies};
}
test('a reserved hostname is not advertised as ready and cannot be copied as a join address',async()=>{
 const {get,copies}=await fixture({state:'reserved',address:'not-resolved.tun.ply.gg',detail:'DNS is not ready',approveUrl:null});
 assert.doesNotMatch(get('public-title').textContent,/address is ready|open to friends/i);
 assert.equal(get('public-copy').disabled,true);
 await get('public-copy').handlers.click();assert.deepEqual(copies,[]);
});
test('stopping Minecraft invalidates the join-copy action even before the next provider poll',async()=>{
 const {get,ctx,copies}=await fixture({state:'reachable',address:'verified.tun.ply.gg',joinAddress:'verified.tun.ply.gg',detail:'Verified',approveUrl:null});
 assert.equal(get('public-copy').disabled,false);
 ctx.state.server.state='offline';vm.runInContext('renderPublicCard()',ctx);
 assert.equal(get('public-copy').disabled,true);await get('public-copy').handlers.click();assert.deepEqual(copies,[]);
});
test('a running server with a verified address retains the useful copy action',async()=>{
 const {get,copies}=await fixture({state:'reachable',address:'verified.tun.ply.gg',joinAddress:'verified.tun.ply.gg',detail:'Verified',approveUrl:null});
 await get('public-copy').handlers.click();assert.deepEqual(copies,['verified.tun.ply.gg']);
});
