// Real main/preload/backend and pinned loopback TLS. Only native picker/delete
// answers and the optional native-folder observer are substituted. Disposable
// Node process/file fixtures are NOT Minecraft or WAN/provider proof.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:net';
import {_electron as electron} from 'playwright';
import {desktopArtifactLaunch} from './desktop-artifact-launch.mjs';
import {dismissInitialSetup,reveal,openSelectedServer} from './desktop-test-setup.mjs';
const project=process.cwd();assert.ok(process.env.TMPDIR?.includes('hermes'),'QA must use Hermes scratch');
const root=await mkdtemp(path.join(process.env.TMPDIR,'seedhost-ux-desktop-'));
const packaged=process.argv.find(v=>v.startsWith('--packaged='))?.slice(11);
const holdArg=process.argv.find(v=>v.startsWith('--hold=')),hold=holdArg?Number(holdArg.slice(7)):90;
assert.ok(Number.isInteger(hold)&&hold>=0&&hold<=120,'Invalid inspection hold');
const realFolder=process.argv.includes('--real-folder');
const env={...process.env,SEEDHOST_TEST_LOOPBACK:'1'};delete env.ELECTRON_RUN_AS_NODE;delete env.SEEDHOST_ACCOUNT_SERVICE;
const apps=[],errors=[];let pa,pb,passed=false;
const state=page=>page.evaluate(()=>window.seedhost.call('getState'));
async function until(check,message){const end=Date.now()+30000;while(!await check()){if(Date.now()>end)throw Error(message);await new Promise(r=>setTimeout(r,100));}}
async function idle(page){await until(async()=>!(await state(page)).busy,'Backend did not become idle');await page.waitForFunction(()=>document.querySelector('#activity-message').textContent==='Ready');}
async function launch(name){
 const app=await electron.launch({...desktopArtifactLaunch(project,path.join(root,name),packaged),env});apps.push(app);
 const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.bringToFront();
 await page.waitForFunction(()=>document.querySelector('#app-version')?.textContent?.match(/^v\d+\.\d+\.\d+/));await dismissInitialSetup(page);await idle(page);
 if(packaged){
  const expected=JSON.parse(await readFile(path.join(project,'package.json'),'utf8')).version;
  const metadata=JSON.parse(await readFile(path.join(path.dirname(packaged),'resources','app','package.json'),'utf8'));
  assert.equal(metadata.version,expected,'Bundled package version must match the release source');
  assert.equal(await app.evaluate(({app})=>app.getVersion()),expected);
  assert.equal((await state(page)).version,expected,'State must identify the packaged version');
  assert.equal((await page.evaluate(()=>window.seedhost.call('updateStatus'))).current,expected,'Updater must use the packaged version');
  await page.waitForFunction(v=>document.querySelector('#app-version')?.textContent===`v${v} · alpha`,expected);
  console.log('PACKAGED_VERSION_MATCH='+expected+' (metadata, Electron, IPC, footer, updater)');
 }
 await app.evaluate(({dialog,shell},realFolder)=>{
  globalThis.__messages=[];globalThis.__folderPaths=[];globalThis.__deleteAnswer=0;globalThis.__nativePick=null;
  dialog.showOpenDialog=async()=>({canceled:!globalThis.__nativePick,filePaths:globalThis.__nativePick?[globalThis.__nativePick]:[]});
  dialog.showMessageBox=async(...args)=>{const o=args.at(-1);globalThis.__messages.push(o);if(o.buttons?.[1]!=='Delete server')throw Error('Unexpected native confirmation: '+o.message);return{response:globalThis.__deleteAnswer};};
  const original=shell.openPath;shell.openPath=async folder=>{globalThis.__folderPaths.push(folder);return realFolder?original(folder):'';};
 },realFolder);return{app,page};
}
async function action(page,selector){await page.bringToFront();await reveal(page,selector);await page.locator(selector).click();}
async function advanced(page){await page.bringToFront();await page.locator('#home-tab').click();await page.locator('#settings-tab').click();if(!await page.locator('#advanced-peers').evaluate(e=>e.open))await page.locator('#advanced-peers > summary').click();}
async function trust(page,name,s){
 await advanced(page);if(!await page.locator('#add-peer-details').evaluate(e=>e.open))await page.locator('#add-peer-details > summary').click();
 await page.locator('#peer-name').fill(name);await page.locator('#peer-fingerprint').fill(s.deviceId);await page.locator('#peer-host').fill(s.peerEndpoint.host);await page.locator('#peer-port').fill(String(s.peerEndpoint.port));await page.locator('#add-peer').click();await idle(page);
 assert.ok((await state(page)).peers.some(p=>p.fingerprint===s.deviceId&&p.port===s.peerEndpoint.port));
}
async function profile(page){
 await openSelectedServer(page);await reveal(page,'#java-executable');if(!await page.locator('#profile-details').evaluate(e=>e.open))await page.locator('#profile-details > summary').click();
 await page.locator('#java-executable').fill(process.execPath);await page.locator('#java-args').fill(JSON.stringify([path.join(project,'tools/fake-java-server.mjs')]));await page.locator('#save-profile').click();await idle(page);
}
async function ownership(page,expected){await until(async()=>(await state(page)).server?.ownership?.state===expected,'Ownership did not become '+expected);await idle(page);}
async function pendingConsent(){
 await until(async()=>Boolean((await state(pb)).incomingHandoff),'Incoming consent missing');await pb.bringToFront();await pb.locator('#incoming-handoff').waitFor();const s=await state(pb);assert.equal(s.busy,'receiveSnapshot');
 assert.equal(await pb.locator('#incoming-handoff-accept').isEnabled(),true);assert.equal(await pb.locator('#incoming-handoff-decline').isEnabled(),true);return s.incomingHandoff;
}
async function closedPort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
try{
 console.log('STEP 1 launch two visible isolated apps; TARGET='+(packaged??'current development Electron'));
 const a=await launch('a');pa=a.page;const b=await launch('b');pb=b.page;
 const source=path.join(root,'Disposable fixture - NOT Minecraft');await mkdir(source);await writeFile(path.join(source,'eula.txt'),'eula=true\n');await writeFile(path.join(source,'world.bin'),'original');
 console.log('STEP 2 cancelled import mutates nothing; import via labelled stopped-source native picker');
 await action(pa,'#import-server');await idle(pa);assert.equal((await state(pa)).server,null);
 await a.app.evaluate((_e,p)=>{globalThis.__nativePick=p;},source);await action(pa,'#import-server');await until(async()=>Boolean((await state(pa)).server),'Import did not publish');await idle(pa);
 const imported=(await state(pa)).server;assert.equal(await readFile(path.join(imported.serverDir,'world.bin'),'utf8'),'original');
 await pa.locator('#home-tab').click();assert.equal(await pa.locator('button[data-action="open"]').count(),0);const card=pa.locator('.server-row');await card.focus();await card.press('Enter');await pa.waitForFunction(()=>!document.querySelector('#operate-panel').hidden);
 console.log('STEP 3 folder opens exact managed path; visible Mods options and optional guide');
 await pa.locator('#server-files-tab').click();await pa.waitForFunction(()=>document.querySelector('#file-feedback').textContent.startsWith('Opened'));assert.deepEqual(await a.app.evaluate(()=>globalThis.__folderPaths),[imported.serverDir]);
 await assert.rejects(pa.evaluate(id=>window.seedhost.call('openServerFolder',{id,path:'C:/arbitrary'}),imported.id),/Invalid server id/);
 await pa.locator('#mods-tab').click();assert.equal(await pa.locator('#mods-details').evaluate(e=>e.tagName),'SECTION');assert.equal(await pa.locator('#mods-details select:visible').count(),0);
 for(const id of ['mod-query','server-mods','client-mods'])assert.equal(await pa.locator('#'+id).isVisible(),true);
 await pa.locator('#nav-setup').click();assert.equal(await pa.locator('[data-setup-step="gateway"]').count(),0);await pa.locator('#setup-later').click();await idle(pa);await pa.screenshot({path:path.join(root,'expanded-mods.png')});await profile(pa);
 console.log('STEP 4 pinned loopback listeners/trust; replication grants no ownership');
 await advanced(pa);await pa.locator('#start-listener').click();await idle(pa);await pb.evaluate(()=>window.seedhost.call('startPeerListener'));await idle(pb);
 const sa=await state(pa),sb=await state(pb);assert.equal(sa.peerEndpoint.host,'127.0.0.1');assert.equal(sb.peerEndpoint.host,'127.0.0.1');await trust(pa,'B',sb);await pb.evaluate(s=>window.seedhost.call('addPeer',{name:'A',fingerprint:s.deviceId,...s.peerEndpoint}),sa);await idle(pb);
 await advanced(pa);await pa.locator('[data-method="sendSnapshot"]').click();await idle(pa);await idle(pb);assert.equal((await state(pb)).server,null);assert.equal(await pa.locator('#send-dialog').count(),0);
 console.log('STEP 5 busy receive waits for explicit inline decline; wrong request id refused');
 await pa.locator('[data-method="handoff"]').click();const offer=await pendingConsent();assert.equal((await state(pb)).server,null);
 await assert.rejects(pb.evaluate(()=>window.seedhost.call('respondIncomingHandoff',{id:'12345678-1234-4234-8234-123456789abc',accepted:true})),/changed|pending/);assert.equal((await state(pb)).incomingHandoff.id,offer.id);
 await pb.locator('#incoming-handoff-decline').click();await ownership(pa,'owned');await idle(pb);assert.equal((await state(pb)).server,null);
 console.log('STEP 6 unreachable recipient fences source; corrected endpoint retries SAME offer, accepted inline');
 await trust(pa,'B',{...sb,peerEndpoint:{host:'127.0.0.1',port:await closedPort()}});await pa.locator('[data-method="handoff"]').click();await ownership(pa,'offered');const pending=(await state(pa)).server.ownership.offer;
 await trust(pa,'B',sb);await pa.locator('[data-method="handoff"]').click();await pendingConsent();await pb.locator('#incoming-handoff-accept').click();await ownership(pa,'transferred');await ownership(pb,'owned');
 const received=(await state(pb)).server;assert.equal(received.ownership.acceptedOfferId,pending.id);assert.equal(received.profile.executable,'');assert.equal(await readFile(path.join(received.serverDir,'world.bin'),'utf8'),'original');
 console.log('STEP 7 explicit fixture Start/clean Stop, then B to A with inline acceptance');
 await profile(pb);await action(pb,'#start-server');await until(async()=>(await state(pb)).server?.state==='running','Fixture process did not start');await idle(pb);await action(pb,'#stop-server');await ownership(pb,'owned');
 await advanced(pb);await pb.locator('[data-method="handoff"]').click();await until(async()=>Boolean((await state(pa)).incomingHandoff),'Return consent missing');await pa.bringToFront();await pa.locator('#incoming-handoff-accept').click();await ownership(pa,'owned');await ownership(pb,'transferred');
 assert.equal((await state(pa)).server.ownership.generation,2);assert.equal(await readFile(path.join(source,'world.bin'),'utf8'),'original');
 await action(pa,'#clean-up');await idle(pa);assert.equal(await readFile(path.join((await state(pa)).server.serverDir,'world.bin'),'utf8'),'original');
 console.log('STEP 8 cancelled Delete is the only native confirmation; local/source data retained');
 await pa.locator('#home-tab').click();await pa.locator('.is-current button[data-action="delete"]').click();await idle(pa);assert.equal((await state(pa)).servers.length,1);assert.equal(await pa.locator('#home-panel').isVisible(),true);
 const messages=await a.app.evaluate(()=>globalThis.__messages);assert.equal(messages.length,1);assert.equal(messages[0].defaultId,0);assert.equal(messages[0].cancelId,0);assert.deepEqual(messages[0].buttons,['Cancel','Delete server']);assert.deepEqual(await b.app.evaluate(()=>globalThis.__messages),[]);
 assert.deepEqual(errors,[]);await pa.locator('.server-row').focus();await pa.evaluate(()=>{window.__heldCard=document.activeElement;});await pa.screenshot({path:path.join(root,'handoff-complete-home.png')});
 console.log('PASS real isolated desktop UX and pinned TLS A to B to A; no Minecraft/WAN/provider allocation claim');
 for(let remaining=hold;remaining>0;remaining-=Math.min(30,remaining)){console.log('VISIBLE HOLD '+remaining+'s');await new Promise(r=>setTimeout(r,Math.min(30,remaining)*1000));}
 assert.equal(await pa.evaluate(()=>document.activeElement===window.__heldCard&&window.__heldCard.isConnected),true,'Home polling retains card focus across final hold');passed=true;
 await writeFile(path.join(root,'result.json'),JSON.stringify({passed,packaged:packaged??null,realFolder,hold,sourceUnchanged:true,errors},null,2));
}catch(error){console.error('FAIL',error);process.exitCode=1;for(const [name,page]of[['a',pa],['b',pb]])if(page&&!page.isClosed()){console.error(name+' STATE',await state(page).then(s=>({busy:s.busy,serverState:s.server?.state,ownership:s.server?.ownership?.state,incoming:Boolean(s.incomingHandoff)})).catch(()=>null));console.error(name+' BANNER',await page.locator('#error-text').textContent().catch(()=>null));await page.screenshot({path:path.join(root,name+'-failed.png')}).catch(()=>{});}}
finally{for(const app of apps){console.log('CLEANUP '+app.process().pid);let timer;try{await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('bounded close expired')),15000);})]);}catch(error){console.error('CLEANUP fallback',error.message);await app.evaluate(({app})=>app.exit(0)).catch(()=>{});}finally{clearTimeout(timer);}}console.log('CLEANUP complete');console.log('ARTIFACT_DIR='+root);console.log('RESULT='+String(passed));}
