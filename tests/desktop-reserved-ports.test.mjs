import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {_electron as electron} from 'playwright';
import {desktopArtifactLaunch} from '../tools/desktop-artifact-launch.mjs';

test('desktop reserves active and inactive managed Minecraft ports before restoring its helper',{timeout:45000},async t=>{
  const root=await mkdtemp(path.join(process.env.TMPDIR,'desktop-reservations-')),profile=path.join(root,'profile');
  const env={...process.env,SEEDHOST_TEST_LOOPBACK:'1'};delete env.ELECTRON_RUN_AS_NODE;delete env.SEEDHOST_ACCOUNT_SERVICE;
  let app; t.after(async()=>{await app?.close();});
  app=await electron.launch({...desktopArtifactLaunch(process.cwd(),profile),env});
  let page=await app.firstWindow();await page.bringToFront();await page.waitForFunction(()=>typeof window.seedhost?.call==='function');
  const expected=[31234,31235];
  for(const port of expected){
    const source=path.join(root,'source-'+port);await mkdir(source);await writeFile(path.join(source,'server.properties'),'server-port='+port+'\n');
    await app.evaluate(({dialog},source)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]});dialog.showMessageBox=async()=>({response:1});},source);
    await page.evaluate(()=>window.seedhost.call('importServer'));
  }
  await app.close();app=undefined;
  const bootstrap=path.join(root,'reservation-bootstrap.mjs');
  const roleUrl=pathToFileURL(path.resolve('dist/src/core/always-on.js')).href;
  const mainUrl=pathToFileURL(path.resolve('dist/apps/desktop/main.js')).href;
  // Observe constructor inputs at the real restore boundary; do not replace listeners/backend behavior.
  await writeFile(bootstrap,`import {AlwaysOnHost} from ${JSON.stringify(roleUrl)};\nconst restore=AlwaysOnHost.prototype.restore;\nAlwaysOnHost.prototype.restore=function(...args){globalThis.__reservedBeforeRestore=[...(this.options.reservedGamePorts??[])];return restore.apply(this,args);};\nconst enable=AlwaysOnHost.prototype.enable;\nAlwaysOnHost.prototype.enable=function(...args){globalThis.__reservedBeforeEnable=[...(args[1]??[])];return enable.apply(this,args);};\nawait import(${JSON.stringify(mainUrl)});\n`);
  const launch=desktopArtifactLaunch(process.cwd(),profile);launch.args[0]=bootstrap;
  app=await electron.launch({...launch,env});page=await app.firstWindow();await page.bringToFront();await page.waitForFunction(()=>typeof window.seedhost?.call==='function');
  assert.deepEqual((await app.evaluate(()=>globalThis.__reservedBeforeRestore)).sort((a,b)=>a-b),expected,'helper must receive every managed game port before restoration');
  const state=await page.evaluate(()=>window.seedhost.call('getState'));assert.equal(state.servers.length,2);
  assert.deepEqual(state.servers.map(s=>s.playerPort).sort((a,b)=>a-b),expected);
  const latePort=31236,lateSource=path.join(root,'source-late');await mkdir(lateSource);await writeFile(path.join(lateSource,'server.properties'),'server-port='+latePort+'\n');
  await app.evaluate(({dialog},source)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]});dialog.showMessageBox=async()=>({response:1});},lateSource);
  await page.evaluate(()=>window.seedhost.call('importServer'));
  const gateway=await page.evaluate(()=>window.seedhost.call('alwaysOnEnable',{name:'Reservation fixture'}));
  assert.deepEqual((await app.evaluate(()=>globalThis.__reservedBeforeEnable)).sort((a,b)=>a-b),[...expected,latePort],'helper activation must refresh reservations for later imported servers');
  assert.equal(gateway.running,true);assert.ok(![...expected,latePort].includes(gateway.gamePort));
  console.log('PASS: actual Electron restart and later activation reserve all managed game ports. ARTIFACT_DIR='+root);
});
