# Opt-in Minecraft TCP player gateway

The always-on relay can now provide **both** stored world revisions/park/claim and a fixed TCP player endpoint. It forwards actual opaque bytes over host-initiated, certificate-pinned TLS tunnels. It does not run Minecraft, start a host, claim ownership, alter firewall/router settings, install a service, or prove Internet reachability.

## Relay operator

Build normally, then explicitly enable the separate player listener:

```sh
npm run build
node dist/src/relay/cli.js serve --root ./relay-data --port 47625 --game-port 25565
```

Both listeners default to `127.0.0.1`. Without `--game-port`, there is **no** player listener. `--game-host` requires `--game-port`; changing the custody listener's `--host` does not expose the player listener. Port `0` requests a temporary OS-assigned port and is intended for testing, not a permanent player address.

For another machine to reach either listener, the operator must explicitly select an appropriate bind address with `--host` and separately `--game-host`, and provide any required networking themselves. The CLI prints `LISTENING=...` for custody/TLS and `GAME_LISTENING=...` for player TCP. A wildcard bind is not an address players can connect to: use the relay machine's reachable DNS/IP and the fixed game port. Existing trust/invite/advertise/storage commands remain unchanged; invites enroll hosts, not players.

## Integration API

`src/core/game-gateway.ts` exports:

```ts
startHostGameGateway(
  identity: PeerIdentity,
  relay: { host: string; port: number; fingerprint: string },
  localPort: number,
  options?: { onStatus?: (status: {
    state: 'connecting' | 'ready' | 'error' | 'off'; detail: string
  }) => void }
): Promise<{ close: () => Promise<void> }>

gatewayStatus(identity: PeerIdentity, relay: {
  host: string; port: number; fingerprint: string
}): Promise<{
  enabled: boolean; host: string | null; port: number | null;
  ready: boolean; detail: string
}>
```

The relay argument is the **custody TLS endpoint**, not its player port. The host target is always literal `127.0.0.1:localPort`. No packet can supply a destination host, URL or alternate port. `localPort` must be an integer from 1 to 65535.

The caller must start the handle **only after its ownership and local server-running checks pass** and close it before stopping, parking, changing relay configuration or quitting. This API deliberately has no access to application state or process management. Start returns a lifecycle handle immediately; it is not a promise of connectivity. Use `onStatus` and an actual `gatewayStatus` request for asynchronous results. Throwing observers cannot take ownership of cleanup.

`ready` means an eligible standby TLS tunnel exists. It does **not** prove Java/Minecraft readiness, a successful player login, or LAN/Internet reachability. The returned `host` is the player listener's bind address; when displaying a remote/wildcard listener, use the configured reachable relay host with this returned game port. Local readiness is separately the application's responsibility.

Relay methods added:

```ts
RelayNode.listenGame(options?: {
  host?: string; port?: number; leaseMs?: number; idleMs?: number
}): Promise<void>
RelayNode.gameEndpoint: { host: string; port: number } | undefined
```

Call `listenGame` after `listen`. Default lease is 15000 ms, active idle timeout 120000 ms. Tests may shorten these within 100–15000 and 100–120000 ms respectively. `RelayNode.close()` closes both listeners and their sockets.

## Protocol and security review

- Existing relay protocol version 1 gains `gateway-status` and `game-tunnel` operations without changing status/park/claim payloads. Gateway control frames are limited to 4096 bytes.
- A tunnel request contains exactly `{ type: 'relay', version: 1, op: 'game-tunnel', generation, lineage }`. Registration requires an ordinary verified peer socket, current enrolled membership, and a valid durable relay ledger in **confirmed `transferred` state**, with exact holder fingerprint, generation and lineage. Missing/malformed authority, parked worlds, pending/unacknowledged claims, stale generations and foreign lineage fail closed.
- Invite-bootstrap sockets stay bootstrap-only even if that same certificate is enrolled through another connection. There is no invite-token gateway authentication and no token in discovery or tunnel frames.
- The relay sends `relay-tunnel-ready`, then `relay-tunnel-start` when selecting one player. The host opens local loopback TCP and sends `relay-tunnel-connected`; only then, after a fresh custody check, both ends switch to raw bytes. Exact-size frame reads preserve coalesced first bytes in either direction. Unsolicited standby data destroys the tunnel.
- Player connections are paused during authorization/setup. Duplex `pipe()` provides stream backpressure; there is no application-sized raw-byte queue and no waiting-player queue. A player with no eligible idle tunnel is disconnected rather than sent to another host.
- Limits: 32 player TCP connections and 32 registered TLS tunnels per relay; at most four standby tunnels. The supplied host maintains two standbys, caps concurrent work, and polls/replenishes at most once per 500 ms with no overlapping discovery request. Bursts exceeding available standbys are rejected, not queued.
- Standby leases expire after at most 15 seconds. Peer handshake/control phases and local TCP connect have five-second deadlines; host standby activation reads are capped at 20 seconds. Active streams have a two-minute idle deadline, including explicit destruction on timeout. No maximum duration is imposed on a healthy active stream.
- Park/claim/untrust trigger route validation. A serialized 250 ms authority/membership reread also detects changes by another CLI process or ledger generation changes; failures revoke existing routes. Active old players are disconnected rather than migrated. New player authorization always rereads current authority, and it is checked again immediately before raw forwarding.
- Closing either side destroys players, TLS/local sockets and timers; unfinished outbound connection attempts are awaited through their existing five-second handshake deadline. An aborted relay activation cannot orphan a local socket.
- This bounds the gateway's admitted resources, not the pre-existing custody listener's entire TLS handshake surface. It is not a DDoS protection service. Players still use the Minecraft server's normal authentication/allowlist; this transport adds no player identity authentication or IP forwarding protocol.

## Verified evidence

Tests use disposable directories and loopback sockets. The A/B test runs the actual existing snapshot park/claim protocol and verifies the same player endpoint answers `A` then `B`, with old players disconnected on park and untrust. Echo servers and binary payloads are **TCP fixtures, not proof of real Minecraft gameplay**. No remote deployment or firewall/router/system changes were performed.

Actual RED → GREEN observations from implementation:

| Behavior | Observed RED failure before its implementation | GREEN |
|---|---|---|
| Disabled capability discovery | `gateway discovery API must exist`: undefined vs function | Pass |
| Real outbound forwarding | `relay must open an opt-in raw TCP listener`: undefined vs function | Pass |
| Park/claim player invalidation | `condition did not become true` waiting for old player close | Pass |
| Standby lease | `socket did not expire/close` | Pass |
| Concurrent standby bound | `12 !== 4` accepted tunnels | Pass |
| Unsolicited standby bytes | `socket did not expire/close` | Pass |
| Active idle expiry | `condition did not become true` | Pass |
| Explicit CLI enable | `Unknown option '--game-port'`, exit 2 | Pass |
| Corrupt durable generation | `relay-tunnel-ready` vs `error` | Pass |
| Aborted activation cleanup | `2 !== 0` orphan local sockets | Pass |
| Observer failure isolation | `Error: observer failure` rejected start | Pass |

Regression/security tests additionally cover bootstrap enrollment separation, wrong pin, nonholder/stale/foreign route denial, unexpected destination fields, no ledger/parked/pending refusal, lease replenishment, retry cancellation, multi-megabyte binary backpressure, out-of-process active-generation invalidation and relay shutdown.

Commands used:

```sh
npm run build
node --test tests/game-gateway.test.mjs tests/relay-gateway.test.mjs tests/relay-gateway-cli.test.mjs \
  dist/tests/relay.test.js dist/tests/relay-cli.test.js dist/tests/friends.test.js tests/friends-security.test.mjs
npm test
git diff --check
```

Focused gateway plus existing relay/friends security regression: **48 tests passed, 0 failed** on the final focused run. An earlier complete `npm test` run returned **351 passed, 0 failed** before the final observer/generation/close additions and other agents' subsequent changes. The latest complete-tree run returned **359 tests: 356 passed, 2 failed, 1 skipped**; the failures were the separately owned onboarding-renderer Java-selection/help assertions. Their isolated retry subsequently returned **10 passed, 0 failed**. Do not treat that isolated retry as a full-tree green result. One intermediate run also exposed a test-only race caused by routing a player after querying a deliberately 150 ms standby lease; renewal and active-player-close assertions were separated, and the final full run passed every gateway test.

Runtime was Node v26.7.0; project requirement remains Node >=22. Official Node 22 API references were consulted; no dependencies were added.

## Official API references

- TLS secure connection and certificate pin inspection: https://nodejs.org/docs/latest-v22.x/api/tls.html#event-secureconnect and https://nodejs.org/docs/latest-v22.x/api/tls.html#tlssocketgetpeercertificatedetailed
- Literal loopback TCP destination: https://nodejs.org/docs/latest-v22.x/api/net.html#netcreateconnectionoptions-connectlistener
- Socket timeout does not itself close a socket: https://nodejs.org/docs/latest-v22.x/api/net.html#socketsettimeouttimeout-callback
- TCP listener connection cap: https://nodejs.org/docs/latest-v22.x/api/net.html#servermaxconnections
- Backpressure and explicit error cleanup: https://nodejs.org/docs/latest-v22.x/api/stream.html#readablepipedestination-options
- Exact reads without draining coalesced bytes: https://nodejs.org/docs/latest-v22.x/api/stream.html#readablereadsize
