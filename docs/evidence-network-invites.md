# Evidence notes: cross-network invite acceptance and 4-character password minimum

Scoped evidence for the invite/account/relay fixes. Raw run logs and the full diff live in
`C:/Users/angel/AppData/Local/hermes/cache/scratch/seedhost-issues-network-evidence/` (EVIDENCE.md,
repo-diff.patch, `*-red.log`/`*-green.log`, `final-focused-suite.log`, `final-electron-accounts-check.log`).
Baseline revision: `22bee0743ca298d8e5e0e15e975983f31e9ee558` (work left uncommitted).

## Root cause: "peer handshake timed out" when accepting a request from another network

Accepting reaches two services: the account directory (delivered the request) and the group relay
pinned in the invitation (`joinWithInvite` → `joinRelayInvite` → `connectPeer`, 5 s TLS handshake
deadline). Source-level causes reproduced in fixtures:

1. `RelayNode.listen()` overwrote a persisted explicit (public/proxy) `advertise` endpoint with the
   local bind address on restart; later invitations named loopback/ephemeral or LAN addresses that a
   remote friend cannot reach.
2. The always-on creator's own enrollment republished the LAN fallback as the relay's advertised
   endpoint, so username invitations to friends on other networks also named `192.168.x.x`.
3. One transient transport loss (dropped FIN/RST/join reply) failed the whole acceptance even though
   the relay's durable receipt is replay-safe per device+token+pin.
4. A lost dismissal reply stranded a friend who had already joined.
5. The failure text named neither the pinned endpoint nor the separate-route explanation.

Fixes preserve fail-closed behavior: no timeout increase, no pin/TLS relaxation; retries only for
typed transport failures and a short socket-error allow-list, never for pin mismatch, protocol, TLS
or authorization refusals; invitation expiry is re-checked before the second token disclosure.

## Commands (RED → GREEN, all via `node_modules/typescript/bin/tsc -p tsconfig.json` then `node --test ...`)

- `node --test tests/password-policy.test.mjs` — RED `Use a password of 12–128 characters` → GREEN
  (4-char register/login, controls rejection, scrypt/session/rate-limit preservation, native pattern).
- `node --test tests/invitation-network.test.mjs` — each slice RED first (exact failures captured in
  the scratch logs): advertised endpoint preserved; creator direct bootstrap; pairing codes don't
  clobber the public route; `relay-advertise.json` fail-closed; one bounded handshake retry; lost
  join response recovered; retry allow-list; permanent failure diagnosed with endpoint + private
  hint; lost dismissal reply; LAN fallback port.
- Focused battery (relay, friends, application, decline, handoff, ipc-policy + accounts,
  account-integration, username-invites, friends-security, peer-sni, always-on, account-cli,
  relay-gateway, network-info, both new suites): 98 tests, 98 pass, 0 fail.
- `node tools/desktop-accounts-check.mjs`: PASS on real isolated Electron profiles.

## Independent-review follow-up: inferred ports and truncated dismissal replies

Verified in `C:/Users/angel/Projects/seedhost-issues-network-fixes` with all work left uncommitted.
Follow-up raw logs: `C:/Users/angel/AppData/Local/hermes/cache/scratch/seedhost-network-retry-fixes-evidence/`.
Each terminal command explicitly set `TMP`, `TEMP`, and `TMPDIR` to Hermes scratch. Listener sockets and
account profiles were disposable and loopback-only; LAN/public hosts were invitation metadata only.

- **Inferred LAN restart RED:** a real restarted relay advertised old port `57111` while its new
  listener used `57112`. GREEN adds persisted `advertiseSource` provenance: `advertiseHost` and bind
  fallbacks are inferred and refresh to the new host/port; explicit `listen({advertise})` and persisted
  `createInvite({advertise})` routes retain their exact host/port. Explicit loopback proxy preservation
  had a separate observed RED/GREEN. Creator bootstrap and LAN pairing remain non-persisting.
- **Truncated dismissal RED:** the real pinned TLS account service deleted the request, then sent its
  correct frame length plus only five JSON bytes before closing. Acceptance failed with the plain
  `Error: Truncated frame body`. GREEN classifies short frame bodies as typed `PEER_DISCONNECTED`,
  allowing the existing account integration to read the authenticated recipient/device inbox before
  success. Partial headers had their own observed RED/GREEN and now use the same typed classification.
  No mutation replay or authentication replay was added.
- Guard fixtures prove that a still-present request remains retryable, failed inbox readback cannot
  report success, session/authorization refusals do not trigger reconciliation, and complete invalid
  JSON/UTF-8, empty frames, and oversized announced frames remain terminal failures. The decline guards
  use a local issuer adapter and test-only persistence vault; full acceptance tests use real applications,
  actual relay membership, encrypted account storage, and the real directory. These are not WAN proofs.

Current-source compilation: `node node_modules/typescript/bin/tsc -p tsconfig.json` — exit 0.
Focused battery: `node --test tests/invitation-network.test.mjs tests/network-retry-boundaries.test.mjs
 tests/password-policy.test.mjs tests/username-invites.test.mjs tests/account-integration.test.mjs
 tests/friends-security.test.mjs tests/accounts.test.mjs tests/always-on.test.mjs tests/peer-sni.test.mjs
 dist/tests/relay.test.js dist/tests/peer-transport.test.js` — **80 tests, 80 pass, 0 fail**, exit 0.
Two repeat runs of the ten targeted follow-up/guard tests each returned **10 pass, 0 fail**, exit 0.
Scoped `git diff --check` returned exit 0.
The follow-up did not modify application/main/IPC/renderer/password policy, package configuration,
deployment, startup registration, or firewall rules.

Legacy compatibility: old non-loopback advertisements without provenance remain untouched because
an old explicit proxy cannot safely be distinguished from an old inferred LAN endpoint. Automatic
port refresh applies to newly recorded inferred endpoints, not guessed migration of legacy routes.
Existing legacy inferred routes require deliberate local migration; pins and explicit proxy ports
must not be silently rewritten.

## Remaining limitations

- Loopback fixtures are not WAN proof; a real two-network check needs a second PC and an approved
  public ingress (`tools/public-group-check.mjs`, opt-in, not run here).
- A route the friend can reach still has to exist: an operator places
  `<profile>/always-on/relay-advertise.json` (`{host,port}`) pointing at Tailscale Funnel raw TCP or
  another public proxy. The app now preserves that route, uses it for invitations, and explains
  when an invitation only works on the same home network; it cannot create NAT traversal itself.
- The sibling workstream's fixed account service is not deployed.
