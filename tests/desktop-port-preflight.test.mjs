import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {_electron as electron} from 'playwright';
import {desktopArtifactLaunch} from '../tools/desktop-artifact-launch.mjs';

const packagedArg=process.argv.find(arg=>arg.startsWith('--packaged='));
const packaged=packagedArg?.slice('--packaged='.length);
if(process.argv.includes('--packaged'))throw new Error('Use --packaged=<absolute executable>; no artifact check may fall back to source.');

test('known app gateway port conflict is refused before launch consent, spawn or ownership change',{timeout:40000},async t=>{
  const root=await mkdtemp(path.join(process.env.TMPDIR,'seedhost-port-preflight-'));
  const profile=path.join(root,'profile'),source=path.join(root,'source');await mkdir(source);await mkdir(path.join(profile,'always-on'),{recursive:true});
  await writeFile(path.join(profile,'always-on/always-on.json'),JSON.stringify({version:1,enabled:true}));
  await writeFile(path.join(source,'eula.txt'),'eula=true\n');await writeFile(path.join(source,'server.properties'),'server-port=25565\n');
  const env={...process.env,SEEDHOST_TEST_LOOPBACK:'1'};delete env.ELECTRON_RUN_AS_NODE;delete env.SEEDHOST_ACCOUNT_SERVICE;
  const app=await electron.launch({...desktopArtifactLaunch(process.cwd(),profile,packaged),env});t.after(()=>app.close());
  console.log('ARTIFACT_MODE='+(packaged?'packaged':'source')+(packaged?' EXECUTABLE='+packaged:''));
  const page=await app.firstWindow();await page.bringToFront();await page.waitForFunction(()=>typeof window.seedhost?.call==='function');
  await app.evaluate(({dialog},source)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]});dialog.showMessageBox=async()=>({response:1});},source);
  await page.evaluate(()=>window.seedhost.call('importServer'));
  await page.evaluate(executable=>window.seedhost.call('saveProfile',{executable,args:['--version']}),process.execPath);
  const gateway=await page.evaluate(()=>window.seedhost.call('alwaysOnStatus'));assert.equal(gateway.running,true);
  const state=await page.evaluate(()=>window.seedhost.call('getState'));
  await page.evaluate(({id,port})=>window.seedhost.call('saveServerSettings',{id,settings:{'server-port':port}}),{id:state.server.id,port:gateway.gamePort});
  const before=await page.evaluate(()=>window.seedhost.call('getState'));
  await app.evaluate(({dialog})=>{globalThis.__launchPrompts=[];dialog.showMessageBox=async(_window,options)=>{globalThis.__launchPrompts.push(options.message);return {response:1};};});
  const failure=await page.evaluate(()=>window.seedhost.call('startServer').then(()=>null,e=>String(e)));
  assert.match(failure,/Minecraft port.*used by.*gateway/i);
  assert.deepEqual(await app.evaluate(()=>globalThis.__launchPrompts),[],'known impossible start should not ask to run code');
  const after=await page.evaluate(()=>window.seedhost.call('getState'));
  assert.equal(after.server.state,'offline');assert.deepEqual(after.server.ownership,before.server.ownership);
  assert.equal(after.server.snapshotId,before.server.snapshotId);
  await page.screenshot({path:path.join(root,'port-preflight.png')});
  console.log('PASS: real isolated Electron preflight; no spawn, ownership mutation or redundant launch prompt. ARTIFACT_DIR='+root);
});
