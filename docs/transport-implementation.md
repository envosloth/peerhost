# Direct peer TLS transport

`src/core/peer-transport.ts` is a functional local-first transport primitive, independent of Electron. It creates identities in process using the installed **selfsigned 5.x async API**, not an `openssl` executable. The installed README and TypeScript declarations were read before implementation.

## Exported API

```ts
import type { TLSSocket } from "node:tls";

interface PeerIdentity {
  keyPem: string;
  certPem: string;
  fingerprint: string;
}

createIdentity(): Promise<PeerIdentity>;

listenPeer(
  identity: PeerIdentity,
  trustedFingerprints: string[],
  onConnection: (socket: TLSSocket, fingerprint: string) => void,
  options?: { host?: string; port?: number },
): Promise<{ host: string; port: number; close: () => Promise<void> }>;

connectPeer(
  identity: PeerIdentity,
  expectedFingerprint: string,
  host: string,
  port: number,
): Promise<TLSSocket>;

writeFrame(socket: TLSSocket, value: unknown): Promise<void>;
readFrame(socket: TLSSocket, maxBytes?: number): Promise<any>;
```

The listener defaults to `127.0.0.1` and port `0` (an OS-selected free port), returning the actual bound host/port. Explicit bind addresses are caller-controlled; development and all tests use loopback only. `close()` is idempotent, stops accepting, and destroys both accepted TLS sockets and underlying TCP connections with unfinished handshakes. A synchronous exception in `onConnection` destroys that socket, not the listener. The callback is intentionally synchronous; callers must handle rejections in their own asynchronous work.

## Authentication and trust

- Identities use an EC P-256 private key and a SHA256-signed, non-CA X.509 certificate with digital-signature and TLS server/client authentication usages.
- The canonical fingerprint is **exactly 64 lowercase hex characters**: `createHash("sha256").update(new X509Certificate(certPem).raw).digest("hex")`. This is compatible with the parent device ID and peer settings. It is not the dependency's fingerprint field, a PEM-text hash, or a colon-separated fingerprint. Invalid pins are rejected before binding/dialing; pins are never silently normalized.
- Both endpoints present their certificates through Node's native TLS implementation. The listener requests a client certificate. TLS CertificateVerify establishes possession of the corresponding private key; a supplied fingerprint string alone cannot authenticate anything.
- TLS uses `minVersion: "TLSv1.2"`, allowing TLS 1.3 when supported. Renegotiation is disabled after verification.
- `rejectUnauthorized: false` is **only** used to permit self-signed certificates behind mandatory, constant-time SHA256 checks against the actually presented DER certificate. A missing/untrusted client certificate is destroyed before the application callback. An incorrect server pin is destroyed before a socket is returned.
- The listener snapshots its allowlist when opened; changing the original array does not change authorization. Restart the listener to apply a new allowlist.
- After verifying the client pin, the listener sends the TLS-encrypted ASCII transport preface `SeedHost/1\n`. The connector verifies the server certificate first, then consumes this exact preface before resolving. This prevents a connector from mistaking its local `secureConnect` event for server-side client acceptance. The preface is protocol control, not cryptographic authentication and not an application frame. Coalesced application bytes remain buffered.
- Native `socket.authorized` may still be false because web-PKI validation was deliberately bypassed. Authentication here is the completed TLS handshake plus the explicit raw-certificate pin gate, not that property. Hostname, CA-chain, and certificate-expiration policy are not independently enforced by these primitives.
- Trust provisioning must happen through an authenticated out-of-band pairing flow owned by the parent. These primitives do not implement TOFU, pairing UI, rotation, revocation infrastructure, or trust on first network contact. The local `identity.fingerprint` field is descriptive; authentication always uses the certificate presented in TLS, never a claimed local field or a JSON token.

No application callback or returned connector socket is exposed before its peer pin is verified. The frame helpers additionally reject sockets that were not authenticated through these primitives.

## Frames, backpressure, and cancellation

The wire format after the acceptance preface is a **4-byte unsigned big-endian UTF8 JSON body length**, followed by exactly that many body bytes. Header bytes are excluded from the body limit.

- `writeFrame` serializes one JSON value, bounds the UTF8 body to **1,048,576 bytes**, constructs one complete packet, and preserves concurrent call ordering. Local serialization/size errors send no partial packet. Unsupported JSON values (for example top-level `undefined`, BigInt, or cycles) reject.
- `readFrame` defaults to **1,048,576 bytes**. A custom `maxBytes` must be an integer from `1` through `1,048,576`; it can tighten the cap, not enlarge it. Excessive advertised lengths are rejected from the header before reading/allocating the body. Empty frames, invalid UTF8, malformed JSON, and truncated frames fail closed.
- Reads are serialized independently from writes. Exact-size paused-mode reads handle split headers/bodies and coalesced packets without consuming the following frame. Queued complete frames remain available even across EOF. Node stream backpressure bounds unread network buffering; there is no eager unbounded queue of decoded incoming frames.
- TLS accept handshakes and outbound connection/acceptance have **5-second caps**. Each active frame read/write has an absolute **5-second deadline** (not reset by byte trickles). A queued frame operation starts its deadline when it becomes active. A timeout or disconnect destroys the socket and cancels the remaining queued operations; timers and temporary event listeners are removed on settlement.
- Writer success means the local TLS write callback completed, not that the remote application consumed or committed the frame. Parent snapshot exchange must define acknowledgments, validate message schemas, and verify its own chunk/snapshot integrity.
- `readFrame` owns paused/readable-mode consumption. Do **not** mix it with a `data` listener, `pipe`, `setEncoding`, an async stream iterator, or another reader on the same socket. Returned connectors remain in paused mode; a deliberate raw-stream consumer must attach its handler and call `resume()` instead of using `readFrame`.
- The local application can queue arbitrarily many calls and thereby retain its own promises/serialized outgoing packets. Await chunk writes or cap the local pipeline; the body limit is not a total outbound application-memory quota.

## Identity storage and limitations

Private keys are currently returned **in memory**. The parent Electron application **must encrypt every persisted private key with Electron `safeStorage`** and fail closed if a suitable encryption backend is unavailable; it must not write plaintext PEM keys into settings, logs, snapshot data, or renderer state. Core does not import Electron or implement persistence.

This is not a production cryptographic audit or proof of internet/NAT traversal. No relay, gateway, discovery, router/firewall modification, cloud API, credential use, Minecraft process/world access, or internet exposure is implemented or exercised here. Certificate trust distribution, expiry/rotation policy, connection-count quotas, and production denial-of-service hardening remain parent/application work.

## Verification

Strict RED → GREEN tracer-bullet TDD was used: missing APIs, wrong pin acceptance, unknown-client acceptance, malformed pins, incomplete cleanup, missing handshake deadlines, split framing, oversized input, concurrent reader interference, disconnect hangs, stalled reads/writes, oversized output, unverified frame access, excessive concurrent write listeners, malformed UTF8, invalid limits, and callback exceptions were observed failing before their fixes.

Run from the repository with Windows Git Bash:

```sh
npm run build
command node --test dist/tests/peer-transport.test.js
```

The verified build/test run returned **25 tests, 25 passed, 0 failed, 0 cancelled, 0 skipped**, with `duration_ms 26008.1553`. No test warnings were emitted.

The dedicated tests use real loopback TLS/TCP sockets, generated in-process certificates, and real short deadlines. They cover mutual-certificate echo, incorrect server pins, unknown/missing client certificates, claimed-fingerprint spoofing, a stolen certificate paired with the wrong private key, fragmented/coalesced UTF8 JSON, concurrent queues, overflow, malformed payloads, EOF/truncation, handshake/frame timeouts, active/pending connection cleanup, queued-operation cancellation, and synchronous application callback failure. These socket fixtures are transport evidence, not Minecraft or internet-hosting evidence.
