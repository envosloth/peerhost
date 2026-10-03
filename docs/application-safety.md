# Application review safety fixes

## Boundaries

- A profile may import a server only when it has no saved server. Reimport (including a different source directory) never resets owned, offered, transferred or uncertain authority. Select a separate explicit profile for a different server. Existing files, metadata and ledger are retained.
- Desktop launch consent runs inside `startServerWithApproval`, under the application operation lock. The callback receives frozen profile-root, server-directory, snapshot and executable/argument data. After consent, metadata, stopped state, EULA and ledger revision are checked again before spawn. `startServer(true)` remains a trusted core caller API, not the desktop IPC path.
- Unexpected child exit queues a fence for that launch's captured ledger. An unrelated operation must commit the uncertain fence before releasing its lock. Explicit startup and stop are classified separately; startup/stop failures still fence ownership. Explicit stopped-process recovery remains available.
- Incoming activation checks the original metadata and ledger, stopped state, actual socket state and unique operation token after consent and before activation. A transport timeout does not authorize an abandoned callback. Verified replicas and unactivated execution directories may be retained; they do not grant authority.
- Once candidate metadata/authority activation begins, the application drains it before releasing its operation lock, even when the transport stops waiting. A stale session aborts before authority is attempted and restores previous metadata under that lock. Once acceptance may have committed, candidate metadata is retained for reconciliation; durable authority is never rolled back because acknowledgment was lost.
- The expected renderer URL uses `pathToFileURL(html).href`; a Windows filename containing spaces or `#` is not interpreted as URL syntax.

## Reproduction and verification

Strict RED/GREEN failures observed before their corresponding fixes:

1. Actual A → B handoff with B's fixture hosting: A reimport incorrectly succeeded (`Missing expected rejection`).
2. Locked approval API absent, then actual desktop native-consent wait returned `busy: null` instead of `startServer`.
3. Actual fixture exit overlapping real settings persistence left the ledger `hosting` instead of `uncertain`.
4. Emitted main URL expression treated `#` as a fragment instead of `%23`.
5. An approval resumed after the actual transport's 120000-ms deadline replaced a newly imported, hosting server's directory.
6. Transport timeout released the operation while candidate metadata persistence remained in flight (`busy: null` instead of `receiveSnapshot`).

Tests exercise real application methods, SQLite commits, disposable managed copies, pinned loopback TLS sessions and Node fixture children. Native desktop dialog responses are substituted to deterministically hold consent; the real Electron main, IPC, backend and launcher execute. Persistence/commit barriers delay the real operation instead of replacing its result. Deadline tests advance Node's timer clock, not TLS, file verification or ledger results. Coverage includes closed-session consent, changed profile/snapshot metadata, precommit abort and durable acceptance with lost acknowledgment, including an acceptance-result error after the SQLite commit.

Commands on this Windows Git Bash host:

```sh
node node_modules/typescript/bin/tsc -p tsconfig.json
node --test dist/tests/application*.test.js
node tools/run-tests.mjs
```

Fresh build and targeted application tests: **23 passed, 0 failed**, approximately 99 seconds. Fresh build and full suite at that time: **186 passed, 0 failed**, approximately 100 seconds (later launcher and deflake additions raised the current total; see the launcher and snapshot docs for their own evidence). The actual desktop regression includes a 90-second visible-window hold and emits `ARTIFACT_DIR` containing pending-approval and approved-fixture screenshots. Latest targeted desktop artifacts: `.test-data/review-desktop-TEzthz/`.

## Limitations

- These are process/TLS fixtures, not Java/Minecraft save-integrity, mod trust, public routing or live-world validation. No live server, credentials, external settings or public sockets were used.
- The timeout regression exercises the real timeout branch with an advanced clock, not a two-minute wall-clock wait.
- Candidate metadata is persisted before the ledger is initialized/accepted, preserving restart fail-closed behavior. During that brief pre-authority phase, the existing `getState()` ledger lookup can reject rather than return tentative ownership. The lock stays held and safe quit remains refused; tests wait for activation settlement before reading committed state. No renderer contract change was made for tentative authority.
- An abandoned native dialog may resolve after its socket/operation expires. Its callback can only log a refusal; it cannot activate server metadata or authority.
