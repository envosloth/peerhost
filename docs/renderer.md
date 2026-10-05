# PeerHost desktop renderer

## Surface and files

This is an **Operate** surface, not a marketing page or simulated dashboard:

- **Frameless window, no title strip:** the sidebar (with the brand at its top) reaches the top edge; a transparent, borderless drag row on the page carries the live activity line (`#activity-message`, with a ready / busy / offline dot) and minimize / fullscreen ⇄ borderless / close. The window test asserts there is no title band. Borderless offers only fullscreen; fullscreen offers only borderless. F11 toggles; Esc leaves fullscreen when no dialog or text field has focus.
- **Splash** inside the one app window. It is never a second `BrowserWindow`, so QA's `firstWindow()` and `getAllWindows()[0]` stay the app window. It covers the first authoritative state read (at least 1.3 s, so the mark finishes drawing) and is never shown for more than 6 s. The first-run setup guide is modal and opens above it.
- **Sidebar page tabs** (vertical ARIA tablist; arrow keys, Home and End move between them):
  - **My server** (`#operate-panel`): a status marquee with four gauges and a ticker that mirrors state and offers no actions; the server card (getting started, how to join, lifecycle buttons, latest console line, always-on PC, technical details); backups; mods; advanced launch settings.
  - **Console** (`#console-panel`): the tab is hidden until a server exists.
  - **Friends** (`#peers-panel`): a Configure surface with **Invite a friend** / **I have an invitation** intent buttons, one focused form, local invitation review, group membership/custody, player-only instructions, and folded *Advanced: direct PC-to-PC transfers*.
  - **Settings** (`#settings-panel`): category tabs **Appearance**, **Network** (displayed player address, relay) and **App** (close button, start at login).
  - Only the selected tab is marked active, and focus stays on the tab that was clicked.
  - **Setup guide** is a separate button that opens the dialog.
- **Setup guide** (`#setup-dialog`): a two-column dialog with a rail (`.setup-rail`, the five `[data-setup-step]` buttons) and a content column. Game type (`.option-tile`) and memory (`.chip-options`) are radio tiles and chips. The hidden `#setup-loader`, `#setup-memory` and `#setup-runtime-memory` selects (`.select-bridge`, not tab-reachable) stay the form values the guide reads and validates. Picks write into them, and programmatic or `selectOption` changes flow back onto the tiles (`syncBridges`).
- **Brand:** the visible name is **Seed Hosting**; the mark (cream seed sprouting two green leaves on a fixed forest-green tile, independent of the accent) is the `#logo` symbol and `tools/generate-icon.mjs` uses the same geometry. Decorative `svg.phyllo` elements are filled at load with a golden-angle (sunflower) seed spiral.
- **Create a world:** `.world-preview` mirrors the form live (`renderWorldPreview`: name, game type, version, memory, and the missing items before creation). `#setup-random-name` rolls a friendly name.
- **Page visibility** lives on the page wrappers. Sections the state hides (`#console-section`, `#mods-details`, …) are inside them, so the two never fight over `hidden`. `revealElement` opens the page or category that holds a control before validation focuses it. QA scripts do the same through `reveal()` in `tools/desktop-test-setup.mjs`, by clicking the real tabs.
- **Appearance** (theme dark / light / system, five accents, surface Soft or Tactile, density, motion, close behavior) lives in `localStorage` under `peerhost.appearance`. It applies instantly and falls back to defaults if storage is unavailable. It is separate from the backend settings form; *Save settings* appears only on the Network and App categories, or while edits are unsaved.
- **Design:** clean and crisp. Depth comes from tonal steps (page → card → raised control), hairline borders and tight shadows; inputs and tracks sit in inset wells. There is deliberately no bloom: no glows, cloud gradients or backdrop blur. The standard dark mode is a deep ink (`#0f1116` page, `#161920` cards). Tactile adds crisp bevels and console scanlines. Affordance never relies on shadow alone: accent colour, borders and focus rings carry it, and text tokens meet WCAG AA in both themes. No external assets, fonts, packages, or build step. Icons are an inline SVG sprite. `tools/generate-icon.mjs` rasterizes the same mark to `icon.png` (window and tray) and `icon-256.png` (Linux launcher).
- **Layout:** the minimum window is **1000 × 700**. `tests/desktop-window.test.mjs` audits overlap, clipped text and horizontal overflow on every page and settings category, in both themes, compact density and fullscreen.

Runtime files are `apps/desktop/index.html`, `apps/desktop/style.css`, and `apps/desktop/renderer.js`. Main and preload are separate and are not implemented by these files.

## Bridge contract

The only privileged interface is `window.peerhost.call(method, payload)`, returning a Promise. Rejected promises show the actual error in a dismissible alert. The renderer contains no fallback data or standalone mock mode. Opening its HTML outside the Electron application, without a bridge, shows an honest unavailable error and blocks actions.

| Method | Payload |
| --- | --- |
| `getState` | None |
| `importServer` | None; main opens the native folder picker |
| `createSnapshot` | None |
| `saveProfile` | `{ executable, args: string[] }` |
| `startServer` | None |
| `stopServer` | None |
| `sendCommand` | `{ command }` |
| `saveSettings` | `{ persistentAddress, gatewayAddress, startAtLogin }` |
| `startPeerListener` | None |
| `addPeer` | `{ name, fingerprint, host, port }` |
| `sendSnapshot` | `{ fingerprint }` |
| `previewInvite` | `{ code }`; local-only validated decoding, no token in result, no enrollment/network request |
| `joinWithInvite` | `{ code, name }`; independently decoded native consent before enrollment |
| `createInvite` / `listFriends` | None; require a configured relay |
| `getWindowState` / `windowMinimize` / `windowToggleFullscreen` | None; returns `{ fullScreen, maximized }` |
| `windowClose` | None; same as closing the window (hides to tray) |
| `quitApp` | None; runs main's safe-quit path (busy / hosting checks and native confirmation) |

`getState` returns `{ version, deviceId, settings, server, peers, logs, peerEndpoint, busy }` as specified by the app contract. `deviceId` is displayed and copied verbatim as the device fingerprint; main must supply its public peer identity, never a private key. Ownership is expected to be a ledger object with `state` and `owner`; hosting and snapshots require `state === 'owned'` and `owner === deviceId`. Missing, uncertain, foreign, offered, or transferred ownership fails closed.

Process states recognized by the renderer are `offline`, `failed`, `starting`, `running`, and `stopping`. Only `offline` / `failed` are treated as stopped. Unknown process states block import, profile edits, snapshots, and start. Commands require `running`; Stop is available for `running` or `starting` when the app is not busy. Backend checks remain authoritative.

## Update and action rules

- Initial authoritative read, then a one-second delay between reads while visible. Hidden windows stop scheduling polls; becoming visible reads immediately. Reads coalesce so no two `getState` requests overlap.
- One mutation at a time. Local pending state and main’s `busy` disable mutations. Polling continues during a pending operation so actual logs / process state can update.
- Every completed or rejected mutation gets an authoritative read-back after any older polling read finishes. Profile, settings, and peer saves explicitly compare the saved fields before clearing drafts.
- State / connection failures disable actions. A later successful state read can clear a recovered connection error; polling does not dismiss an operation error.
- Polls preserve unsaved profile and settings edits. Importing a different server resets that server’s profile draft. Start is blocked while its profile has unsaved edits.
- Snapshot creation and sending are unavailable while hosting, starting, stopping, or under uncertain ownership. Snapshot send requires a confirmation dialog showing the full recipient fingerprint and snapshot ID. A changed snapshot / removed peer invalidates that confirmation.
- Empty console, absent server, no peers, and inactive listener states are explicit. Saved peers are not presented as connected peers. Counts come only from the actual returned peer array.

## Validation and security

- CSP: `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'`.
- No Node access, `require`, direct filesystem access, network requests, `innerHTML`, HTML parsing of logs, or executable strings in event attributes. Dynamic paths, filenames, log output, peer names, and pins are assigned with `textContent`, `.value`, and DOM creation APIs.
- Java path is a single executable string, not a shell command. Arguments must be JSON containing an array of strings. NUL / line breaks are rejected. Forge / NeoForge argument-file entries are preserved literally. Prominent copy warns that JARs, mods, and executables run code on this PC.
- Commands are one process-console line, not a shell command. Empty, NUL-containing, multiline, and over-4096-character input is rejected. Failed commands keep their input.
- Peer fingerprints require **exactly 64 lowercase hexadecimal characters**. No whitespace stripping, case normalization, truncation, or guessed pin. Self-pins are rejected. Trust needs a recognizable name, separate host, and integer port from 1 through 65535.
- Opted-in gateways require `hostname:port` with a port from 1 through 65535. Protocols, paths, and whitespace are rejected. Turning opt-in off disables the address input without discarding its draft.
- Explicit labels, visible focus rings, skip link, alert / status announcements, keyboard tab navigation, native disclosure controls, and a modal confirmation with Cancel focused first. Follow output can be turned off to read older console lines.

## Alpha honesty

Direct hosting on **this Windows PC** is the default. A persistent address is optional and off by default. The gateway badge always says **Unconnected** because this contract has no gateway-connection operation or proof of public incoming reachability. Saving a preference does not connect, deploy, change a router / firewall, or prove public availability.

Hosting invitations enroll members of an existing optional relay. **Check invitation** only decodes metadata; it does not prove authenticity, reachability, or that the token is unused. **Review & join group** shows native consent based on the original code, not renderer-supplied preview details. Compare the full fingerprint through a trusted channel. There is no automatic discovery or NAT traversal. The advanced direct listener is explicitly loopback-only; a separately configured reachable relay is needed between separate PCs.

Sending shares server files, potentially including configuration or player data. It does not claim that an ownership handoff completed. The renderer warns before sending and reflects whatever ownership main actually returns.

Start-at-login is labeled a saved preference only in this alpha, not a Windows startup registration. Close-to-tray is explained in the UI; actual tray / quit behavior belongs to main. No renderer control changes startup, router, firewall, services, or existing external servers.

## Verification performed

- `command node --check apps/desktop/renderer.js`: passed.
- Strict RED/GREEN development with a temporary **explicitly synthetic DOM + bridge** fixture harness outside the repository: **13 tests passed**. Covered empty states, literal untrusted strings, running / unknown / foreign-ownership locks, payloads and read-back, JSON validation, draft preservation, busy serialization, actual errors, manual trust / confirmation, opt-in settings, visible polling, and bridge recovery.
- Headed Chromium loaded the actual local HTML / CSS / JS at **1100 × 760** with an explicitly synthetic bridge. Exercised import-state rendering, profile validation / save, listener / peer trust, send cancellation / confirmation, hosting locks, command errors / retry, settings save, and keyboard tabs. No horizontal overflow, no remote requests, and no page / console errors. Screenshots inspected for layout and copy.
- These are renderer / browser checks, **not Electron preload/main, Minecraft, Java-process, socket, public-connectivity, or real snapshot proof**. Parent integration verification must exercise the visible real Electron application and actual backend independently.

Temporary harnesses and screenshots live under the Hermes scratch directory, not the app or repository; none is a production fallback.

## Guided friends flow

- A hosting invitation grants access to world/configuration files and the ability to share hosting. Players who only join Minecraft need a player address, not enrollment.
- Without a relay, the join form is the default; the invite view offers **Set up shared hosting** rather than an unexplained disabled action.
- The preview displays group name, endpoint and expiry using text nodes; the full fingerprint is under **Verify details with your friend**. Editing the code/name or closing setup invalidates pending and completed previews. Joining requires an exact current, unexpired preview. Main independently repeats decoding/validation.
- Codes and display-name drafts are transient, not saved in onboarding progress or local storage. Guide closure and play-only navigation are blocked while a mutation is pending; once idle, closing clears invitation drafts. Native cancellation preserves entries for retry; errors never echo invitation tokens. A verified successful retry clears the earlier cancellation/failure notice.
- Successful enrollment requires authoritative read-back of the relay and endpoint. Joining does not create/download/start a server. Clean stops attempt to park at the relay; an offline relay leaves the world local.
- **Members confirmed** means a successful membership read, not online presence. A failed refresh clears stale members. Custody remains based only on the relay's ledger, never an unrelated local server.
- `tools/desktop-friends-check.mjs` and `tests/friends-ux-desktop.test.mjs` exercise isolated visible Electron profiles and a real loopback relay. Timing-only IPC substitutions are explicitly labelled in their concurrency cases. They are not two-physical-PC or Minecraft-gameplay evidence.
