import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { ModrinthClient } from '../dist/src/core/modrinth.js';
import { addModBatch } from '../dist/src/core/mods.js';
import { installMod } from '../dist/src/core/mod-install.js';
import { writeModIndex, readModIndex } from '../dist/src/core/mod-index.js';
import { writeZip } from '../dist/src/core/zip.js';
const scratch = process.env.TMPDIR || path.resolve('.test-data');
async function fixture(t, options = {}) {
 const root = await mkdtemp(path.join(scratch, 'mod-safety-')); t.after(() => rm(root, {recursive:true,force:true}));
 await writeZip(path.join(root,'real.jar'), [{name:'fabric.mod.json',data:Buffer.from('{"id":"safe"}')}]);
 const jar = await readFile(path.join(root,'real.jar')); let base; const requests=[];
 const file = {filename:'safe.jar', size:jar.length, sha512:createHash('sha512').update(jar).digest('hex')};
 const version = (id) => ({id:'v-'+id,project_id:id,version_number:'1',version_type:'release',loaders:options.incompatible&&id==='dep'?['forge']:['fabric'],game_versions:['1.21.1'],dependencies:id==='root'? options.dependencies??[]:[],files:[{...file,filename:id+'.jar',url:base+'/cdn',hashes:{sha512:options.tamper&&id==='dep'?'f'.repeat(128):file.sha512}}]});
 const server=createServer((req,res)=> {requests.push(req.url); res.setHeader('content-type','application/json');
  const pathname=new URL(req.url,base).pathname;
  if (pathname==='/cdn') return res.end(jar);
  if (pathname==='/v2/search') {res.write('{"hits":['); let n=0; const emit=()=> {if(res.destroyed||n++>150) return res.end(']}'); if(!res.write('"'+ 'x'.repeat(65536)+'",')) res.once('drain',emit); else setImmediate(emit);}; return emit();}
  const ver=/^\/v2\/version\/v-(.+)$/.exec(pathname); if(ver) return res.end(JSON.stringify(version(ver[1])));
  const p=/^\/v2\/project\/([^/]+)(\/version)?$/.exec(pathname);
  if(p) return res.end(JSON.stringify(p[2]?[version(p[1])]:{id:p[1],slug:p[1],title:p[1],project_type:'mod',client_side:'required',server_side:'required'}));
  res.statusCode=404; res.end('{}');
 }); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const client=new ModrinthClient({apiBase:base+'/v2',downloadHosts:[new URL(base).host]});
 const serverDir=path.join(root,'server');await mkdir(serverDir);await mkdir(path.join(serverDir,'mods'));await writeModIndex(serverDir,{version:1,target:{loader:'fabric',gameVersion:'1.21.1'},mods:[]});
 return {root,serverDir,client,requests,file:{...file,url:base+'/cdn'}};
}
test('production endpoints cannot be replaced with arbitrary hosts',()=> {
 assert.throws(()=>new ModrinthClient({apiBase:'http://example.com/v2'}));
 assert.throws(()=>new ModrinthClient({downloadHosts:['evil.example']}));
});
test('unsafe filenames fail before any download',async t=> {const f=await fixture(t);for(const filename of ['../x.jar','con.jar','a/b.jar','x'.repeat(256)+'.jar','x.jar ']) await assert.rejects(f.client.download({...f.file,filename},path.join(f.root,'downloads')),/unsafe/);assert.deepEqual(f.requests,[]);});
test('bounded JSON streaming cancels oversized body',async t=>{const f=await fixture(t);await assert.rejects(f.client.search('',0,{loader:'fabric',gameVersion:'1.21.1'}),/unexpectedly large/);});
test('download does not overwrite a prior file',async t=> {const f=await fixture(t);const dir=path.join(f.root,'download');await f.client.download(f.file,dir);await assert.rejects(f.client.download(f.file,dir),/EEXIST/);assert.deepEqual(await readdir(dir),['safe.jar']);});
test('offsite and HTTP CDN downloads fail before any request',async t=>{const f=await fixture(t);await assert.rejects(f.client.download({...f.file,url:'http://example.invalid/evil.jar'},path.join(f.root,'downloads')),/not an allowed download host/);await assert.rejects(new ModrinthClient().download({...f.file,url:'http://cdn.modrinth.com/evil.jar'},path.join(f.root,'downloads')),/HTTPS/);assert.deepEqual(f.requests,[]);});
test('missing verifiable metadata is rejected before download',async t=>{const f=await fixture(t);for(const file of [{...f.file,size:-1},{...f.file,sha512:'no'},{...f.file,size:0}]) await assert.rejects(f.client.download(file,path.join(f.root,'downloads')));assert.deepEqual(f.requests,[]);});
test('cross-folder batch rolls back when metadata commit fails',async t=>{const f=await fixture(t);await assert.rejects(addModBatch(f.serverDir,[{kind:'server',source:path.join(f.root,'real.jar')},{kind:'client',source:path.join(f.root,'real.jar')}],async()=>{throw Error('commit failed')}),/commit failed/);assert.deepEqual(await readdir(path.join(f.serverDir,'mods')),[]);assert.equal((await readdir(f.serverDir)).includes('peerhost-client-mods'),false);});
test('tampered dependency leaves no partial batch',async t=>{const f=await fixture(t,{tamper:true,dependencies:[{dependency_type:'required',project_id:'dep',version_id:null}]});await assert.rejects(installMod(f.serverDir,path.join(f.root,'stage'),f.client,{projectId:'root'}),/integrity/);assert.deepEqual(await readdir(path.join(f.serverDir,'mods')),[]);assert.equal((await readModIndex(f.serverDir)).mods.length,0);});
test('version-only dependencies are installed and cycles terminate',async t=>{const f=await fixture(t,{dependencies:[{dependency_type:'required',project_id:null,version_id:'v-dep'},{dependency_type:'required',project_id:'root',version_id:null}]});const result=await installMod(f.serverDir,path.join(f.root,'stage'),f.client,{projectId:'root'});assert.deepEqual(result.installed.map(m=>m.projectId),['root','dep']);});
test('pinned incompatible dependency is refused before any CDN fetch',async t=>{const f=await fixture(t,{incompatible:true,dependencies:[{dependency_type:'required',project_id:'dep',version_id:'v-dep'}]});await assert.rejects(installMod(f.serverDir,path.join(f.root,'stage'),f.client,{projectId:'root'}),/no version/);assert.equal(f.requests.includes('/cdn'),false);});
test('incompatible dependency constraint fails closed',async t=>{const f=await fixture(t,{dependencies:[{dependency_type:'required',project_id:'dep',version_id:null},{dependency_type:'incompatible',project_id:'dep',version_id:null}]});await assert.rejects(installMod(f.serverDir,path.join(f.root,'stage'),f.client,{projectId:'root'}),/incompatible|conflict/i);assert.equal(f.requests.includes('/cdn'),false);});
