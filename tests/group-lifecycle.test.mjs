import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {AlwaysOnHost} from '../dist/src/core/always-on.js';
import {SeedHostApplication} from '../dist/src/core/application.js';
import {createIdentity} from '../dist/src/core/peer-transport.js';
import {loadIdentity} from '../dist/src/core/identity-store.js';
import * as client from '../dist/src/core/relay-client.js';
const vault={encrypt:s=>Buffer.from(s),decrypt:b=>b.toString()}; // disposable test vault only
const options={host:'127.0.0.1',port:0,gamePorts:[0],discoveryPort:0,loadGroupIdentity:root=>loadIdentity(root,vault)};
test('disband then create uses a durable distinct group without reviving old membership or deleting worlds',async t=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR,'seed-lifecycle-'));
 const roleRoot=path.join(root,'always-on'),roleIdentity=await loadIdentity(roleRoot,vault),owner=await createIdentity(),member=await createIdentity();
 const host=new AlwaysOnHost(roleRoot,roleIdentity,options),app=new SeedHostApplication(path.join(root,'app'),owner);
 t.after(async()=>{await app.close();await host.close();await rm(root,{recursive:true,force:true});});
 await app.open();const source=path.join(root,'source');await mkdir(source);await writeFile(path.join(source,'world.dat'),'retained');await writeFile(path.join(source,'eula.txt'),'eula=true');await app.importExisting(source,true);
 await host.startGroup('Old group');const invite=await host.ownerInvite('Owner',owner.fingerprint);await app.joinHostingGroup({code:invite.code,name:'Owner',serverId:(await app.getState()).server.id,parkOnStop:false});
 const oldPeer={fingerprint:roleIdentity.fingerprint,host:'127.0.0.1',port:(await host.status()).port};
 // Keep a previously enrolled member and an outstanding invitation as revocation probes.
 const oldRelay=host['relay'];await oldRelay.trust('Member',member.fingerprint);const unused=await oldRelay.createInvite();
 await mkdir(path.join(roleRoot,'store'),{recursive:true});await writeFile(path.join(roleRoot,'store','keep'),'relay snapshot');await writeFile(path.join(root,'app','account.enc'),'account and friendships');
 const before=await app.listSnapshots(),selected=(await app.getState()).server;
 await app.disbandGroup(selected.id,oldPeer.fingerprint);
 const fresh=await host.startGroup('New group');assert.notEqual(fresh.fingerprint,oldPeer.fingerprint,'new group needs a new pinned identity');assert.equal(fresh.enabled,false);assert.equal(fresh.gamePort,null);
 const next=await host.ownerInvite('Owner',owner.fingerprint);await app.joinHostingGroup({code:next.code,name:'Owner',serverId:selected.id,parkOnStop:false});
 assert.equal((await app.getState()).relay.fingerprint,fresh.fingerprint);assert.equal((await app.getState()).server.ownership.state,'owned');assert.deepEqual(await app.listSnapshots(),before);
 assert.equal(await readFile(path.join(selected.serverDir,'world.dat'),'utf8'),'retained');assert.equal(await readFile(path.join(roleRoot,'store','keep'),'utf8'),'relay snapshot');assert.equal(await readFile(path.join(root,'app','account.enc'),'utf8'),'account and friendships');
 assert.equal((await client.relayDisbandStatus(owner,oldPeer)).disbanded,true);await assert.rejects(client.relayFriends(member,oldPeer),/refused|untrusted|denied/i);await assert.rejects(client.joinRelayInvite(member,unused.code,'Member'),/revoked|expired|disband|unavailable/i);await assert.rejects(oldRelay.trust('Owner',owner.fingerprint),/permanently disbanded/i);
 await host.close();const again=new AlwaysOnHost(roleRoot,roleIdentity,options);t.after(()=>again.close());await again.restore();assert.equal((await again.status()).fingerprint,fresh.fingerprint);assert.equal((await again.status()).gamePort,null);assert.equal((await again.status()).enabled,false);assert.equal(JSON.parse(await readFile(path.join(roleRoot,'relay.json'),'utf8')).disbandedBy,owner.fingerprint);
 const restored=await again.ownerInvite('Owner',owner.fingerprint);assert.ok(restored.code);
});

test('fresh creation never repurposes an unrelated enrolled group or its opted-in role',async t=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR,'seed-lifecycle-role-')),identity=await loadIdentity(root,vault),owner=await createIdentity();
 const host=new AlwaysOnHost(root,identity,options);t.after(async()=>{await host.close();await rm(root,{recursive:true,force:true});});
 await host.enable('Unrelated role');await host.ownerInvite('Owner',owner.fingerprint);const before=await host.status();
 await assert.rejects(host.startGroup('Different server group',true),/existing group|already.*group/i);
 const after=await host.status();assert.equal(after.fingerprint,before.fingerprint);assert.equal(after.name,before.name);assert.equal(after.gamePort,before.gamePort);assert.equal(after.enabled,true);assert.deepEqual(after.members,before.members);
 const peer={fingerprint:identity.fingerprint,host:'127.0.0.1',port:before.port};await client.relayDisbandGroup(owner,peer);
 const fresh=await host.startGroup('Replacement group',true);assert.notEqual(fresh.fingerprint,before.fingerprint);assert.equal(fresh.enabled,false);assert.equal(fresh.gamePort,null);
 const role=await host.status();assert.equal(role.fingerprint,before.fingerprint);assert.equal(role.gamePort,before.gamePort);assert.equal(role.enabled,true);
 const invite=await host.ownerInvite('Owner',owner.fingerprint);const joined=await client.joinRelayInvite(owner,invite.code,'Owner');assert.equal(joined.relayName,'Replacement group');
 await host.close();const again=new AlwaysOnHost(root,identity,options);t.after(()=>again.close());await again.restore();assert.equal((await again.status()).fingerprint,identity.fingerprint);assert.equal((await again.status()).enabled,true);assert.ok((await again.status()).gamePort);assert.ok((await again.ownerInvite('Owner',owner.fingerprint)).code);
});

test('replacement group supports explicit role enable and disable without losing control, then preserves that role on another disband',async t=>{
 const root=await mkdtemp(path.join(process.env.TMPDIR,'seed-lifecycle-toggle-')),identity=await loadIdentity(root,vault),owner=await createIdentity();
 const host=new AlwaysOnHost(root,identity,options);t.after(async()=>{await host.close();await rm(root,{recursive:true,force:true});});
 await host.startGroup('First');await host.ownerInvite('Owner',owner.fingerprint);const first=await host.status();await client.relayDisbandGroup(owner,{fingerprint:first.fingerprint,host:'127.0.0.1',port:first.port});
 const second=await host.startGroup('Second',true);await host.ownerInvite('Owner',owner.fingerprint);
 const enabled=await host.enable('Second');assert.equal(enabled.fingerprint,second.fingerprint,'explicit enable must address the new non-revoked group');assert.equal(enabled.enabled,true);assert.ok(enabled.gamePort);
 await host.disable();const off=await host.status();assert.equal(off.enabled,false);assert.ok(off.port,'disable retains current group control');assert.ok((await host.ownerInvite('Owner',owner.fingerprint)).code);
 await host.enable();const active=await host.status();await client.relayDisbandGroup(owner,{fingerprint:active.fingerprint,host:'127.0.0.1',port:active.port});
 const third=await host.startGroup('Third',true);assert.notEqual(third.fingerprint,second.fingerprint);assert.equal(third.enabled,false);assert.equal((await host.status()).fingerprint,second.fingerprint,'opted-in existing role is not rotated');assert.equal((await host.status()).gamePort,active.gamePort);
 await host.ownerInvite('Owner',owner.fingerprint);await host.close();const again=new AlwaysOnHost(root,identity,options);t.after(()=>again.close());await again.restore();assert.equal((await again.status()).fingerprint,second.fingerprint);assert.equal((await again.status()).enabled,true);assert.ok((await again.ownerInvite('Owner',owner.fingerprint)).code);await again.disable();assert.equal((await again.status()).fingerprint,third.fingerprint);assert.ok((await again.status()).port);
});


