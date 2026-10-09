import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {SeedHostApplication} from '../dist/src/core/application.js';
import {createIdentity} from '../dist/src/core/peer-transport.js';

test('new profile setup progress survives reopening without creating a server',async t=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR,'ph-onboarding-'));
 const identity=await createIdentity();const app=new SeedHostApplication(root,identity);
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});await app.open();
 const state=await app.getState();assert.equal(state.onboarding?.step,'server');assert.equal(state.onboarding.dismissed,false);
 const progress={step:'ready',dismissed:true,completed:false,skipped:['friends'],draft:{name:'Our world',loader:'fabric',gameVersion:'1.21.1',memoryMiB:2048}};
 await app.saveOnboarding(progress);
 const reopened=new SeedHostApplication(root,identity);await reopened.open();
 assert.deepEqual((await reopened.getState()).onboarding,{version:1,...progress,error:null});
 assert.equal((await reopened.getState()).server,null);await reopened.close();
});
test('setup cannot claim complete without an actual configured server',async t=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR,'ph-onboarding-complete-'));
 const app=new SeedHostApplication(root,await createIdentity());await app.open();
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const {version,error,...progress}=(await app.getState()).onboarding;
 await assert.rejects(app.saveOnboarding({...progress,step:'ready',completed:true}),/configure.*server/i);
 assert.equal((await app.getState()).onboarding.completed,false);
});
test('corrupt optional setup cannot disable core state, console, Stop or safe quit',async t=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR,'ph-onboarding-corrupt-'));
 const source=path.join(root,'source');await mkdir(source);await writeFile(path.join(source,'eula.txt'),'eula=true\n');
 const profile=path.join(root,'profile');const app=new SeedHostApplication(profile,await createIdentity());await app.open();
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 await app.importExisting(source,true);await app.saveProfile({executable:process.execPath,args:[path.resolve('tools/fake-java-server.mjs')]});
 await app.startServer(true);const file=path.join(profile,`onboarding-server-${(await app.getState()).server.id}.json`);await writeFile(file,'{');
 const state=await app.getState();assert.equal(state.server.state,'running');assert.match(state.onboarding.error,/unreadable/);
 const {version,error,...progress}=state.onboarding;await assert.rejects(app.saveOnboarding(progress),/unreadable/);
 assert.equal(await readFile(file,'utf8'),'{');app.sendCommand('list');await app.stopServer();
 assert.equal((await app.getState()).server.ownership.state,'owned');await app.close();
});
test('setup rejects secret fields and oversized optional metadata without changing it',async t=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR,'ph-onboarding-bounds-'));
 const app=new SeedHostApplication(root,await createIdentity());await app.open();
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const {version,error,...progress}=(await app.getState()).onboarding;
 await assert.rejects(app.saveOnboarding({...progress,inviteCode:'secret'}),/Invalid/);
 await assert.rejects(app.saveOnboarding({...progress,draft:{...progress.draft,javaExecutable:'/arbitrary'}}),/Invalid/);
 await writeFile(path.join(root,'onboarding-new.json'),'x'.repeat(20000));assert.match((await app.getState()).onboarding.error,/unreadable/);
 assert.equal((await app.getState()).server,null);
});
