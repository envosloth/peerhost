import assert from 'node:assert/strict';
import { dismissInitialSetup, reveal } from './desktop-test-setup.mjs';
import { mkdir,mkdtemp,writeFile,readFile } from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:net';
import {_electron as electron} from 'playwright';
import {createRequire} from 'node:module';
const electronPath=createRequire(import.meta.url)('electron');
const linuxKeyring=process.platform==='linux'?['--password-store=gnome-libsecret']:[];
const project=process.cwd();await mkdir('.test-data',{recursive:true});const root=await mkdtemp(path.resolve('.test-data/desktop-handoff-'));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const packaged=process.argv.find(v=>v.startsWith('--packaged='))?.slice('--packaged='.length);
async function launch(name){return electron.launch({executablePath:packaged||electronPath,args:packaged?[...linuxKeyring,'--profile-root='+path.join(root,name)]:[...linuxKeyring,path.join(project,'dist/apps/desktop/main.js'),'--profile-root='+path.join(root,name)],env});}
let a,b,pa,pb;const errors=[];
// page.waitForFunction treats an async predicate's Promise as truthy, so poll from Node instead.
async function idle(page){const deadline=Date.now()+30000;while((await page.evaluate(()=>window.peerhost.call('getState'))).busy){if(Date.now()>deadline)throw new Error('Timed out waiting for idle');await new Promise(r=>setTimeout(r,100));}}
async function action(page,selector){await page.bringToFront();await page.locator('#advanced-peers').evaluate(el=>el.open=true);await reveal(page,selector);await page.locator(selector).click();}
async function trust(page,name,state){await page.bringToFront();await page.locator('#advanced-peers').evaluate(el=>el.open=true);await page.locator('#add-peer-details').evaluate(el=>el.open=true);await reveal(page,'#peer-name');await page.locator('#peer-name').fill(name);await page.locator('#peer-fingerprint').fill(state.deviceId);await page.locator('#peer-host').fill(state.peerEndpoint.host);await page.locator('#peer-port').fill(String(state.peerEndpoint.port));await action(page,'#add-peer');await idle(page);await page.waitForFunction(()=>document.querySelector('#peer-count').textContent==='1 SAVED');}
async function closedPort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const {port}=server.address();await new Promise(r=>server.close(r));return port;}
async function ownership(page,text){await page.waitForFunction(text=>document.querySelector('#ownership-state').textContent.includes(text),text);}
async function profile(page){await page.bringToFront();await reveal(page,'#java-executable');await page.locator('#profile-details').evaluate(el=>el.open=true);await page.locator('#java-executable').fill(process.execPath);await page.locator('#java-args').fill(JSON.stringify([path.join(project,'tools/fake-java-server.mjs')]));assert.equal(await page.locator('#start-timeout').inputValue(),'600','modpack-friendly start timeout is the default');await action(page,'#save-profile');await page.waitForFunction(()=>!document.querySelector('#start-server').disabled);}
try{
  console.log('STEP 1: Launch TWO visible Electron instances with isolated profiles.');a=await launch('a');b=await launch('b');pa=await a.firstWindow();pb=await b.firstWindow();
  for(const p of [pa,pb]){p.on('pageerror',e=>errors.push(String(e)));await p.waitForFunction(()=>document.querySelector('#app-version').textContent.includes('v0.2.1'));}
  await dismissInitialSetup(pa);await dismissInitialSetup(pb);
  const source=path.join(root,'Disposable fixture - NOT Minecraft');await mkdir(source);await writeFile(path.join(source,'eula.txt'),'eula=true\n');await writeFile(path.join(source,'world.bin'),'original');
  await a.evaluate(({dialog},source)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]});dialog.showMessageBox=async()=>({response:1});},source);await b.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});});
  console.log('STEP 2: Import A through its visible control. Start real pinned loopback listeners and pair via visible peer forms.');
  await action(pa,'#import-server');await pa.waitForFunction(()=>document.querySelector('#server-name').textContent.includes('NOT Minecraft'));await profile(pa);
  await action(pa,'#start-listener');await action(pb,'#start-listener');await idle(pa);await idle(pb);
  const sa=await pa.evaluate(()=>window.peerhost.call('getState')),sb=await pb.evaluate(()=>window.peerhost.call('getState'));
  await trust(pa,'B',sb);await trust(pb,'A',sa);
  assert.equal(await pa.locator('[data-method="handoff"]').count(),1,'the UI must expose real handoff, not just replication');
  console.log('STEP 3: Send snapshot through visible confirmation dialog; B must NOT gain a server or authority.');
  await action(pa,'[data-method="sendSnapshot"]');await action(pa,'#confirm-send');await idle(pa);assert.equal((await pb.evaluate(()=>window.peerhost.call('getState'))).server,null);
  console.log('STEP 4: B declines through its native dialog; A must get ownership back and be able to host.');
  await b.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:0});});
  await action(pa,'[data-method="handoff"]');await action(pa,'#confirm-send');
  await pa.waitForFunction(()=>!document.querySelector('#error-banner').hidden&&document.querySelector('#error-text').textContent.includes('declined'));
  await ownership(pa,'owned');await idle(pa);await idle(pb);assert.equal(await pa.locator('#start-server').isDisabled(),false,'decline restores hosting');
  assert.equal((await pb.evaluate(()=>window.peerhost.call('getState'))).server,null);
  await b.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});});
  console.log('STEP 5: B unreachable: A stays fenced and offers Retry; after fixing the endpoint, Retry completes the SAME offer.');
  await trust(pa,'B',{...sb,peerEndpoint:{host:'127.0.0.1',port:await closedPort()}});
  await action(pa,'[data-method="handoff"]');await action(pa,'#confirm-send');
  await pa.waitForFunction(()=>!document.querySelector('#error-banner').hidden&&/retry/i.test(document.querySelector('#error-text').textContent));
  await ownership(pa,'offered');await idle(pa);
  assert.equal(await pa.locator('#start-server').isDisabled(),true,'an unanswered offer keeps the source fenced');
  assert.equal(await pa.locator('[data-method="handoff"]').textContent(),'Retry handoff');
  const pendingOffer=(await pa.evaluate(()=>window.peerhost.call('getState'))).server.ownership.offer;
  await pa.screenshot({path:path.join(root,'A-retry-pending.png')});
  await trust(pa,'B',sb);
  await action(pa,'[data-method="handoff"]');await action(pa,'#confirm-send');
  await ownership(pa,'transferred');await ownership(pb,'owned');await idle(pb);
  assert.equal((await pb.evaluate(()=>window.peerhost.call('getState'))).server.ownership.acceptedOfferId,pendingOffer.id,'retry delivered the original offer');
  assert.equal(await pa.locator('#start-server').isDisabled(),true);assert.equal(await pb.locator('#java-executable').inputValue(),'');
  const received=await pb.evaluate(()=>window.peerhost.call('getState'));assert.equal(await readFile(path.join(received.server.serverDir,'world.bin'),'utf8'),'original');
  await profile(pb);await action(pb,'#start-server');await pb.waitForFunction(()=>document.querySelector('#server-status').textContent==='Hosting');await pb.screenshot({path:path.join(root,'B-hosting-fixture.png')});await action(pb,'#stop-server');await pb.waitForFunction(()=>document.querySelector('#ownership-state').textContent.includes('owned'));await idle(pb);
  console.log('STEP 6: Handoff back. Verify durable counters and retained source bytes.');
  await action(pb,'[data-method="handoff"]');await action(pb,'#confirm-send');await pa.waitForFunction(()=>document.querySelector('#ownership-state').textContent.includes('owned'));await idle(pa);
  const returned=await pa.evaluate(()=>window.peerhost.call('getState'));assert.equal(returned.server.ownership.generation,2);assert.equal(returned.server.ownership.owner,sa.deviceId);assert.equal(await readFile(path.join(source,'world.bin'),'utf8'),'original');
  console.log('STEP 7: Clean up storage on A through its visible control; the current revision must stay usable.');
  await action(pa,'#clean-up');
  await idle(pa);
  const cleaned=await pa.evaluate(()=>window.peerhost.call('getState'));console.log('  '+cleaned.logs.find(l=>l.startsWith('Cleanup removed')));
  assert.equal(await readFile(path.join(cleaned.server.serverDir,'world.bin'),'utf8'),'original');
  await action(pa,'#start-server');await pa.waitForFunction(()=>document.querySelector('#server-status').textContent==='Hosting');await action(pa,'#stop-server');await ownership(pa,'owned');await idle(pa);
  await pa.screenshot({path:path.join(root,'A-returned-ownership.png')});assert.deepEqual(errors,[]);
  console.log('PASS: Actual two-app loopback handoff with decline-restore, fenced retry of the same offer, A → B → A, and cleanup; source stayed untouched; sender start blocked; peer executable paths not inherited. Fixture is NOT Minecraft.');console.log('ARTIFACT_DIR='+root);
}catch(error){for(const [name,p] of [['a',pa],['b',pb]])if(p&&!p.isClosed())await p.screenshot({path:path.join(root,name+'-failed.png')}).catch(()=>{});console.error('FAIL:',error);process.exitCode=1;}
finally{if(pa||pb){console.log('Holding the visible windows for 90 seconds for inspection.');await new Promise(r=>setTimeout(r,90000));}if(a)await a.close();if(b)await b.close();}
