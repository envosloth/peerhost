import assert from "node:assert/strict";
import { createHash, createPublicKey, X509Certificate } from "node:crypto";
import test, { type TestContext } from "node:test";
import { once } from "node:events";
import { connect as connectTcp, createServer as createTcpServer, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createServer as createTlsServer, connect as connectTls, type TLSSocket } from "node:tls";
import * as peer from "../src/core/peer-transport.js";
import type { PeerIdentity as Identity } from "../src/core/peer-transport.js";

test("createIdentity generates distinct in-process keys and SHA256 raw-certificate pins", async () => {
  assert.equal(typeof peer.createIdentity, "function");
  const first = await peer.createIdentity();
  const second = await peer.createIdentity();
  const cert = new X509Certificate(first.certPem);
  assert.match(first.keyPem, /BEGIN PRIVATE KEY/);
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(first.fingerprint, createHash("sha256").update(cert.raw).digest("hex"));
  assert.equal(cert.publicKey.export({ format: "pem", type: "spki" }),
    createPublicKey(first.keyPem).export({ format: "pem", type: "spki" }));
  assert.equal(cert.verify(cert.publicKey), true);
  assert.equal(cert.ca, false);
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.notEqual(first.keyPem, second.keyPem);
});

async function identities() {
  const [server, client] = await Promise.all([peer.createIdentity(), peer.createIdentity()]);
  return { server: server!, client: client! };
}

async function listen(t: TestContext, identity: Identity, pins: string[],
  onConnection: (socket: TLSSocket, fingerprint: string) => void = () => {}) {
  const listener = await peer.listenPeer(identity, pins, onConnection);
  t.after(() => listener.close());
  return listener;
}

test("paired loopback peers present both certificates and echo only through the verified callback",
  { timeout: 10000 }, async (t) => {
    assert.equal(typeof peer.listenPeer, "function");
    assert.equal(typeof peer.connectPeer, "function");
    const { server, client } = await identities();
    let receivedFingerprint: string | undefined;
    const listener = await listen(t, server, [client.fingerprint], (socket, fingerprint) => {
      receivedFingerprint = fingerprint;
      assert.ok(["TLSv1.2", "TLSv1.3"].includes(socket.getProtocol()!));
      assert.equal(createHash("sha256").update(socket.getPeerCertificate().raw).digest("hex"), client.fingerprint);
      socket.once("data", (data: Buffer) => socket.end(data));
    });
    assert.equal(listener.host, "127.0.0.1");
    assert.ok(listener.port > 0);
    const socket = await peer.connectPeer(client, server.fingerprint, listener.host, listener.port);
    t.after(() => socket.destroy());
    assert.ok(["TLSv1.2", "TLSv1.3"].includes(socket.getProtocol()!));
    assert.equal(createHash("sha256").update(socket.getPeerCertificate().raw).digest("hex"), server.fingerprint);
    const response = once(socket, "data");
    socket.resume();
    socket.write("pinned echo");
    assert.equal((await response)[0].toString(), "pinned echo");
    assert.equal(receivedFingerprint, client.fingerprint);
    socket.destroy();
  });

test("connectPeer rejects the wrong server certificate pin before exposing a socket", { timeout: 10000 }, async (t) => {
  const { server, client } = await identities();
  const listener = await listen(t, server, [client.fingerprint]);
  const attempt = peer.connectPeer(client, "00".repeat(32), listener.host, listener.port)
    .then((socket) => { socket.destroy(); return socket; });
  await assert.rejects(attempt, /server.*fingerprint|server.*pin/i);
});

test("unknown client fails closed without callback or application bytes", { timeout: 10000 }, async (t) => {
  const { server, client } = await identities();
  let admitted = 0;
  const listener = await listen(t, server, [], (socket) => {
    admitted += 1;
    socket.write("secret application bytes");
  });
  const attempt = peer.connectPeer(client, server.fingerprint, listener.host, listener.port)
    .then((socket) => { socket.destroy(); return socket; });
  await assert.rejects(attempt, /closed|disconnect|rejected/i);
  assert.equal(admitted, 0);
});

test("claiming a trusted fingerprint string cannot authorize a different certificate or a stolen certificate without its key",
  { timeout: 10000 }, async (t) => {
    const { server, client } = await identities();
    const attacker = await peer.createIdentity();
    let admitted = 0;
    const listener = await listen(t, server, [client.fingerprint], () => { admitted += 1; });
    await assert.rejects(peer.connectPeer({ ...attacker, fingerprint: client.fingerprint },
      server.fingerprint, listener.host, listener.port), /disconnect|closed/i);
    await assert.rejects(peer.connectPeer({ ...client, keyPem: attacker.keyPem },
      server.fingerprint, listener.host, listener.port), /key values mismatch/i);
    assert.equal(admitted, 0);
  });

test("a TLS client with no certificate receives no application bytes and no callback", { timeout: 10000 }, async (t) => {
  const { server, client } = await identities();
  let admitted = 0;
  const listener = await listen(t, server, [client.fingerprint], () => { admitted += 1; });
  const socket = connectTls({ host: listener.host, port: listener.port, rejectUnauthorized: false,
    minVersion: "TLSv1.2" });
  t.after(() => socket.destroy());
  let received = 0;
  socket.on("error", () => {});
  socket.on("data", (data: Buffer) => { received += data.length; });
  socket.resume();
  await within(closed(socket), 1000);
  assert.equal(admitted, 0);
  assert.equal(received, 0);
});

test("malformed fingerprints fail before listening or dialing", async () => {
  const identity = await peer.createIdentity();
  for (const invalid of ["", "AB".repeat(32), "ab:".repeat(31) + "ab", "g".repeat(64)]) {
    await assert.rejects(peer.listenPeer(identity, [invalid], () => {})
      .then(async (listener) => { await listener.close(); return listener; }), /fingerprint/i);
    await assert.rejects(peer.connectPeer(identity, invalid, "127.0.0.1", 1), /fingerprint/i);
  }
});

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Test deadline exceeded")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function closed(socket: Socket): Promise<void> {
  if (socket.closed) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

test("listener close tears down active TLS and unfinished handshakes and is idempotent",
  { timeout: 10000 }, async () => {
    const { server, client } = await identities();
    const listener = await peer.listenPeer(server, [client.fingerprint], () => {});
    const socket = await peer.connectPeer(client, server.fingerprint, listener.host, listener.port);
    const stalled = connectTcp(listener.port, listener.host);
    stalled.on("error", () => {});
    try {
      await once(stalled, "connect");
      await delay(10); // Allow the accept event to run before teardown.
      const gone = Promise.all([closed(socket), closed(stalled)]);
      await within(listener.close(), 500);
      await within(gone, 500);
      await within(Promise.all([listener.close(), listener.close()]), 500);
      await assert.rejects(new Promise<void>((resolve, reject) => {
        const probe = connectTcp(listener.port, listener.host);
        probe.once("error", reject);
        probe.once("connect", () => { probe.destroy(); resolve(); });
      }), /ECONNREFUSED/);
    } finally {
      socket.destroy();
      stalled.destroy();
      await listener.close().catch(() => {});
    }
  });

test("listener destroys a TCP client that never completes TLS within five seconds",
  { timeout: 10000 }, async (t) => {
    const identity = await peer.createIdentity();
    let admitted = 0;
    const listener = await listen(t, identity, [], () => { admitted += 1; });
    const stalled = connectTcp(listener.port, listener.host);
    stalled.on("error", () => {});
    t.after(() => stalled.destroy());
    await once(stalled, "connect");
    await within(closed(stalled), 6500);
    assert.equal(admitted, 0);
  });

async function uncooperative(t: TestContext, identity?: Identity) {
  const sockets = new Set<Socket>();
  const server = identity ? createTlsServer({
    key: identity.keyPem, cert: identity.certPem,
    minVersion: "TLSv1.2", requestCert: true, rejectUnauthorized: false,
  }) : createTcpServer();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    if (!identity) socket.resume(); // Drain ClientHello so FIN can be observed by the TCP fixture.
  });
  const ready = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await ready;
  t.after(async () => {
    const done = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await done;
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { host: address.address, port: address.port, sockets };
}

test("connectPeer caps both unfinished TLS and missing pinned-client acceptance at five seconds",
  { timeout: 20000 }, async (t) => {
    const { server, client } = await identities();
    for (const identity of [undefined, server]) {
      const fixture = await uncooperative(t, identity);
      await assert.rejects(within(peer.connectPeer(client, server.fingerprint, fixture.host, fixture.port), 6500),
        /handshake.*timed out/i);
      for (const socket of fixture.sockets) await within(closed(socket), 500);
    }
  });

async function connected(t: TestContext) {
  const { server, client } = await identities();
  let accepted!: (socket: TLSSocket) => void;
  const connection = new Promise<TLSSocket>((resolve) => { accepted = resolve; });
  const listener = await listen(t, server, [client.fingerprint], accepted);
  const outbound = await peer.connectPeer(client, server.fingerprint, listener.host, listener.port);
  const inbound = await connection;
  t.after(() => { outbound.destroy(); inbound.destroy(); });
  return { inbound, outbound, listener };
}

test("writeFrame and readFrame exchange UTF8 JSON over mutually pinned loopback TLS",
  { timeout: 10000 }, async (t) => {
    assert.equal(typeof peer.writeFrame, "function");
    assert.equal(typeof peer.readFrame, "function");
    const { inbound, outbound } = await connected(t);
    const expected = { chunk: "世界 🍄", index: 2, enabled: true, items: [null, 0] };
    const incoming = peer.readFrame(inbound);
    await peer.writeFrame(outbound, expected);
    assert.deepEqual(await incoming, expected);
    const returning = peer.readFrame(outbound);
    await peer.writeFrame(inbound, { ack: 2 });
    assert.deepEqual(await returning, { ack: 2 });
  });

function encode(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function writeRaw(socket: TLSSocket, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => socket.write(bytes, (error) => error ? reject(error) : resolve()));
}

test("readFrame handles split length headers and split UTF8 payloads", { timeout: 10000 }, async (t) => {
  const { inbound, outbound } = await connected(t);
  const expected = { payload: "split 🧱 bytes" };
  const packet = encode(expected);
  const receiving = peer.readFrame(inbound);
  const sending = (async () => {
    for (const bytes of [packet.subarray(0, 1), packet.subarray(1, 3), packet.subarray(3, 5),
      packet.subarray(5, 20), packet.subarray(20, 22), packet.subarray(22)]) {
      await writeRaw(outbound, bytes);
      await delay(5);
    }
  })();
  const [actual] = await Promise.all([receiving, sending]);
  assert.deepEqual(actual, expected);
});

test("readFrame rejects an oversized announced body before waiting for or allocating it",
  { timeout: 10000 }, async (t) => {
    for (const [limit, length] of [[8, 9], [1048576, 1048577], [1048576, 0xffffffff]]) {
      const { inbound, outbound } = await connected(t);
      const header = Buffer.alloc(4);
      header.writeUInt32BE(length!);
      const rejected = assert.rejects(within(peer.readFrame(inbound, limit), 500), /frame.*(limit|large|exceed)/i);
      await writeRaw(outbound, header);
      await rejected;
      assert.equal(inbound.destroyed, true);
    }
  });

test("concurrent readFrame calls preserve fragmented and coalesced queued frames in order",
  { timeout: 10000 }, async (t) => {
    const { inbound, outbound } = await connected(t);
    const values = [{ id: 1, payload: "a".repeat(50) }, { id: 2 }, { id: 3, payload: "left queued" }];
    const packet = Buffer.concat(values.map(encode));
    const receiving = Promise.all([peer.readFrame(inbound), peer.readFrame(inbound)]);
    const sending = (async () => {
      await writeRaw(outbound, packet.subarray(0, 9));
      await delay(10);
      await writeRaw(outbound, packet.subarray(9));
    })();
    const [actual] = await Promise.all([receiving, sending]);
    assert.deepEqual(actual, values.slice(0, 2));
    await delay(20);
    assert.deepEqual(await peer.readFrame(inbound), values[2]);
    assert.equal(inbound.listenerCount("readable"), 0);
  });

test("disconnect cancels active and queued reads, including truncated headers and bodies",
  { timeout: 10000 }, async (t) => {
    const frame = encode({ payload: "unfinished" });
    for (const prefix of [Buffer.alloc(0), frame.subarray(0, 2), frame.subarray(0, 7)]) {
      const { inbound, outbound } = await connected(t);
      const endListeners = inbound.listeners("end");
      const rejected = Promise.all([peer.readFrame(inbound), peer.readFrame(inbound)].map((reading) =>
        assert.rejects(within(reading, 500), /disconnect|closed|truncat/i)));
      outbound.end(prefix);
      await rejected;
      assert.equal(inbound.listenerCount("readable"), 0);
      assert.deepEqual(inbound.listeners("end"), endListeners);
      assert.equal(inbound.destroyed, true);
    }
  });

test("complete coalesced frames stay queued across EOF until consumed", { timeout: 10000 }, async (t) => {
  const { inbound, outbound } = await connected(t);
  const values = [null, [1, "two"], { final: true }];
  outbound.end(Buffer.concat(values.map(encode)));
  await delay(20);
  for (const value of values) assert.deepEqual(await peer.readFrame(inbound), value);
  await assert.rejects(within(peer.readFrame(inbound), 500), /disconnect|closed/i);
});

test("listener teardown cancels active and queued frame operations", { timeout: 10000 }, async (t) => {
  const { inbound, outbound, listener } = await connected(t);
  outbound.pause();
  const reads = Promise.allSettled([peer.readFrame(inbound), peer.readFrame(inbound)]);
  const writes = Promise.allSettled(Array.from({ length: 32 }, () =>
    peer.writeFrame(inbound, "x".repeat(1048574))));
  await delay(20);
  await listener.close();
  const [readResults, writeResults] = await within(Promise.all([reads, writes]), 1000);
  assert.ok(readResults.every((result) => result.status === "rejected"));
  assert.ok(writeResults.some((result) => result.status === "rejected"));
  assert.equal(inbound.destroyed, true);
  assert.equal(inbound.listenerCount("readable"), 0);
});

test("stalled frame reads have a five-second absolute deadline and cancel queued reads",
  { timeout: 10000 }, async (t) => {
    const { inbound, outbound } = await connected(t);
    const rejected = Promise.all([
      assert.rejects(peer.readFrame(inbound), /frame.*timed out/i),
      assert.rejects(peer.readFrame(inbound), /disconnect|closed/i),
    ]);
    await writeRaw(outbound, encode({ payload: "stalled" }).subarray(0, 6));
    await within(rejected, 6500);
    assert.equal(inbound.destroyed, true);
    assert.equal(inbound.listenerCount("readable"), 0);
  });

test("readFrame uses the supplied absolute deadline and cancels queued reads",
  { timeout: 10000 }, async (t) => {
    const { inbound, outbound } = await connected(t);
    const rejected = Promise.all([
      assert.rejects(within(peer.readFrame(inbound, undefined, 100), 500), /frame.*timed out/i),
      assert.rejects(within(peer.readFrame(inbound, undefined, 120000), 500), /disconnect|closed/i),
    ]);
    const packet = encode({ payload: "unfinished trickle" });
    await writeRaw(outbound, packet.subarray(0, 2));
    await delay(50);
    await writeRaw(outbound, packet.subarray(2, 6));
    await rejected;
    assert.equal(inbound.destroyed, true);
    assert.equal(inbound.listenerCount("readable"), 0);
  });

test("writeFrame enforces the one-MiB UTF8 byte bound without sending a partial frame",
  { timeout: 10000 }, async (t) => {
    const { inbound, outbound } = await connected(t);
    let seen = 0;
    const spy = (data: Buffer) => { seen += data.length; };
    inbound.on("data", spy);
    inbound.resume();
    await assert.rejects(within(peer.writeFrame(outbound, "🧱".repeat(300000)), 1000), /frame.*(limit|large|exceed)/i);
    await delay(20);
    assert.equal(seen, 0);
    inbound.removeListener("data", spy);
    inbound.pause();
    const next = peer.readFrame(inbound);
    await peer.writeFrame(outbound, { stillUsable: true });
    assert.deepEqual(await next, { stillUsable: true });
  });

test("frame helpers refuse TLS sockets that have not passed peer certificate pin verification",
  { timeout: 10000 }, async (t) => {
    const { server, client } = await identities();
    const fixture = await uncooperative(t, server);
    const socket = connectTls({ host: fixture.host, port: fixture.port,
      key: client.keyPem, cert: client.certPem, rejectUnauthorized: false, minVersion: "TLSv1.2" });
    socket.on("error", () => {});
    t.after(() => socket.destroy());
    await once(socket, "secureConnect");
    await assert.rejects(peer.writeFrame(socket, { forbidden: true }), /verified|authenticated/i);
    await assert.rejects(peer.readFrame(socket), /verified|authenticated/i);
  });

test("backpressured frame writes time out instead of hanging on a peer that never reads",
  { timeout: 15000 }, async (t) => {
    const { inbound, outbound } = await connected(t);
    inbound.pause();
    const payload = "x".repeat(1048574); // JSON quotes make the body exactly one MiB.
    const transferring = (async () => {
      for (let index = 0; index < 32; index++) await peer.writeFrame(outbound, payload);
      throw new Error("Fixture did not reach transport backpressure");
    })();
    await assert.rejects(within(transferring, 8000), /frame write.*timed out/i);
    assert.equal(outbound.destroyed, true);
  });

test("concurrent frame writes stay ordered without per-write socket-listener accumulation",
  { timeout: 10000 }, async (t) => {
    const { inbound, outbound } = await connected(t);
    const baseline = outbound.listenerCount("error");
    const values = Array.from({ length: 32 }, (_, id) => ({ id }));
    const receiving = Promise.all(values.map(() => peer.readFrame(inbound)));
    const sending = Promise.all(values.map((value) => peer.writeFrame(outbound, value)));
    const transferring = Promise.all([receiving, sending]);
    try {
      await Promise.resolve();
      assert.ok(outbound.listenerCount("error") <= baseline + 1, "one active write owns socket listeners");
      const [actual] = await transferring;
      assert.deepEqual(actual, values);
      assert.equal(outbound.listenerCount("error"), baseline);
    } finally { await transferring.catch(() => {}); }
  });

test("a throwing acceptance callback fails its socket closed without killing the listener",
  { timeout: 10000 }, async (t) => {
    const { server, client } = await identities();
    let calls = 0;
    const listener = await listen(t, server, [client.fingerprint], (socket) => {
      if (++calls === 1) throw new Error("Application acceptance failed");
      socket.end("second connection works");
    });
    const first = peer.connectPeer(client, server.fingerprint, listener.host, listener.port)
      .then((socket) => { socket.destroy(); return socket; });
    await assert.rejects(first, /disconnect|closed/i);
    const second = await peer.connectPeer(client, server.fingerprint, listener.host, listener.port);
    t.after(() => second.destroy());
    const response = once(second, "data");
    second.resume();
    assert.equal((await response)[0].toString(), "second connection works");
    second.destroy();
    assert.equal(calls, 2);
  });

test("readFrame validates a finite positive maxBytes cap without poisoning the connection",
  { timeout: 10000 }, async (t) => {
    const { inbound, outbound } = await connected(t);
    for (const limit of [0, -1, Number.NaN, Infinity, 1.5, 1048577]) {
      await assert.rejects(within(peer.readFrame(inbound, limit), 300), /maxBytes/);
    }
    const receiving = peer.readFrame(inbound, 4);
    await peer.writeFrame(outbound, "ok");
    assert.equal(await receiving, "ok");
  });

test("readFrame rejects invalid timeoutMs values without consuming or poisoning the connection",
  { timeout: 10000 }, async (t) => {
    const { inbound, outbound } = await connected(t);
    await Promise.all([0, -1, Number.NaN, Infinity, 120001].map((timeoutMs) =>
      assert.rejects(within(peer.readFrame(inbound, undefined, timeoutMs), 300),
        { name: "RangeError", message: /timeoutMs/ }, `invalid timeoutMs: ${timeoutMs}`)));
    const receiving = peer.readFrame(inbound);
    await peer.writeFrame(outbound, { stillUsable: true });
    assert.deepEqual(await receiving, { stillUsable: true });
  });

test("malformed UTF8, invalid JSON, and empty frames fail closed", { timeout: 10000 }, async (t) => {
  for (const body of [Buffer.from([0x22, 0xc3, 0x28, 0x22]), Buffer.from("[bad]"), Buffer.alloc(0)]) {
    const { inbound, outbound } = await connected(t);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    const rejected = assert.rejects(within(peer.readFrame(inbound), 500), /UTF.?8|JSON|empty/i);
    await writeRaw(outbound, Buffer.concat([header, body]));
    await rejected;
    assert.equal(inbound.destroyed, true);
  }
});

