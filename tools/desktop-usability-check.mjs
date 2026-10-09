// Visible real main/preload/core QA for the three usability tweaks.
// ONLY native dialog answers are substituted. Sources/process are disposable, NOT Minecraft.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:net';
import {createServer as httpServer} from 'node:http';
import {createRequire} from 'node:module';
import {_electron as electron} from 'playwright';
import {reveal,openSelectedServer} from './desktop-test-setup.mjs';

const flag=name=>process.argv.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3);
const executable=flag('executable');
const holdSeconds=Number(flag('hold')??90);
assert.ok(process.env.TMPDIR,'Hermes scratch TMPDIR is required');
assert.ok(Number.isFinite(holdSeconds)&&holdSeconds>=0&&holdSeconds<=180);
const root=await mkdtemp(path.join(process.env.TMPDIR,'seedhost-usability-'));
const profile=path.join(root,'profile');
const errors=[],steps=[];
let app,page;
const sockets=new Set();
const rejecting=createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));socket.destroy();});
await new Promise(resolve=>rejecting.listen(0,'127.0.0.1',resolve));
const updates=httpServer((_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end('[]');});
await new Promise(resolve=>updates.listen(0,'127.0.0.1',resolve));
const env={...process.env,SEEDHOST_TEST_LOOPBACK:'1',SEEDHOST_UPDATE_ORIGIN:`http://127.0.0.1:${updates.address().port}`};
delete env.ELECTRON_RUN_AS_NODE;delete env.SEEDHOST_ACCOUNT_SERVICE;
const note=text=>{steps.push(text);console.log('STEP '+text);};
const wait=(fn,arg)=>page.waitForFunction(fn,arg,{timeout:45000});
const settled=()=>wait(()=>document.querySelector('#activity-message').textContent.startsWith('Ready'));
const state=()=>page.evaluate(()=>window.seedhost.call('getState'));
const shot=async name=>{await page.bringToFront();await page.screenshot({path:path.join(root,name+'.png'),animations:'disabled'});console.log('SCREENSHOT='+path.join(root,name+'.png'));};
async function click(selector){await page.bringToFront();await page.locator(selector).click();await settled();}
async function launch(){
 app=await electron.launch({executablePath:executable||createRequire(import.meta.url)('electron'),args:[...(executable?[]:[path.resolve('dist/apps/desktop/main.js')]),'--profile-root='+profile],env});
 page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await page.bringToFront();await settled();
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setFullScreen(false);w.setContentSize(1240,860);});
 await page.context().newCDPSession(page).then(cdp=>cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true}));
}
async function native(folder=null,{hold=false,cancel=false}={}){
 await app.evaluate(({dialog},{folder,hold,cancel})=>{
  globalThis.__nativePending=false;globalThis.__nativeRelease=null;
  dialog.showMessageBox=async()=>({response:1});
  dialog.showOpenDialog=async()=>{
   if(hold)await new Promise(resolve=>{globalThis.__nativePending=true;globalThis.__nativeRelease=()=>{globalThis.__nativePending=false;resolve();};});
   return cancel?{canceled:true,filePaths:[]}:{canceled:false,filePaths:[folder]};
  };
 },{folder,hold,cancel});
}
async function heldImport(selector,folder,cancel=false){
 await native(folder,{hold:true,cancel});await page.bringToFront();await page.locator(selector).click();
 try{
  assert.equal(await app.evaluate(()=>globalThis.__nativePending),true);
  const status=selector==='#setup-import'?'#setup-dialog [data-loading-context="dialog"]':'#action-loading';
  await page.locator(status).waitFor({state:'visible'});
  assert.equal(await page.locator(status).getAttribute('role'),'status');
  assert.notEqual(await page.locator(status+' .loading-spinner').evaluate(el=>getComputedStyle(el).animationName),'none');
  // Keep the real animation in the evidence instead of screenshotting with animations disabled.
  await page.screenshot({path:path.join(root,cancel?'loading-cancel.png':'loading-import.png')});
 }finally{await app.evaluate(()=>globalThis.__nativeRelease?.());}
 await settled();
}
async function source(name){
 const dir=path.join(root,name);await mkdir(dir);await writeFile(path.join(dir,'eula.txt'),'eula=true\n');await writeFile(path.join(dir,'world-marker.txt'),name+'\n');
 await writeFile(path.join(dir,'server.properties'),`server-port=${rejecting.address().port}\nserver-ip=127.0.0.1\nonline-mode=false\n`);return dir;
}
async function select(id){await click('#home-tab');await click(`#server-list [data-action="open"][data-id="${id}"]`);await wait(id=>document.querySelector('#server-list .is-current button')?.dataset.id===id,id);}
let result={passed:false,executable:executable??'development Electron',root,profile,steps,errors};
try{
 note('Launch isolated real app; dismiss first-run guide through Save for later');await launch();await wait(()=>document.querySelector('#setup-dialog').open);await click('#setup-later');await wait(()=>!document.querySelector('#setup-dialog').open);
 const alphaSource=await source('Alpha disposable world');const betaSource=await source('Beta disposable world');
 note('Hold only native import response; observe animated status, then real copy/adoption');await heldImport('#import-server',alphaSource);await wait(()=>document.querySelectorAll('#server-list .server-row').length===1);
 let s=await state();const alphaId=s.server.id;assert.equal(s.gateway.enabled,false);assert.equal(s.settings.persistentAddress,false);
 await wait(()=>document.querySelector('#action-loading').hidden);
 // Actual OS memory sample, not a forged dashboard result. Stop protocol only; no game or socket implementation.
 assert.ok(os.freemem()>4*1024**3,'At least 4 GiB available required for the bounded 1100-MiB process fixture');
 const memoryFixture=path.join(root,'memory-process-fixture.mjs');
 await writeFile(memoryFixture,"// NOT Java or Minecraft. Disposable process/sampling fixture.\nimport{createInterface}from'node:readline';\nconst memory=Buffer.alloc(1100*1024*1024,1);\nconst life=setTimeout(()=>process.exit(0),180000);\nconsole.log('Done (memory process fixture)!');\nconst input=createInterface({input:process.stdin});\ninput.on('line',line=>{if(line==='stop'){clearTimeout(life);console.log('fixture stopping '+memory[0]);process.exit(0);}});\n");
 await openSelectedServer(page);await reveal(page,'#java-executable');await page.locator('#profile-details').evaluate(el=>el.open=true);
 await page.locator('#java-executable').fill(process.execPath);await page.locator('#java-args').fill(JSON.stringify([memoryFixture]));await click('#save-profile');
 note('Complete Alpha guide through explicit optional-step skips');await click('#nav-setup');await click('[data-setup-step="friends"]');await click('#setup-skip');await click('#setup-skip');await click('#setup-next');await wait(()=>!document.querySelector('#setup-dialog').open);
 const alphaGuide=(await state()).onboarding;assert.equal(alphaGuide.completed,true);assert.deepEqual(alphaGuide.skipped,['friends','gateway']);
 note('New server starts fresh despite completed selected world; save independent named draft');await click('#home-tab');await click('#add-server');
 assert.equal(await page.locator('#setup-existing').isHidden(),true);assert.equal(await page.locator('#setup-name').inputValue(),'My Minecraft server');assert.equal(await page.locator('[data-setup-step="server"]').getAttribute('data-done'),'false');
 await page.locator('#setup-name').fill('Next scratch world');await shot('new-server-fresh-guide');await click('#setup-save-close');await wait(()=>!document.querySelector('#setup-dialog').open);
 s=await state();assert.deepEqual(s.onboarding,alphaGuide);assert.equal(s.newServerOnboarding.draft.name,'Next scratch world');assert.equal(s.newServerOnboarding.completed,false);
 note('Real close/reopen keeps selected-world and new-world progress independent');await app.close();app=null;await launch();s=await state();assert.equal(s.server.id,alphaId);assert.deepEqual(s.onboarding,alphaGuide);assert.equal(s.newServerOnboarding.draft.name,'Next scratch world');
 await click('#add-server');assert.equal(await page.locator('#setup-name').inputValue(),'Next scratch world');await click('#setup-back');
 note('Cancelling the guide import dialog stays quiet and changes nothing');const beforeGuideCancel=await state();await heldImport('#setup-import',null,true);assert.equal(await page.locator('#error-banner').isHidden(),true,'cancelled guide import must not show a failure banner');assert.equal(await page.locator('#setup-error').isHidden(),true,'cancelled guide import must not show the setup error line');assert.equal(await page.evaluate(()=>document.querySelector('#setup-dialog').open),true,'the guide must stay open after Cancel');const afterGuideCancel=await state();assert.deepEqual(afterGuideCancel.servers,beforeGuideCancel.servers);assert.deepEqual(afterGuideCancel.onboarding,beforeGuideCancel.onboarding);assert.deepEqual(afterGuideCancel.newServerOnboarding,beforeGuideCancel.newServerOnboarding);
 await native(betaSource);await click('#setup-import');await wait(()=>!document.querySelector('#setup-runtime').hidden);
 s=await state();const betaId=s.server.id;assert.notEqual(betaId,alphaId);assert.equal(s.servers.length,2);assert.equal(s.onboarding.draft.name,'Next scratch world');assert.equal(s.onboarding.completed,false);assert.equal(s.newServerOnboarding.draft.name,'My Minecraft server');
 await shot('beta-own-guide');await click('#setup-save-close');await wait(()=>!document.querySelector('#setup-dialog').open);const betaGuide=(await state()).onboarding;
 note('A-B-A selection and another real reopen retain each server guide');await select(alphaId);assert.deepEqual((await state()).onboarding,alphaGuide);await select(betaId);assert.deepEqual((await state()).onboarding,betaGuide);await select(alphaId);await app.close();app=null;await launch();assert.deepEqual((await state()).onboarding,alphaGuide);
 note('Start disposable memory process; observe actual sampled GiB in packaged Performance');await openSelectedServer(page);await click('#start-server');await wait(()=>document.querySelector('#server-status').textContent==='Hosting');await click('#operate-tab');await wait(()=>/ GiB$/.test(document.querySelector('#performance-memory').textContent));
 const sampled=await page.evaluate(async()=>{const s=await window.seedhost.call('getState');return window.seedhost.call('getServerDashboard',{id:s.server.id});});
 assert.ok(sampled.performance.memoryMiB>=1024);const shown=await page.locator('#performance-memory').textContent();assert.match(shown,/^\d+(?:\.\d)? GiB$/);result.memory={actualSampleMiB:sampled.performance.memoryMiB,displayed:shown,fixture:'NOT Minecraft: 1100-MiB Node process'};await shot('performance-real-gib');await click('#stop-server');await wait(()=>document.querySelector('#server-status').textContent==='Stopped');
 note('Held native cancellation clears loading without changing library or either server guide');await click('#home-tab');const beforeCancel=await state();await heldImport('#import-server',null,true);await wait(()=>document.querySelector('#action-loading').hidden);const afterCancel=await state();assert.deepEqual(afterCancel.servers,beforeCancel.servers);assert.deepEqual(afterCancel.onboarding,beforeCancel.onboarding);assert.deepEqual(afterCancel.newServerOnboarding,beforeCancel.newServerOnboarding);
 await select(betaId);assert.deepEqual((await state()).onboarding,betaGuide);await click('#nav-setup');await shot('final-beta-independent-guide');
 for(const [dir,name] of [[alphaSource,'Alpha disposable world'],[betaSource,'Beta disposable world']])assert.equal(await readFile(path.join(dir,'world-marker.txt'),'utf8'),name+'\n');
 assert.deepEqual(errors,[]);result.passed=true;console.log('PASS real main/preload/core: animated import/cancel cleanup, completed-world vs new-draft isolation, verified guide import binding, A-B-A/reopen, actual GiB process samples, untouched disposable sources. NOT Minecraft or cross-PC proof.');
 for(let left=holdSeconds;left>0;left-=15){console.log('VISIBLE_INSPECTION_SECONDS='+left);await page.bringToFront();await new Promise(resolve=>setTimeout(resolve,Math.min(15,left)*1000));}
}catch(error){result.failure=String(error.stack||error);console.error('FAIL',error);process.exitCode=1;if(page&&!page.isClosed()){result.uiError=await page.locator('#error-text').textContent().catch(()=>null);await shot('failure').catch(()=>{});}}
finally{
 if(app){await app.evaluate(()=>globalThis.__nativeRelease?.()).catch(()=>{});await app.close().catch(error=>{result.closeError=String(error);result.passed=false;process.exitCode=1;});}
 for(const socket of sockets)socket.destroy();await new Promise(resolve=>rejecting.close(resolve));await new Promise(resolve=>updates.close(resolve));
 await writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2));console.log('ARTIFACT_DIR='+root);
}
