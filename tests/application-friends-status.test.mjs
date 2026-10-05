import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { SeedHostApplication } from '../dist/src/core/application.js';
import { RelayNode } from '../dist/src/core/relay.js';

test('an unrelated locally owned server cannot invent the relay group holder', async t => {
  const root=await mkdtemp(path.join(process.env.TMPDIR,'ph-friends-state-'));
  const relay=new RelayNode(path.join(root,'relay'),await createIdentity(),{log:()=>{}});
  const app=new SeedHostApplication(path.join(root,'profile'),await createIdentity());
  t.after(async()=>{await app.close();await relay.close();await rm(root,{recursive:true,force:true});});
  await relay.open();await relay.listen();await app.open();
  await app.joinWithInvite({code:(await relay.createInvite({hours:1})).code,name:'Angel'});
  await mkdir(path.join(root,'unrelated-world'));
  await app.importExisting(path.join(root,'unrelated-world'),true);
  const friends=await app.listFriends();
  assert.equal(friends.holder,null,'relay has never received this lineage; holder is not observable');
});
