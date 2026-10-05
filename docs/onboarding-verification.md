# Onboarding and saved-world verification

## Local implementation status

Resumable beginner setup, verified Vanilla/Fabric creation, stopped-folder import, Java/RAM assistance, optional friends and third-PC setup, real opt-in player forwarding, and retained world revision restore are implemented locally. **Not committed, published, packaged, deployed, or release-approved.** The existing published alpha does not automatically contain these working-tree changes.

One approved checkpoint remains blocked: the independent reviewer exhausted its provider quota. Parent direct review and corrective regressions were completed, but are not represented as a completed independent review.

## Final execution evidence

| Gate | Observed result |
|---|---|
| TypeScript desktop/core build | Clean (`npm run build`, exit 0) |
| Full automated suite, live downloads enabled | **375 tests, 375 pass, 0 fail, 0 skipped** |
| Visible Electron checks | **8 distinct tools, 8 pass** |
| Real Minecraft JVM smoke | Vanilla and Fabric **1.21.1**, both pass |
| Production dependency audit | **0 vulnerabilities** (`npm audit --omit=dev --audit-level=high`) |
| Diff whitespace/conflict hygiene | `git diff --check`, exit 0 |
| Final disposable QA processes | `QA_PROCESSES=[]` |
| Packaging / authenticated player login / physical-PC Internet test | **Not performed** |
| Independent third-party review | **Blocked by provider usage limit** |

Full-suite log: `<scratch>/seedhost-final-suite-live.log`. It was run with the explicitly approved disposable runtime selected through `SEEDHOST_SETUP_LIVE_JAVA`; the normally opt-in official Vanilla/Fabric preparation test was not skipped.

Visible checks ran serially against the built application, with isolated profiles and genuine production IPC/backend operations. Native picker/consent answers were automated, not backend operations. Latest named checks: `desktop`, `handoff`, `relay`, `mods`, `browser-friends`, `mod-recovery`, `onboarding`, `server-create`. Per-tool final logs are `scratch/seedhost-final-<name>.log`; exact aggregate is `<scratch>/seedhost-final-visible-all.json`.

## Acceptance trace

| Requested behavior | Exercised evidence |
|---|---|
| Fresh create/import/later setup and exact lowercase `create a server` Operate action | Renderer tests and actual fresh Electron wizard/empty-state assertion |
| Save/resume progress at any time, skipped optional stages, existing-world preservation | Durable progress tests; actual Escape, reopen, relaunch, drafts and friend/gateway skips |
| Verified Vanilla/Fabric creation without implicit EULA or automatic launch | Official metadata/hash/size/origin/deadline tests; application adoption tests; actual native EULA/download cancel and approval, stopped managed Vanilla creation; real official Fabric preparation and launch |
| Friendly Java/RAM setup | Actual disposable Java probe cancellation/approval and profile-save native cancellation/approval; unambiguous JAR inference, preserved Java arguments/timeouts, scripted/ambiguous layouts refused; argument-file heap overrides require advanced profile |
| Optional friend enrollment | Real relay invitation/enrollment in browser/friends visible check; wizard friend controls/skip and no secret draft persistence |
| Third-PC storage and stable player forwarding | Real relay Park/Claim; opt-in host gateway lifecycle/custody and expected local lineage/generation tests; visible save/not-ready/verified-route/forwarding/Stop checks |
| Accessible saved world revisions and safe restore | Real ancestry/retention tests; actual visible list, native cancel/approve, safety snapshot/new folder, preserved prior folder/generation and running-host restore refusal |
| Optional setup/catalog/gateway faults cannot trap Stop | Corrupt/oversized metadata lifecycle tests, console/clean Stop/safe close and fenced mutations; corrupt gateway metadata revokes forwarding without stopping the local world |

## Real Minecraft, not fixtures

The final `tools/real-minecraft-check.mjs` run used actual official Vanilla/Fabric 1.21.1 servers with disposable Temurin 25.0.4.1. It exercised application-managed gateway opt-in and automatic Start/Stop, decoded genuine Minecraft protocol-767 status replies, created a scoreboard through the console, stopped/saved/captured revisions, Parked/Claimed between profiles A and B, verified the saved scoreboard hash, and served the same relay player port after switching hosts. A was fenced and closed before B hosted; B held generation 4. Stopped routes refused new connections.

Final result: `<scratch>/seedhost-real-minecraft-WpDetk/result.json`; log: `<scratch>/seedhost-final-minecraft.log`. Vanilla player port `41869`, Fabric `42045`—ephemeral loopback addresses, not deployment endpoints. See [real-server verification](real-minecraft-verification.md).

This proves real JVM/status/world-save transfer on one computer with simulated host profiles. **It does not prove authenticated player login/gameplay, arbitrary modpack compatibility, physical multi-PC/public connectivity or power-loss survival.** Most desktop lifecycle checks deliberately use a labeled Node process or echo fixture and are not counted as Minecraft tests.

## Corrective RED/GREEN work and review boundary

Parent reproduced and fixed: missing application methods, uncertain ownership after failed creation persistence, native execution consent for simple Java setup, local lineage/generation checks before host routing, misleading gateway status on corrupt optional settings, and RAM changes silently overridden by JVM argument files. Gateway tests also cover nonholders/stale authority/foreign lineage, pin mismatch, pending and parked custody, membership revocation, leases/timeouts, early/coalesced binary bytes, backpressure and teardown. Official preparation tests refuse tampered/missing integrity data, redirects/offsite endpoints, oversized bodies, incompatible Java and partial publication.

Two final visible-test failures were harness defects: Electron message-box capture initially recorded the BrowserWindow argument instead of the last options argument; a legacy helper waited for a wizard on a returning profile that correctly kept it closed. Both were reproduced and corrected, then relevant checks were rerun; all six legacy checks were rerun after the helper correction. A timed-out QA run left one stopped-profile Electron instance; its exact disposable process tree was explicitly terminated and verified absent. No user application or live hosted world was touched.

Parent direct review is not an independent security audit. Keep the independent-review checkbox open until an available reviewer completes it. No release-readiness claim is made.

## Visual and scope checks

Actual screenshots reviewed from `<scratch>/seedhost-onboarding-zG9H6B`: `fresh-server-1000.png` and `gateway-verified-visible.png`. The modal is centered, controls/readable text and fixed navigation stay within the viewport, longer content scrolls, and the verified-route warning explicitly separates tunnel readiness from Internet access. Geometry assertions cover 1000×700 and 1240×860.

All test runtime/server/profile artifacts stayed in approved scratch or ignored `.test-data`. The original import source remained untouched. No system Java install/PATH change, real world/settings migration, router/firewall/startup change, remote deployment, git commit or publishing occurred. Scratch evidence is temporary and may be pruned; the checked-in test tools recreate it.
