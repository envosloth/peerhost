// Real Electron/preload/main/backend and pinned loopback TLS; isolated disposable profile.
// Only native dialog answers are substituted. No live profile or external service changes.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {_electron} from 'playwright';
import {AccountService} from '../dist/src/core/accounts.js';
import {createIdentity} from '../dist/src/core/peer-transport.js';
const root=await mkdtemp(path.join(process.env.TMPDIR,'seedhost-lifecycle-live-')),profile=path.join(root,'profile'),source=path.join(root,'source');
await mkdir(source);await writeFile(path.join(source,'eula.txt'),'eula=true\n');await writeFile(path.join(source,'world.dat'),'original world');
const service=new AccountService(path.join(root,'directory'),await createIdentity());await service.listen({host:'127.0.0.1',port:0});await mkdir(profile);await writeFile(path.join(profile,'account-service.json'),JSON.stringify({...service.endpoint,fingerprint:service.identity.fingerprint}));
const env={...process.env,SEEDHOST_TEST_LOOPBACK:'1'};delete env.ELECTRON_RUN_AS_NODE;delete env.SEEDHOST_ACCOUNT_SERVICE;
let app,page;const errors=[];
async function launch(){app=await _electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:[path.resolve('dist/apps/desktop/main.js'),'--profile-root='+profile],env});page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>document.querySelector('#splash').hidden);await page.waitForFunction(()=>document.querySelector('#activity-message').textContent.startsWith('Ready'));await app.evaluate(({dialog},source)=>{globalThis.answer=1;dialog.showMessageBox=async()=>({response:globalThis.answer});dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]});},source);}
async function call(method,payload){return page.evaluate(({method,payload})=>window.seedhost.call(method,payload),{method,payload});}
async function answer(value){await app.evaluate((_e,value)=>{globalThis.answer=value;},value);}
async function close(){await call('quitApp');await app.close();app=null;}
try{
 await launch();if(!(await call('accountStatus')).signedIn){await page.waitForFunction(()=>document.querySelector('#account-dialog').open);await page.locator('#account-offline').click();}if(await page.locator('#setup-dialog').isVisible())await page.locator('#setup-save-close').click();
 await call('accountRegister',{username:'lifecycleowner',password:randomBytes(24).toString('hex')});await call('importServer');const selected=(await call('getState')).server;
 await answer(0);assert.equal(await call('accountStartGroup'),null);assert.equal((await call('getState')).relay,null);
 await answer(1);await call('accountStartGroup');const first=(await call('getState')).relay;assert.ok(first);assert.equal((await call('alwaysOnStatus')).enabled,false);const backups=await call('listSnapshots'),friends=await call('accountFriends');
 await answer(0);assert.equal(await call('disbandGroup',{id:selected.id,fingerprint:first.fingerprint}),null);assert.equal((await call('getState')).relay.fingerprint,first.fingerprint);
 await answer(1);assert.equal((await call('disbandGroup',{id:selected.id,fingerprint:first.fingerprint})).disbanded,true);assert.equal((await call('getState')).relay,null);
 await call('accountStartGroup');const second=(await call('getState')).relay;assert.notEqual(second.fingerprint,first.fingerprint);assert.equal(second.parkOnStop,false);assert.equal((await call('alwaysOnStatus')).enabled,false);assert.equal((await call('alwaysOnStatus')).gamePort,null);assert.equal((await call('listFriends')).canManage,true);
 assert.equal(JSON.parse(await readFile(path.join(profile,'always-on','relay.json'),'utf8')).disbandedBy,(await call('getState')).deviceId);assert.deepEqual(await call('listSnapshots'),backups);assert.deepEqual(await call('accountFriends'),friends);assert.equal(await readFile(path.join(selected.serverDir,'world.dat'),'utf8'),'original world');assert.equal((await call('getState')).server.ownership.state,'owned');
 await close();await launch();assert.equal((await call('getState')).relay.fingerprint,second.fingerprint);assert.equal((await call('alwaysOnStatus')).fingerprint,second.fingerprint);assert.equal((await call('alwaysOnStatus')).enabled,false);assert.equal((await call('accountStatus')).username,'lifecycleowner');assert.deepEqual(await call('listSnapshots'),backups);
 // A second disband/create exercises rotation of a generated group, not just the legacy root.
 await answer(1);await call('disbandGroup',{id:selected.id,fingerprint:second.fingerprint});await call('accountStartGroup');assert.notEqual((await call('getState')).relay.fingerprint,second.fingerprint);assert.equal((await call('alwaysOnStatus')).enabled,false);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({root,verified:['native Cancel leaves original group intact','native-confirmed disband then Create new group through real IPC','distinct durable identity, owner authority and optional role OFF','account, friendships, ownership, world and snapshot retention','restart and second generation disband/create'],errors},null,2));
}finally{if(app){await call('quitApp').catch(()=>{});await app.close().catch(()=>{});}await service.close();}
