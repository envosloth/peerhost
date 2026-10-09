import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('desktop state reports Electron package version, overriding stale core metadata',async()=>{
 const source=await readFile(new URL('../dist/apps/desktop/main.js',import.meta.url),'utf8');
 const start=source.indexOf("case 'getState':");const end=source.indexOf("case 'alwaysOnStatus':",start);
 assert.ok(start>=0&&end>start);
 const block=source.slice(start,end);const body=block.slice(block.indexOf('{')+1,block.lastIndexOf('}'));
 // The compiled case reads the per-group helper registry instead of one app-wide always-on host; the slice
 // scope must list exactly the identifiers it uses or it dies with a ReferenceError instead of testing behavior.
 const run=new (Object.getPrototypeOf(async function(){}).constructor)('backend','helperForSelected','helpers','onboardingChecks','publicAddress','app','appNotice','incomingHandoff',body);
 const value=await run({getState:async()=>({version:'0.5.0',servers:[],onboarding:{}})},async()=>({status:async()=>({running:false})}),{runningGamePorts:async()=>[]},()=>({ready:'pending'}),{}, {getVersion:()=> '0.6.1-alpha'},null,{status:()=>null});
 assert.equal(value.version,'0.6.1-alpha');
});
