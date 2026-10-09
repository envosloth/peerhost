# v0.6.5-alpha release verification

Public unsigned Windows alpha prerelease: https://github.com/envosloth/seedhost/releases/tag/v0.6.5-alpha

## Provenance
- Application source/tag target: `610bc6868bdc4e9ad054dedab100ba090fb2b64c`.
- Annotated tag object: `132e37290b460d7da85723dd2483259a2068659b`.
- Release ID: `408141443`, public, draft false, prerelease true. Existing releases preserved.
- Source branch: `fix/multihost-complete-audit`; main unchanged.
- Published assets exactly `SeedHost-0.6.5-alpha-win32-x64.zip` and `SHA256SUMS.txt`.
- ZIP:159969804 bytes,1301 files, SHA256 `6b15835a69523c1bcc6b58946e6784c950177a816b8ff9cefb8fb78b670c8f70`.
- Checksum asset:101 bytes, SHA256 `51f03c3bf75d13730b8179442236ae0bdd5f9b4f8770249c73bbb49fefc9dce4`.

## Executed gates
- Release-source `npm test`:995 tests,994 passed,0 failed/cancelled,1 skipped; exit0. Thirty captured source/checkpoint files unchanged during run.
- Targeted independent reviews passed reservation safety, canonical corrections and release version/exclusion changes. No whole-repository certification.
- Exact versioned package matched122 emitted-core/desktop resources. Local operational checkpoints excluded from package and publication.
- Real headed Electron with actual renderer/preload/main/backend and pinned loopback TLS passed against exact versioned package. Only native dialog answers substituted. Checks: serverless pending Start; latest world/mod/config bytes and deletions; active owner/member refusal without interrupting host; mandatory clean Stop/final-save publication even with legacy optional flag off; A->B->A rotation; competing Starts exactly one Java spawn. Ninety-second final visible inspection completed; bounded fixture cleanup completed.
- Five version surfaces matched0.6.5-alpha: footer (formatted `v0.6.5-alpha · alpha`), desktop IPC, Electron metadata, updater current version and bundled package metadata. Initial scratch probe expected bare footer string incorrectly; corrected exact formatted assertion passed without changing app.
- Every one of1301ZIP files matched tested package by hash.
- GitHub draft-first upload/readback confirmed asset name,state,size and server SHA256 before public publication; anonymous public release readback confirmed tag,source and exact assets.
- Bundled updater against real published URLs:0.6.2-alpha and0.6.4-alpha detected0.6.5-alpha; current0.6.5-alpha up to date. Real download, SHA256 verification and extraction passed; all1301 staged files matched tested package. No install/apply performed.
- GitHub exact-head checks/statuses/workflows each reported0; local gates are not GitHub CI.

## Limits and testing guidance
Unsigned prerelease. Back up independent stopped worlds and update both hosting members before testing. Keep the hosting-control endpoint reachable; directory connectivity alone is not hosting transport. Tests use real Java processes with synthetic world/mod/config bytes, not Minecraft gameplay, arbitrary modpack or cross-home-network certification.

Automatic group launch supports validated unambiguous Vanilla/Fabric JAR layouts with approved local Java; scripts/argument-file/ambiguous modloader layouts refuse. Advanced launch is not a group bypass. Crash/restart or lost acknowledgment can conservatively strand pending admission; no timeout takeover or unsafe recovery exists. Same-app stopped publication retry is supported. Separate legacy Playit authentication repair remains unresolved.

No live profiles, installed app, hosted worlds, router/firewall/startup or tunnels were changed by release publication. This audit-only commit follows the immutable application tag rather than moving its target.
