import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
const electronPath=createRequire(import.meta.url)('electron') as string;
// Electron cannot auto-detect the Secret Service on every Linux desktop (e.g. Hyprland); safeStorage then fails closed.
const linuxKeyring=process.platform==='linux'?['--password-store=gnome-libsecret']:[];

test('real desktop IPC holds start preflight lock without a Run popup and rejects a replacement profile', {timeout:150000},async()=>{
  assert.ok(process.env.TMPDIR,'Hermes scratch TMPDIR is required for isolated profiles');
  await mkdir(process.env.TMPDIR,{recursive:true});
  const root=await mkdtemp(path.join(process.env.TMPDIR,'review-desktop-'));
  const source=path.join(root,'source');await mkdir(source);await writeFile(path.join(source,'eula.txt'),'eula=true\n');
  const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;
  env.SEEDHOST_TEST_LOOPBACK='1';
  console.log('DESKTOP STEP 1: Launch actual visible Electron app with isolated scratch profile.');
  // Playwright's evaluation context has no dynamic-import callback. Execute imports
  // through a real ESM bootstrap in Electron, so this is the main module's instance.
  const bootstrap=path.join(root,'desktop-preflight-bootstrap.mjs');
  await writeFile(bootstrap,`globalThis.__reviewInElectron = moduleUrl => import(moduleUrl);\nawait import(${JSON.stringify(pathToFileURL(path.resolve('dist/apps/desktop/main.js')).href)});\n`);
  const app=await electron.launch({executablePath:electronPath,args:[...linuxKeyring,bootstrap,'--profile-root='+path.join(root,'profile')],env});
  const page=await app.firstWindow();await page.bringToFront();
  try{
    await page.waitForFunction(()=>typeof (window as any).seedhost?.call==='function');
    await app.evaluate(({dialog},source)=>{
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]});
      dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});
    },source);
    await page.evaluate(()=>(window as any).seedhost.call('importServer'));
    const profile={executable:process.execPath,args:[path.resolve('tools/fake-java-server.mjs'),'--lifetime-ms=30000','approved desktop profile']};
    await page.evaluate(profile=>(window as any).seedhost.call('saveProfile',profile),profile);
    console.log('DESKTOP STEP 2: Delay actual AlwaysOnHost status preflight once; real IPC, backend and child remain unchanged.');
    await app.evaluate(async({dialog},moduleUrl)=>{
      (globalThis as any).__reviewDialogs=[];
      dialog.showMessageBox=async(_window:any,options?:any)=>{
        (globalThis as any).__reviewDialogs.push(options);
        return {response:0,checkboxChecked:false};
      };
      const {AlwaysOnHost}=await (globalThis as any).__reviewInElectron(moduleUrl);
      const original=AlwaysOnHost.prototype.status;
      (globalThis as any).__reviewRestoreStatus=()=>{AlwaysOnHost.prototype.status=original;};
      let delayed=false;
      AlwaysOnHost.prototype.status=async function(...args:any[]){
        // Only the explicit-start callback invoked under the core operation lock:
        // renderer polling and safe-quit getState calls must remain nonblocking.
        if(!delayed && new Error().stack?.includes('application.js:')){
          delayed=true;
          (globalThis as any).__reviewWaiting=true;
          await new Promise<void>(resolve=>{(globalThis as any).__reviewDecision=resolve;});
        }
        return original.apply(this,args);
      };
    },pathToFileURL(path.resolve('dist/src/core/always-on.js')).href);
    await page.bringToFront();
    await page.evaluate(()=>{(window as any).__reviewStart=(window as any).seedhost.call('startServer').then(()=>({ok:true}), (e:Error)=>({error:String(e)}));});
    const preflightWaiting=await app.evaluate(async()=>{
      for(let i=0;i<200;i++){if((globalThis as any).__reviewWaiting)return true;await new Promise(r=>setTimeout(r,10));}
      return false;
    });
    assert.equal(preflightWaiting,true,'explicit start must reach actual AlwaysOnHost status preflight');
    const waiting=await page.evaluate(()=>(window as any).seedhost.call('getState'));
    assert.equal(waiting.busy,'startServer');
    assert.equal(waiting.server.state,'offline','preflight precedes process spawn');
    const replacement=await page.evaluate(profile=>(window as any).seedhost.call('saveProfile',profile).then(()=>null,(e:Error)=>String(e)),{executable:process.execPath,args:[profile.args[0]!,'unapproved replacement']});
    assert.match(replacement!,/operation|progress/i);
    console.log('DESKTOP STEP 3: Actual safe-quit remains blocked during start preflight.');
    const quitBlocked=await app.evaluate(async({app})=>{
      app.quit();
      for(let i=0;i<200;i++){
        if((globalThis as any).__reviewDialogs.some((d:any)=>d.message==='An operation is still in progress.'))return true;
        await new Promise(r=>setTimeout(r,10));
      }
      return false;
    });
    assert.equal(quitBlocked,true);assert.equal(page.isClosed(),false);
    await page.screenshot({path:path.join(root,'pending-preflight.png')});
    const dialogs=await app.evaluate(()=>(globalThis as any).__reviewDialogs);
    assert.equal(dialogs.some((d:any)=>d.message==='Run this server on this PC?'),false);
    assert.ok(dialogs.some((d:any)=>d.message==='An operation is still in progress.' && d.type==='warning'));
    console.log('DESKTOP STEP 4: Release preflight and verify captured fixture arguments and execution directory.');
    await app.evaluate(()=>(globalThis as any).__reviewDecision());
    assert.deepEqual(await page.evaluate(()=>(window as any).__reviewStart),{ok:true});
    await page.waitForFunction(async()=>{const state=await (window as any).seedhost.call('getState');return state.logs.some((line:string)=>line.startsWith('fixture '));});
    const state=await page.evaluate(()=>(window as any).seedhost.call('getState'));
    const launch=JSON.parse(state.logs.find((line:string)=>line.startsWith('fixture ')).slice('fixture '.length));
    assert.deepEqual(launch.args,profile.args.slice(1));assert.equal(launch.cwd,waiting.server.serverDir);assert.equal(state.server.id,waiting.server.id);assert.equal(state.server.state,'running');
    assert.equal((await app.evaluate(()=>(globalThis as any).__reviewDialogs)).some((d:any)=>d.message==='Run this server on this PC?'),false);
    await page.screenshot({path:path.join(root,'started-fixture.png')});
    await page.evaluate(()=>(window as any).seedhost.call('stopServer'));
    console.log('DESKTOP PASS: Real IPC/preflight lock, no Run popup, replacement rejection, safe quit and fixture process verified. NOT Minecraft. ARTIFACT_DIR='+root);
  }finally{
    await app.evaluate(()=>{(globalThis as any).__reviewDecision?.();(globalThis as any).__reviewRestoreStatus?.();}).catch(()=>{});
    await page.evaluate(()=>(window as any).__reviewStart).catch(()=>{});
    await page.evaluate(()=>(window as any).seedhost.call('stopServer')).catch(()=>{});
    console.log('Holding visible desktop regression window for 90 seconds for inspection.');
    await new Promise(r=>setTimeout(r,90000));
    await app.close();
  }
});
