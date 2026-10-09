// Real Electron official downloads with automatic Java (SEEDHOST_SMOKE_JAVA is put first on PATH); no backend/network mocks.
// Explicit test-only EULA consent is required; this tool never starts a server.
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { desktopArtifactLaunch } from './desktop-artifact-launch.mjs';

let java=process.env.SEEDHOST_SMOKE_JAVA;
const provision=process.env.SEEDHOST_SMOKE_PROVISION_JAVA==='true';
if((!provision && (!java || !path.isAbsolute(java))) || process.env.SEEDHOST_SMOKE_ACCEPT_EULA!=='true')throw new Error('Set SEEDHOST_SMOKE_PROVISION_JAVA=true (or absolute SEEDHOST_SMOKE_JAVA) and explicit SEEDHOST_SMOKE_ACCEPT_EULA=true for disposable test-server creation.');
assert.ok(process.env.TMPDIR,'Artifacts must stay in scratch');
const project=fileURLToPath(new URL('../',import.meta.url));
const root=await mkdtemp(path.join(process.env.TMPDIR,'seedhost-desktop-create-'));
const profile=path.join(root,'profile');
const downloads=path.join(root,'chosen-downloads');await mkdir(downloads);
const packaged=process.argv.find(v=>v.startsWith('--packaged='))?.slice('--packaged='.length);
const emptyPath=path.join(root,'no-system-java');await mkdir(emptyPath);
const env={...process.env,SEEDHOST_TEST_LOOPBACK:'1',PATH:provision?emptyPath:path.dirname(java)+path.delimiter+(process.env.PATH??'')};delete env.ELECTRON_RUN_AS_NODE;delete env.JAVA_HOME;delete env.SEEDHOST_ACCOUNT_SERVICE;
let app,page;const errors=[];const dialogs=[];
const state=()=>page.evaluate(()=>window.seedhost.call('getState'));
const settled=()=>page.waitForFunction(()=>document.querySelector('#activity-message').textContent.startsWith('Ready'),undefined,{timeout:240000});
async function click(id){await page.locator('#'+id).click();await settled();}
async function native(pick){
 await app.evaluate(({dialog},{pick})=>{
  globalThis.__setupNativeMessages=[];
  dialog.showOpenDialog=async()=>({canceled:!pick,filePaths:pick?[pick]:[]});
  dialog.showMessageBox=async (...args)=>{const options=args.at(-1);globalThis.__setupNativeMessages.push({message:options.message,detail:options.detail});throw Error('Routine creation/settings must not show a warning popup');};
 },{pick});
}
async function collect(){dialogs.push(...await app.evaluate(()=>globalThis.__setupNativeMessages??[]));}
try{
 console.log('STEP 1 visible isolated official-server creation, TARGET='+(packaged??'current source Electron'));
 app=await electron.launch({...desktopArtifactLaunch(project,profile,packaged),env});
 page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.bringToFront();await settled();
 await page.waitForFunction(()=>document.querySelector('#setup-dialog').open&&!document.querySelector('#setup-choose-create').disabled,undefined,{timeout:60000});
 await page.locator('#setup-choose-create').click();
 assert.equal(await page.locator('#setup-java').count(),0,'Java is automatic');
 await page.locator('#setup-name').fill('Disposable desktop Vanilla');
 await page.waitForFunction(()=>document.querySelector('#setup-version').options.length>2,undefined,{timeout:60000});
 await page.locator('#setup-all-versions').check();
 await page.locator('#setup-version').selectOption('1.21.1');
 assert.equal(await page.locator('#setup-memory').count(),0,'memory is configured in the next step, not duplicated in Create');
 assert.match(await page.locator('#setup-eula-note').textContent(),/Minecraft EULA/,'EULA agreement is stated beside Create');
 await page.screenshot({path:path.join(root,'clean-create-form.png')});
 console.log('STEP 2 native download-directory cancellation leaves no server');
 await native(null);await click('setup-create');await collect();
 assert.equal((await state()).server,null,'cancelled native creation leaves server absent');
 console.log('STEP 3 real verified Mojang 1.21.1 download to chosen source, separately adopted managed copy; no auto-start');
 await native(downloads);await click('setup-create');await collect();
 await page.waitForFunction(()=>!document.querySelector('#setup-runtime').hidden,undefined,{timeout:240000});
 const created=await state();assert.ok(created.server);assert.equal(created.server.state,'offline');
 assert.equal(await page.locator('#setup-runtime-java').isVisible(),false,'Java is an advanced control, not a setup chore');
 assert.equal(await page.locator('#setup-runtime-memory').inputValue(),'2048','default creation memory is already saved');
 assert.doesNotMatch(await page.locator('#setup-runtime-feedback').textContent(),/Create or import/);
 await page.screenshot({path:path.join(root,'automatic-java-ready.png')});
 if(provision){assert.ok(created.server.profile.executable.startsWith(path.join(profile,'runtimes')+path.sep),'Java installed privately by the app');java=created.server.profile.executable;}
 else assert.equal(path.resolve(created.server.profile.executable),path.resolve(java));
 assert.equal(await readFile(path.join(created.server.serverDir,'eula.txt'),'utf8'),'eula=true\n');
 const jar=await readFile(path.join(created.server.serverDir,'server.jar'));assert.equal(jar.readUInt32LE(0),0x04034b50);
 const entries=await readdir(downloads);assert.equal(entries.length,1);
 const [sourceName]=await readdir(path.join(downloads,entries[0]));
 const downloaded=path.join(downloads,entries[0],sourceName);assert.notEqual(downloaded,created.server.serverDir);
 assert.deepEqual(await readFile(path.join(downloaded,'server.jar')),jar,'selected location really receives the verified official artifact');
 console.log('STEP 4 explicit RAM Save has no warning popup; optional helper stays off');
 await page.locator('#setup-runtime-memory').evaluate(e=>{e.value='1536';e.dispatchEvent(new Event('input',{bubbles:true}));});await click('setup-profile-save');await collect();
 assert.ok((await state()).server.profile.args.includes('-Xmx1536M'));
 assert.equal(await page.locator('[data-setup-step="gateway"]').count(),0);assert.equal((await state()).gateway.enabled,false);
 await page.screenshot({path:path.join(root,'created-java-direct.png')});
 await click('setup-save-close');
 assert.equal((await state()).server.state,'offline','nothing started automatically');
 assert.deepEqual(dialogs,[]);
 assert.deepEqual(errors,[]);
 console.log('PASS: Automatic Java '+(provision?'downloaded with no system Java':'from PATH')+', labelled EULA agreement, native destination cancellation, official Vanilla 1.21.1 download/source/adoption, popup-free RAM save and direct mode. Nothing launched; public allocation/WAN are not verified.');
 await writeFile(path.join(root,'result.json'),JSON.stringify({pass:true,java,serverBytes:jar.length,serverSnapshot:created.server.snapshotId,dialogs,errors},null,2));
}catch(error){console.error(error);process.exitCode=1;if(page&&!page.isClosed()){console.error('UI ERROR',await page.locator('#setup-error').textContent());await page.screenshot({path:path.join(root,'failure.png')}).catch(()=>{});}}
finally{if(app){console.log('CLEANUP '+app.process().pid);let timer;try{await Promise.race([app.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('close timeout')),15000);})]);}catch{await app.evaluate(({app})=>app.exit(0)).catch(()=>{});}finally{clearTimeout(timer);}}console.log('CLEANUP complete');console.log('ARTIFACT_DIR='+root);}
