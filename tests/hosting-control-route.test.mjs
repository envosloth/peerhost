import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {AlwaysOnHost} from '../dist/src/core/always-on.js';
import {createIdentity} from '../dist/src/core/peer-transport.js';
import {decodeInvite} from '../dist/src/core/invites.js';
import {joinRelayInvite,relayInviteFor} from '../dist/src/core/relay-client.js';
import {validateCall} from '../dist/src/core/ipc-policy.js';

test('per-helper control advertisement persists without changing local enrollment or another helper',async t=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR,'control-route-'));
 const identity=await createIdentity(),owner=await createIdentity(),friend=await createIdentity();
 const options={host:'127.0.0.1',port:0,gamePorts:[0],discoveryPort:0};
 const host=new AlwaysOnHost(root,identity,options);t.after(async()=>{await host.close();await rm(root,{recursive:true,force:true});});
 await host.startGroup('Group');const bootstrap=await host.ownerInvite('Owner',owner.fingerprint);await joinRelayInvite(owner,bootstrap.code,'Owner');
 const pin=decodeInvite(bootstrap.code),local={fingerprint:identity.fingerprint,host:pin.host,port:pin.port};
 const before=await host.controlRoute();assert.equal(before.privateRoute,true);assert.equal(before.reachability,'unverified');
 await host.setControlRoute({host:'group.example',port:8443});
 const route=await host.controlRoute();assert.deepEqual(route.advertised,{host:'group.example',port:8443});assert.deepEqual(route.listener,before.listener);assert.equal(route.privateRoute,false);
 const invitation=decodeInvite((await relayInviteFor(owner,local,friend.fingerprint)).code);assert.equal(invitation.host,'group.example');assert.equal(invitation.port,8443);
 assert.equal(decodeInvite((await host.ownerInvite('Owner',owner.fingerprint)).code).host,'127.0.0.1');
 await host.close();const again=new AlwaysOnHost(root,identity,options);t.after(()=>again.close());await again.restore();assert.deepEqual((await again.controlRoute()).advertised,route.advertised);
 await assert.rejects(again.setControlRoute({host:'0.0.0.0',port:8443}),/Invalid/);
});

test('control-route IPC uses exact fingerprint and endpoint payloads',()=>{
 const url='file:///app/index.html',context={senderId:1,expectedSenderId:1,isMainFrame:true};const call=(method,payload)=>validateCall(method,payload,url,url,context);
 assert.deepEqual(call('getHostingControlRoute',{fingerprint:'a'.repeat(64)}),{fingerprint:'a'.repeat(64)});
 assert.deepEqual(call('setHostingControlRoute',{fingerprint:'a'.repeat(64),host:'group.example',port:8443}),{fingerprint:'a'.repeat(64),host:'group.example',port:8443});
 assert.throws(()=>call('setHostingControlRoute',{fingerprint:'A'.repeat(64),host:'group.example',port:8443}),/Invalid/);
 assert.throws(()=>call('setHostingControlRoute',{fingerprint:'a'.repeat(64),host:'0.0.0.0',port:8443}),/Invalid/);
});
