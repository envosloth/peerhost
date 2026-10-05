import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RelayNode } from '../dist/src/core/relay.js';
import { createIdentity, connectPeer, listenPeer, readFrame, writeFrame, readInviteFrame, writeInviteFrame } from '../dist/src/core/peer-transport.js';
import { joinRelayInvite, relayInvite, relayFriends, relayStatus, relayRequest } from '../dist/src/core/relay-client.js';
import { decodeInvite } from '../dist/src/core/invites.js';
const quiet = { name: "Angel's relay", log() {} };
async function fixture(t) {
  const root = await mkdtemp(path.join(process.env.TMPDIR || path.resolve('.test-data'), 'relay-friends-'));
  const relay = new RelayNode(root, await createIdentity(), quiet);
  await relay.open(); await relay.listen();
  t.after(async () => { await relay.close(); await rm(root, {recursive:true,force:true}); });
  return {root, relay, peer:{fingerprint:relay.identity.fingerprint, ...relay.endpoint}};
}
test('core pinned join, hashed persistence, same-certificate retry, member invites, friends and admin', async t => {
  const {root,relay,peer} = await fixture(t);
  const first = await createIdentity(), second = await createIdentity();
  const invite = await relay.createInvite();
  const decoded = decodeInvite(invite.code);
  const files = await readdir(path.join(root,'invites'));
  assert.equal(files[0],createHash('sha256').update(decoded.token).digest('hex')+'.json');
  assert.ok(!(await readFile(path.join(root,'invites',files[0]),'utf8')).includes(decoded.token.toString('hex')));
  assert.deepEqual(await joinRelayInvite(first,invite.code,'First'),{relayName:"Angel's relay"});
  assert.deepEqual(await readdir(path.join(root,'invites')),[]);
  await joinRelayInvite(first,invite.code,'First');
  await assert.rejects(joinRelayInvite(second,invite.code,'Second'),/used|expired|not valid/i);
  const member = await relayInvite(first,peer);
  await joinRelayInvite(second,member.code,'Second');
  assert.deepEqual(await relayFriends(first,peer),{members:[{name:'First',fingerprint:first.fingerprint,you:true},{name:'Second',fingerprint:second.fingerprint,you:false}],custody:'unknown',holder:null});
  await relay.setMemberInvites(false);
  await assert.rejects(relayInvite(first,peer),/only the relay owner/i);
  await relay.setMemberInvites(true);
  await relay.untrust(first.fingerprint);
  await assert.rejects(relayStatus(first,peer),/disconnected|refused/i);
  await assert.rejects(joinRelayInvite(first,invite.code,'First'),/used|expired|refused/i);
  assert.equal(await relayStatus(second,peer),null);
});
test('unknown status park claim invite and friends refused with pending invitations', async t => {
  const {relay,peer} = await fixture(t);
  const unknown=await createIdentity();
  await relay.createInvite();
  for(const op of ['status','park','claim','invite','friends']) {
    const socket=await connectPeer(unknown,peer.fingerprint,peer.host,peer.port);
    try {
      await writeFrame(socket,relayRequest(op));
      const reply=await readFrame(socket);
      assert.equal(reply.type,'error'); assert.match(reply.message,/invite|untrusted|refused/i);
    } finally {socket.destroy();}
  }
  assert.equal(relay.trusted.length,0);
});
test('bootstrap transport cannot use ordinary readFrame writeFrame',async t=>{
  const serverId=await createIdentity(), clientId=await createIdentity();
  let resolve;
  const serverSocket=new Promise(r=>resolve=r);
  const listener=await listenPeer(serverId,[],s=>resolve(s),{authorizeCertificate:async()=> 'invite'});
  t.after(()=>listener.close());
  const client=await connectPeer(clientId,serverId.fingerprint,listener.host,listener.port);
  t.after(()=>client.destroy());
  const socket=await serverSocket;
  await assert.rejects(writeFrame(socket,{type:'ack'}),/peer-pin verified/);
  await assert.rejects(readFrame(socket),/peer-pin verified/);
  await writeFrame(client,{type:'join'});
  assert.deepEqual(await readInviteFrame(socket),{type:'join'});
  await writeInviteFrame(socket,{type:'refused'});
  assert.deepEqual(await readFrame(client),{type:'refused'});
});
test('concurrent redeem has one winner; concurrent CLI writers preserve every friend',async t=>{
  const {root,relay,peer}=await fixture(t);
  const a=await createIdentity(),b=await createIdentity();
  const invite=await relay.createInvite();
  const results=await Promise.allSettled([joinRelayInvite(a,invite.code,'A'),joinRelayInvite(b,invite.code,'B')]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const cli=new RelayNode(root,relay.identity,quiet); await cli.open();
  const c=await createIdentity(),d=await createIdentity();
  await Promise.all([cli.trust('C',c.fingerprint),relay.trust('D',d.fingerprint)]);
  await relay.reload(); assert.equal(relay.trusted.length,3);
  assert.equal(await relayStatus(c,peer),null);
  await cli.untrust(c.fingerprint);
  await assert.rejects(relayStatus(c,peer),/disconnected|refused/i);
});
test('expired server record refuses join and wrong relay fingerprint refuses before token disclosure',async t=>{
  const {root,relay}=await fixture(t);
  const unknown=await createIdentity();
  const invite=await relay.createInvite({hours:1});
  const record=(await readdir(path.join(root,'invites')))[0];
  const file=path.join(root,'invites',record);
  await writeFile(file,JSON.stringify({...JSON.parse(await readFile(file,'utf8')),expiresAt:Date.now()-1000}));
  await assert.rejects(joinRelayInvite(unknown,invite.code,'Unknown'),/expired/i);
  const fresh=await relay.createInvite();
  const {encodeInvite}=await import('../dist/src/core/invites.js');
  const forged=encodeInvite({...decodeInvite(fresh.code),relayFingerprint:unknown.fingerprint});
  await assert.rejects(joinRelayInvite(await createIdentity(),forged,'Unknown'),/pin|fingerprint|certificate/i);
  assert.equal(relay.trusted.length,0);
});
test('real CLI invite/trust/untrust updates a running listener without dropping an authenticated connection',async t=>{
  const {execFile,spawn}=await import('node:child_process');
  const {promisify}=await import('node:util');
  const exec=promisify(execFile);
  const cli=path.resolve('dist/src/relay/cli.js');
  const root=await mkdtemp(path.join(process.env.TMPDIR || path.resolve('.test-data'), 'relay-cli-friends-'));
  const run=(...args)=>exec(process.execPath,[cli,...args,'--root',root]);
  await run('init','--name',"Angel's relay");
  const serving=spawn(process.execPath,[cli,'serve','--root',root,'--host','127.0.0.1','--port','0']);
  t.after(async()=>{serving.kill('SIGTERM'); if(serving.exitCode===null) await new Promise(r=>serving.once('exit',r)); await rm(root,{recursive:true,force:true});});
  let output='';
  const endpoint=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('CLI did not listen')),5000);
    serving.stdout.on('data',chunk=>{output+=chunk; const found=/LISTENING=127\.0\.0\.1:(\d+)/.exec(output); if(found){clearTimeout(timer);resolve({host:'127.0.0.1',port:Number(found[1]),fingerprint:/FINGERPRINT=([a-f0-9]{64})/.exec(output)[1]});}});
    serving.once('error',reject);
  });
  const {stdout}=await run('invite','--hours','1');
  const code=stdout.split('\n').find(line=>line.startsWith('SEEDHOST-'));
  const a=await createIdentity(),b=await createIdentity();
  assert.equal((await joinRelayInvite(a,code,'A')).relayName,"Angel's relay");
  const socket=await connectPeer(a,endpoint.fingerprint,endpoint.host,endpoint.port);
  try {
    await run('trust','--name','B','--fingerprint',b.fingerprint);
    assert.equal(socket.destroyed,false,'trust must not restart the live listener');
    await writeFrame(socket,relayRequest('status')); assert.equal((await readFrame(socket)).type,'relay-status');
  } finally {socket.destroy();}
  assert.equal(await relayStatus(b,endpoint),null);
  await run('member-invites','--enabled','off');
  await assert.rejects(relayInvite(a,endpoint),/only the relay owner/i);
  await run('untrust','--fingerprint',b.fingerprint);
  await assert.rejects(relayStatus(b,endpoint),/disconnected|refused/i);
  assert.match((await run('status')).stdout,new RegExp('TRUSTED=A '+a.fingerprint));
});
test('Unicode control characters in friend names are refused',async t=>{
  const {relay}=await fixture(t);
  const invite=await relay.createInvite();
  await assert.rejects(joinRelayInvite(await createIdentity(),invite.code,'Name\u0085'),/name|control/i);
  assert.equal(relay.trusted.length,0);
});
test('turning off member invites revokes outstanding tokens permanently',async t=>{
  const {relay,peer}=await fixture(t);
  const a=await createIdentity(),b=await createIdentity();
  await joinRelayInvite(a,(await relay.createInvite()).code,'A');
  const member=await relayInvite(a,peer);
  await relay.setMemberInvites(false); await relay.setMemberInvites(true);
  await assert.rejects(joinRelayInvite(b,member.code,'B'),/revoked|used|expired|not valid/i);
});
