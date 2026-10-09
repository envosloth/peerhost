// Actual main/preload/renderer + pinned loopback account directory, disposable profiles only.
// Native import picker/consent answers are the sole substituted privilege seams. Not WAN/gameplay proof.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { AccountService } from '../dist/src/core/accounts.js';
import { desktopArtifactLaunch } from './desktop-artifact-launch.mjs';
import { dismissInitialSetup } from './desktop-test-setup.mjs';
const scratch=process.env.TMPDIR;if(!scratch)throw Error('Scratch TMPDIR required');
const root=await mkdtemp(path.join(scratch,'seedhost-profile-desktop-'));
const profile=path.join(root,'profile'),source=path.join(root,'import-source');
await mkdir(profile);await mkdir(source);await writeFile(path.join(source,'server.properties'),'motd=Disposable UI check\nonline-mode=true\n');
const service=new AccountService(path.join(root,'directory'),await createIdentity());
await service.listen({host:'127.0.0.1'});
await writeFile(path.join(profile,'account-service.json'),JSON.stringify({...service.endpoint,fingerprint:service.identity.fingerprint}));
const env={...process.env,SEEDHOST_TEST_LOOPBACK:'1'};delete env.ELECTRON_RUN_AS_NODE;delete env.SEEDHOST_ACCOUNT_SERVICE;
const packaged=process.argv.find(a=>a.startsWith('--packaged='))?.slice('--packaged='.length);
const hold=Number(process.argv.find(a=>a.startsWith('--hold='))?.slice(7)??90);
if(!Number.isFinite(hold)||hold<0||hold>300)throw Error('Invalid hold');
let app,page;const errors=[];
async function launch(){
 app=await electron.launch({...desktopArtifactLaunch(process.cwd(),profile,packaged),env,timeout:25000});
 page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 await page.bringToFront();await page.waitForFunction(()=>document.querySelector('#activity-message').textContent.startsWith('Ready'));
}
async function click(s){await page.bringToFront();await page.locator(s).click();}
async function shot(name){await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));await page.screenshot({path:path.join(root,name+'.png')});}
try{
 await launch();console.log('STEP 1: register disposable loopback account');
 await page.waitForSelector('#account-dialog[open]');await page.locator('#account-username').fill('profile_fixture');await page.locator('#account-password').fill('fixture-current-123');await click('#account-submit');
 await page.waitForFunction(()=>!document.querySelector('#account-dialog').open);await dismissInitialSetup(page);
 assert.deepEqual(await page.locator('.nav-tabs > button').evaluateAll(ns=>ns.filter(n=>!n.hidden).map(n=>n.id)),['home-tab','friends-tab','settings-tab']);
 await shot('home');await click('#friends-tab');assert.equal(await page.locator('#account-card').isVisible(),true);
 console.log('STEP 2: real Profile username/password update through sandbox preload and main');
 await click('#profile-open');await page.locator('#profile-username').fill('profile_changed');await page.locator('#profile-current-password').fill('fixture-current-123');await page.locator('#profile-new-password').fill('fixture-updated-456');await page.locator('#profile-confirm-password').fill('fixture-updated-456');await click('#profile-save');
 await page.waitForFunction(()=>!document.querySelector('#profile-save').disabled);
 assert.match(await page.locator('#account-profile-feedback').textContent(),/Saved profile/);
 assert.equal((await page.evaluate(()=>window.seedhost.call('accountStatus'))).username,'profile_changed');
 for(const id of ['profile-current-password','profile-new-password','profile-confirm-password'])assert.equal(await page.locator('#'+id).inputValue(),'');
 await shot('profile-saved');await click('#profile-close');
 console.log('STEP 3: wrong current password is rejected without altering username');
 await click('#profile-open');await page.locator('#profile-username').fill('not_saved');await page.locator('#profile-current-password').fill('fixture-wrong-789');await click('#profile-save');
 await page.waitForFunction(()=>!document.querySelector('#profile-save').disabled);assert.match(await page.locator('#account-profile-feedback').textContent(),/Current password is incorrect/);
 assert.equal((await page.evaluate(()=>window.seedhost.call('accountStatus'))).username,'profile_changed');await click('#profile-close');
 console.log('STEP 4: import stopped disposable source and verify only Server settings in workspace');
 await click('#home-tab');await app.evaluate(({dialog},dir)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[dir]});dialog.showMessageBox=async()=>({response:1});},source);
 await click('#import-server');await page.waitForFunction(()=>document.querySelector('#server-list [data-action="open"]'));
 await click('#server-list [data-action="open"]');await click('#server-settings-tab');
 assert.equal(await page.locator('#settings-tab').isVisible(),false);assert.equal(await page.locator('#friends-tab').isVisible(),false);assert.equal(await page.locator('#profile-open').isVisible(),true);await shot('server-settings');
 await click('#home-tab');await click('#settings-tab');assert.equal(await page.locator('#settings-panel').isVisible(),true);await shot('app-settings');
 console.log('STEP 5: sign out, log in with the new credentials, then restart and verify persisted session');
 await click('#friends-tab');await click('#account-signout');await page.waitForFunction(()=>!document.querySelector('#account-open').hidden);
 await click('#profile-open');await click('#profile-signin');await page.locator('#account-username').fill('profile_changed');await page.locator('#account-password').fill('fixture-updated-456');await click('#account-submit');await page.waitForFunction(()=>!document.querySelector('#account-dialog').open);
 await app.close();app=null;await launch();await dismissInitialSetup(page);
 assert.equal((await page.evaluate(()=>window.seedhost.call('accountStatus'))).username,'profile_changed');assert.equal(await page.locator('#account-dialog').evaluate(d=>d.open),false);
 await click('#profile-open');await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setFullScreen(false);w.setContentSize(1000,700);});
 await shot('profile-minimum');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no page horizontal overflow');
 const duplicates=await page.evaluate(()=>{const ids=[...document.querySelectorAll('[id]')].map(n=>n.id);return ids.filter((id,i)=>ids.indexOf(id)!==i);});assert.deepEqual(duplicates,[]);assert.deepEqual(errors,[]);
 console.log('PASS: real profile update/refusal/new-credential login/restart; global Friends and app Settings; server-only settings; unique DOM IDs.');console.log('ARTIFACT_DIR='+root);
 for(let remaining=hold;remaining>0;remaining-=15){console.log('Visible inspection hold: '+remaining+'s');await page.waitForTimeout(Math.min(15,remaining)*1000);}
}finally{if(app)await app.close().catch(()=>{});await service.close();}
