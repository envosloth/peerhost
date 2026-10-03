import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
const mod:any=await import('../src/core/'+'identity-store.js').catch(()=>({}));
test('identity persistence requires a vault and never writes the plaintext private key',async()=>{
  assert.equal(typeof mod.loadIdentity,'function');
  await mkdir('.test-data',{recursive:true});const root=await mkdtemp(path.resolve('.test-data/identity-'));
  // Synthetic reversible vault tests the storage contract, not Windows DPAPI encryption.
  const vault={encrypt:(s:string)=>Buffer.from(s).reverse(),decrypt:(b:Buffer)=>Buffer.from(b).reverse().toString()};
  try{
    const first=await mod.loadIdentity(root,vault);const second=await mod.loadIdentity(root,vault);
    assert.equal(first.fingerprint,second.fingerprint);assert.equal(first.keyPem,second.keyPem);
    assert.equal((await readFile(path.join(root,'identity.json'),'utf8')).includes('PRIVATE KEY'),false);
    await assert.rejects(mod.loadIdentity(root,{encrypt:vault.encrypt,decrypt:()=>{throw new Error('vault locked');}}),/locked/);
  }finally{await rm(root,{recursive:true,force:true});}
});
