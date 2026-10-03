import test from 'node:test';
import assert from 'node:assert/strict';
const settings: any = await import('../src/core/'+'settings.js').catch(()=>({defaultSettings:()=>undefined}));
test('direct hosting is the default with no gateway dependency',()=>{
  assert.deepEqual(settings.defaultSettings(),{persistentAddress:false,gatewayAddress:'',startAtLogin:false});
});
test('gateway host bounds reject malformed DNS and noncanonical IP endpoints',async t=>{
  const validHosts=['localhost','mini-pc.example','127.0.0.1','a'.repeat(63)+'.example',['a'.repeat(63),'b'.repeat(63),'c'.repeat(63),'d'.repeat(61)].join('.')];
  for(const host of ['-','-a.example','a-.example','..','a..example','a'.repeat(64)+'.example','256.1.1.1','127.00.0.1','1.2.3','999','[::1]','::1',validHosts[4]+'e'])await t.test(host,()=>{
    assert.throws(()=>settings.validateSettings({persistentAddress:true,gatewayAddress:host+':25565',startAtLogin:false}),/gateway/i);
  });
  for(const host of validHosts)await t.test('valid '+host,()=>{
    assert.equal(settings.validateSettings({persistentAddress:true,gatewayAddress:host+':25565',startAtLogin:false}).gatewayAddress,host+':25565');
  });
});
test('persistent address validates the endpoint only when opted in',()=>{
  assert.equal(typeof settings.validateSettings,'function');
  assert.deepEqual(settings.validateSettings({persistentAddress:false,gatewayAddress:'',startAtLogin:false}),settings.defaultSettings());
  assert.throws(()=>settings.validateSettings({persistentAddress:true,gatewayAddress:'',startAtLogin:false}),/gateway/i);
  assert.throws(()=>settings.validateSettings({persistentAddress:true,gatewayAddress:'localhost:99999',startAtLogin:false}),/gateway/i);
  assert.deepEqual(settings.validateSettings({persistentAddress:true,gatewayAddress:'mini-pc.example:25565',startAtLogin:false}),{persistentAddress:true,gatewayAddress:'mini-pc.example:25565',startAtLogin:false});
  assert.throws(()=>settings.validateSettings({persistentAddress:'yes',gatewayAddress:'',startAtLogin:false}),/boolean/i);
});
