import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
test('sandbox preload exposes only a frozen, allowlisted call bridge',async()=>{
  const source=await readFile(new URL('../apps/desktop/preload.cjs',import.meta.url),'utf8').catch(()=>'');
  const exposed:Record<string,any>={};const invoked:any[]=[];
  const sandbox={exports:{},require:(name:string)=>{assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld:(key:string,api:any)=>{exposed[key]=api;}},ipcRenderer:{invoke:(...args:any[])=>{invoked.push(args);return Promise.resolve({ok:true});}}};}};
  runInNewContext(source,sandbox);
  assert.equal(typeof exposed.peerhost?.call,'function');
  assert.deepEqual(Object.keys(exposed.peerhost),['call']);
  assert.equal(Object.isFrozen(exposed.peerhost),true);
  await exposed.peerhost.call('getState');assert.equal(invoked[0][0],'peerhost:call');
  await assert.rejects(exposed.peerhost.call('exec',{command:'unsafe'}),/method/i);
  assert.equal(invoked.length,1);
});
test('preload forwards only the window chrome controls main implements',async()=>{
  const source=await readFile(new URL('../apps/desktop/preload.cjs',import.meta.url),'utf8').catch(()=>'');
  const exposed:Record<string,any>={};const invoked:any[]=[];
  runInNewContext(source,{exports:{},require:()=>({contextBridge:{exposeInMainWorld:(key:string,api:any)=>{exposed[key]=api;}},ipcRenderer:{invoke:(...args:any[])=>{invoked.push(args);return Promise.resolve(null);}}})});
  const chrome=['getWindowState','windowMinimize','windowToggleFullscreen','windowClose','quitApp'];
  for(const method of chrome)await exposed.peerhost.call(method);
  assert.deepEqual(invoked.map(a=>a[1]),chrome);
  await assert.rejects(exposed.peerhost.call('windowSetBounds',{}),/method/i);
});
test('preload forwards read-only invitation preview without exposing extra privileges',async()=>{
  const source=await readFile(new URL('../apps/desktop/preload.cjs',import.meta.url),'utf8');
  const exposed:Record<string,any>={};const invoked:any[]=[];
  runInNewContext(source,{exports:{},require:()=>({contextBridge:{exposeInMainWorld:(key:string,api:any)=>{exposed[key]=api;}},ipcRenderer:{invoke:(...args:any[])=>{invoked.push(args);return Promise.resolve({relayName:'Friends'});}}})});
  const payload={code:'PEERHOST-test-input'};
  await assert.doesNotReject(exposed.peerhost.call('previewInvite',payload));
  assert.equal(invoked.length,1);
  assert.equal(invoked[0][0],'peerhost:call');
  assert.equal(invoked[0][1],'previewInvite');
  assert.equal(invoked[0][2],payload,'the main process must validate the original code');
  await assert.rejects(exposed.peerhost.call('decodeInvite',payload),/method/i);
  assert.equal(invoked.length,1,'no additional API is exposed');
});
