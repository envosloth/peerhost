// Real visible Electron, IPC, account directory, pinned TLS and disposable world files.
// Only native dialog answers are substituted; never uses the user's live profile.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {_electron} from 'playwright';
import {desktopArtifactLaunch} from './desktop-artifact-launch.mjs';
import {dismissInitialSetup} from './desktop-test-setup.mjs';
const option=name=>process.argv.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3);
const project=path.resolve(option('project')||process.cwd()),packaged=option('packaged');
const hold=Number(option('hold')||0);assert.ok(Number.isInteger(hold)&&hold>=0&&hold<=300);
const {AccountService}=await import(pathToFileURL(path.join(project,'dist/src/core/accounts.js')));
const {createIdentity}=await import(pathToFileURL(path.join(project,'dist/src/core/peer-transport.js')));
const root=await mkdtemp(path.join(process.env.TMPDIR,'friends-multihost-live-'));
const service=new AccountService(path.join(root,'directory'),await createIdentity()),apps=[],errors=[];
await service.listen({host:'127.0.0.1',port:0});
const env={...process.env,SEEDHOST_TEST_LOOPBACK:'1'};delete env.ELECTRON_RUN_AS_NODE;delete env.SEEDHOST_ACCOUNT_SERVICE;delete env.SEEDHOST_UPDATE_ORIGIN;
const step=text=>console.log('STEP '+text);
async function call(page,method,payload){return page.evaluate(({method,payload})=>window.seedhost.call(method,payload),{method,payload});}
async function click(page,selector){await page.bringToFront();await page.locator(selector).click();}
async function friends(page){await click(page,'#home-tab');await click(page,'#friends-tab');}
async function launch(name){
 const profile=path.join(root,name);await mkdir(profile,{recursive:true});
 await writeFile(path.join(profile,'account-service.json'),JSON.stringify({...service.endpoint,fingerprint:service.identity.fingerprint}));
 const app=await _electron.launch({...desktopArtifactLaunch(project,profile,packaged),env,timeout:30000});apps.push(app);
 const page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>document.querySelector('#splash').hidden);
 await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});});
 await page.waitForFunction(()=>document.querySelector('#account-dialog').open);
 await click(page,'#account-offline');await dismissInitialSetup(page);
 await call(page,'accountRegister',{username:name,password:randomBytes(24).toString('hex')});
 await page.evaluate(()=>window.dispatchEvent(new Event('seedhost-account-changed')));
 await friends(page);await page.waitForFunction(()=>document.querySelector('#account-heading').textContent.startsWith('@'));
 return {app,page,profile};
}
async function importWorld(instance,name){
 const source=path.join(root,name);await mkdir(source,{recursive:true});await writeFile(path.join(source,'eula.txt'),'eula=true\n');await writeFile(path.join(source,'world-fixture.bin'),name);
 await instance.app.evaluate(({dialog},source)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]});},source);
 await click(instance.page,'#home-tab');await click(instance.page,'#import-server');
 await instance.page.waitForFunction(()=>document.querySelector('#server-list .is-current button[data-action="open"]'));
 await click(instance.page,'#server-list .is-current button[data-action="open"]');await click(instance.page,'#peers-tab');
 return {source,state:await call(instance.page,'getState')};
}
async function refresh(page){await click(page,'#hosting-requests-refresh');await page.waitForFunction(()=>!document.querySelector('#hosting-requests-refresh').disabled);}
async function invite(owner,recipient){
 await owner.page.bringToFront();await owner.page.locator('#hosting-friend-list [data-host-invite="'+recipient+'"]').waitFor({state:'visible'});
 await click(owner.page,'#hosting-friend-list [data-host-invite="'+recipient+'"]');
 await owner.page.waitForFunction(()=>document.querySelector('#hosting-friend-feedback').textContent.includes('Hosting invitation sent'));
}
async function shot(page,name){await page.bringToFront();await page.screenshot({path:path.join(root,name+'.png')});}
try{
 step('Create real isolated accounts; recipient starts with no local servers.');
 const alice=await launch('audit_alice'),bob=await launch('audit_bob');
 assert.equal((await call(bob.page,'getState')).servers.length,0);
 step('Friend request and acceptance through the visible Friends page.');
 await alice.page.locator('#friend-add-username').fill('audit_bob');await click(alice.page,'#friend-add-submit');
 await alice.page.waitForFunction(()=>document.querySelector('#account-friends-feedback').textContent.includes('Friend request sent'));
 await click(bob.page,'#friend-requests-refresh');await bob.page.locator('#friend-request-list [data-friend-accept]').waitFor({state:'visible'});
 await click(bob.page,'#friend-request-list [data-friend-accept]');await bob.page.waitForFunction(()=>document.querySelector('#account-friends-feedback').textContent.includes('are now friends'));
 step('Owner creates a group for a disposable world; sends an invitation from Multi-host.');
 const first=await importWorld(alice,'alpha-world');await click(alice.page,'#hosting-start-group');
 await alice.page.waitForFunction(()=>document.querySelector('#hosting-friend-feedback').textContent.includes('group is ready'));
 const groupA=(await call(alice.page,'getState')).relay;assert.ok(groupA);
 await invite(alice,'audit_bob');await friends(bob.page);
 assert.equal(await bob.page.locator('#friends-panel #hosting-request-list').count(),1,'serverless hosting invitation inbox must live in Friends');
 await refresh(bob.page);
 step('Serverless recipient sees invitation in Friends, never under an unrelated server.');
 assert.equal(await bob.page.locator('#friends-panel #hosting-request-list').count(),1,'hosting inbox must belong to Friends');
 assert.equal(await bob.page.locator('#peers-panel #hosting-request-list').count(),0);
 await bob.page.locator('#hosting-request-list [data-account-accept]').waitFor({state:'visible'});await shot(bob.page,'01-friends-invitation');
 await click(bob.page,'#hosting-request-list [data-account-accept]');await bob.page.waitForFunction(()=>document.querySelector('#hosting-request-feedback').textContent.startsWith('Joined'));
 let joined=await call(bob.page,'getState');assert.equal(joined.servers.length,0);assert.ok(joined.pendingGroups.some(g=>g.fingerprint===groupA.fingerprint));
 await bob.page.locator('#hosting-group-list [data-hosting-group="'+groupA.fingerprint+'"]').waitFor({state:'visible'});
 assert.equal((await call(bob.page,'accountRequests')).length,0,'directory inbox dismissal readback');
 step('Import unrelated world after enrollment; it must not silently adopt the invited group.');
 const unrelated=await importWorld(bob,'unrelated-world');assert.equal(unrelated.state.relay,null);
 assert.ok(unrelated.state.pendingGroups.some(g=>g.fingerprint===groupA.fingerprint));
 const unrelatedBefore=unrelated.state.servers;
 await friends(bob.page);
 step('Owner overview displays created group; recipient overview displays joined/pending group.');
 await friends(alice.page);await alice.page.locator('#hosting-group-list [data-hosting-group="'+groupA.fingerprint+'"]').waitFor({state:'visible'});
 const overview=await call(alice.page,'listHostingGroups');assert.ok(overview.some(g=>g.fingerprint===groupA.fingerprint&&g.localAuthority===true&&g.serverId===first.state.server.id));
 step('Unread notifications survive refresh without duplicate invitation entries.');
 await click(bob.page,'#notifications-open');await bob.page.locator('#notifications-dialog[open]').waitFor({state:'visible'});
 const before=await bob.page.locator('#notifications-list').textContent();assert.match(before,/audit_alice/);
 assert.doesNotMatch(before,/SHINV|fixture-password|BEGIN PRIVATE KEY/);
 const entries=await bob.page.locator('#notifications-list li').count();await bob.page.keyboard.press('Escape');await refresh(bob.page);
 await click(bob.page,'#notifications-open');assert.equal(await bob.page.locator('#notifications-list li').count(),entries,'polling does not duplicate notifications');
 await click(bob.page,'#notifications-mark-read');await bob.page.waitForFunction(()=>document.querySelector('#notifications-count').hidden||document.querySelector('#notifications-count').textContent==='0');
 await shot(bob.page,'02-notifications');await bob.page.keyboard.press('Escape');
 step('Explicit pending download creates a NEW server without replacing the unrelated world.');
 await call(alice.page,'selectServer',{id:first.state.server.id});await call(alice.page,'parkAtRelay');
 const pendingCard=bob.page.locator('#hosting-group-list [data-hosting-group="'+groupA.fingerprint+'"]');
 await bob.page.bringToFront();await pendingCard.getByRole('button',{name:/Download as a new server/i}).click();
 await bob.page.waitForFunction(()=>document.querySelector('#hosting-group-feedback').textContent.startsWith('Downloaded as a new server.'));
 await bob.page.waitForFunction(async()=>{const s=await window.seedhost.call('getState');return !s.busy&&s.servers.length===2&&s.pendingGroups.length===0;});
 joined=await call(bob.page,'getState');
 const retained=joined.servers.find(s=>s.id===unrelatedBefore[0].id);
 // The download selects its new server; the unrelated world keeps its identity, group and bytes.
 assert.equal(retained.group,null);assert.equal(retained.ownerName,unrelatedBefore[0].ownerName);assert.equal(retained.state,'offline');
 assert.equal(await readFile(path.join(unrelated.state.server.serverDir,'world-fixture.bin'),'utf8'),'unrelated-world');
 assert.equal(await readFile(path.join(joined.server.serverDir,'world-fixture.bin'),'utf8'),'alpha-world');
 assert.notEqual(joined.server.id,retained.id);assert.equal(joined.server.state,'offline');
 step('Create second independent group; both group identities coexist in the overview.');
 await importWorld(alice,'bravo-world');await click(alice.page,'#hosting-start-group');await alice.page.waitForFunction(()=>document.querySelector('#hosting-friend-feedback').textContent.includes('group is ready'));
 const groupB=(await call(alice.page,'getState')).relay;assert.notEqual(groupB.fingerprint,groupA.fingerprint);
 await friends(alice.page);const groups=await call(alice.page,'listHostingGroups');assert.equal(groups.length,2);assert.equal(new Set(groups.map(g=>g.fingerprint)).size,2);
 await shot(alice.page,'03-created-groups');await friends(bob.page);await shot(bob.page,'04-joined-group');
 step('Renderer reload retains membership and notification history.');
 await bob.page.reload();await bob.page.waitForFunction(()=>document.querySelector('#splash').hidden);await friends(bob.page);
 await bob.page.locator('#hosting-group-list [data-hosting-group="'+groupA.fingerprint+'"]').waitFor({state:'visible'});
 await click(bob.page,'#notifications-open');assert.match(await bob.page.locator('#notifications-list').textContent(),/audit_alice/);await bob.page.keyboard.press('Escape');
 assert.deepEqual(errors,[]);console.log('PASS: real IPC/TLS invitation acceptance, Friends inbox, no auto-adoption, explicit append-only download, independent groups, persistent deduped notifications.');
 console.log('ARTIFACT_DIR='+root);
 if(hold){await friends(bob.page);await bob.page.bringToFront();for(let left=hold;left>0;left-=Math.min(15,left)){console.log('INSPECTION '+left+' seconds remaining');await new Promise(r=>setTimeout(r,Math.min(15,left)*1000));}}
}catch(error){process.exitCode=1;console.error(error);for(const [i,app] of apps.entries()){const page=await app.firstWindow().catch(()=>null);if(page&&!page.isClosed())await page.screenshot({path:path.join(root,'failure-'+i+'.png')}).catch(()=>{});}console.log('ARTIFACT_DIR='+root);
}finally{for(const app of [...apps].reverse()){
 console.log('CLEANUP isolated Electron '+app.process().pid);
 const closed=await Promise.race([app.close().then(()=>true,e=>{console.error(e);return false;}),new Promise(r=>setTimeout(()=>r(false),15000))]);
 if(!closed){process.exitCode=1;console.error('Isolated Electron did not close cleanly; forcing fixture exit.');await app.evaluate(({app})=>app.exit(0)).catch(()=>{});}
 }console.log('CLEANUP account service');await service.close();console.log('CLEANUP complete');}
