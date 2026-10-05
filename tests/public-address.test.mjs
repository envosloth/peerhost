import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PublicAddress } from '../dist/src/core/public-address.js';

// One-click public address with a fake playit (API, approval and agent binary). No real account or network.
const scratch = process.env.TMPDIR;
assert.ok(scratch);
const KEY = 'c'.repeat(64), AGENT = '239a25b9-9377-4d34-be26-94f11ec1813e', TUNNEL = '493875ca-042a-49ea-87ce-0734209d40f8';
// A stand-in "agent": a Node script that proves it was given the key file, then stays running like the real one.
const agentScript = Buffer.from(`#!${process.execPath}
const fs = require('fs'); const a = process.argv; const secret = a[a.indexOf('--secret-path') + 1];
fs.writeFileSync(require('path').join(require('path').dirname(secret), 'agent-saw-key'), fs.readFileSync(secret, 'utf8').trim() === '${KEY}' ? 'yes' : 'no');
setInterval(() => {}, 1000);
`);
function vault() {
  const key = randomBytes(32);
  return { encrypt(text) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, c.update(text), c.final(), c.getAuthTag()]); },
    decrypt(data) { const c = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); c.setAuthTag(data.subarray(-16)); return c.update(data.subarray(12, -16), undefined, 'utf8') + c.final('utf8'); } };
}
async function setup(t, overrides = {}) {
  const root = await mkdtemp(path.join(scratch, 'public-address-'));
  const calls = [], opened = [];
  let tunnels = [], setupState = 'WaitingForUserVisit', approveAfter = 2, polls = 0;
  const deps = {
    vault: vault(), target: () => ({ host: '127.0.0.1', port: 25566 }),
    binary: { url: 'https://github.com/fixture/playit', sha256: createHash('sha256').update(agentScript).digest('hex'), file: 'playit-fixture' },
    fetchBinary: async () => { calls.push('download'); return agentScript; },
    openBrowser: async (url) => { opened.push(url); },
    claim: async (route, payload) => {
      calls.push(route);
      assert.match(payload.code, /^[a-f0-9]{10}$/);
      if (route === '/claim/setup') { if (++polls >= approveAfter) setupState = overrides.reject ? 'UserRejected' : 'UserAccepted'; return { status: 'success', data: setupState }; }
      return setupState === 'UserAccepted' ? { status: 'success', data: { secret_key: KEY } } : { status: 'fail', data: 'NotAccepted' };
    },
    api: async (key, route, payload) => {
      assert.equal(key, KEY); calls.push(route);
      if (route === '/v1/agents/rundata') return { agent_id: AGENT };
      if (route === '/v1/tunnels/list') return { tunnels };
      if (route === '/tunnels/create') {
        assert.deepEqual(payload.origin, { type: 'agent', data: { agent_id: AGENT, local_ip: '127.0.0.1', local_port: 25566 } });
        tunnels = [{ id: TUNNEL, tunnel_type: 'minecraft-java', origin: { type: 'agent', details: { agent_id: AGENT, config_data: { fields: [{ name: 'local_ip', value: '127.0.0.1' }, { name: 'local_port', value: '25566' }] } } }, offline_reasons: null, connect_addresses: [{ value: { address: 'mossy-hollow.tun.ply.gg' } }] }];
        return {};
      }
      throw new Error('unexpected ' + route);
    },
    probe: async ({ host }) => { calls.push('probe:' + host); return overrides.probe ?? true; },
    pollMs: 5, claimTimeoutMs: 5000, ...overrides.deps,
  };
  const pa = new PublicAddress(root, deps);
  t.after(async () => { await pa.close(); await rm(root, { recursive: true, force: true }); });
  const settle = async (states) => { for (let i = 0; i < 400; i++) { if (states.includes(pa.status().state)) return pa.status(); await new Promise(r => setTimeout(r, 10)); } return pa.status(); };
  return { root, pa, calls, opened, settle, deps };
}

test('one click: download, browser approval, hidden agent, tunnel to this PC, verified live address', async t => {
  const { root, pa, calls, opened, settle } = await setup(t);
  await pa.enable();
  const status = await settle(['reachable', 'error']);
  assert.equal(status.state, 'reachable', status.detail);
  assert.equal(status.address, 'mossy-hollow.tun.ply.gg');
  assert.equal(opened.length, 1); assert.match(opened[0], /^https:\/\/playit\.gg\/claim\/[a-f0-9]{10}$/);
  assert.ok(calls.indexOf('download') < calls.indexOf('/claim/setup'), 'binary verified before approval');
  assert.ok(calls.includes('/tunnels/create')); assert.ok(calls.includes('probe:mossy-hollow.tun.ply.gg'));
  const dir = path.join(root, 'public-address');
  assert.equal(await readFile(path.join(dir, 'agent-saw-key'), 'utf8'), 'yes', 'agent was started with the approved key');
  const saved = await readFile(path.join(dir, 'playit.json'), 'utf8');
  assert.equal(saved.includes(KEY), false, 'key is stored encrypted only');
  assert.equal((await stat(path.join(dir, 'playit.json'))).mode & 0o777, 0o600);
  // Turning it off and on again reuses the approved agent and tunnel: no browser, no download, no new tunnel.
  await pa.disable();
  assert.equal(pa.status().state, 'off');
  const before = { opened: opened.length, creates: calls.filter(c => c === '/tunnels/create').length, downloads: calls.filter(c => c === 'download').length };
  await pa.enable();
  assert.equal((await settle(['reachable', 'error'])).state, 'reachable');
  assert.deepEqual({ opened: opened.length, creates: calls.filter(c => c === '/tunnels/create').length, downloads: calls.filter(c => c === 'download').length }, before);
});

test('a tampered download is refused and never run', async t => {
  const { pa, calls, settle } = await setup(t, { deps: { fetchBinary: async () => Buffer.from('#!/bin/sh\necho evil\n') } });
  await pa.enable();
  const status = await settle(['error']);
  assert.match(status.detail, /checksum/);
  assert.equal(calls.includes('/claim/setup'), false, 'no approval is requested for an unverified app');
});

test('a declined approval stops cleanly without saving anything', async t => {
  const { root, pa, settle } = await setup(t, { reject: true });
  await pa.enable();
  assert.match((await settle(['error'])).detail, /declined/);
  assert.equal((await readdir(path.join(root, 'public-address'))).includes('playit.json'), false);
});

test('reserved but not answering is reported honestly', async t => {
  const { pa, settle } = await setup(t, { probe: false });
  await pa.enable();
  const status = await settle(['reserved', 'error']);
  assert.equal(status.state, 'reserved'); assert.equal(status.address, 'mossy-hollow.tun.ply.gg');
  assert.match(status.detail, /whenever someone is hosting/);
});

test('needs something to point at first', async t => {
  const { pa } = await setup(t, { deps: { target: () => null } });
  await assert.rejects(pa.enable(), /world first/);
});
