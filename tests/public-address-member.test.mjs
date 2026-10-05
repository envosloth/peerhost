import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { SeedHostApplication } from '../dist/src/core/application.js';
import { RelayNode } from '../dist/src/core/relay.js';
import { PublicAddress } from '../dist/src/core/public-address.js';

// A gaming PC presses "Get my address"; the always-on PC (real relay over pinned TLS) makes it, reusing
// an already-approved playit agent so no browser step is needed. Fake playit API; no real account.
const KEY = 'd'.repeat(64), AGENT = '239a25b9-9377-4d34-be26-94f11ec1813e';
function vault() {
  const key = randomBytes(32);
  return { encrypt(t) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, c.update(t), c.final(), c.getAuthTag()]); },
    decrypt(d) { const c = createDecipheriv('aes-256-gcm', key, d.subarray(0, 12)); c.setAuthTag(d.subarray(-16)); return c.update(d.subarray(12, -16), undefined, 'utf8') + c.final('utf8'); } };
}

test('a paired gaming PC turns on the always-on PC’s public address with one call; non-members cannot', async t => {
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'public-member-'));
  const relay = new RelayNode(path.join(root, 'relay'), await createIdentity(), { log: () => {} });
  const app = new SeedHostApplication(path.join(root, 'gaming'), await createIdentity());
  const stranger = new SeedHostApplication(path.join(root, 'stranger'), await createIdentity());
  t.after(async () => { await app.close(); await stranger.close(); await relay.close(); await rm(root, { recursive: true, force: true }); });
  await relay.open(); await relay.listen({ host: '127.0.0.1', port: 0 }); await relay.listenGame({ host: '127.0.0.1', port: 0 });
  let tunnels = [], opened = 0;
  const secretFile = path.join(root, 'existing-playit-secret.txt'); await writeFile(secretFile, KEY + '\n');
  relay.publicAddress = new PublicAddress(path.join(root, 'relay'), {
    vault: vault(), externalAgent: true, target: () => ({ host: '127.0.0.1', port: relay.gameEndpoint.port }),
    adoptKey: async () => (await import('node:fs/promises')).readFile(secretFile, 'utf8').then(s => s.trim()),
    openBrowser: async () => { opened++; },
    claim: async () => { throw new Error('no browser approval expected when a key is adopted'); },
    api: async (key, route, payload) => {
      assert.equal(key, KEY);
      if (route === '/v1/agents/rundata') return { agent_id: AGENT };
      if (route === '/v1/tunnels/list') return { tunnels };
      if (route === '/tunnels/create') {
        tunnels = [{ id: '493875ca-042a-49ea-87ce-0734209d40f8', tunnel_type: 'minecraft-java', origin: { type: 'agent', details: { agent_id: AGENT, config_data: { fields: [{ name: 'local_ip', value: payload.origin.data.local_ip }, { name: 'local_port', value: String(payload.origin.data.local_port) }] } } }, offline_reasons: null, connect_addresses: [{ value: { address: 'friends-world.tun.ply.gg' } }] }];
        return {};
      }
      throw new Error(route);
    },
    probe: async () => true,
  });
  await app.open(); await stranger.open();
  await app.joinWithInvite({ code: (await relay.createInvite({ hours: 1 })).code, name: 'Angel' });
  assert.equal((await app.publicAddress('public-status')).state, 'off');
  let status = await app.publicAddress('public-enable');
  for (let i = 0; i < 200 && status.state !== 'reachable'; i++) { await new Promise(r => setTimeout(r, 20)); status = await app.publicAddress('public-status'); if (status.state === 'error') break; }
  assert.equal(status.state, 'reachable', status.detail);
  assert.equal(status.address, 'friends-world.tun.ply.gg');
  assert.equal(opened, 0, 'adopted key: no browser step');
  assert.equal((await app.getState()).gateway.enabled, true, 'this PC’s link to the always-on PC is turned on too');
  // Someone who never joined cannot touch it.
  await stranger.addPeer({ name: 'relay', fingerprint: relay.identity.fingerprint, host: '127.0.0.1', port: relay.endpoint.port });
  await stranger.saveRelay({ fingerprint: relay.identity.fingerprint, parkOnStop: false });
  await assert.rejects(stranger.publicAddress('public-disable'));
  assert.equal((await app.publicAddress('public-status')).state, 'reachable');
  assert.equal((await app.publicAddress('public-disable')).state, 'off');
});
