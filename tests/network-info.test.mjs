import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { privateLanAddresses, readServerPort } from '../dist/src/core/network-info.js';

test('only private, non-internal IPv4 addresses are offered as LAN join addresses', () => {
  const interfaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
    wg0: [{ address: '10.8.0.2', family: 'IPv4', internal: false }],
    docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
    wan: [{ address: '203.0.113.9', family: 'IPv4', internal: false }],
    tailscale0: [{ address: '100.97.20.84', family: 'IPv4', internal: false }],
  };
  assert.deepEqual(privateLanAddresses(interfaces), ['192.168.1.20', '10.8.0.2']);
});

test('server port comes from server.properties, defaulting to 25565', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'seedhost-port-'));
  assert.equal(await readServerPort(dir), 25565);
  await writeFile(path.join(dir, 'server.properties'), '#comment\nmotd=hi\nserver-port=25570\n');
  assert.equal(await readServerPort(dir), 25570);
  await writeFile(path.join(dir, 'server.properties'), 'server-port=banana\n');
  assert.equal(await readServerPort(dir), 25565);
});
