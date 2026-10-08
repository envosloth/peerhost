import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {GroupHelpers} from '../dist/apps/desktop/group-helpers.js';
import {loadIdentity} from '../dist/src/core/identity-store.js';
test('concurrent group allocation reserves the primary helper at most once',async t=>{
 const scratch=process.env.TMPDIR||process.env.TEMP||process.env.TMP||path.resolve('.test-data');const root=await mkdtemp(path.join(scratch,'group-allocation-'));
 const vault={encrypt:s=>Buffer.from(s),decrypt:b=>b.toString()};
 const registry=new GroupHelpers(root,{loadIdentity:r=>loadIdentity(r,vault),role:()=>({host:'127.0.0.1',port:0,gamePorts:[0],discoveryPort:0})});
 t.after(async()=>{await registry.closeAll();await rm(root,{recursive:true,force:true});});
 await registry.restoreAll(()=>true);
 let entered=0,release;const gate=new Promise(r=>release=r);
 registry.primaryIsFree=async()=>{if(++entered===2)release();await gate;return true;};
 const result=await Promise.all([registry.create(),registry.create()]);
 assert.equal(new Set(result.map(x=>x.fingerprint)).size,2);
 assert.equal(new Set(result.map(x=>x.root)).size,2);
});
