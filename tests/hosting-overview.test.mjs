import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {SeedHostApplication} from '../dist/src/core/application.js';
import {AlwaysOnHost} from '../dist/src/core/always-on.js';
import {createIdentity} from '../dist/src/core/peer-transport.js';
import {validateCall} from '../dist/src/core/ipc-policy.js';

test('global hosting overview deduplicates saved groups without changing selection or guessing local authority',async t=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR,'overview-')),identity=await createIdentity();
 const app=new SeedHostApplication(root,identity);await app.open();t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const one='a'.repeat(64),two='b'.repeat(64),three='c'.repeat(64);
 app.saved.servers=[{id:'world-a',name:'World A',group:{fingerprint:one,parkOnStop:false}},{id:'world-b',name:'World B',group:{fingerprint:one,parkOnStop:true}}];
 app.saved.activeServerId='world-b';
 app.saved.pendingGroups=[{fingerprint:one,relayName:'Duplicate',since:1},{fingerprint:two,relayName:'Joined',since:1},{fingerprint:three,relayName:'Created',since:1}];
 app.saved.peers=[{fingerprint:one,name:'Bound group'},{fingerprint:two,name:'Joined'}];
 assert.deepEqual(await app.listHostingGroups([three]),[
  {fingerprint:one,name:'Bound group',serverId:'world-a',serverName:'World A',pending:false,localAuthority:false},
  {fingerprint:two,name:'Joined',serverId:null,serverName:null,pending:true,localAuthority:false},
  {fingerprint:three,name:'Created',serverId:null,serverName:null,pending:true,localAuthority:true}
 ]);
 assert.equal(app.saved.activeServerId,'world-b');
 assert.equal((await app.listHostingGroups())[2].localAuthority,false,'saved membership alone is not helper authority');
 await assert.rejects(app.listHostingGroups(['A'.repeat(64)]),/fingerprint/i);
 app.saved.servers=[];
});

test('Friends IPC permits read-only overview and strictly pinned pending claim',()=>{
 const url='file:///seedhost/index.html',context={senderId:1,expectedSenderId:1,isMainFrame:true};
 const call=(method,payload)=>validateCall(method,payload,url,url,context);
 assert.deepEqual(call('listHostingGroups'),{});
 assert.throws(()=>call('listHostingGroups',{}),/no arguments/);
 assert.deepEqual(call('claimPendingGroup',{fingerprint:'a'.repeat(64)}),{fingerprint:'a'.repeat(64)});
 for(const fingerprint of ['A'.repeat(64),'a'.repeat(63),' '+ 'a'.repeat(64)])assert.throws(()=>call('claimPendingGroup',{fingerprint}),/Invalid/);
 assert.throws(()=>call('claimPendingGroup',{fingerprint:'a'.repeat(64),id:'world-a'}),/Invalid/);
});

test('helper registry reports its real identities rather than player role status or world custody',async()=>{
 const base=await createIdentity(),group=await createIdentity(),retained=await createIdentity();
 const helper=new AlwaysOnHost('unused',base);
 helper.groupHost=new AlwaysOnHost('unused-group',group);
 helper.retainedRole=new AlwaysOnHost('unused-role',retained);
 assert.deepEqual(helper.localGroupFingerprints(),[base.fingerprint,group.fingerprint,retained.fingerprint]);
});
