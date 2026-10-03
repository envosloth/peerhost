import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
const electronPath=createRequire(import.meta.url)('electron') as string;
// Electron cannot auto-detect the Secret Service on every Linux desktop (e.g. Hyprland); safeStorage then fails closed.
const linuxKeyring=process.platform==='linux'?['--password-store=gnome-libsecret']:[];

test('real desktop IPC holds launch approval lock and rejects a replacement profile', {timeout:150000},async()=>{
  await mkdir('.test-data',{recursive:true});
  const root=await mkdtemp(path.resolve('.test-data/review-desktop-'));
  const source=path.join(root,'source');await mkdir(source);await writeFile(path.join(source,'eula.txt'),'eula=true\n');
  const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;
  console.log('DESKTOP STEP 1: Launch actual visible Electron app with isolated project profile.');
  const app=await electron.launch({executablePath:electronPath,args:[...linuxKeyring,path.resolve('dist/apps/desktop/main.js'),'--profile-root='+path.join(root,'profile')],env});
  const page=await app.firstWindow();await page.bringToFront();
  try{
    await page.waitForFunction(()=>typeof (window as any).peerhost?.call==='function');
    await app.evaluate(({dialog},source)=>{
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]});
      dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});
    },source);
    await page.evaluate(()=>(window as any).peerhost.call('importServer'));
    const profile={executable:process.execPath,args:[path.resolve('tools/fake-java-server.mjs'),'--lifetime-ms=30000','approved desktop profile']};
    await page.evaluate(profile=>(window as any).peerhost.call('saveProfile',profile),profile);
    console.log('DESKTOP STEP 2: Delay only native consent response; real main, IPC, backend and child remain unchanged.');
    await app.evaluate(({dialog})=>{
      (globalThis as any).__reviewDialogs=[];
      dialog.showMessageBox=async(_window:any,options?:any)=>{
        (globalThis as any).__reviewDialogs.push(options);
        if(options.message==='Run this server on this PC?'){
          (globalThis as any).__reviewWaiting=true;
          return new Promise(resolve=>{(globalThis as any).__reviewDecision=()=>resolve({response:1,checkboxChecked:false});});
        }
        return {response:0,checkboxChecked:false};
      };
    });
    await page.bringToFront();
    await page.evaluate(()=>{(window as any).__reviewStart=(window as any).peerhost.call('startServer').then(()=>({ok:true}), (e:Error)=>({error:String(e)}));});
    const dialogWaiting=await app.evaluate(async()=>{
      for(let i=0;i<200;i++){if((globalThis as any).__reviewWaiting)return true;await new Promise(r=>setTimeout(r,10));}
      return false;
    });
    assert.equal(dialogWaiting,true);
    const waiting=await page.evaluate(()=>(window as any).peerhost.call('getState'));
    assert.equal(waiting.busy,'startServer');
    const replacement=await page.evaluate(profile=>(window as any).peerhost.call('saveProfile',profile).then(()=>null,(e:Error)=>String(e)),{executable:process.execPath,args:[profile.args[0]!,'unapproved replacement']});
    assert.match(replacement!,/operation|progress/i);
    console.log('DESKTOP STEP 3: Actual safe-quit remains blocked during native approval.');
    const quitBlocked=await app.evaluate(async({app})=>{
      app.quit();
      for(let i=0;i<200;i++){
        if((globalThis as any).__reviewDialogs.some((d:any)=>d.message==='An operation is still in progress.'))return true;
        await new Promise(r=>setTimeout(r,10));
      }
      return false;
    });
    assert.equal(quitBlocked,true);assert.equal(page.isClosed(),false);
    await page.screenshot({path:path.join(root,'pending-approval.png')});
    const dialogs=await app.evaluate(()=>(globalThis as any).__reviewDialogs);
    const detail=dialogs.find((d:any)=>d.message==='Run this server on this PC?').detail;
    assert.ok(detail.includes(waiting.server.serverDir));assert.ok(detail.includes(waiting.server.snapshotId));assert.ok(detail.includes(profile.executable));assert.ok(detail.includes('approved desktop profile'));
    console.log('DESKTOP STEP 4: Approve and verify actual fixture arguments and execution directory.');
    await app.evaluate(()=>(globalThis as any).__reviewDecision());
    assert.deepEqual(await page.evaluate(()=>(window as any).__reviewStart),{ok:true});
    const state=await page.evaluate(()=>(window as any).peerhost.call('getState'));
    const launch=JSON.parse(state.logs.find((line:string)=>line.startsWith('fixture ')).slice('fixture '.length));
    assert.deepEqual(launch.args,profile.args.slice(1));assert.equal(launch.cwd,state.server.serverDir);assert.equal(state.server.state,'running');
    await page.screenshot({path:path.join(root,'approved-fixture.png')});
    await page.evaluate(()=>(window as any).peerhost.call('stopServer'));
    console.log('DESKTOP PASS: Real IPC/native approval lock, replacement rejection, safe quit and fixture process verified. NOT Minecraft. ARTIFACT_DIR='+root);
  }finally{
    await app.evaluate(()=>(globalThis as any).__reviewDecision?.()).catch(()=>{});
    await page.evaluate(()=>(window as any).__reviewStart).catch(()=>{});
    await page.evaluate(()=>(window as any).peerhost.call('stopServer')).catch(()=>{});
    console.log('Holding visible desktop regression window for 90 seconds for inspection.');
    await new Promise(r=>setTimeout(r,90000));
    await app.close();
  }
});
