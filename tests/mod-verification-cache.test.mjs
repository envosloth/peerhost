import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { indexedMods, sourceMatches } from '../dist/src/core/mod-index.js';
import { writeZip } from '../dist/src/core/zip.js';
import { PeerHostApplication } from '../dist/src/core/application.js';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { writeModIndex } from '../dist/src/core/mod-index.js';

test('status provenance uses stat-invalidated cache; mutation checks still rehash freshly', async t => {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR,'ph-mod-cache-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'mods'));
  const file = path.join(root,'mods','probe.jar');
  await writeZip(file,[{name:'fabric.mod.json',data:Buffer.from('{"id":"probe"}')}]);
  const bytes = await fs.readFile(file);
  const record = {kind:'server',name:'probe.jar',source:{provider:'modrinth',projectId:'probe',versionId:'v-probe',slug:'probe',title:'Probe',versionNumber:'1.0',sha512:createHash('sha512').update(bytes).digest('hex'),loader:'fabric',gameVersion:'1.21.1'}};
  const index = {version:1,target:null,mods:[record]};
  const cache = new Map();
  let reads=0;
  const original = fs.open;
  fs.open = async (...args) => {
    const handle = await original(...args);
    if (args[0] === file) {
      const read = handle.read.bind(handle);
      handle.read = async (...params) => { reads++; return read(...params); };
    }
    return handle;
  };
  syncBuiltinESMExports();
  t.after(() => {fs.open=original;syncBuiltinESMExports();});
  assert.equal((await indexedMods(root,'server',index,cache))[0].source.projectId,'probe');
  assert.ok(reads>0);
  reads=0;
  assert.equal((await indexedMods(root,'server',index,cache))[0].source.projectId,'probe');
  assert.equal(reads,0,'unchanged status poll must not reread jar contents');
  assert.equal(await sourceMatches(root,record),true);
  assert.ok(reads>0,'fresh mutation checks do not use status cache');
  const before=await fs.stat(file);
  bytes[bytes.length-1]^=1;
  await fs.writeFile(file,bytes);
  await fs.utimes(file,before.atime,before.mtime);
  reads=0;
  assert.equal((await indexedMods(root,'server',index,cache))[0].source,undefined,'same-size modification with restored mtime invalidates through ctime');
  assert.ok(reads>0);
  reads=0;
  assert.equal((await indexedMods(root,'server',index,cache))[0].source,undefined);
  assert.equal(reads,0,'unchanged mismatch is cached as well');
  await fs.rm(file);
  assert.deepEqual(await indexedMods(root,'server',index,cache),[]);
});

test('application status polling does not rehash an unchanged indexed jar', async t => {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR,'ph-mod-app-cache-'));
  const source = path.join(root,'source');
  await fs.mkdir(source);
  const app = new PeerHostApplication(path.join(root,'profile'),await createIdentity());
  t.after(async () => {await app.close();await fs.rm(root,{recursive:true,force:true});});
  await app.open();await app.importExisting(source,true);
  const dir=(await app.getState()).server.serverDir;
  const file=path.join(dir,'mods','probe.jar');
  await writeZip(file,[{name:'fabric.mod.json',data:Buffer.from('{"id":"probe"}')}]);
  const sourceInfo={provider:'modrinth',projectId:'probe',versionId:'v-probe',slug:'probe',title:'Probe',versionNumber:'1',sha512:createHash('sha512').update(await fs.readFile(file)).digest('hex'),loader:'fabric',gameVersion:'1.21.1'};
  await writeModIndex(dir,{version:1,target:null,mods:[{kind:'server',name:'probe.jar',source:sourceInfo}]});
  let reads=0;
  const original=fs.open;
  fs.open=async (...args) => {
    const handle=await original(...args);
    if(args[0]===file){const read=handle.read.bind(handle);handle.read=async (...params)=>{reads++;return read(...params);};}
    return handle;
  };
  syncBuiltinESMExports();
  t.after(()=>{fs.open=original;syncBuiltinESMExports();});
  assert.equal((await app.getState()).server.mods.server[0].source.projectId,'probe');
  reads=0;
  assert.equal((await app.getState()).server.mods.server[0].source.projectId,'probe');
  assert.equal(reads,0,'application uses status-only cache');
});
