// Standing real-Electron contract gate. The child uses fresh scratch profiles,
// loopback TLS and disposable Node/file fixtures, never the user's running app.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile);
test('desktop UX retains explicit incoming consent under the real receive lock through decline and A-B-A handoff',{timeout:180000},async()=>{
 assert.ok(process.env.TMPDIR?.includes('hermes'),'Use isolated Hermes scratch');
 const project=fileURLToPath(new URL('../',import.meta.url));
 const {stdout,stderr}=await run(process.execPath,['tools/desktop-handoff-check.mjs','--hold=0'],{cwd:project,env:{...process.env},timeout:170000,maxBuffer:2*1024*1024});
 assert.match(stdout,/RESULT=true/);assert.match(stdout,/CLEANUP complete/);assert.match(stdout,/STEP 8 cancelled Delete/);
 console.log(stdout);assert.equal(stderr,'','the desktop gate reports no failures');
});
