import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const module = () => import('../dist/src/core/playit.js');
const agentId = '239a25b9-9377-4d34-be26-94f11ec1813e';
const tunnelId = '493875ca-042a-49ea-87ce-0734209d40f8';
const tunnel = { id:tunnelId,tunnel_type:'minecraft-java',user_enabled:true,disabled_by_admin:false,offline_reasons:null,origin:{type:'agent',details:{agent_id:agentId,config_invalid:null,config_data:{fields:[{name:'local_ip',value:'100.64.0.2'},{name:'local_port',value:'25565'}]}}},connect_addresses:[{type:'auto',value:{address:'example.tun.ply.gg'}}] };
async function connected(t, options={}) {
 const f=await fixture(t,{api:async(_key,route)=>route==='/v1/agents/rundata'?{agent_id:agentId}:{tunnels:[structuredClone(tunnel)]},...options});
 const file=path.join(f.root,'agent.txt');await writeFile(file,secret);await f.app.importAgentFile(file);return f;
}
test('matching relay is probed before advertising reachability',async t=>{
 let probed;const {app}=await connected(t,{probe:async ep=>{probed=ep;return true;}});
 const r=await app.check();assert.equal(r.state,'reachable');assert.equal(r.address,'example.tun.ply.gg');assert.equal(probed.host,'example.tun.ply.gg');
});
test('wrong target, wrong agent and disabled tunnels are rejected',async t=>{
 for(const mutate of [x=>x.origin.details.config_data.fields[1].value='47625',x=>x.origin.details.agent_id='c'.repeat(36),x=>x.user_enabled=false,x=>x.origin.details.config_invalid={},x=>x.offline_reasons=['AgentOffline']]){
 const bad=structuredClone(tunnel);mutate(bad);const {app}=await connected(t,{api:async(_k,r)=>r==='/v1/agents/rundata'?{agent_id:agentId}:{tunnels:[bad]}});assert.notEqual((await app.check()).state,'reachable');
 }
});
test('failed probe preserves reserved address without claiming reachability',async t=>{
 const {app}=await connected(t,{probe:async()=>false});const r=await app.check();assert.equal(r.state,'unreachable');assert.equal(r.address,'example.tun.ply.gg');
});
test('unsafe addresses do not trigger probes and errors never expose credentials',async t=>{
 const bad=structuredClone(tunnel);bad.connect_addresses[0].value.address='127.0.0.1:22';let probes=0;
 const {app}=await connected(t,{api:async(_k,r)=>r==='/v1/agents/rundata'?{agent_id:agentId}:{tunnels:[bad]},probe:async()=>{probes++;return true;}});assert.notEqual((await app.check()).state,'reachable');assert.equal(probes,0);
 const f=await connected(t);f.deps.api=async()=>{throw Error(secret)};assert.equal(JSON.stringify(await f.app.check()).includes(secret),false);
});
test('creation reuses matching tunnel and refuses the control port',async t=>{
 const {app}=await connected(t);assert.equal((await app.create()).address,'example.tun.ply.gg');
 const f=await connected(t,{gateway:async()=>({...relay,port:47625})});await assert.rejects(f.app.create(),/gateway/i);
});
const secret = 'a'.repeat(64); // Synthetic credential; never a real account.
const relay = { fingerprint: 'b'.repeat(64), controlPort: 47625, enabled: true, host: '100.64.0.2', port: 25565, ready: true, detail: 'ready' };
function vault() {
  const key = randomBytes(32);
  return { encrypt(text) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([c.update(text), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]); }, decrypt(data) { const c = createDecipheriv('aes-256-gcm', key, data.subarray(0,12)); c.setAuthTag(data.subarray(12,28)); return c.update(data.subarray(28), undefined, 'utf8') + c.final('utf8'); } };
}
async function fixture(t, overrides = {}) {
  const { PlayitIntegration } = await module();
  const root = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'seedhost-playit-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], v = vault();
  const deps = { vault: v, gateway: async () => relay, api: async (key, route) => { calls.push(route); assert.equal(key, secret); if (route === '/v1/agents/rundata') return { agent_id: agentId }; throw Error('Unexpected API request'); }, probe: async () => true, ...overrides };
  return { root, calls, deps, app: new PlayitIntegration(root, deps) };
}
test('playit is opt-in; importing an agent stores only an encrypted backend credential', async t => {
  const { app, root, calls, deps } = await fixture(t);
  assert.equal((await app.status()).state, 'off');
  assert.deepEqual(calls, []);
  const file = path.join(root, 'selected-secret.txt'); await writeFile(file, secret, { mode: 0o600 });
  await app.importAgentFile(file);
  const state = await app.status(); assert.equal(state.connected, true); assert.equal(state.state, 'unchecked');
  assert.equal(JSON.stringify(state).includes(secret), false);
  const stored = await readFile(path.join(root, 'playit.json'), 'utf8'); assert.equal(stored.includes(secret), false);
  // POSIX-only: Node's Windows mode bits do not prove owner-only NTFS ACLs.
  // Encryption/plaintext absence above remains asserted on every platform.
  if (process.platform !== 'win32') assert.equal((await stat(path.join(root, 'playit.json'))).mode & 0o777, 0o600, 'POSIX credential file is owner-only');
  else t.diagnostic('Windows credential encryption verified; NTFS ACL confinement is not verified by POSIX mode bits.');
  const { PlayitIntegration } = await module(); assert.equal((await new PlayitIntegration(root, deps).status()).connected, true);
  await app.disconnect(); assert.equal((await app.status()).state, 'off');
  assert.deepEqual(calls, ['/v1/agents/rundata']);
});
