# SeedHost v0.6.4-alpha — published release verification

This records the newly authorized GitHub publication. The earlier `ux-batch-checkpoint.md` and `ux-batch-verification.md` remain the historical, local-only 0.6.3-alpha checkpoint; their nonpublication statements describe that earlier task, not this release.

## Immutable publication targets

- Repository: `envosloth/seedhost`.
- Source commit: `26935758eff1c011c79bf8b741380c39b5d1fcb6` (`feat(desktop): release v0.6.4-alpha UX and hosting safety [verified]`). All 60 batch files were committed together; the commit also retains the previously local 0.6.3-alpha hosting-safety fixes in its ancestry.
- Source branch: `fix/multihost-complete-audit`. The default branch was not changed.
- Annotated tag: `v0.6.4-alpha`; tag object `2e15878da064b77b4395f5b92dfce099c161b816`, independently read back peeled to the source commit above.
- GitHub release: https://github.com/envosloth/seedhost/releases/tag/v0.6.4-alpha
- Release ID: `407413861`; published `2026-10-09T01:42:55Z`; `draft=false`, `prerelease=true`. Not marked the latest stable release.
- Publication used a draft, uploaded and read back both exact assets and their GitHub SHA-256 digests, then published and reread the exact release. A subsequent unauthenticated public API read also matched.
- This evidence document lands after the source commit. The tag stays on the commit whose application code produced the artifact; it is not moved to a later documentation tip.

## Version and frozen-source gate

`package.json` and both root version fields in `package-lock.json` are `0.6.4-alpha`. The package is genuinely newer than the previous public `v0.6.2-alpha` and the previously local `0.6.3-alpha`.

The final canonical `npm test` included a fresh build and finished with:

| Result | Count |
|---|---:|
| Tests | 952 |
| Pass | 951 |
| Fail | 0 |
| Cancelled | 0 |
| Skipped | 1 |
| Todo | 0 |

Exit status was 0. The opt-in `LIVE official Vanilla/Fabric preparation with real Java and checksum-verified upstream jars` test was skipped; this is not claimed as passing. Before/after dirty-tree manifests were equal, and a precommit comparison matched the same tested tree. The manifest SHA-256 was `8fee4339d92e9e5587416524f117c908a8fc8ef051faf1093c65b42709d2719b` (a verification manifest, not a Git tree-object ID).

Added-line credential/shell/eval/raw-HTML static scans and `git diff --check` passed. Independent review was scope-bounded: the prior local risk snapshots, synchronized release metadata/documentation/packaged-version assertions, and the final test-only foreground/diagnostic change. This is not a claim of a whole-repository security audit.

### Earlier failure and rerun history

The preceding normalized-temp full run finished with 952 tests, 950 passes, one failure and one skip. `desktop-window.test.mjs` timed out after 30 seconds at the setup-stage visibility/Ready wait, old line 174. Its exact failed stage and root cause were not established. It was not reclassified as a verified environment failure or a fixed production defect.

The unchanged test passed in isolation, in five window/version parallel repetitions, and three window/handoff parallel repetitions. Then the harness brought its own visible window to front before each guide-rail action and added requested-stage/DOM-state logging plus a failure screenshot. It retained all stage/readiness/layout assertions and deadlines, introduced no click retry, and rethrows the original error. Scoped static review approved that QA-only change. The new paired window/handoff gate and the final full canonical run passed. Production application code was not guessed at or changed to hide the timeout.

## Exact Windows package and desktop QA

Package: `release/alpha-jqjfBK/SeedHost-win32-x64/SeedHost.exe`.

- Direct packaging-only tool exited 0 after the canonical source gate.
- Resource verifier matched 122 app resources against the committed/tested source and checked packaging exclusions.
- Two isolated packaged Electron apps agreed on **0.6.4-alpha** across bundled metadata, `app.getVersion()`, state IPC, exact footer `v0.6.4-alpha · alpha`, and updater current version.
- Real desktop main/preload/IPC/core were exercised. Only native picker/confirmation replies were substituted; profiles and process/file workloads were disposable fixtures.
- Native import cancellation changed nothing; the stopped source remained distinct from its managed copy; Server files opened the validated managed OS path and Mods controls were visible.
- Pinned loopback TLS A → B → A passed, including request-scoped inline decline/accept, wrong-request refusal, source fencing with an unreachable recipient, and retry of the same offer. The process start/stop was a fixture, not Minecraft gameplay.
- Exact-package creation downloaded and verified the official Vanilla 1.21.1 JAR, retained the chosen source and adopted a separate managed copy. Native destination cancellation, popup-free explicit RAM Save and the optional-helper-off direct path passed. No Minecraft JVM was launched by that creation case.
- Friends exercised real isolated accounts/TLS/IPC: social friendship, per-world hosting invitations, serverless/pending membership, unrelated-world preservation, explicit append-only claim, independent groups, notification dedupe and reload persistence.
- A final 90-second visible holding-card observation measured 101 state reads and 7 completed directory refreshes. Card replacements: 0; minimum opacity: 1; animation: none; focus retained through the hold.
- All harness cleanup markers completed; a subsequent process check found no owned QA orphan.

## Published assets and archive verification

| Asset | Bytes | SHA-256 |
|---|---:|---|
| `SeedHost-0.6.4-alpha-win32-x64.zip` | 159956248 | `922c9b643c54b5506ad0e9689d13d1d6d7623c4cd832d57e41f2e038bb185e4f` |
| `SHA256SUMS.txt` | 101 | `b1125a3e19c385774e6ede11dad353c60fbff8d6464bf6bc659bce7ac11c095c` |

The ZIP's only application payload folder is `SeedHost-win32-x64`. The archive verifier rejected duplicate/unsafe names and compared the exact member set and every file's bytes: **1,300 file members matched the tested package**. The published checksum entry names that precise ZIP. No previous local ZIP was relabelled as 0.6.4-alpha.

## Real published updater validation

Using the exact package's `Updater` module, with disposable scratch roots and **no test API origin**, checks configured with current version 0.6.2-alpha and 0.6.3-alpha both selected v0.6.4-alpha. A check configured with current version 0.6.4-alpha reported up to date.

The updater fetched the actual published ZIP and `SHA256SUMS.txt`, traversed real GitHub/CDN download redirects, SHA-256-verified and extracted the archive. Its archive hash matched the local release asset above, and **all 1,300 staged files** matched the tested package, including bundled app code and package version. It staged only in a disposable root. `install()`/apply was never called. This validates the shipped updater module configured with older version labels, not every historically installed updater implementation.

## CI and remaining boundaries

At readback the source commit had zero GitHub check runs and zero status contexts; the repository listed zero Actions workflows. The passing gate is the executed local build/canonical/package checks, not invented remote CI.

This remains an **unsigned Windows x64 development alpha**; keep independent world backups. This release cycle does not certify authenticated Minecraft gameplay, public Playit allocation/reachability, WAN/different-PC hosting, or arbitrary modpacks. It did not install/update/stop the user's running app, edit live profiles/worlds, change startup/router/firewall configuration, update the shared directory service, or mutate unrelated tunnels/worktrees.

The artifact and local evidence remain under the ignored release directory. Verification logs/manifests are retained beside the package in `verification/`; only this bounded release record is added to the source tree after publication.
