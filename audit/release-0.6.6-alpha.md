# v0.6.6-alpha release verification

## Source and publication

- Release source: `378759fb8c391a4671d146a74e6b61bed45297cd`.
- Annotated tag: `v0.6.6-alpha`, object `2c76814b3e23d00cfeb130346116afeb968948a8`.
- Branch: `fix/multihost-complete-audit`; default `main` unchanged.
- Public unsigned prerelease: https://github.com/envosloth/seedhost/releases/tag/v0.6.6-alpha
- Release ID: `408227912`.
- ZIP: `SeedHost-0.6.6-alpha-win32-x64.zip`, 159972559 bytes, 1302 files.
- ZIP SHA-256: `530afb757c16b4ed489e0e0c169973f4e8b2484e53cd2ff58698895be1b9c043`.
- `SHA256SUMS.txt` published and each uploaded asset's provider digest verified before public publication.

## Changes and reproduced defects

- Initial publication awaited a full stopped snapshot/park under the five-second reply deadline. A real loopback TLS regression held publication beyond five seconds and reproduced `Frame read timed out`; only that operation now uses the existing bounded 120-second maximum. Timeout is not cancellation or authority to launch.
- A preexisting Playit refresh race inspected an intermediate creating reservation before its tunnel ID was durable. A gated real-relay/fake-provider regression reproduced the exact missing/changed-route error on HEAD-equivalent source. Refresh now validates only after creation has persisted and its cancellation guard succeeds. Genuine changed-route rejection remains covered.
- Both scoped independent reviews passed without blocking findings.

## Execution gates

- First aggregate: 997 total, 995 passed, 1 failed, 1 skipped. The Playit failure was reproduced and corrected before release.
- Final release-tree build and aggregate: 998 total, 997 passed, 0 failed/cancelled, 1 skipped; exit 0.
- Exact package: 122 emitted/desktop resources matched current source; private operational checkpoint documents excluded.
- Packaged real Electron/renderer/preload/backend/TLS/Java-fixture checks passed: initial serverless Start, latest bytes/deletions, mandatory final-save publication, A-B-A rotation, active-host refusal and exactly one spawned winner for competing Starts. Visible final inspection held for 90 seconds.
- Packaged Electron, package metadata, IPC, updater and decorated footer all identify `0.6.6-alpha`.
- ZIP member hashes matched all 1302 tested-package files.
- Published updater checks: previous 0.6.4 and 0.6.5 identify 0.6.6; shipped 0.6.6 is current. Real public ZIP download, checksum verification and extraction matched all 1302 tested-package files.
- Authorized local side-by-side installation matched all 1302 package files. Both existing user shortcuts were backed up and updated to the fixed build and explicitly approved current profile. Installed version/footer/updater readback passed; safe Quit followed by normal Desktop-shortcut launch verified the correct executable/profile. Previous installations retained.
- Existing public group control forwarding was not changed. Public ingress reached the correct group and returned an application-level unknown-device refusal; wrong certificate pin was rejected after normal restart.
- GitHub checks/status/workflow inventory: no checks, statuses or workflows configured; all verification described above was local. Empty combined status was `pending`, not CI success.

## Limits

The local fixture proves orchestration, not actual Minecraft saves, arbitrary modpacks or different-network friend hosting. The friend's installed version and successful Start after this release remain a user-side acceptance check. Public Playit gameplay reachability remains independent. A publication exceeding two minutes can still expire safely; late publication does not launch the timed-out member. No world, custody, friends or provider resources were manually reset for this release.
