import test from 'node:test';import assert from 'node:assert/strict';
import {validateCall} from '../dist/src/core/ipc-policy.js';
const ctx={senderId:1,expectedSenderId:1,isMainFrame:true};
test('playit IPC has no caller-selected secrets, paths, URLs or tunnel targets',()=>{
 for(const method of ['playitStatus','playitImport','playitCheck','playitCreate','playitDisconnect','playitSetup']){
  assert.deepEqual(validateCall(method,undefined,'file:///app','file:///app',ctx),{});
  assert.throws(()=>validateCall(method,{path:'/secret'},'file:///app','file:///app',ctx));
  assert.throws(()=>validateCall(method,undefined,'https://evil.test','file:///app',ctx));
 }
});
