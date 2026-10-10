import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import * as ports from '../dist/src/core/port-preflight.js';

const entry = (address, family = 'IPv6', scopeid = 0) => ({
  address, family, scopeid, netmask: family === 'IPv6' ? 'ffff:ffff:ffff:ffff::' : '255.255.255.0',
  mac: '00:00:00:00:00:00', internal: false, cidr: null,
});
const fixture = {
  eno1: [entry('192.0.2.1', 'IPv4'), entry('fe80::8279:d482:8816:5e52', 'IPv6', 2)],
};
async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'port-preflight-scopes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function properties(root, port, scope = '') {
  await writeFile(path.join(root, 'server.properties'), `server-ip=${scope}\nserver-port=${port}\n`);
}

// Interface fixtures and a recording transport are necessary to exercise Linux on a Windows host.
// Real socket safety is covered separately below; no error is suppressed by the product.
test('Linux wildcard preflight retains the interface-name zone from networkInterfaces', async t => {
  const root = await directory(t);
  await properties(root, 48674);
  const originalInterfaces = os.networkInterfaces;
  const originalServer = net.createServer;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const observed = [];
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    os.networkInterfaces = () => fixture;
    net.createServer = () => {
      const probe = new EventEmitter();
      probe.listen = (options, ready) => { observed.push(options); queueMicrotask(ready); };
      probe.close = done => done();
      return probe;
    };
    syncBuiltinESMExports();
    await ports.preflightMinecraftPort(root);
    assert.deepEqual(observed, [
      { port: 48674, host: '0.0.0.0', exclusive: true },
      { port: 48674, host: '192.0.2.1', exclusive: true },
      { port: 48674, host: 'fe80::8279:d482:8816:5e52%eno1', exclusive: true },
    ]);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    os.networkInterfaces = originalInterfaces;
    net.createServer = originalServer;
    syncBuiltinESMExports();
  }
});

test('host derivation uses Linux interface names and Windows numeric scope IDs without broadening explicit scopes', () => {
  const interfaces = {
    ...fixture,
    second: [entry('FE90::1', 6, 7), entry('febf::1', 'IPv6', 7),
      entry('fe80::1%existing', 'IPv6', 7), entry('fec0::1', 'IPv6', 7),
      entry('2001:db8::1', 'IPv6', 7), entry('::1'), entry('fe80::2', 'IPv6', 0)],
    absent: undefined,
  };
  const common = ['fe80::1%existing', 'fec0::1', '2001:db8::1', '::1'];
  assert.deepEqual(ports.deriveMinecraftProbeHosts('', interfaces, 'linux'), [
    '0.0.0.0', '192.0.2.1', 'fe80::8279:d482:8816:5e52%eno1',
    'FE90::1%second', 'febf::1%second', ...common, 'fe80::2%second',
  ]);
  assert.deepEqual(ports.deriveMinecraftProbeHosts('::', interfaces, 'win32'), [
    '0.0.0.0', '192.0.2.1', 'fe80::8279:d482:8816:5e52%2',
    'FE90::1%7', 'febf::1%7', ...common, 'fe80::2%second',
  ]);
  assert.deepEqual(ports.deriveMinecraftProbeHosts('0.0.0.0', interfaces, 'linux'), ['0.0.0.0', '192.0.2.1']);
  for (const scope of ['fe80::1%eno1', 'fe80::1%2', 'fe80::1', '127.0.0.2', ' example.invalid ']) {
    assert.deepEqual(ports.deriveMinecraftProbeHosts(scope, interfaces, 'linux'), [scope]);
    assert.deepEqual(ports.deriveMinecraftProbeHosts(scope, interfaces, 'win32'), [scope]);
  }
});

test('Java-properties escaped, continued and duplicate explicit scopes are passed through exactly', async t => {
  const root = await directory(t);
  const originalServer = net.createServer;
  const observed = [];
  try {
    net.createServer = () => {
      const probe = new EventEmitter();
      probe.listen = (options, ready) => { observed.push(options.host); queueMicrotask(ready); };
      probe.close = done => done();
      return probe;
    };
    syncBuiltinESMExports();
    const cases = [
      ['server\\u002dip=fe80\\:\\:1%eno1\n', 'fe80::1%eno1'],
      ['server-ip=fe80::1%2\n', 'fe80::1%2'],
      ['server-ip=fe80::1%en\\\n  o1\n', 'fe80::1%eno1'],
      ['server-ip=127.0.0.1\n#server-ip=ignored\nserver-ip=fe80::1%eno1\n', 'fe80::1%eno1'],
    ];
    for (const [text, expected] of cases) {
      await writeFile(path.join(root, 'server.properties'), text + 'server-port=48674\n');
      await ports.preflightMinecraftPort(root);
      assert.equal(observed.at(-1), expected);
    }
    assert.equal(observed.length, cases.length);
  } finally {
    net.createServer = originalServer;
    syncBuiltinESMExports();
  }
});

async function listener(t, host, ipv6Only) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host, ipv6Only, exclusive: true }, resolve);
  });
  t.after(() => server.listening ? new Promise(resolve => server.close(resolve)) : undefined);
  return server;
}
for (const host of ['127.0.0.1', '::1']) {
  test(`real ${host} occupied bind is rejected and the released port is free`, async t => {
    const root = await directory(t);
    const server = await listener(t, host, true);
    const port = server.address().port;
    await properties(root, port, host);
    await assert.rejects(ports.preflightMinecraftPort(root), error => {
      assert.match(error.message, /Minecraft bind port .* is unavailable/);
      assert.equal(error.cause.code, 'EADDRINUSE');
      return true;
    });
    await new Promise(resolve => server.close(resolve));
    await ports.preflightMinecraftPort(root);
  });
}

test('IPv4 wildcard still detects an occupied specific IPv4 listener', async t => {
  const root = await directory(t);
  const server = await listener(t, '127.0.0.1');
  await properties(root, server.address().port, '0.0.0.0');
  await assert.rejects(ports.preflightMinecraftPort(root), /unavailable/);
});

test('blank and IPv6 wildcard scopes still detect an occupied IPv6-only listener', async t => {
  const root = await directory(t);
  const server = await listener(t, '::1', true);
  for (const scope of ['', '::']) {
    await properties(root, server.address().port, scope);
    await assert.rejects(ports.preflightMinecraftPort(root), /unavailable/);
  }
});

test('IPv4-only wildcard scope excludes an IPv6-only occupied port and remains free', async t => {
  const root = await directory(t);
  const server = await listener(t, '::1', true);
  await properties(root, server.address().port, '0.0.0.0');
  await ports.preflightMinecraftPort(root);
});

test('explicit IPv4 scope does not expand to an unrelated occupied address', async t => {
  const root = await directory(t);
  const server = await listener(t, '127.0.0.1');
  await properties(root, server.address().port, '127.0.0.2');
  await ports.preflightMinecraftPort(root);
});

test('invalid explicit bind addresses remain errors with their original cause', async t => {
  const root = await directory(t);
  await properties(root, 48674, '2001:db8::1234');
  await assert.rejects(ports.preflightMinecraftPort(root), error => {
    assert.match(error.message, /unavailable/);
    assert.ok(error.cause instanceof Error);
    return true;
  });
});
