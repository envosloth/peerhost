import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import { createServer, connect, type TLSSocket } from "node:tls";
import type { Socket } from "node:net";
import { generate } from "selfsigned";

export interface PeerIdentity {
  keyPem: string;
  certPem: string;
  /** SHA256 of the DER certificate, encoded as exactly 64 lowercase hex digits. */
  fingerprint: string;
}

export async function createIdentity(): Promise<PeerIdentity> {
  const pems = await generate([{ name: "commonName", value: "SeedHost" }], {
    keyType: "ec",
    curve: "P-256",
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: false, critical: true },
      { name: "keyUsage", digitalSignature: true, critical: true },
      { name: "extKeyUsage", serverAuth: true, clientAuth: true },
    ],
  });
  return {
    keyPem: pems.private,
    certPem: pems.cert,
    fingerprint: createHash("sha256").update(new X509Certificate(pems.cert).raw).digest("hex"),
  };
}

const ACCEPTED = Buffer.from("SeedHost/1\n", "ascii");
const HANDSHAKE_TIMEOUT_MS = 5000;
const FRAME_TIMEOUT_MS = 5000;
const MAX_FRAME_BYTES = 1048576;
const verifiedSockets = new WeakSet<TLSSocket>();
const inviteSockets = new WeakSet<TLSSocket>();

/** Narrow bootstrap capability: never usable by ordinary framing or snapshot transfers. */
function requireInviteSocket(socket: TLSSocket): void {
  if (!inviteSockets.has(socket) && !verifiedSockets.has(socket)) throw new Error('Socket has not been invite-gate verified');
}

function requireVerified(socket: TLSSocket): void {
  if (!verifiedSockets.has(socket)) throw new Error("Socket has not been peer-pin verified");
}

export function isVerifiedPeerSocket(socket: TLSSocket): boolean { return verifiedSockets.has(socket); }

function pinBytes(fingerprint: string): Buffer {
  if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error("Fingerprint must be exactly 64 lowercase SHA256 hex digits");
  }
  return Buffer.from(fingerprint, "hex");
}

export async function listenPeer(
  identity: PeerIdentity,
  trustedFingerprints: string[],
  onConnection: (socket: TLSSocket, fingerprint: string) => void,
  { host = "127.0.0.1", port = 0, authorizeCertificate }: {
    host?: string; port?: number;
    /** Checked anew per connection. 'invite' permits only invite framing, not ordinary transfers. */
    authorizeCertificate?: (fingerprint: string) => Promise<'trusted' | 'invite' | false>;
  } = {},
): Promise<{ host: string; port: number; close: () => Promise<void> }> {
  const trustedPins = trustedFingerprints.map(pinBytes);
  const sockets = new Set<Socket>();
  let stopping = false;
  let closing: Promise<void> | undefined;
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    if (stopping) socket.destroy();
  };
  const server = createServer({
    key: identity.keyPem,
    cert: identity.certPem,
    minVersion: "TLSv1.2",
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    requestCert: true,
    // Self-signed leaves are accepted ONLY behind the mandatory raw-certificate pin gate below.
    rejectUnauthorized: false,
  }, (socket) => {
    track(socket);
    if (stopping) return;
    socket.on("error", () => {});
    // Certificate possession is authenticated by TLS; capability is decided before the callback.
    const raw = socket.getPeerCertificate().raw;
    if (!raw) { socket.destroy(); return; }
    const hash = createHash("sha256").update(raw).digest();
    const fingerprint = hash.toString("hex");
    void (async () => {
      const access = authorizeCertificate ? await authorizeCertificate(fingerprint)
        : trustedPins.some((pin) => timingSafeEqual(pin, hash)) ? 'trusted' : false;
      if (!access || stopping || socket.destroyed) { socket.destroy(); return; }
      socket.disableRenegotiation();
      if (access === 'trusted') verifiedSockets.add(socket);
      else inviteSockets.add(socket);
      socket.write(ACCEPTED);
      onConnection(socket, fingerprint);
    })().catch(() => socket.destroy());
  });
  server.on("connection", track);
  server.on("tlsClientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Peer listener has no TCP address");
  return {
    host: address.address,
    port: address.port,
    close: () => {
      if (!closing) {
        stopping = true;
        closing = new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          for (const socket of sockets) socket.destroy();
        });
      }
      return closing;
    },
  };
}

export async function connectPeer(
  identity: PeerIdentity, expectedFingerprint: string, host: string, port: number,
): Promise<TLSSocket> {
  const expectedPin = pinBytes(expectedFingerprint);
  return new Promise<TLSSocket>((resolve, reject) => {
    const socket = connect({
      host, port, key: identity.keyPem, cert: identity.certPem,
      minVersion: "TLSv1.2", rejectUnauthorized: false,
    });
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("error", fail);
      socket.removeListener("end", disconnected);
      socket.removeListener("close", disconnected);
      socket.removeListener("readable", accepted);
      socket.removeListener("secureConnect", secured);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const disconnected = () => fail(new Error("Peer disconnected before client acceptance"));
    const accepted = () => {
      if (settled) return;
      // Exact-size reads preserve application bytes coalesced with the acceptance preface.
      const response = socket.read(ACCEPTED.length) as Buffer | null;
      if (!response) return;
      if (!response.equals(ACCEPTED)) { fail(new Error("Peer rejected the transport protocol")); return; }
      settled = true;
      cleanup();
      verifiedSockets.add(socket);
      resolve(socket);
    };
    const timer = setTimeout(() => fail(new Error("Peer handshake timed out")), HANDSHAKE_TIMEOUT_MS);
    socket.on("error", () => {});
    socket.once("error", fail);
    socket.once("end", disconnected);
    socket.once("close", disconnected);
    function secured() {
      if (settled) return;
      const raw = socket.getPeerCertificate().raw;
      const fingerprint = raw && createHash("sha256").update(raw).digest();
      if (!fingerprint || !timingSafeEqual(fingerprint, expectedPin)) {
        fail(new Error("Server certificate fingerprint does not match the expected pin"));
        return;
      }
      socket.disableRenegotiation();
      socket.on("readable", accepted);
      accepted();
    }
    socket.once("secureConnect", secured);
  });
}

const writeQueues = new WeakMap<TLSSocket, Promise<void>>();

// One active reader/writer per direction: no competing reads or accumulating event listeners.
function serialize<T>(queues: WeakMap<TLSSocket, Promise<void>>, socket: TLSSocket, work: () => Promise<T>): Promise<T> {
  const result = (queues.get(socket) ?? Promise.resolve()).then(work);
  queues.set(socket, result.then(() => {}, () => {}));
  return result;
}

export async function writeFrame(socket: TLSSocket, value: unknown): Promise<void> {
  requireVerified(socket);
  return writeCheckedFrame(socket, value);
}

export async function writeInviteFrame(socket: TLSSocket, value: unknown): Promise<void> {
  requireInviteSocket(socket);
  if (Buffer.byteLength(JSON.stringify(value)) > 4096) throw new RangeError('Invite frame exceeds the bootstrap byte limit');
  return writeCheckedFrame(socket, value);
}

function writeCheckedFrame(socket: TLSSocket, value: unknown): Promise<void> {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_FRAME_BYTES) throw new Error("Frame exceeds the one-MiB byte limit");
  const packet = Buffer.allocUnsafe(4 + body.length);
  packet.writeUInt32BE(body.length, 0);
  body.copy(packet, 4);
  return serialize(writeQueues, socket, () => writePacket(socket, packet));
}

function writePacket(socket: TLSSocket, packet: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("error", fail);
      socket.removeListener("close", disconnected);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const disconnected = () => fail(new Error("Peer disconnected during a frame write"));
    const timer = setTimeout(() => fail(new Error("Frame write timed out")), FRAME_TIMEOUT_MS);
    socket.once("error", fail);
    socket.once("close", disconnected);
    if (socket.destroyed || !socket.writable || socket.writableEnded) { disconnected(); return; }
    socket.write(packet, (error) => {
      if (error) { fail(error); return; }
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    });
  });
}

const readQueues = new WeakMap<TLSSocket, Promise<void>>();

export async function readFrame(socket: TLSSocket, maxBytes = 1048576, timeoutMs = FRAME_TIMEOUT_MS): Promise<any> {
  requireVerified(socket);
  return readCheckedFrame(socket, maxBytes, timeoutMs);
}

export async function readInviteFrame(socket: TLSSocket, maxBytes = 4096, timeoutMs = FRAME_TIMEOUT_MS): Promise<any> {
  requireInviteSocket(socket);
  if (maxBytes > 4096) throw new RangeError('Invite frame exceeds the bootstrap byte limit');
  return readCheckedFrame(socket, maxBytes, timeoutMs);
}

function readCheckedFrame(socket: TLSSocket, maxBytes: number, timeoutMs: number): Promise<any> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FRAME_BYTES) {
    throw new RangeError("maxBytes must be an integer between 1 and 1048576");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) {
    throw new RangeError("timeoutMs must be finite, positive, and at most 120000");
  }
  return serialize(readQueues, socket, () => readOneFrame(socket, maxBytes, timeoutMs));
}

function readOneFrame(socket: TLSSocket, maxBytes: number, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    let length: number | undefined;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("readable", pump);
      socket.removeListener("end", disconnected);
      socket.removeListener("close", disconnected);
      socket.removeListener("error", fail);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const missing = () => {
      if (socket.destroyed || socket.readableEnded) fail(new Error("Peer disconnected during a frame"));
    };
    const pump = () => {
      if (settled) return;
      try {
        if (length === undefined) {
          // Never drain the whole stream: later coalesced frames stay buffered with Node backpressure.
          const header = socket.read(4) as Buffer | null;
          if (!header) { missing(); return; }
          if (header.length !== 4) throw new Error("Truncated frame header");
          length = header.readUInt32BE(0);
          if (length === 0) throw new Error("Empty frame is not valid JSON");
          if (length > maxBytes) throw new Error("Frame exceeds the configured byte limit");
        }
        const body = socket.read(length) as Buffer | null;
        if (!body) { missing(); return; }
        if (body.length !== length) throw new Error("Truncated frame body");
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
        settled = true;
        cleanup();
        resolve(value);
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    };
    const disconnected = () => {
      pump(); // Complete buffered frames still win over an EOF notification.
      if (!settled) fail(new Error("Peer disconnected during a frame"));
    };
    const timer = setTimeout(() => fail(new Error("Frame read timed out")), timeoutMs);
    socket.on("readable", pump);
    socket.once("end", disconnected);
    socket.once("close", disconnected);
    socket.once("error", fail);
    pump();
  });
}
