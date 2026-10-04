import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { PeerHostApplication } from '../dist/src/core/application.js';
import { createIdentity } from '../dist/src/core/peer-transport.js';
async function fixture(t,jars=['server.jar']) {
 const root=await mkdtemp(path.join(process.env.TMPDIR,'ph-simple-')),source=path.join(root,'source'),java=path.join(root,'java');await mkdir(source);
 await writeFile(java,`#!${process.execPath}\nprocess.stderr.write('openjdk version "21.0.4"\\n');`);await chmod(java,0o700);
 for(const name of jars)await writeFile(path.join(source,name),'jar fixture, not Minecraft');await writeFile(path.join(source,'eula.txt'),'eula=true\n');
 const app=new PeerHostApplication(path.join(root,'app'),await createIdentity());await app.open();await app.importExisting(source,true);
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});return{app,root,java};
}
test('simple profile preserves existing Java arguments and timeouts while replacing heap flags',async t=>{
 const {app,java}=await fixture(t);await app.saveProfile({executable:java,args:['-Xms1G','-Xmx2G','-Dthing=unchanged','@unix_args.txt','nogui'],startTimeoutSeconds:120,stopTimeoutSeconds:60});
 await app.configureSimpleProfile({javaExecutable:java,memoryMiB:2048});const p=(await app.getState()).server.profile;
 assert.deepEqual(p.args,['-Xms512M','-Xmx2048M','-Dthing=unchanged','@unix_args.txt','nogui']);assert.equal(p.startTimeoutSeconds,120);assert.equal(p.stopTimeoutSeconds,60);
});
test('simple profile refuses unknown/multiple JAR layouts and launcher scripts',async t=>{
 for(const jars of [['unknown.jar'],['server.jar','other.jar']]){const{app,java}=await fixture(t,jars);await assert.rejects(app.configureSimpleProfile({javaExecutable:java,memoryMiB:1024}),/advanced/i);assert.equal((await app.getState()).server.profile.executable,'');}
 const{app,java}=await fixture(t);await writeFile(path.join((await app.getState()).server.serverDir,'run.sh'),'launcher');await assert.rejects(app.configureSimpleProfile({javaExecutable:java,memoryMiB:1024}),/advanced/i);
});
test('simple profile refuses heap overrides in argument files rather than pretending RAM changed',async t=>{
 const{app,java}=await fixture(t);const file=path.join((await app.getState()).server.serverDir,'user_jvm_args.txt');await writeFile(file,'-Xmx8G\n');await app.saveProfile({executable:java,args:['@user_jvm_args.txt','@unix_args.txt']});
 await assert.rejects(app.configureSimpleProfile({javaExecutable:java,memoryMiB:1024}),/advanced|argument file/i);
});
test('simple profile infers one server JAR and saves probed Java/RAM without starting',async t=>{
 const {app,java}=await fixture(t);await app.configureSimpleProfile({javaExecutable:java,memoryMiB:1024});
 const state=await app.getState();assert.equal(state.server.state,'offline');assert.equal(state.server.profile.executable,java);
 assert.deepEqual(state.server.profile.args,['-Xms512M','-Xmx1024M','-jar','server.jar','nogui']);
});
