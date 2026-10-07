import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {createIdentity} from '../dist/src/core/peer-transport.js';
import {SeedHostApplication} from '../dist/src/core/application.js';
import {validateServerProperties} from '../dist/src/core/server-properties.js';

const controls={motd:'Weekend world','server-port':25567,'max-players':12,difficulty:'hard',gamemode:'adventure',pvp:false,'white-list':true,'view-distance':8,'simulation-distance':6,hardcore:true,'spawn-protection':0,'allow-flight':true};
test('every displayed property including Hardcore persists with exact readback after reopening a disposable profile',async t=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR,'seed-settings-guide-')); const source=path.join(root,'source');await mkdir(source);
 const original='# retain comment\nonline-mode=true\nmotd=Before\n'; await writeFile(path.join(source,'server.properties'),original);await writeFile(path.join(source,'eula.txt'),'eula=true\n');await writeFile(path.join(source,'world.dat'),'retain world');
 const identity=await createIdentity();const profile=path.join(root,'profile');let app=new SeedHostApplication(profile,identity);await app.open();
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});await app.importExisting(source,true);const server=(await app.getState()).server;
 const saved=await app.saveServerSettings(server.id,controls);assert.equal(await readFile(saved.backupFile,'utf8'),original);
 for(const [key,value] of Object.entries(controls))assert.equal((await app.getServerDashboard(server.id)).settings[key],String(value),key);
 await app.close();app=new SeedHostApplication(profile,identity);await app.open();
 for(const [key,value] of Object.entries(controls))assert.equal((await app.getServerDashboard(server.id)).settings[key],String(value),key+' persisted');
 assert.equal(await readFile(path.join(source,'server.properties'),'utf8'),original);assert.equal(await readFile(path.join(server.serverDir,'world.dat'),'utf8'),'retain world');
 for(const settings of [{hardcore:'yes'},{'spawn-protection':-1},{'spawn-protection':100000},{'allow-flight':'yes'},{'online-mode':false}])assert.throws(()=>validateServerProperties(settings),/invalid|unsupported/i);
});
