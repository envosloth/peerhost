# Local SeedHost UX batch — verification result

Status: DONE for authorized local implementation and portable-build verification. Not an installation, public release, cross-PC repair or Minecraft gameplay certification.

Source: `fix/multihost-complete-audit`, HEAD `ced1ef3d80d939998ee83e483b6b6c02b30d64ae` plus preserved uncommitted changes. Other workstreams and the live profile were not modified. No commit/push/release, router/firewall/startup changes or purchases.

## Acceptance evidence

| Requirement | Achieved verification |
|---|---|
| Guide friend action completes in place and persists by world/generation | Renderer and real core persistence/stale-context tests in current canonical gate; signed-in inline action and no false progress after failures/obsolete workflows. |
| Visible Mods discovery/options and installed server/client lists | Canonical visible renderer tests plus exact packaged main/preload/backend navigation. Compatibility/dependency/content-verification suites remain green. |
| Native download destination and cancellation | Real official Mojang 1.21.1 desktop creation in development and exact package; native cancellation, actual selected source vs separate managed JAR byte equality, no automatic start. Real-file RED/GREEN junction, ancestor replacement and existing hardlink-leaf overwrite regressions. |
| Popup removal, consent and safe quit | Only Delete retains confirmation with Cancel default. Real pinned loopback A→B→A tests under receive lock, decline/accept, wrong ID, fenced same-offer retry; expiry, stale timer, concurrent offer and busy-quit refusal pins. Timer is callback-driven, not a hard real-time wall-clock deadline. |
| Whole-card opening/accessibility and focus | Click/Enter/Space and nested-action/focus tests in canonical gate; exact packaged card observed through 102 state reads and 7 completed directory refreshes, zero replacements, opacity 1, animation none, focus checked before and after the full 90-second visible hold. |
| Truthful server-bound/pending Friends groups | Renderer label tests and exact-package real IPC/pinned-directory TLS: serverless invitation, pending membership, unrelated import preserved, explicit append-only download, two independent groups, reload and deduped notification history. |
| Validated OS folder opening | Narrow ID-only IPC, exact managed-folder shell dispatch, malformed/arbitrary-path refusal; packaged shell invocation observed without opening an unrelated Explorer window. |
| Polling overhead and honest unavailable metrics | Real fixture process/loopback regression: eight concurrent dashboard reads and immediate refresh share one probe. World/PID/port freshness and lifecycle invalidation; unavailable players remain null. No measured Minecraft TPS or internet-latency improvement claim. |
| Optional helper omitted from guide | Four-stage layout and optional-role tests; real packaged creation leaves helper off, local hosting not dependent on helper. |
| Automatic per-world public setup | Returned-world binding, distinct ports/reservations, approval/allocation/error and persistence tests pass. Packaged creation success remains success without provider readiness. No live tunnel adoption/allocation/public Minecraft probe performed. |

## Gates

- Fresh build plus canonical `npm test`: 952 tests, **951 passed, 0 failed, 0 cancelled, 1 skipped** (opt-in live-server test), TEST_EXIT 0 and wrapper EXIT 0.
- Before/after canonical full tree manifests identical: `b7d03bd0e9ed0454caf80a14af66961f1d5b2488d9c0c22780f7061bf6fbfc5f`.
- Independent scoped read-only review: strict JSON `passed:true`, empty concern/error lists. Initial delegate workers timed out without complete verdicts; those were not approvals. Documented CLI query-file review and supplemental correctly located source excerpts supplied the final verdict. Scope is risky adoption/consent/quit/native-create/folder boundaries, not a whole-repository security audit.
- Exact unsigned Windows x64 package: **122 app/source resources SHA-256 matched**. Old preserved package negative control correctly failed on stale `accounts.css`. Private state/.env/development dependency exclusion checks passed.
- Exact packaged handoff and official-server creation passed; packaged Friends/group/polling/final visible hold passed with clean bounded teardown. A first polling-observer attempt mistakenly expected an `ok` envelope; the actual IPC returns an array. Corrected observer preserves original responses and counts successful array-valued directory reads. No product change or expectation weakening.
- `git diff --check` passed. Final process readback found no remaining isolated test/packager workers; the pre-existing running v0.6.2 PID 34072 remained alive and untouched.

The `package:windows` npm wrapper unexpectedly started another whole suite inline and exceeded the tool wait. Only its verified disposable process subtree was stopped; that redundant partial run is not test evidence. The actual packager was subsequently run as a tracked background job against the already freshly built, verified source and exited 0.

## Deliverable

Folder: `release/alpha-h2lkU3/SeedHost-win32-x64/`

Portable ZIP: `release/alpha-h2lkU3/SeedHost-0.6.3-alpha-local-ux-20261008.zip`

ZIP size: 159,951,153 bytes (152.5 MiB). Archive inventory exactly equals all **1,299** package files, with safe unique names and every member SHA-256 matching the tested package. Top-level folder: `SeedHost-win32-x64`.

SHA-256: `44153db396b49476e99a1970a9d058fa25931404219f4ecdcf1ef431d369a0f8`

Adjacent `.zip.sha256` and `-verification.json` are supplied. Same version 0.6.3-alpha, explicitly labelled **local UX build**, unsigned and unpublished. Do not confuse it with an official new release or replacement of the running app.

Fifteen nonempty logs/manifests, copied with hash readback, are preserved in `release/alpha-h2lkU3/verification/`, outside prunable scratch. Current scratch log names are also referenced by the checkpoint.

## Higher-level boundaries

Real official JAR creation was exercised but the server was not started for gameplay. The handoff/process-start fixtures prove desktop/core/loopback behavior, not Minecraft gameplay, public Playit routing or two networks. Installation, live-profile changes, remote deployment and release/publication were explicitly out of scope. No automatic continuation work remains for this local batch.
