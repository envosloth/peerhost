# PeerHost — local-first experimental alpha

A Windows-first Minecraft Java server manager under development. Import a **stopped** existing server into a separate managed copy, run it locally, replicate immutable snapshots, and explicitly hand ownership to a trusted peer. The original source is not edited. No cloud object storage or gateway is required for local hosting.

**This is a development alpha, not a production-ready Minecraft hosting service.** Tests so far use disposable files, real local processes, real loopback TLS, and visible Electron controls. They do not establish real Minecraft/modpack compatibility, cross-household networking, power-loss durability, or working mini-PC routing.

## Run from source

Use a modern Node runtime with built-in `node:sqlite` (development tested with Node 26.7.0; Electron's embedded Node 24.21.0 is used by the desktop). Java is not bundled.

```sh
npm ci --ignore-scripts
node node_modules/electron/install.js
npm test
npm start
```

On the development Windows Git Bash session, use `command node` if its wrapper reports `stdin is not a tty`.

The app keeps its own profile at `%APPDATA%/PeerHost`. `--profile-root=<absolute path>` selects an isolated development/test profile. Never copy, delete, or reinitialize ownership databases to unblock hosting. That can erase a safety fence.

1. Stop the source server, including any launcher-managed Java process.
2. Click **Import existing**, select its folder, and acknowledge that it is stopped. PeerHost copies it into its profile.
3. Configure the **local** Java executable and a JSON argument array. Vanilla example: `["-Xmx4G", "-jar", "server.jar", "nogui"]`. Existing modpacks may require different arguments or `@` argument files. The start timeout (default 600 s) and stop timeout (default 180 s) are editable per server; large modpacks can need several minutes to reach `Done (`.
4. The managed server must already contain your accepted Minecraft EULA. PeerHost does not accept it for you.
5. Start only executables/mods you trust. Stop cleanly before snapshot or handoff operations.

## Snapshot versus hosting handoff

- **Send snapshot:** authenticated replication; the recipient receives verified immutable files, but gains no hosting authority and does not auto-run anything.
- **Hand off:** capture the final stopped copy, fence this device, transfer/verify files, ask the recipient for explicit local approval, commit recipient authority, then acknowledge. The recipient configures its own executable before starting.
- **Explicit decline:** if the recipient's pinned acknowledgment says it declined, nothing was committed there, so the offer is cancelled and the source owns the server again.
- **Failed or missing acknowledgment:** the source stays fenced, because a network error does not prove the recipient did not accept. Use **Retry handoff** on the same peer: it resends the *same* offer, and a recipient that already accepted it simply re-acknowledges it. A pending offer cannot be redirected to a different peer. No automatic rollback or heartbeat-loss takeover.
- **Uncertain local session:** confirm all previous processes are stopped before using the recovery control. This does not recover pending offers or take ownership back from another peer.

Old server execution directories and revisions are retained until you click **Clean up storage**, which (after a native confirmation) deletes earlier managed server folders, interrupted transfer staging, and revisions older than the current one and its two parents. The original imported folder is never touched. Conflicting ownership is refused rather than silently replaced or merged. Keep independent backups. Only an online device holding the latest complete revision can supply it; no free unlimited always-online availability is implied.

## Current boundaries

- Peer listeners bind **127.0.0.1 only** in this development build. Two isolated profiles on this PC can exercise replication/handoff. Another computer cannot reach these listeners yet.
- Manual certificate-fingerprint trust on both sides. No automatic invitations, discovery, NAT traversal, encrypted transit relay, or public deployment.
- Persistent address is **optional and OFF by default**. The saved mini-PC gateway setting remains **Unconnected**: routing is not implemented by that checkbox.
- Start-at-login is a saved preference only. No Windows startup entry is installed.
- Closing the window hides it to the tray. Use **PeerHost → Quit safely** or the tray menu to exit. Busy operations block quitting; running hosting requires a clean stop.
- Transfers send only the current revision, so history length never affects them. Bounds: 65,536 files, 16 GiB per file, 128 GiB per revision, and a 1 GiB free-disk reserve on the receiver; see [transfer documentation](docs/transfers.md). Both peers must run the same alpha (wire protocol v2).
- Snapshots reuse files whose size, timestamps and inode are unchanged since the previous snapshot (files modified within the last two seconds are always re-read), and flush new objects, the manifest and their directories before the ownership ledger records the revision.
- No live hosted world, credentials, application state, router, firewall, or mini-PC deployment is used by this project.

## Verification commands

```sh
npm test
npm run check:desktop
npm run check:handoff
npm run package:windows
```

The desktop checks open visible Electron windows, log each step, save screenshots under ignored `.test-data`, and hold windows for 90 seconds. Their server child is explicitly a **Node process fixture, NOT Minecraft**. QA substitutes native consent dialog answers, not the backend or IPC operations. The handoff check uses two actual application instances and pinned TLS on loopback.

Packaging creates a fresh unsigned Windows folder under `release/alpha-*`, checks bundled files and absence of test/private profiles, and prints its exact executable path. Do not distribute or treat a package as release-approved merely because it builds. To run visible handoff verification against that exact binary:

```sh
node tools/desktop-handoff-check.mjs --packaged="C:/absolute/path/to/PeerHost.exe"
```

## Architecture and license

Portable TypeScript/Node core; isolated sandboxed Electron renderer; narrow sender/frame-bound IPC; SQLite ownership ledger; SHA256 content-addressed snapshots; mutual certificate-pinned TLS; private identity encrypted by Electron `safeStorage` on Windows.

Packaged builds omit DevTools and force-reload from the menu. On Linux, run desktop checks with a Secret Service (the checks pass `--password-store=gnome-libsecret`); identity storage refuses to fall back to plaintext. Configured SQLite durability and filesystem tests are not hardware power-loss proof. See [ownership durability](docs/ownership-durability.md), [snapshots](docs/snapshot-implementation.md), [launcher](docs/launcher-implementation.md), and [transport](docs/transport-implementation.md) for tested scope and limitations.

Source is MIT licensed; bundled dependencies retain their own licenses.
