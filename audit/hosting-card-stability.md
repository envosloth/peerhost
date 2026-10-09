# Solid hosting-group cards — local v0.6.3-alpha patch

## Reproduced cause

The main renderer polls app state every 1,000 ms and dispatches `seedhost-state-read`. The account renderer called `renderGroups()` from each event and replaced every hosting-group card even when its displayed information was unchanged. Each new `.account-request` restarted `account-enter`, a 250 ms fade/vertical entry animation.

The original renderer and CSS hashes matched the running installed v0.6.2-alpha build. A deterministic visible Chromium regression observed four replacements across four unchanged state events, a disconnected original card, and lost button focus. A separate presentation regression observed `account-enter`, partially transparent cards and a translated transform. Both failed before their respective fixes.

## Narrow fix

- `apps/desktop/accounts.js`: compare signed-in visibility and all displayed group metadata before replacing children. Retain unchanged cards and action listeners; update mutation-lock button disabling in place. Real group changes and sign-out still redraw the correct state.
- `apps/desktop/accounts.css`: remove entry animation only from persistent hosting-group cards. No global motion disable, polling disable, group/member changes or custody changes.
- `tests/friends-inbox-renderer.test.mjs`: preserve DOM identity/focus through unchanged state/account refresh, retain busy-lock disabling/re-enabling, clear cards at sign-out, verify full opacity/no transform/no animation, and verify genuine metadata/pending-state changes still render.
- `tools/desktop-friends-multihost-check.mjs`: monitor actual installed/package cards through real main/preload/backend state and account polls, without reply overrides.

## Verification

- Current build passed.
- Focused Friends/control-route selection: 25 passed, zero failed; subsequently strengthened stability checks: 2 passed.
- Current canonical `npm test`: 923 tests, 922 passed, zero failed, zero cancelled, one skipped; exit 0. Log: `C:/Users/angel/AppData/Local/hermes/cache/scratch/seedhost-widget-fullsuite.log`.
- The source/test/tool diff hash was unchanged before and after the canonical gate: `e0f93ea7958e3727505414e8ce2ac769502eb24023bc98f01d15cbd932420030`.
- JavaScript syntax and `git diff --check` passed; added-line scans found no literal secrets, unsafe shell, unsafe HTML insertion or eval/exec patterns. This is a scoped self-review, not an independent reviewer verdict or a security audit. No subagents were used.
- Fresh local unsigned package: `release/alpha-QaMHiN/SeedHost-win32-x64/SeedHost.exe`; same-version unpublished local UI patch, not a new public release.
- Package AND installed app matched all 119 source resources; packaging exclusion checks passed.
- Exact installed executable exercised visibly with real isolated accounts, pinned loopback TLS, disposable worlds and `--unreachable --hold=90`: exit 0. Timeout feedback, acceptance, append-only download, independent groups and notification persistence passed.
- Installed-card observation: 90 genuine state reads, zero card replacements, original card retained, minimum opacity 1, animation `none`; focused action survived background polling. This verifies local installed renderer behavior, not cross-PC acceptance.
- Screenshots: `C:/Users/angel/AppData/Local/hermes/cache/scratch/friends-multihost-live-3sX3C6/05-solid-hosting-card.png` (disposable QA profile).

## Local installation and activation boundary

Updated only `resources/app/apps/desktop/accounts.js` and `accounts.css` in the inactive `C:/Users/angel/AppData/Local/Programs/SeedHost/0.6.3-alpha` install. All other expected resources matched before installation. Original renderer files backed up under `C:/Users/angel/AppData/Local/Programs/SeedHost/backups/before-solid-hosting-card-ace64182d98e4547bdcdf00ff4f0b56b`. The complete v0.6.2-alpha install was retained.

Desktop and Start Menu shortcuts were checked and left unchanged, still targeting v0.6.3-alpha with the existing live profile argument. The live v0.6.2-alpha session was NOT restarted or modified; live worlds/profile/membership/custody were not used as test fixtures. Activation requires the user to fully Quit the old tray-resident app and reopen the usual shortcut when safe. Closing its window alone can leave the old process running.

Nothing was pushed or published. These source changes remain uncommitted. The prior remote-directory update and real recipient acceptance remain separate, unverified deployment matters; this rendering patch does not establish either.
