import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCall} from '../dist/src/core/ipc-policy.js';
const url='file:///seedhost/app/index.html';
const context={senderId:42,expectedSenderId:42,isMainFrame:true};
const call=(method,payload)=>validateCall(method,payload,url,url,context);
for(const method of ['accountFriends','accountFriendRequests']){
  test(method+' is a trusted read-only zero-argument operation',()=>{
    assert.deepEqual(call(method,undefined),{});
    for(const payload of [null,{},[],{token:'renderer-supplied'}])assert.throws(()=>call(method,payload));
    assert.throws(()=>validateCall(method,undefined,url,url,{...context,isMainFrame:false}),/Untrusted IPC sender/);
    assert.throws(()=>validateCall(method,undefined,url,url,{...context,senderId:43}),/Untrusted IPC sender/);
  });
}
for(const [method,key,valid,canonical] of [['accountFriendSend','username','Sam','sam'],['accountFriendRemove','username','Sam','sam'],['accountFriendAccept','id','11111111-2222-3333-4444-555555555555','11111111-2222-3333-4444-555555555555'],['accountFriendDecline','id','11111111-2222-3333-4444-555555555555','11111111-2222-3333-4444-555555555555']]){
  test(method+' is a trusted single-value mutation',()=>{
    assert.deepEqual(call(method,{[key]:valid}),{[key]:canonical});
    assert.throws(()=>call(method,undefined),/Invalid payload/);
    for(const payload of [null,{},[],{username:'not the right key'},{id:'not the right key'},{[key]:valid,extra:1}])if(payload!==null){
      const sameKeyOnly=Object.keys(payload).length===1&&key in payload;
      if(!sameKeyOnly)assert.throws(()=>call(method,payload));
    }
    assert.throws(()=>call(method,{[key]:'not valid !!'}),/Invalid|Username/);
    assert.throws(()=>call(method,{[key]:'x'.repeat(5000)}),/Invalid|Username/);
    assert.throws(()=>validateCall(method,{[key]:valid},url,url,{...context,isMainFrame:false}),/Untrusted IPC sender/);
  });
}
test('accountFriendSend and accountFriendRemove reject empty or whitespace usernames',()=>{
  for(const method of ['accountFriendSend','accountFriendRemove'])for(const value of ['','   ','\u0000bad']){
    assert.throws(()=>call(method,{username:value}));
  }
});
test('friend request ids must be bounded uuid-shaped strings',()=>{
  for(const method of ['accountFriendAccept','accountFriendDecline'])for(const value of ['','1234','zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz',42,null]){
    assert.throws(()=>call(method,{id:value}));
  }
});
