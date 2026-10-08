# Multihost fixes — deployment record (2026-10-08)

Source: branch `fix/multihost-complete-audit` (662f220 + d0da913 + this docs commit).

## Desktop app
- Packaged `release/alpha-KVtc0d/SeedHost-win32-x64` (0.6.3-alpha), resource-equivalence 119 files exit 0, visible packaged acceptance harness PASS (log: scratch `friends-multihost-live-LxPZYi`).
- Installed to `C:\Users\angel\AppData\Local\Programs\SeedHost\0.6.3-alpha` beside `0.6.2-alpha` (rollback kept); Desktop + Start Menu shortcuts updated with readback.
- The running instance stays 0.6.2 until it is quit and relaunched from a shortcut.

## Account directory (the live one for friends)
- The app uses the directory hosted on the separate mini PC `omarchy` (`omarchy.tail715de3.ts.net:10000`, cert pin `f4de239f…`), switched there on 2026-10-07 13:46. The local `SeedHost-Accounts` service (127.0.0.1:47640, pin `9091ff…`) is stale and was NOT updated.
- Fixed `accounts.js` (sha256 `14188e12…`) and `seedhost-update-omarchy-directory.sh` were staged to the mini PC via Taildrop. Update on that machine:
  `tailscale file get ~/Downloads && bash ~/Downloads/seedhost-update-omarchy-directory.sh`
  (script backs up the current file, swaps in the fixed one, restarts the service; re-run safe if already applied).

## Verified live
- Public ingress `desktop-vmcmip5.tail715de3.ts.net:8443` (funnel → `127.0.0.1:47627`) pins the group helper `22d18aae…`; an unknown device is refused (`Invite required; untrusted request refused`); a wrong pin is refused. Funnel targets read from `tailscale funnel status`.
- Group relay config advertises `desktop-vmcmip5.tail715de3.ts.net:8443` with `advertiseSource: "explicit"`.

## Pending at record time
- Mini-PC directory update (user runs it there).
- Sender resend + friend `cordless` acceptance (friend-side; not executable from here).
- App quit + relaunch so 0.6.3 runs.

## Notes for future sessions
- Two directories exist; friends' account/session data lives on the mini PC one. Do not "repair" the stale local one, and do not switch the app's directory without migrating account data.
- The desktop funnel on port 10000 also still points at the stale local directory (`127.0.0.1:47640`); it is unused by the app but remains exposed.
