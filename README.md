# SeedHost — local-first experimental alpha

The desktop app is presented as **Seed Hosting**. The repository, package, Windows executable, relay binary, IPC channel, invite code prefix and profile folder all use the `seedhost` name.

A Windows-first Minecraft Java server manager under development. Create a checked official Vanilla/Fabric server or import a **stopped** existing server into a separate managed copy, run it locally, retain world revisions, and explicitly hand ownership to a trusted peer. The original source is not edited. No cloud object storage or gateway is required for local hosting.

**This is a development alpha, not a production-ready Minecraft hosting service.** Checks include actual disposable Vanilla/Fabric 1.21.1 JVM servers, saved-world transfer and Minecraft status through an opt-in pinned TLS player gateway, plus visible Electron controls. They do not establish authenticated player login/gameplay, arbitrary modpack compatibility, cross-household networking, physical mini-PC deployment, or power-loss durability.

## Run from source

**Linux launcher:** `npm run install:linux` adds SeedHost to your app menu (and `~/Desktop` if it exists), rebuilding automatically when sources change.

Use a modern Node runtime with built-in `node:sqlite` (development tested with Node 26.7.0; Electron's embedded Node 24.21.0 is used by the desktop). Java is not bundled: when creating a world, Seed Hosting uses a compatible Java already on the PC, or downloads Mojang's official runtime (the one the Minecraft launcher uses) into its own profile folder, checking every file's SHA-1.

```sh
npm ci --ignore-scripts
node node_modules/electron/install.js
npm test
npm start
```

On the development Windows Git Bash session, use `command node` if its wrapper reports `stdin is not a tty`.

The app keeps its own profile at `%APPDATA%/SeedHost`. `--profile-root=<absolute path>` selects an isolated development/test profile. Never copy, delete, or reinitialize ownership databases to unblock hosting. That can erase a safety fence.

1. Open **Setup guide**, or use the prominent **create a server** action in an empty **My server** page. Setup saves non-secret drafts/stages and can be closed or resumed at any time.
2. **Create:** choose a name, Vanilla/Fabric, release and RAM. Java is automatic. Pressing **Create my world** is the stated agreement to the Minecraft EULA, linked beside the button; a native directory picker chooses the download source, and cancellation creates nothing. Official files are checked before adoption into a separate managed running copy; the chosen source is retained. **Import:** stop the original server and use the labelled stopped-source native picker; SeedHost preserves the original.
3. **Memory:** configure RAM; Java discovery/selection remains under **Advanced: change Java** for imports or deliberate changes, with execution consequences stated inline. Simple setup preserves existing Java arguments; argument files controlling RAM or ambiguous/scripted modpacks need **advanced Launch profile**. Example: `["-Xmx4G", "-jar", "server.jar", "nogui"]`. Start/stop timeouts default to 600/180 s.
4. Friends is optional and its guide action completes in place. The always-on role is an optional **Multi-host** setting, not a guide stage or local-hosting prerequisite. The managed server must contain your explicitly accepted EULA; imported servers need their own acceptance.
5. Start only executables/mods you trust. Nothing starts automatically. Stop cleanly before snapshots/handoffs; **Backups** offers confirmed restore into a separate managed folder with a safety revision and preserved ownership generation. See [beginner setup](docs/onboarding.md).

## Snapshot versus hosting handoff

- **Send snapshot:** authenticated replication; the recipient receives verified immutable files, but gains no hosting authority and does not auto-run anything.
- **Hand off:** capture the final stopped copy, fence this device, transfer/verify files, ask the recipient for explicit local approval, commit recipient authority, then acknowledge. The recipient configures its own executable before starting.
- **Explicit decline:** if the recipient's pinned acknowledgment says it declined, nothing was committed there, so the offer is cancelled and the source owns the server again.
- **Failed or missing acknowledgment:** the source stays fenced, because a network error does not prove the recipient did not accept. Use **Retry handoff** on the same peer: it resends the *same* offer, and a recipient that already accepted it simply re-acknowledges it. A pending offer cannot be redirected to a different peer. No automatic rollback or heartbeat-loss takeover.
- **Uncertain local session:** confirm all previous processes are stopped before using the recovery control. This does not recover pending offers or take ownership back from another peer.

### Mods

Open a server card, then **Mods**: discovery/search, compatibility options and installed server/client lists are visible together. SeedHost detects common Fabric, Quilt, Forge and NeoForge layouts; if detection is incomplete, select the loader and Minecraft version and click **Save compatibility**. Browse popular compatible mods, search, and click **Install**. Required dependencies are resolved and downloaded with SHA-512 verification before files are added; execution trust is explained inline. Installing requires this PC to own the stopped server.

- **Server mods** are copied into the server's `mods/` folder and load on the next start.
- **Client pack** holds client-only mods (shaders, minimaps, the client half of a modpack). The server never loads them. **Export client pack** writes a zip with a `mods/` folder and install instructions to hand to players.

Placement follows Modrinth's declared client/server requirements. The existing **Add .jar…** buttons remain available for local files. Files and their Modrinth provenance travel with snapshots and relay claims. A checksum proves download integrity, not that a mod is harmless; review trusted sources and use the correct loader. SeedHost does not install or upgrade the loader itself. See [mod browsing](docs/mod-browser.md).

Only real `.jar` files are accepted; a batch with any invalid, duplicate or unsafe file is refused as a whole, and an existing mod is never overwritten (remove it first to update). Both lists live inside the managed server, so they travel with snapshots, handoffs and relay claims. Remove buttons delete from the current copy only; earlier snapshots keep their files.

### Optional relay (always-on storage)

Direct handoff needs both PCs online at once. An optional **relay**, a headless `seedhost-relay` process on an always-on PC, stores the server between hosts: **Hand off to always-on PC** when you finish, and any trusted PC can **Take over hosting** later, even while the first PC is off. Park-on-stop can do this automatically. Parking and claiming are ordinary pinned, verified handoffs with one owner at a time; a lineage id stops a different server from passing as a newer one. Setup and guarantees: [relay documentation](docs/relay.md).

### Several servers on one PC

Create or import as many servers as you like. **Home** lists accessible server cards: click one or press Enter/Space to open its workspace; nested copy/delete controls do not open it. Each keeps its own world, launch settings, backups and ownership record, and the app runs only the selected server. Adding a server never replaces or converts an existing one. **Server files** opens its validated managed folder in the OS file manager, not the original download/import source.

**Delete…** removes one server from this PC after a native confirmation. It deletes that server's managed copy, the backups it alone kept and its ownership record. It never touches the folder you originally imported, your other servers, your group, your playit tunnel or your account.

- **Only the server in use can run.** Switching and deleting are refused while a server is running.
- **A server whose ownership is not safely held by this PC cannot be deleted.** If it is fenced, uncertain or hosted elsewhere, recover it or take it back first — deleting would erase the safety record that blocks double-hosting.
- **Free up space** (Backups) still removes old folders and revisions, and now keeps every server in the library and their revisions.
- Each hosting group carries **one** server lineage. Create independent groups in each world's **Multi-host** page; the desktop allocates distinct durable helpers for independent worlds. See [relay documentation](docs/relay.md).

### Public address for friends anywhere (optional, playit.gg)

A relay player address works over the same LAN or Tailscale. Friends on another network with no VPN need a real public address. Seed Hosting supports **playit.gg** with a distinct persistent mapping for each world; local/direct hosting needs no relay or public address. A public address is shown only when one exists for that world, with readiness reported separately. Optional relay routing can provide a stable player entry point across hosting changes, but is not a prerequisite for ordinary local hosting.

Creating a new world automatically initiates setup for that exact world's Playit mapping with a distinct Minecraft port. First-time browser approval remains required; pending allocation or provider failure does not undo successful creation. The server workspace's join-address controls let you finish or retry setup. Seed Hosting downloads and manages the verified official agent or supports an approved external agent; credentials stay OS-encrypted, never in snapshots or logs. Existing unrelated tunnels are not silently repointed or deleted. An address is reported reachable only after a real Minecraft status ping. Setup, security and troubleshooting: [public address](docs/playit.md).

### Add a friend

**Only joining to play Minecraft?** Ask the host for the Minecraft address shown under **My server → How to join**. A hosting invitation is not a player address: it gives a trusted friend access to world/configuration files and permission to share hosting.

With a configured account directory, open **Friends**, create an account and send a request to your friend's signup username; they accept in their own app. Friendship works without a hosting group and grants no world-file or hosting access. Social requests and hosting invitations are separate; incoming hosting invitations and pending/serverless memberships remain reachable without a local server.

Create a group or invite a friend to share a selected world in that world's **Multi-host** page. Only its owner can invite or remove members. Enrollment is scoped to that world: it never replaces an unrelated local world, and an explicit download/claim creates a separate server for a pending group. The account directory delivers invitations; it does not supply hosting-control transport. Both directory and group relay must be reachable from each PC, and their administrator's machine must remain online. Worlds stay on member devices, not in the directory. Legacy code protocols remain internal for compatibility; advanced direct-device trust is in app Settings, not username enrollment. See [accounts and public hosting groups](docs/accounts.md).

Old server execution directories and revisions are retained until you click **Free up space**, whose inline explanation describes deletion of managed server folders no server in the library uses, interrupted transfer staging, and revisions older than the current one and its two parents. It keeps every server in the library and their revisions, because one content-addressed store holds all of their backup objects. The original imported folder is never touched. Conflicting ownership is refused rather than silently replaced or merged. Keep independent backups. Only an online device holding the latest complete revision can supply it; no free unlimited always-online availability is implied.

## Current boundaries

- Direct peer listeners bind **127.0.0.1 only**. For separate PCs, use the optional relay with an explicitly reachable LAN/Tailscale endpoint.
- Single-use invitations pin the relay certificate; manual fingerprint trust remains available for advanced direct peers. LAN pairing can discover an explicitly enabled always-on PC; public pinned-TLS ingress requires administrator configuration. No automatic router/firewall changes or universal public deployment. An explicitly enabled relay player listener supports host-initiated pinned TLS forwarding; see [game gateway](docs/game-gateway.md).
- Persistent address and the always-on role are **optional and OFF by default**, configured in **Multi-host**, not required guide stages. The displayed-address preference does not enable routing. Park/Claim establishes custody; only the confirmed running holder forwards. Players reconnect after a host change, and tunnel readiness is not Internet reachability.
- The optional **playit.gg** public address exposes Minecraft player traffic, not group membership. The normal workflow manages an official verified agent after browser approval; an existing approved external agent is also supported. Seed Hosting makes or reuses the Minecraft Java tunnel and never changes router, firewall or startup settings. Anyone with the address can attempt to join, so keep `online-mode` on and use a whitelist for private play. Free tunnels are rate-limited with no uptime guarantee.
- Start-at-login is a saved preference only. No Windows startup entry is installed.
- The window is frameless with no title strip; the window buttons sit on the page: **minimize**, a **fullscreen ⇄ borderless** toggle (also F11; Esc leaves fullscreen) and **✕**. By default ✕ hides SeedHost to the tray; *Settings → App → Close button* can make it quit instead. Use **Quit safely** in the sidebar or the tray menu to exit. Busy operations block quitting; running hosting requires a clean stop.
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
npm run check:playit
npm run check:library
# Requires approved disposable Java and explicit test EULA environment variables:
npm run check:server-create
npm run check:minecraft
npm run package:windows
```

The desktop checks open visible Electron windows and log each step. Legacy checks save screenshots under ignored `.test-data` and hold windows for inspection. Their server child is explicitly a **Node process fixture, NOT Minecraft**. QA substitutes native consent dialog answers, not the backend or IPC operations. The handoff check uses two actual application instances and pinned TLS on loopback. The relay check runs a real `seedhost-relay` process, parks from one instance, closes it, claims from the other, and reclaims on the first. The browser/friends check uses scratch profiles, downloads Lithium from live Modrinth, checks cancellation/install/persistence, and enrolls two profiles with real relay invites before park/claim. It saves screenshots in the scratch directory it prints and closes its instances automatically.

Packaging creates a fresh unsigned Windows folder under `release/alpha-*`, checks bundled files and absence of test/private profiles, and prints its exact executable path. Do not distribute or treat a package as release-approved merely because it builds. To run visible handoff verification against that exact binary:

```sh
node tools/desktop-handoff-check.mjs --packaged="C:/absolute/path/to/SeedHost.exe"
```

## Updates

Packaged builds check the project's official [GitHub releases](https://github.com/envosloth/seedhost/releases) and can update themselves: open **Settings → App → Updates**, press **Check for updates**, then **Download update**. The download is verified against the release's published SHA-256 (`SHA256SUMS.txt`) before anything runs. **Restart & update** closes the app, replaces the files in the app's own folder with the verified download, and opens the app again. Updates install only from this project's releases, on Windows, in packaged builds; a development (source) run can check but not install. The build stays unsigned as described below.

Release maintainers: `npm run package:windows` produces the folder under `release/alpha-*`; `node tools/package-release.mjs` then writes `release/SeedHost-<version>-win32-x64.zip` and `release/SHA256SUMS.txt` — the two assets the updater consumes. Keep the ZIP's internal top-level folder named `SeedHost-win32-x64`.

## Architecture and license

Portable TypeScript/Node core; isolated sandboxed Electron renderer; narrow sender/frame-bound IPC; SQLite ownership ledger; SHA256 content-addressed snapshots; mutual certificate-pinned TLS; private identity encrypted by Electron `safeStorage` on Windows.

Packaged builds omit DevTools and force-reload from the menu. On Linux, run desktop checks with a Secret Service (the checks pass `--password-store=gnome-libsecret`); identity storage refuses to fall back to plaintext. Configured SQLite durability and filesystem tests are not hardware power-loss proof. See [ownership durability](docs/ownership-durability.md), [snapshots](docs/snapshot-implementation.md), [launcher](docs/launcher-implementation.md), and [transport](docs/transport-implementation.md) for tested scope and limitations.

Source is MIT licensed; bundled dependencies retain their own licenses.
