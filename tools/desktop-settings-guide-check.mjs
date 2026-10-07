// Real Electron/preload/main/backend, disposable profiles and loopback relay only.
// Only native dialog answers are substituted. Not Minecraft/gameplay/WAN proof.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {_electron} from 'playwright';
import {AccountService,AccountClient} from '../dist/src/core/accounts.js';
import {randomBytes} from 'node:crypto';
import {RelayNode} from '../dist/src/core/relay.js';
import {createIdentity} from '../dist/src/core/peer-transport.js';
const root=await mkdtemp(path.join(process.env.TMPDIR,'seedhost-settings-live-')),profile=path.join(root,'profile'),source=path.join(root,'source');
await mkdir(source);await writeFile(path.join(source,'server.properties'),'# keep\nmotd=Before\nonline-mode=true\nserver-port=25565\n');await writeFile(path.join(source,'eula.txt'),'eula=true\n');await writeFile(path.join(source,'world.dat'),'retain local world');
const env={...process.env,SEEDHOST_TEST_LOOPBACK:'1'};delete env.ELECTRON_RUN_AS_NODE;delete env.SEEDHOST_ACCOUNT_SERVICE;
const service=new AccountService(path.join(root,'accounts'),await createIdentity());await service.listen({host:'127.0.0.1',port:0});await mkdir(profile);await writeFile(path.join(profile,'account-service.json'),JSON.stringify({...service.endpoint,fingerprint:service.identity.fingerprint}));
let app,page,relay;const errors=[];
async function launch(){app=await _electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:[path.resolve('dist/apps/desktop/main.js'),'--profile-root='+profile],env});page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));await page.bringToFront();await page.waitForFunction(()=>document.querySelector('#splash').hidden);await page.waitForFunction(()=>document.querySelector('#activity-message').textContent.startsWith('Ready'));await app.evaluate(({dialog},source)=>{globalThis.qaAnswer=1;dialog.showMessageBox=async()=>({response:globalThis.qaAnswer});dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]});},source);}
async function call(method,payload){return page.evaluate(({method,payload})=>window.seedhost.call(method,payload),{method,payload});}
async function answer(value){await app.evaluate((_e,value)=>{globalThis.qaAnswer=value;},value);}
try{
 await launch();if(!(await call('accountStatus')).signedIn){await page.waitForFunction(()=>document.querySelector('#account-dialog').open);await page.locator('#account-offline').click();}if(await page.locator('#setup-dialog').isVisible())await page.locator('#setup-save-close').click();
 await call('accountRegister',{username:'ownertest',password:randomBytes(24).toString('hex')});
 const endpoint={...service.endpoint,fingerprint:service.identity.fingerprint};const sam=new AccountClient(await createIdentity(),endpoint),taylor=new AccountClient(await createIdentity(),endpoint);const samSession=await sam.call('register',{username:'samtest',password:randomBytes(24).toString('hex')});await taylor.call('register',{username:'taylortest',password:randomBytes(24).toString('hex')});await sam.call('friend-send',{token:samSession.token,username:'ownertest'});
 await page.evaluate(()=>window.dispatchEvent(new Event('seedhost-account-changed')));await page.locator('#nav-setup').click();await page.locator('[data-setup-step="friends"]').click();await page.waitForFunction(()=>!document.querySelector('#setup-friend-send').disabled);
 await page.locator('#setup-friend-username').fill('taylortest');await page.locator('#setup-friend-send').click();await page.waitForFunction(()=>document.querySelector('#setup-friend-feedback').textContent.includes('sent to @taylortest'));
 await page.locator('#setup-friend-request-list [data-friend-accept]').click();await page.waitForFunction(()=>document.querySelector('#setup-friend-feedback').textContent.includes('now friends'));assert.equal(await page.locator('#setup-dialog').isVisible(),true);const accountFriends=await call('accountFriends');assert.ok(accountFriends.some(f=>f.username==='samtest'));await page.locator('#setup-save-close').click();
 assert.equal((await call('alwaysOnStatus')).enabled,false);
 await call('importServer');let state=await call('getState');const selected=state.server;
 const patch={motd:'Verified','server-port':25567,'max-players':12,difficulty:'hard',gamemode:'adventure',pvp:false,'white-list':true,'view-distance':8,'simulation-distance':6,hardcore:true,'spawn-protection':0,'allow-flight':true};
 await answer(0);assert.equal(await call('saveServerSettings',{id:selected.id,settings:patch}),null);assert.equal((await call('getServerDashboard',{id:selected.id})).settings.motd,'Before');
 await answer(1);await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await page.locator('#server-list .is-current [data-action="open"]').click();await page.locator('#server-settings-tab').click();await page.waitForFunction(()=>!document.querySelector('#property-motd').disabled);
 for(const [key,value] of Object.entries(patch)){const input=page.locator('#property-'+key);if(typeof value==='boolean'){await input.check();if(!value)await input.uncheck();}else if(['difficulty','gamemode'].includes(key))await input.selectOption(value);else await input.fill(String(value));}
 await page.locator('#properties-save').click();await page.waitForFunction(()=>document.querySelector('#properties-feedback').textContent.includes('Verified'));
 const dashboard=await call('getServerDashboard',{id:selected.id});for(const [k,v] of Object.entries(patch))assert.equal(dashboard.settings[k],String(v));
 const identity=await createIdentity();relay=new RelayNode(path.join(root,'relay'),identity,{log:()=>{}});await relay.open();await relay.trust('Owner',state.deviceId);await relay.setOwner(state.deviceId);await relay.listen();const invite=await relay.createInvite({recipient:state.deviceId});
 await call('joinWithInvite',{code:invite.code,name:'Owner'});await call('saveRelay',{fingerprint:identity.fingerprint,parkOnStop:false});state=await call('getState');assert.equal(state.relay.fingerprint,identity.fingerprint);
 // Explicit role enable stays app-wide, separate from this external group's selected-server association.
 await call('alwaysOnEnable',{name:'Explicit opt-in'});assert.equal((await call('alwaysOnStatus')).enabled,true);await call('alwaysOnDisable');assert.equal((await call('alwaysOnStatus')).enabled,false);await call('alwaysOnEnable',{name:'Explicit opt-in'});
 const peers=state.peers,backups=await call('listSnapshots');
 await answer(0);assert.equal(await call('disbandGroup',{id:selected.id,fingerprint:identity.fingerprint}),null);assert.equal((await call('getState')).relay.fingerprint,identity.fingerprint);
 await answer(1);const result=await call('disbandGroup',{id:selected.id,fingerprint:identity.fingerprint});assert.equal(result.disbanded,true);assert.equal((await call('getState')).relay,null);assert.deepEqual((await call('getState')).peers,peers);assert.deepEqual(await call('listSnapshots'),backups);assert.equal((await call('alwaysOnStatus')).enabled,true);assert.deepEqual(await call('accountFriends'),accountFriends);assert.equal((await call('accountStatus')).username,'ownertest');
 assert.equal(await readFile(path.join(selected.serverDir,'world.dat'),'utf8'),'retain local world');assert.match(await readFile(path.join(selected.serverDir,'server.properties'),'utf8'),/hardcore=true/);assert.match(await readFile(path.join(source,'server.properties'),'utf8'),/motd=Before/);
 await page.screenshot({path:path.join(root,'settings-live.png')});await call('quitApp');await app.close();app=null;
 await launch();assert.equal((await call('getState')).relay,null);assert.equal((await call('getServerDashboard',{id:selected.id})).settings.hardcore,'true');assert.equal((await call('alwaysOnStatus')).enabled,true);assert.equal((await call('getState')).server.ownership.state,'owned');assert.deepEqual(errors,[]);
 console.log(JSON.stringify({root,verified:['real inline guide friendship send and acceptance over loopback TLS','account friendship retention across group disband','real settings cancellation and complete property persistence','real TLS group-wide revocation and local readback','world/backups/peer retention','explicit role enable/disable and opt-in retention across disband/restart','reopened disposable profile'],errors},null,2));
}finally{if(app){await call('quitApp').catch(()=>{});await app.close().catch(()=>{});}await relay?.close();await service.close();}
