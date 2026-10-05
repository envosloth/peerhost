import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import vm from 'node:vm';
test('public address panel uses backend checks, copies only checked address, and clears stale status',async()=>{
 const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,{textContent:'',hidden:false,disabled:false,handlers:{},addEventListener(k,v){this.handlers[k]=v;}});return elements.get(id);};
 let copied='',mode='off';const calls=[];
 const ctx={document:{getElementById:get,addEventListener(){}},navigator:{clipboard:{writeText:async s=>{copied=s;}}},window:{seedhost:{call:async m=>{calls.push(m);return mode==='off'?{connected:false,state:'off',detail:'Off'}:{connected:true,state:'reachable',address:'example.tun.ply.gg',detail:'Answered'};}}},setInterval:()=>0};
 vm.runInNewContext(await readFile(new URL('../apps/desktop/playit.js',import.meta.url),'utf8'),ctx);await new Promise(r=>setImmediate(r));assert.equal(get('playit-copy').disabled,true);
 mode='on';await get('playit-check').handlers.click();assert.equal(get('playit-address').textContent,'example.tun.ply.gg');await get('playit-copy').handlers.click();assert.equal(copied,'example.tun.ply.gg');
 mode='off';await get('playit-check').handlers.click();assert.equal(get('playit-address').textContent,'');assert.equal(get('playit-copy').disabled,true);assert(calls.includes('playitCheck'));
});
