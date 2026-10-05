import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { RelayNode } from '../dist/src/core/relay.js';
import * as client from '../dist/src/core/relay-client.js';

test('only the explicitly appointed group owner can revoke membership over real TLS', async t => {
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'group-'));
  const [ri, owner, friend, outsider] = await Promise.all(Array.from({length:4},()=>createIdentity()));
  const relay = new RelayNode(root, ri, { log:()=>{} });
  t.after(async()=>{await relay.close();await rm(root,{recursive:true,force:true});});
  await relay.open(); await relay.trust('Owner',owner.fingerprint); await relay.trust('Friend',friend.fingerprint);
  assert.equal(typeof relay.setOwner,'function','explicit owner configuration is required');
  await relay.setOwner(owner.fingerprint);
  await relay.listen();
  const peer = {...relay.endpoint,fingerprint:ri.fingerprint};
  assert.equal((await client.relayFriends(owner,peer)).canManage,true);
  assert.equal((await client.relayFriends(friend,peer)).canManage,false);
  const invite = await client.relayInvite(friend,peer);
  await assert.rejects(client.relayRemoveFriend(friend,peer,owner.fingerprint),/owner/);
  await assert.rejects(client.relayRemoveFriend(owner,peer,owner.fingerprint),/owner/);
  await client.relayRemoveFriend(owner,peer,friend.fingerprint);
  assert.deepEqual((await client.relayFriends(owner,peer)).members.map(m=>m.fingerprint),[owner.fingerprint]);
  await assert.rejects(client.relayFriends(friend,peer));
  await assert.rejects(client.joinRelayInvite(outsider,invite.code,'Outsider'));
});
