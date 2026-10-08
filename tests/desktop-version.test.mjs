import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('desktop state reports Electron package version, overriding stale core metadata',async()=>{
 const source=await readFile(new URL('../dist/apps/desktop/main.js',import.meta.url),'utf8');
 const start=source.indexOf("case 'getState':");const end=source.indexOf("case 'alwaysOnStatus':",start);
 assert.ok(start>=0&&end>start);
 const block=source.slice(start,end);const body=block.slice(block.indexOf('{')+1,block.lastIndexOf('}'));
 const run=new (Object.getPrototypeOf(async function(){}).constructor)('backend','alwaysOn','onboardingChecks','publicAddress','app',body);
 const value=await run({getState:async()=>({version:'0.5.0',servers:[],onboarding:{}})},{status:async()=>({running:false})},()=>({ready:'pending'}),{}, {getVersion:()=> '0.6.1-alpha'});
 assert.equal(value.version,'0.6.1-alpha');
});
