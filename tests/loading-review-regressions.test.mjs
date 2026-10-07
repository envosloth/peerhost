// TEST-ONLY deterministic renderer contracts for independent-review findings.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {_electron as electron} from 'playwright';
let app,page;const errors=[];
before(async()=>{
 assert.ok(process.env.TMPDIR);const root=await mkdtemp(path.join(process.env.TMPDIR,'seed-loading-review-'));const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:[path.resolve('tools/dashboard-fixture-main.cjs'),'--profile-root='+root],env});
 page=await app.firstWindow();page.setDefaultTimeout(9000);page.on('pageerror',e=>errors.push(e.message));
});
after(async()=>{if(app){app.process().kill();await app.close().catch(()=>{});}assert.deepEqual(errors,[]);});
const settle=()=>page.waitForFunction(()=>document.querySelector('#activity-message').textContent==='Ready');
const click=async selector=>{await page.bringToFront();await page.locator(selector).click();};
async function reset(){await page.bringToFront();await page.evaluate(()=>window.dashboardFixture.reset());await page.reload();await page.waitForFunction(()=>document.querySelector('#splash').hidden);await page.waitForFunction(()=>document.querySelector('#action-loading').hidden);}
async function set(value){await page.evaluate(v=>window.dashboardFixture.set(v),value);await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await settle();}
const pending=method=>page.waitForFunction(method=>window.dashboardFixture.read().heldCalls?.[method],method);
async function release(method){await page.evaluate(method=>{window.dashboardFixture.set({holdCalls:[]});window.dashboardFixture.releaseCall(method);},method);}

test('background relay check stays quiet while explicit relay check animates',async()=>{
 const source=await readFile(new URL('../apps/desktop/renderer.js',import.meta.url),'utf8');
 const fn=source.match(/async function checkRelay\([\s\S]*?(?=  \$\('check-relay'\))/)?.[0];assert.ok(fn);
 const run=new(Object.getPrototypeOf(async function(){}).constructor)('foreground',`let labels=[];const state={relay:{fingerprint:'fixture'}},bridgeReady=true;let relayRequest=0,relayStatus,relayStatusError;const syncRelayContext=()=> 'fixture';const errorMessage=e=>e.message;const render=()=>{};const window={seedhost:{call:async()=>({})}};const trackedCall=async()=>{labels.push('tracked');return {};};${fn};await checkRelay(foreground);return labels;`);
 assert.deepEqual(await run(false),[],'automatic/startup checks cannot animate foreground status');assert.deepEqual(await run(true),['tracked']);
});

test('slow setup metadata preserves side-by-side guide layout and visible navigation',async()=>{
 await reset();await page.evaluate(()=>window.dashboardFixture.set({holdCalls:['listServerVersions','discoverJava']}));
 try{
  await click('#nav-setup');await pending('listServerVersions');
  for(const [width,height]of [[1000,700],[1240,860]]){
   await app.evaluate(({BrowserWindow},{width,height})=>{const w=BrowserWindow.getAllWindows()[0];w.setFullScreen(false);w.setContentSize(width,height);},{width,height});
   const geometry=await page.evaluate(()=>{const rail=document.querySelector('.setup-rail').getBoundingClientRect(),main=document.querySelector('.setup-main').getBoundingClientRect(),footer=document.querySelector('.setup-footer').getBoundingClientRect();return{topDelta:Math.abs(rail.top-main.top),sideBySide:main.left>=rail.right-1,footerVisible:footer.bottom<=innerHeight&&footer.top>=0,mainWidth:main.width};});
   assert.ok(geometry.topDelta<=1,'loading must not place content in a second grid row');assert.equal(geometry.sideBySide,true);assert.equal(geometry.footerVisible,true);assert.ok(geometry.mainWidth>500);
   await page.screenshot({path:process.env.TMPDIR+'/seed-loading-guide-layout-'+width+'.png'});
  }
 }finally{await release('listServerVersions');await release('discoverJava');}
 await page.waitForFunction(()=>document.querySelector('#action-loading').hidden);
});

test('authentication shows modal animation and cleans up after rejection',async()=>{
 await reset();await set({accountStatus:{configured:true,signedIn:false,online:true,username:null,detail:'Sign in'},holdCalls:['accountRegister'],fail:'accountRegister'});
 await page.evaluate(()=>window.dispatchEvent(new Event('seedhost-account-changed')));await page.waitForFunction(()=>document.querySelector('#account-dialog').open);
 await page.locator('#account-username').fill('fixture_user');
 // Synthetic password exists only in the TEST-ONLY bridge; not a real account credential.
 await page.locator('#account-password').fill('fixture-only-password');
 try{await click('#account-submit');await pending('accountRegister');assert.equal(await page.locator('#account-dialog [data-loading-context="dialog"]').isVisible(),true);}
 finally{await release('accountRegister');}
 await page.waitForFunction(()=>!document.querySelector('#account-error').hidden);await page.waitForFunction(()=>document.querySelector('#action-loading').hidden);
});

test('profile save animates through account readback and rejection cleanup',async()=>{
 await reset();await set({accountStatus:{configured:true,signedIn:true,online:true,username:'alex',detail:'Signed in'},holdCalls:['accountUpdateProfile']});await page.evaluate(()=>window.dispatchEvent(new Event('seedhost-account-changed')));
 await click('#profile-open');await page.locator('#profile-username').fill('alex_new');await page.locator('#profile-current-password').fill('fixture-only-password');
 try{await click('#profile-save');await pending('accountUpdateProfile');assert.equal(await page.locator('#profile-dialog [data-loading-context="dialog"]').isVisible(),true);}
 finally{await release('accountUpdateProfile');}
 await page.waitForFunction(()=>document.querySelector('#account-profile-feedback').textContent.includes('confirmed'));await page.waitForFunction(()=>document.querySelector('#action-loading').hidden);
});

test('manual group-member refresh animates while automatic member reads remain quiet',async()=>{
 await reset();const f=await page.evaluate(()=>window.dashboardFixture.read());f.state.relay={name:'Fixture group',fingerprint:'c'.repeat(64),parkOnStop:false};
 await set({state:f.state});await click('#server-list [data-action="open"][data-id="alpha"]');await click('#peers-tab');await page.waitForFunction(()=>!document.querySelector('#refresh-friends').disabled);
 await page.evaluate(()=>window.dashboardFixture.set({holdCalls:['listFriends']}));
 try{await click('#refresh-friends');await pending('listFriends');assert.equal(await page.locator('#action-loading').isVisible(),true);}
 finally{await release('listFriends');}
 await page.waitForFunction(()=>document.querySelector('#action-loading').hidden);
 await page.evaluate(()=>{window.dashboardFixture.set({holdCalls:['listFriends']});window.dispatchEvent(new Event('seedhost-account-changed'));});
 try{await pending('listFriends');assert.equal(await page.locator('#action-loading').isHidden(),true,'account-change member read is background');}
 finally{await release('listFriends');}
});

test('automatic backup refresh stays quiet but explicit backup refresh animates',async()=>{
 await reset();const f=await page.evaluate(()=>window.dashboardFixture.read());f.state.server.snapshotId='changed-backup';
 await page.evaluate(f=>window.dashboardFixture.set({state:f.state,holdCalls:['listSnapshots']}),f);await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
 try{await pending('listSnapshots');assert.equal(await page.locator('#action-loading').isHidden(),true,'state-poll history reads are background');}
 finally{await release('listSnapshots');}
 await click('#server-list [data-action="open"][data-id="alpha"]');await click('#backups-tab');await page.waitForFunction(()=>!document.querySelector('#refresh-snapshots').disabled);
 await page.evaluate(()=>window.dashboardFixture.set({holdCalls:['listSnapshots']}));
 try{await click('#refresh-snapshots');await pending('listSnapshots');assert.equal(await page.locator('#action-loading').isVisible(),true);}
 finally{await release('listSnapshots');}
});
