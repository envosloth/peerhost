// Real Electron official downloads with automatic Java (SEEDHOST_SMOKE_JAVA is put first on PATH); no backend/network mocks.
// Explicit test-only EULA consent is required; this tool never starts a server.
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

let java=process.env.SEEDHOST_SMOKE_JAVA;
const provision=process.env.SEEDHOST_SMOKE_PROVISION_JAVA==='true';
if((!provision && (!java || !path.isAbsolute(java))) || process.env.SEEDHOST_SMOKE_ACCEPT_EULA!=='true')throw new Error('Set SEEDHOST_SMOKE_PROVISION_JAVA=true (or absolute SEEDHOST_SMOKE_JAVA) and explicit SEEDHOST_SMOKE_ACCEPT_EULA=true for disposable test-server creation.');
assert.ok(process.env.TMPDIR,'Artifacts must stay in scratch');
const project=fileURLToPath(new URL('../',import.meta.url));
const root=await mkdtemp(path.join(process.env.TMPDIR,'seedhost-desktop-create-'));
const profile=path.join(root,'profile');
const emptyPath=path.join(root,'no-system-java');await mkdir(emptyPath);
const env={...process.env,PATH:provision?emptyPath:path.dirname(java)+path.delimiter+(process.env.PATH??'')};delete env.ELECTRON_RUN_AS_NODE;delete env.JAVA_HOME;delete env.SEEDHOST_ACCOUNT_SERVICE;
let app,page;const errors=[];const dialogs=[];
const state=()=>page.evaluate(()=>window.seedhost.call('getState'));
const settled=()=>page.waitForFunction(()=>document.querySelector('#activity-message').textContent.startsWith('Ready'),undefined,{timeout:240000});
async function click(id){await page.locator('#'+id).click();await settled();}
async function native(response,pick=java){
 await app.evaluate(({dialog},{response,pick})=>{
  globalThis.__setupNativeMessages=[];
  dialog.showOpenDialog=async()=>({canceled:!pick,filePaths:pick?[pick]:[]});
  dialog.showMessageBox=async (...args)=>{const options=args.at(-1);globalThis.__setupNativeMessages.push({message:options.message,detail:options.detail});return{response};};
 },{response,pick});
}
async function collect(){dialogs.push(...await app.evaluate(()=>globalThis.__setupNativeMessages??[]));}
try{
 app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:[...(process.platform==='linux'?['--password-store=gnome-libsecret']:[]),path.join(project,'dist/apps/desktop/main.js'),'--profile-root='+profile],env});
 page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.bringToFront();await settled();
 await page.waitForFunction(()=>document.querySelector('#setup-dialog').open&&!document.querySelector('#setup-choose-create').disabled,undefined,{timeout:60000});
 await page.locator('#setup-choose-create').click();
 assert.equal(await page.locator('#setup-java').count(),0,'Java is automatic');
 await page.locator('#setup-name').fill('Disposable desktop Vanilla');
 await page.waitForFunction(()=>document.querySelector('#setup-version').options.length>2,undefined,{timeout:60000});
 await page.locator('#setup-all-versions').check();
 await page.locator('#setup-version').selectOption('1.21.1');
 await page.locator('#setup-memory').selectOption('1024');
 assert.match(await page.locator('#setup-eula-note').textContent(),/Minecraft EULA/,'EULA agreement is stated beside Create');
 await page.screenshot({path:path.join(root,'clean-create-form.png')});
 await native(0);await click('setup-create');await collect();
 assert.equal((await state()).server,null,'cancelled native creation leaves server absent');
 await native(1);await click('setup-create');await collect();
 await page.waitForFunction(()=>!document.querySelector('#setup-runtime').hidden,undefined,{timeout:240000});
 const created=await state();assert.ok(created.server);assert.equal(created.server.state,'offline');
 assert.equal(await page.locator('#setup-runtime-java').isVisible(),false,'Java is an advanced control, not a setup chore');
 assert.equal(await page.locator('#setup-runtime-memory').inputValue(),'1024','chosen memory is already saved');
 assert.doesNotMatch(await page.locator('#setup-runtime-feedback').textContent(),/Create or import/);
 await page.screenshot({path:path.join(root,'automatic-java-ready.png')});
 if(provision){assert.ok(created.server.profile.executable.startsWith(path.join(profile,'runtimes')+path.sep),'Java installed privately by the app');java=created.server.profile.executable;}
 else assert.equal(created.server.profile.executable,java);
 assert.equal(await readFile(path.join(created.server.serverDir,'eula.txt'),'utf8'),'eula=true\n');
 const jar=await readFile(path.join(created.server.serverDir,'server.jar'));assert.equal(jar.readUInt32LE(0),0x04034b50);
 await page.locator('#setup-runtime-memory').selectOption('1536');await native(0);await click('setup-profile-save');await collect();
 assert.ok((await state()).server.profile.args.includes('-Xmx1024M'),'cancelled native Java execution consent leaves launch profile unchanged');
 await native(1);await click('setup-profile-save');await collect();
 assert.ok((await state()).server.profile.args.includes('-Xmx1536M'));
 await page.locator('[data-setup-step="gateway"]').click();await settled();
 await page.locator('#setup-gateway-advanced').evaluate(d=>{d.open=true;});
 await click('setup-gateway-check');assert.match(await page.locator('#setup-gateway-status').textContent(),/Not ready/i);
 await page.locator('#setup-gateway-enabled').check();await click('setup-gateway-save');
 assert.match(await page.locator('#setup-error').textContent(),/relay/i);
 assert.equal((await state()).gateway.enabled,false,'no-relay opt-in refused and read back');
 await page.locator('#setup-gateway-enabled').uncheck();await click('setup-gateway-save');
 await page.screenshot({path:path.join(root,'created-java-gateway.png')});
 await click('setup-save-close');
 assert.equal((await state()).server.state,'offline','nothing started automatically');
 assert.ok(dialogs.some(d=>/EULA/.test(d.detail)&&/https:\/\/www.minecraft.net\/en-us\/eula/.test(d.detail)),JSON.stringify(dialogs));
 assert.ok(dialogs.some(d=>/Check Java and save this launch profile/.test(d.message)));
 assert.deepEqual(errors,[]);
 console.log('PASS: Automatic Java '+(provision?'downloaded with no system Java':'from PATH')+', stated EULA agreement, native creation cancellation/approval, official Vanilla 1.21.1 download/adoption, simple RAM save and no-relay gateway refusal. Nothing launched.');
 await writeFile(path.join(root,'result.json'),JSON.stringify({pass:true,java,serverBytes:jar.length,serverSnapshot:created.server.snapshotId,dialogs,errors},null,2));
}catch(error){console.error(error);process.exitCode=1;if(page&&!page.isClosed()){console.error('UI ERROR',await page.locator('#setup-error').textContent());await page.screenshot({path:path.join(root,'failure.png')}).catch(()=>{});}}
finally{if(app)await app.close().catch(()=>{});console.log('ARTIFACT_DIR='+root);}
