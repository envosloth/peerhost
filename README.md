# PeerHost — local-first experimental alpha

The desktop app is presented as **Seed Hosting**. The repository, package, IPC channel and profile folder keep the `peerhost` name.

A Windows-first Minecraft Java server manager under development. Create a checked official Vanilla/Fabric server or import a **stopped** existing server into a separate managed copy, run it locally, retain world revisions, and explicitly hand ownership to a trusted peer. The original source is not edited. No cloud object storage or gateway is required for local hosting.

**This is a development alpha, not a production-ready Minecraft hosting service.** Checks include actual disposable Vanilla/Fabric 1.21.1 JVM servers, saved-world transfer and Minecraft status through an opt-in pinned TLS player gateway, plus visible Electron controls. They do not establish authenticated player login/gameplay, arbitrary modpack compatibility, cross-household networking, physical mini-PC deployment, or power-loss durability.

## Run from source

**Linux launcher:** `npm run install:linux` adds PeerHost to your app menu (and `~/Desktop` if it exists), rebuilding automatically when sources change.

Use a modern Node runtime with built-in `node:sqlite` (development tested with Node 26.7.0; Electron's embedded Node 24.21.0 is used by the desktop). Java is not bundled.

```sh
npm ci --ignore-scripts
node node_modules/electron/install.js
npm test
npm start
```

On the development Windows Git Bash session, use `command node` if its wrapper reports `stdin is not a tty`.

The app keeps its own profile at `%APPDATA%/PeerHost`. `--profile-root=<absolute path>` selects an isolated development/test profile. Never copy, delete, or reinitialize ownership databases to unblock hosting. That can erase a safety fence.

1. Open **Setup guide**, or use the prominent **create a server** action in an empty **My server** page. Setup saves non-secret drafts/stages and can be closed or resumed at any time.
2. **Create:** choose Vanilla/Fabric, release, trusted installed Java and RAM; explicitly read/accept the Minecraft EULA and approve native confirmation. Official files are checked before adoption. **Import:** stop the original server, select its folder through the native picker and confirm it is stopped; PeerHost preserves the original.
3. **Java & hosting:** discover/select Java and configure RAM with native execution consent. Simple setup preserves existing Java arguments; argument files controlling RAM or ambiguous/scripted modpacks need **advanced Launch profile**. Example: `["-Xmx4G", "-jar", "server.jar", "nogui"]`. Start/stop timeouts default to 600/180 s.
4. Friends and **Always-on PC** are optional skippable stages. Local hosting requires neither. The managed server must contain your explicitly accepted EULA; imported servers need their own acceptance.
5. Start only executables/mods you trust. Nothing starts automatically. Stop cleanly before snapshots/handoffs; **Backups** offers confirmed restore into a separate managed folder with a safety revision and preserved ownership generation. See [beginner setup](docs/onboarding.md).

## Snapshot versus hosting handoff

- **Send snapshot:** authenticated replication; the recipient receives verified immutable files, but gains no hosting authority and does not auto-run anything.
- **Hand off:** capture the final stopped copy, fence this device, transfer/verify files, ask the recipient for explicit local approval, commit recipient authority, then acknowledge. The recipient configures its own executable before starting.
- **Explicit decline:** if the recipient's pinned acknowledgment says it declined, nothing was committed there, so the offer is cancelled and the source owns the server again.
- **Failed or missing acknowledgment:** the source stays fenced, because a network error does not prove the recipient did not accept. Use **Retry handoff** on the same peer: it resends the *same* offer, and a recipient that already accepted it simply re-acknowledges it. A pending offer cannot be redirected to a different peer. No automatic rollback or heartbeat-loss takeover.
- **Uncertain local session:** confirm all previous processes are stopped before using the recovery control. This does not recover pending offers or take ownership back from another peer.

### Mods

Open **Mods → Browse Modrinth** on the Operate page. PeerHost detects common Fabric, Quilt, Forge and NeoForge layouts; if detection is incomplete, select the loader and Minecraft version and click **Save compatibility**. Browse popular compatible mods, search, and click **Install**. Required dependencies are resolved and downloaded with SHA-512 verification before files are added; native consent is required. Installing requires this PC to own the stopped server.

- **Server mods** are copied into the server's `mods/` folder and load on the next start.
- **Client pack** holds client-only mods (shaders, minimaps, the client half of a modpack). The server never loads them. **Export client pack** writes a zip with a `mods/` folder and install instructions to hand to players.

Placement follows Modrinth's declared client/server requirements. The existing **Add .jar…** buttons remain available for local files. Files and their Modrinth provenance travel with snapshots and relay claims. A checksum proves download integrity, not that a mod is harmless; review trusted sources and use the correct loader. PeerHost does not install or upgrade the loader itself. See [mod browsing](docs/mod-browser.md).

Only real `.jar` files are accepted; a batch with any invalid, duplicate or unsafe file is refused as a whole, and an existing mod is never overwritten (remove it first to update). Both lists live inside the managed server, so they travel with snapshots, handoffs and relay claims. Remove buttons delete from the current copy only; earlier snapshots keep their files.

### Optional relay (always-on storage)

Direct handoff needs both PCs online at once. An optional **relay**, a headless `peerhost-relay` process on an always-on PC, stores the server between hosts: **Hand off to always-on PC** when you finish, and any trusted PC can **Take over hosting** later, even while the first PC is off. Park-on-stop can do this automatically. Parking and claiming are ordinary pinned, verified handoffs with one owner at a time; a lineage id stops a different server from passing as a newer one. Setup and guarantees: [relay documentation](docs/relay.md).

### Add a friend

With a reachable relay configured, open **Peers → Add friend → Create invitation**, then send the single-use code privately. Your friend chooses **Join with an invitation**, enters their name and pastes the code. This enrolls their PC and configures the same relay without manual fingerprint exchange; nothing downloads or starts automatically. **Refresh members** shows the group and the current holder. The first member needs an invitation created on the relay itself. Invites expire after 24 hours by default; loopback codes work only on the same machine. Setup and owner controls: [friend invitations](docs/friends.md).

Old server execution directories and revisions are retained until you click **Free up space**, which (after a native confirmation) deletes earlier managed server folders, interrupted transfer staging, and revisions older than the current one and its two parents. The original imported folder is never touched. Conflicting ownership is refused rather than silently replaced or merged. Keep independent backups. Only an online device holding the latest complete revision can supply it; no free unlimited always-online availability is implied.

## Current boundaries

- Direct peer listeners bind **127.0.0.1 only**. For separate PCs, use the optional relay with an explicitly reachable LAN/Tailscale endpoint.
- Single-use invitations pin the relay certificate; manual fingerprint trust remains available for advanced direct peers. No automatic discovery, NAT traversal, firewall/router changes, or public deployment. An explicitly enabled relay player listener supports host-initiated pinned TLS forwarding; see [game gateway](docs/game-gateway.md).
- Persistent address is **optional and OFF by default**. The displayed-address preference does not enable routing. Enable actual host tunnels in **Setup → Always-on PC**, configure the local Minecraft port, and enable the third PC's separate player listener. Park/Claim establishes custody; only the confirmed running holder forwards. Players reconnect after a host change, and tunnel readiness is not Internet reachability.
- Start-at-login is a saved preference only. No Windows startup entry is installed.
- The window is frameless with no title strip; the window buttons sit on the page: **minimize**, a **fullscreen ⇄ borderless** toggle (also F11; Esc leaves fullscreen) and **✕**. By default ✕ hides PeerHost to the tray; *Settings → App → Close button* can make it quit instead. Use **Quit safely** in the sidebar or the tray menu to exit. Busy operations block quitting; running hosting requires a clean stop.
- Fullscreen uses Electron's native fullscreen: the window takes the whole display and hides the taskbar. Chromium-based apps cannot use a GPU "exclusive fullscreen" display mode the way DirectX games can.
- Appearance preferences (theme, accent, surface style, density, motion, close behavior) stay in the renderer's local storage on this PC. They are not part of hosting state, snapshots or relays.
- Transfers send only the current revision, so history length never affects them. Bounds: 65,536 files, 16 GiB per file, 128 GiB per revision, and a 1 GiB free-disk reserve on the receiver; see [transfer documentation](docs/transfers.md). Both peers must run the same alpha (wire protocol v2).
- Snapshots reuse files whose size, timestamps and inode are unchanged since the previous snapshot (files modified within the last two seconds are always re-read), and flush new objects, the manifest and their directories before the ownership ledger records the revision.
- No live hosted world, credentials, application state, router, firewall, or mini-PC deployment is used by this project.

## Verification commands

```sh
npm test
npm run check:desktop
npm run check:handoff
npm run check:relay
npm run check:mods
npm run check:browser-friends
npm run check:mod-recovery
npm run check:onboarding
# Requires approved disposable Java and explicit test EULA environment variables:
npm run check:server-create
npm run check:minecraft
npm run package:windows
```

The desktop checks open visible Electron windows and log each step. Legacy checks save screenshots under ignored `.test-data` and hold windows for inspection. Their server child is explicitly a **Node process fixture, NOT Minecraft**. QA substitutes native consent dialog answers, not the backend or IPC operations. The handoff check uses two actual application instances and pinned TLS on loopback. The relay check runs a real `peerhost-relay` process, parks from one instance, closes it, claims from the other, and reclaims on the first. The browser/friends check uses scratch profiles, downloads Lithium from live Modrinth, checks cancellation/install/persistence, and enrolls two profiles with real relay invites before park/claim. It saves screenshots in the scratch directory it prints and closes its instances automatically.

Packaging creates a fresh unsigned Windows folder under `release/alpha-*`, checks bundled files and absence of test/private profiles, and prints its exact executable path. Do not distribute or treat a package as release-approved merely because it builds. To run visible handoff verification against that exact binary:

```sh
node tools/desktop-handoff-check.mjs --packaged="C:/absolute/path/to/PeerHost.exe"
```

## Architecture and license

Portable TypeScript/Node core; isolated sandboxed Electron renderer; narrow sender/frame-bound IPC; SQLite ownership ledger; SHA256 content-addressed snapshots; mutual certificate-pinned TLS; private identity encrypted by Electron `safeStorage` on Windows.

Packaged builds omit DevTools and force-reload from the menu. On Linux, run desktop checks with a Secret Service (the checks pass `--password-store=gnome-libsecret`); identity storage refuses to fall back to plaintext. Configured SQLite durability and filesystem tests are not hardware power-loss proof. See [ownership durability](docs/ownership-durability.md), [snapshots](docs/snapshot-implementation.md), [launcher](docs/launcher-implementation.md), and [transport](docs/transport-implementation.md) for tested scope and limitations.

Source is MIT licensed; bundled dependencies retain their own licenses.
