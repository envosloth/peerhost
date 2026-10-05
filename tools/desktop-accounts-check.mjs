// Isolated real Electron, real account service, real pinned TLS relay; only native confirmation answers are substituted.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { RelayNode } from '../dist/src/core/relay.js';
import { AccountService } from '../dist/src/core/accounts.js';
import { dismissInitialSetup } from './desktop-test-setup.mjs';
const root=await mkdtemp(path.join(process.env.TMPDIR,'accounts-ui-'));
const service=new AccountService(path.join(root,'directory'),await createIdentity()),relay=new RelayNode(path.join(root,'relay'),await createIdentity(),{log:()=>{}}),apps=[];
const errors=[];await service.listen();await relay.open();await relay.listen();
const env={...process.env,SEEDHOST_TEST_LOOPBACK:'1'};delete env.ELECTRON_RUN_AS_NODE;delete env.SEEDHOST_ACCOUNT_SERVICE;
async function launch(name){await mkdir(path.join(root,name),{recursive:true});await writeFile(path.join(root,name,'account-service.json'),JSON.stringify({...service.endpoint,fingerprint:service.identity.fingerprint}));const app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:['--password-store=gnome-libsecret',path.resolve('dist/apps/desktop/main.js'),'--profile-root='+path.join(root,name)],env,timeout:20000});apps.push(app);const page=await app.firstWindow();await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});});page.on('pageerror',e=>errors.push(String(e)));await page.waitForFunction(()=>document.querySelector('#activity-message').textContent.startsWith('Ready'));return {app,page};}
async function signup(page,name){await page.waitForSelector('#account-dialog[open]',{timeout:5000});assert.equal(await page.locator('#account-password').evaluate(el=>Math.round(el.getBoundingClientRect().height)),await page.locator('#account-username').evaluate(el=>Math.round(el.getBoundingClientRect().height)),'password gets the same styled control as username');if(name==='alice'){await page.waitForFunction(()=>getComputedStyle(document.querySelector('#account-dialog')).opacity==='1');await page.screenshot({path:path.join(root,'signup.png')});}await page.locator('#account-username').fill(name);await page.locator('#account-password').fill(name+'-fixture-password-123');await page.locator('#account-submit').click();await page.waitForFunction(()=>!document.querySelector('#account-dialog').open);await dismissInitialSetup(page);await page.locator('#peers-tab').click();}
try {
 const a=await launch('alice');await signup(a.page,'alice');
 await a.page.locator('#account-start-group').click();
 await a.page.waitForFunction(()=>document.querySelector('#account-friend-feedback').textContent.includes('Your group is ready'));
 assert.equal((await a.page.evaluate(()=>window.seedhost.call('listFriends'))).canManage,true,'creator is automatically the group owner');
 const b=await launch('bob');await signup(b.page,'bob');
 await a.page.bringToFront();await a.page.locator('#friend-username').fill('bob');await a.page.locator('#username-invite').click();
 await a.page.waitForFunction(()=>document.querySelector('#account-friend-feedback').textContent.includes('Invitation sent'));
 await b.page.bringToFront();await b.page.locator('#account-refresh').click();await b.page.locator('[data-account-accept]').click();
 await b.page.waitForFunction(()=>document.querySelector('#account-friend-feedback').textContent.includes('Joined'));
 await b.page.locator('#refresh-friends').click();await b.page.waitForFunction(()=>document.querySelectorAll('#friend-list li').length===2);
 assert.equal(await b.page.locator('[data-remove-friend]').count(),0,'members cannot remove each other');
 await a.page.bringToFront();await a.page.locator('#refresh-friends').click();await a.page.waitForFunction(()=>document.querySelectorAll('[data-remove-friend]').length===1);
 await a.page.screenshot({path:path.join(root,'owner-friends.png')});
 for(const [w,h] of [[1240,860],[1000,700]]){await a.page.setViewportSize({width:w,height:h});assert.ok(await a.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');}
 await a.app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:0});});await a.page.locator('[data-remove-friend]').click();await a.page.waitForFunction(()=>document.querySelector('#activity-message').textContent.startsWith('Ready') && !document.querySelector('[data-remove-friend]')?.disabled);assert.equal((await a.page.evaluate(()=>window.seedhost.call('listFriends'))).members.length,2,'Cancel preserves member');
 await a.app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});});await a.page.locator('[data-remove-friend]').click();await a.page.waitForFunction(()=>document.querySelectorAll('#friend-list li').length===1);assert.equal((await a.page.evaluate(()=>window.seedhost.call('listFriends'))).members.length,1);
 await a.app.close();apps.splice(apps.indexOf(a.app),1);const restored=await launch('alice');await restored.page.waitForTimeout(1000);assert.equal(await restored.page.locator('#account-dialog').evaluate(d=>d.open),false,'returning users stay signed in');assert.equal((await restored.page.evaluate(()=>window.seedhost.call('accountStatus'))).username,'alice');
 assert.deepEqual(errors,[]);console.log('PASS: signup, username invitation, acceptance, owner-only removal, cancel, secure persistence, responsive layout.');
 console.log('ARTIFACT_DIR='+root);
}finally{for(const app of apps.reverse())await app.close();await relay.close();await service.close();}
