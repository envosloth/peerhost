import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readHandshake, statusResponse, serverFixture, frameOf, withPacketId } from './fixtures/minecraft-status-fixtures.mjs';

let queryLocalMinecraft;
try {
  ({ queryLocalMinecraft } = await import('../dist/src/core/minecraft-status.js'));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

// Loopback protocol fixtures are not Minecraft proof; they exercise framing, validation and bounds.
const statusJson = (overrides = {}) => JSON.stringify({
  version: { name: '1.21.1', protocol: 767 },
  players: { max: 20, online: 3, sample: [{ name: 'Alice', id: '11111111-1111-1111-1111-111111111111' }, { name: 'Bob' }] },
  description: { text: 'Fixture world' },
  ...overrides,
});

test('a status query speaks the MCP handshake to 127.0.0.1 and returns validated player data', async t => {
  assert.equal(typeof queryLocalMinecraft, 'function', 'queryLocalMinecraft must be implemented');
  const remotes = [];
  const fixture = await serverFixture(t, (socket, received) => {
    remotes.push(socket.remoteAddress);
    const request = readHandshake(received);
    if (request) socket.end(statusResponse(statusJson()));
  });
  const result = await queryLocalMinecraft(fixture.port, 2_000);
  assert.deepEqual(result, {
    online: 3,
    max: 20,
    sample: [{ name: 'Alice', id: '11111111-1111-1111-1111-111111111111' }, { name: 'Bob' }],
    error: null,
  });
  const request = readHandshake(fixture.connectedBuffer());
  assert.deepEqual(request, {
    packetId: 0, protocol: 770, host: '127.0.0.1', port: fixture.port, nextState: 1,
    trailing: 0, requestId: 0, requestTrailing: 0,
  });
  assert.ok(remotes.length > 0 && remotes.every(remote => remote === '127.0.0.1'), 'IPv4 loopback only');
});

test('a refused loopback connection reports a stopped server, not an error', async t => {
  const probe = await serverFixture(t, () => {});
  const port = probe.port;
  await new Promise(resolve => probe.server.close(resolve));
  const result = await queryLocalMinecraft(port, 1_000);
  assert.deepEqual(result, { online: 0, max: null, sample: [], error: null });
});

// Adversarial replies: each ends the socket one way or another, and every one must fail closed.
const malformedReplies = [
  ['a frame length far beyond the byte budget', () => Buffer.from([0xff, 0xff, 0xff, 0x7f, 0x00])],
  ['a declared length larger than the actual bytes', () => Buffer.concat([Buffer.from([0x64]), Buffer.from('short')])],
  ['a valid frame carrying the wrong packet id', () => withPacketId(statusResponse(statusJson()), 0x7f)],
  ['a valid frame whose string length overruns the frame', () => frameOf(Buffer.concat([Buffer.from([0x00, 0x7f]), Buffer.from('tiny')]))],
  ['a frame of JSON that is not a status document', () => statusResponse(JSON.stringify({ hello: 'world' }))],
  ['a status document whose players field is not an object', () => statusResponse(JSON.stringify({ players: 42 }))],
  ['a status document with a negative online count', () => statusResponse(statusJson({ players: { max: 20, online: -3, sample: [] } }))],
  ['a status document with a fractional online count', () => statusResponse(statusJson({ players: { max: 20, online: 1.5, sample: [] } }))],
  ['json that does not parse at all', () => statusResponse('{not json')],
  ['a VarInt that continues past five bytes', () => Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0x01])],
];

test('malformed or hostile status replies fail closed with nulls and an error', async t => {
  for (const [label, build] of malformedReplies) {
    const fixture = await serverFixture(t, (socket, received) => { if (readHandshake(received)) socket.write(Buffer.from(build())); });
    const result = await queryLocalMinecraft(fixture.port, 1_000);
    assert.equal(result.online, null, label);
    assert.equal(result.max, null, label);
    assert.deepEqual(result.sample, [], label);
    assert.ok(result.error, label);
  }
});

test('a server that closes mid-frame is an error, not a fabricated zero', async t => {
  const fixture = await serverFixture(t, (socket, received) => { if (readHandshake(received)) socket.end(Buffer.from([0x80])); });
  const result = await queryLocalMinecraft(fixture.port, 1_000);
  assert.deepEqual(result, { online: null, max: null, sample: [], error: 'Minecraft server status unavailable' });
});

test('a truly silent server is bounded by the timeout', async t => {
  const fixture = await serverFixture(t, () => {}, { allowHalfOpen: true });
  const started = Date.now();
  const result = await queryLocalMinecraft(fixture.port, 300);
  const elapsed = Date.now() - started;
  assert.equal(result.online, null);
  assert.ok(result.error, 'timeout is reported, not hidden');
  assert.ok(elapsed >= 250 && elapsed < 2_000, `timeout bounded the query: ${elapsed}ms`);
});

test('the timeout argument is clamped to short bounds in both directions', async t => {
  const fixture = await serverFixture(t, () => {}, { allowHalfOpen: true });
  const quick = Date.now();
  await queryLocalMinecraft(fixture.port, 1);
  const quickElapsed = Date.now() - quick;
  assert.ok(quickElapsed >= 80 && quickElapsed < 1_500, `tiny timeout clamped up: ${quickElapsed}ms`);
  const slow = Date.now();
  await queryLocalMinecraft(fixture.port, 60_000);
  const slowElapsed = Date.now() - slow;
  assert.ok(slowElapsed < 6_500, `huge timeout clamped down to the short ceiling: ${slowElapsed}ms`);
});

test('invalid ports fail fast without touching the network', async t => {
  const fixture = await serverFixture(t, () => {});
  for (const port of [0, -1, 65_536, 1.5, NaN, Infinity, '25565']) {
    const result = await queryLocalMinecraft(port);
    assert.deepEqual(result, { online: null, max: null, sample: [], error: 'Invalid Minecraft server port' }, String(port));
  }
  const nearMiss = await queryLocalMinecraft(fixture.port + 0.5);
  assert.equal(nearMiss.error, 'Invalid Minecraft server port');
  await delay(150);
  assert.equal(fixture.received.length, 0, 'no socket was opened for an invalid port');
});

test('the 100-entry sample cap keeps the first entries and drops the rest', async t => {
  const entries = Array.from({ length: 150 }, (_, index) => ({ name: `Player${index}` }));
  const fixture = await serverFixture(t, (socket, received) => {
    if (readHandshake(received)) socket.end(statusResponse(statusJson({ players: { max: 150, online: 150, sample: entries } })));
  });
  const result = await queryLocalMinecraft(fixture.port, 1_000);
  assert.equal(result.error, null);
  assert.equal(result.sample.length, 100);
  assert.equal(result.sample[0].name, 'Player0');
  assert.equal(result.sample[99].name, 'Player99');
});

test('player sample entries with hostile names fail closed', async t => {
  for (const sample of [[{ name: 'x'.repeat(200) }], [{ name: '' }], [{ name: 42 }], ['not-an-object']]) {
    const fixture = await serverFixture(t, (socket, received) => {
      if (readHandshake(received)) socket.end(statusResponse(statusJson({ players: { max: 1, online: 1, sample } })));
    });
    const result = await queryLocalMinecraft(fixture.port, 1_000);
    assert.equal(result.online, null, JSON.stringify(sample).slice(0, 60));
    assert.ok(result.error);
  }
});

test('an overlong entry id is dropped while the readable entry survives', async t => {
  const fixture = await serverFixture(t, (socket, received) => {
    if (readHandshake(received)) socket.end(statusResponse(statusJson({ players: { max: 2, online: 2, sample: [{ name: 'ok', id: 'x'.repeat(200) }, { name: 'fine' }] } })));
  });
  const result = await queryLocalMinecraft(fixture.port, 1_000);
  assert.equal(result.error, null);
  assert.deepEqual(result.sample, [{ name: 'ok' }, { name: 'fine' }]);
});

test('a valid but oversized status document beyond the frame cap is rejected', async t => {
  const fixture = await serverFixture(t, (socket, received) => {
    if (readHandshake(received)) socket.end(statusResponse(statusJson({ description: { text: 'x'.repeat(600 * 1024) } })));
  });
  const result = await queryLocalMinecraft(fixture.port, 2_000);
  assert.equal(result.online, null);
  assert.ok(result.error);
});

test('a reply with smuggled trailing frames is rejected', async t => {
  const fixture = await serverFixture(t, (socket, received) => {
    if (readHandshake(received)) socket.end(Buffer.concat([statusResponse(statusJson()), frameOf(Buffer.from([0x00, 0x01, 0x00]))]));
  });
  const result = await queryLocalMinecraft(fixture.port, 1_000);
  assert.equal(result.online, null);
  assert.ok(result.error);
});

test('a flooded reply is abandoned quickly once the byte budget is passed', async t => {
  const fixture = await serverFixture(t, (socket, received) => {
    if (!readHandshake(received)) return;
    const blob = Buffer.alloc(65_536, 0x41);
    for (let sent = 0; sent < 20; sent++) socket.write(blob); // 1.25 MiB, socket deliberately left open
  }, { allowHalfOpen: true });
  const started = Date.now();
  const result = await queryLocalMinecraft(fixture.port, 5_000);
  const elapsed = Date.now() - started;
  assert.equal(result.online, null);
  assert.ok(result.error);
  assert.ok(elapsed < 3_000, `budget aborted the read early: ${elapsed}ms`);
});

test('a chunked reply arriving in fragments is still parsed', async t => {
  const fixture = await serverFixture(t, (socket, received) => {
    if (!readHandshake(received)) return;
    const reply = statusResponse(statusJson());
    for (const byte of reply) socket.write(Buffer.from([byte]));
    socket.end();
  });
  const result = await queryLocalMinecraft(fixture.port, 3_000);
  assert.equal(result.error, null);
  assert.equal(result.online, 3);
});

// Socket-release proof: sockets created by the module live in this process, so
// process.getActiveResourcesInfo() shows any client socket the query failed to release
// (a destroyed remote is invisible to its peer on Windows, so server-side state cannot prove it).
const countClientSockets = () => process.getActiveResourcesInfo().filter(name => name === 'TCPSocketWrap').length;
const waitFor = async (check, timeoutMs = 2_000) => {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) return false;
    await delay(25);
  }
  return true;
};

test('the client socket is released after success, refusal, timeout, malformed reply, and flood', async t => {
  const ok = await serverFixture(t, (socket, received) => {
    if (readHandshake(received)) socket.end(statusResponse(statusJson()));
  });
  const silent = await serverFixture(t, () => {}, { allowHalfOpen: true });
  const malformed = await serverFixture(t, (socket, received) => {
    if (readHandshake(received)) socket.write(Buffer.from([0x80]));
  });
  const flood = await serverFixture(t, (socket, received) => {
    if (readHandshake(received)) for (let sent = 0; sent < 20; sent++) socket.write(Buffer.alloc(65_536, 0x41));
  }, { allowHalfOpen: true });

  await queryLocalMinecraft(ok.port, 1_000);
  assert.equal(ok.openSockets(), 0, 'a completed query closes both sides');
  await queryLocalMinecraft(silent.port, 200);
  await queryLocalMinecraft(malformed.port, 400);
  await queryLocalMinecraft(flood.port, 5_000);
  for (const fixture of [ok, silent, malformed, flood]) fixture.destroyAll();
  assert.ok(await waitFor(() => countClientSockets() === 0), `no TCP sockets remain: ${countClientSockets()}`);
});
