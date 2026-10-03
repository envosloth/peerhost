import test from 'node:test';
import assert from 'node:assert/strict';
const mod:any=await import('../src/core/'+'ipc-policy.js').catch(()=>({}));
const renderer='file:///C:/peerhost/index.html';
const trusted={senderId:7,expectedSenderId:7,isMainFrame:true};
test('same renderer URL cannot authorize a foreign WebContents or frame',async t=>{
  for(const [label,context] of [
    ['missing context',undefined],
    ['other WebContents',{...trusted,senderId:8}],
    ['subframe',{...trusted,isMainFrame:false}],
    ['missing frame',{senderId:7,expectedSenderId:7}],
    ['nonboolean frame',{...trusted,isMainFrame:'true'}],
    ['invalid sender IDs',{...trusted,senderId:0,expectedSenderId:0}],
    ['noninteger sender IDs',{...trusted,senderId:7.5,expectedSenderId:7.5}],
  ] as const)await t.test(label,()=>{
    assert.throws(()=>mod.validateCall('getState',undefined,renderer,renderer,context),/sender/i);
  });
  assert.deepEqual(mod.validateCall('getState',undefined,renderer,renderer,trusted),{});
});
test('peer endpoints enforce DNS label and IP bounds',async t=>{
  const validHosts=['localhost','mini-pc.example','127.0.0.1','a'.repeat(63)+'.example',['a'.repeat(63),'b'.repeat(63),'c'.repeat(63),'d'.repeat(61)].join('.')];
  for(const host of ['-','-a.example','a-.example','..','a..example','a'.repeat(64)+'.example','256.1.1.1','127.00.0.1','1.2.3','999','[::1]','::1',validHosts[4]+'e'])await t.test(host,()=>{
    assert.throws(()=>mod.validateCall('addPeer',{name:'Friend',fingerprint:'a'.repeat(64),host,port:25565},renderer,renderer,trusted),/peer/i);
  });
  for(const host of validHosts)await t.test('valid '+host,()=>{
    const peer={name:'Friend',fingerprint:'a'.repeat(64),host,port:25565};
    assert.deepEqual(mod.validateCall('addPeer',peer,renderer,renderer,trusted),peer);
  });
});
test('desktop accepts only its exact local renderer and bounded known commands',()=>{
  assert.equal(typeof mod.validateCall,'function');
  assert.deepEqual(mod.validateCall('getState',undefined,renderer,renderer,trusted),{});
  assert.throws(()=>mod.validateCall('getState',{},'https://attacker.invalid',renderer,trusted),/sender/i);
  assert.throws(()=>mod.validateCall('exec',{command:'anything'},renderer,renderer,trusted),/method/i);
  assert.throws(()=>mod.validateCall('sendCommand',{command:'stop\nsay injected'},renderer,renderer,trusted),/command/i);
  assert.deepEqual(mod.validateCall('saveProfile',{executable:'C:/Program Files/Java/bin/java.exe',args:['-Xmx2G','-jar','server.jar']},renderer,renderer,trusted),{executable:'C:/Program Files/Java/bin/java.exe',args:['-Xmx2G','-jar','server.jar']});
  assert.throws(()=>mod.validateCall('saveProfile',{executable:'java',args:'-jar server.jar'},renderer,renderer,trusted),/arguments/i);
  assert.throws(()=>mod.validateCall('addPeer',{name:'Friend',fingerprint:'x',host:'127.0.0.1',port:65536},renderer,renderer,trusted),/peer/i);
});
