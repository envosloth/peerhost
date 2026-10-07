// Isolated real Electron, real account service, real always-on group; only native confirmation answers are substituted.
// Flow (current build): Friends = sign-in, friendship and friend requests; Multi-host = group creation + hosting invitation.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { AccountService } from '../dist/src/core/accounts.js';
import { dismissInitialSetup } from './desktop-test-setup.mjs';
const root=await mkdtemp(path.join(process.env.TMPDIR,'accounts-ui-'));
const service=new AccountService(path.join(root,'directory'),await createIdentity()),apps=[];
const errors=[];await service.listen();
const env={...process.env,SEEDHOST_TEST_LOOPBACK:'1'};delete env.ELECTRON_RUN_AS_NODE;delete env.SEEDHOST_ACCOUNT_SERVICE;
let workspaceSequence=0;
async function launch(name){
  await mkdir(path.join(root,name),{recursive:true});
  await writeFile(path.join(root,name,'account-service.json'),JSON.stringify({...service.endpoint,fingerprint:service.identity.fingerprint}));
  await writeFile(path.join(root,name,'onboarding.json'),JSON.stringify({version:1,step:'server',dismissed:true,completed:false,skipped:[],draft:{name:'My Minecraft server',loader:'vanilla',gameVersion:'',memoryMiB:2048}}));
  const app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:['--password-store=gnome-libsecret',path.resolve('dist/apps/desktop/main.js'),'--profile-root='+path.join(root,name)],env,timeout:20000});
  apps.push(app);const page=await app.firstWindow();
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});});
  page.on('pageerror',e=>errors.push(String(e)));
  await page.waitForFunction(()=>document.querySelector('#activity-message').textContent.startsWith('Ready'));
  return {app,page};
}
async function signup(page,name){
  await page.waitForSelector('#account-dialog[open]',{timeout:8000});
  assert.equal(await page.locator('#account-password').evaluate(el=>Math.round(el.getBoundingClientRect().height)),await page.locator('#account-username').evaluate(el=>Math.round(el.getBoundingClientRect().height)),'password gets the same styled control as username');
  if(name==='alice'){await page.waitForFunction(()=>getComputedStyle(document.querySelector('#account-dialog')).opacity==='1');await page.screenshot({path:path.join(root,'signup.png')});}
  await page.locator('#account-username').fill(name);await page.locator('#account-password').fill(name+'-fixture-password-123');
  await page.locator('#account-submit').click();
  await page.waitForFunction(()=>!document.querySelector('#account-dialog').open && document.querySelector('#account-heading').textContent.startsWith('@'));
  await dismissInitialSetup(page);
  await page.locator('#friends-tab').click();
}
// A disposable stopped workspace (NOT Minecraft) so Multi-host is reachable; native folder answer only.
async function enterMultiHost({app,page}){
  await page.locator('#home-tab').click();
  if(!(await page.evaluate(async()=>Boolean((await window.seedhost.call('getState')).server)))){
    const source=path.join(root,'workspace-'+(workspaceSequence++));await mkdir(source,{recursive:true});await writeFile(path.join(source,'eula.txt'),'eula=true\n');
    await app.evaluate(({dialog},source)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]});},source);
    await page.locator('#import-server').click();
    await page.waitForFunction(()=>document.querySelector('#server-list .is-current button[data-action="open"]'));
  }
  await page.locator('#server-list .is-current button[data-action="open"]').click();
  await page.waitForFunction(()=>!document.querySelector('#peers-tab').hidden);
  await page.locator('#peers-tab').click();
}
try {
  const a=await launch('alice');await signup(a.page,'alice');
  await enterMultiHost(a);
  await a.page.locator('#hosting-create-group').waitFor({state:'visible'});
  await a.page.locator('#hosting-start-group').click();
  await a.page.waitForFunction(()=>document.querySelector('#hosting-friend-feedback').textContent.includes('Your hosting group is ready'));
  assert.equal((await a.page.evaluate(()=>window.seedhost.call('listFriends'))).canManage,true,'creator is automatically the group owner');
  const b=await launch('bob');await signup(b.page,'bob');
  await enterMultiHost(b);
  // Friendship first (Friends page), then an explicit hosting invitation for this server (Multi-host).
  await a.page.locator('#friends-tab').click();
  await a.page.locator('#friend-add-username').fill('bob');
  await a.page.locator('#friend-add-submit').click();
  await a.page.waitForFunction(()=>document.querySelector('#account-friends-feedback').textContent.includes('Friend request sent to @bob'));
  await b.page.locator('#friends-tab').click();await b.page.locator('#friend-requests-refresh').click();
  await b.page.locator('#friend-request-list [data-friend-accept]').waitFor({state:'visible'});
  await b.page.locator('#friend-request-list [data-friend-accept]').click();
  await b.page.waitForFunction(()=>document.querySelector('#account-friends-feedback').textContent.includes('are now friends'));
  await a.page.locator('#peers-tab').click();
  await a.page.locator('#hosting-friend-list [data-host-invite="bob"]').waitFor({state:'visible'});
  await a.page.locator('#hosting-friend-list [data-host-invite="bob"]').click();
  await a.page.waitForFunction(()=>document.querySelector('#hosting-friend-feedback').textContent.includes('Hosting invitation sent to @bob'));
  await b.page.bringToFront();await b.page.locator('#hosting-requests-refresh').click();
  await b.page.locator('#hosting-request-list [data-account-accept]').waitFor({state:'visible'});
  await b.page.locator('#hosting-request-list [data-account-accept]').click();
  await b.page.waitForFunction(()=>document.querySelector('#hosting-request-feedback').textContent.includes('Joined'));
  await b.page.locator('#refresh-friends').click();await b.page.waitForFunction(()=>document.querySelectorAll('#friend-list li').length===2);
  assert.equal(await b.page.locator('[data-remove-friend]').count(),0,'members cannot remove each other');
  await a.page.bringToFront();await a.page.locator('#refresh-friends').click();await a.page.waitForFunction(()=>document.querySelectorAll('[data-remove-friend]').length===1);
  await a.page.screenshot({path:path.join(root,'owner-multi-host.png')});
  for(const [w,h] of [[1240,860],[1000,700]]){await a.page.setViewportSize({width:w,height:h});assert.ok(await a.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');}
  await a.app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:0});});await a.page.locator('[data-remove-friend]').click();await a.page.waitForFunction(()=>document.querySelector('#activity-message').textContent.startsWith('Ready') && !document.querySelector('[data-remove-friend]')?.disabled);assert.equal((await a.page.evaluate(()=>window.seedhost.call('listFriends'))).members.length,2,'Cancel preserves member');
  await a.app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});});await a.page.locator('[data-remove-friend]').click();await a.page.waitForFunction(()=>document.querySelectorAll('#friend-list li').length===1);assert.equal((await a.page.evaluate(()=>window.seedhost.call('listFriends'))).members.length,1);
  await a.app.close();apps.splice(apps.indexOf(a.app),1);
  const restored=await launch('alice');await restored.page.waitForTimeout(1200);
  assert.equal(await restored.page.locator('#account-dialog').evaluate(d=>d.open),false,'returning users stay signed in');
  assert.equal((await restored.page.evaluate(()=>window.seedhost.call('accountStatus'))).username,'alice');
  await restored.page.locator('#friends-tab').click();
  await restored.page.waitForFunction(()=>document.querySelector('#account-friends-list').textContent.includes('@bob'));
  assert.deepEqual(errors,[]);
  console.log('PASS: signup, friendship, hosting group, invitation, acceptance, owner-only removal, cancel, secure persistence, responsive layout.');
  console.log('ARTIFACT_DIR='+root);
} finally {for(const app of apps.reverse())await app.close();await service.close();}
