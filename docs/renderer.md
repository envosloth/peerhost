# PeerHost desktop renderer

## Surface and files

This is an **Operate** surface, not a marketing page or simulated dashboard:

- Narrow PeerHost navigation; server identity, import / host / stop / snapshot controls, and process console in the center.
- Right inspector with keyboard-accessible Peers and Settings tabs.
- Warm graphite surfaces, restrained teal actions, local Segoe UI / Consolas typography. No external assets, fonts, packages, or build step.
- Fixed desktop shell with independent workspace, inspector, and console scrolling. Target viewport: **1100 × 760**. Expanded launch profiles remain scrollable without moving the sidebar.

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

Manual trust comes first: exchange full fingerprints over a separate trusted channel and share the actual listener endpoint; both peers must trust each other. Loopback listener addresses are clearly labeled as local-only. There is no automatic discovery, invitation flow, or NAT traversal; invitation ease is later work, not an unfinished working-looking control.

Sending shares server files, potentially including configuration or player data. It does not claim that an ownership handoff completed. The renderer warns before sending and reflects whatever ownership main actually returns.

Start-at-login is labeled a saved preference only in this alpha, not a Windows startup registration. Close-to-tray is explained in the UI; actual tray / quit behavior belongs to main. No renderer control changes startup, router, firewall, services, or existing external servers.

## Verification performed

- `command node --check apps/desktop/renderer.js`: passed.
- Strict RED/GREEN development with a temporary **explicitly synthetic DOM + bridge** fixture harness outside the repository: **13 tests passed**. Covered empty states, literal untrusted strings, running / unknown / foreign-ownership locks, payloads and read-back, JSON validation, draft preservation, busy serialization, actual errors, manual trust / confirmation, opt-in settings, visible polling, and bridge recovery.
- Headed Chromium loaded the actual local HTML / CSS / JS at **1100 × 760** with an explicitly synthetic bridge. Exercised import-state rendering, profile validation / save, listener / peer trust, send cancellation / confirmation, hosting locks, command errors / retry, settings save, and keyboard tabs. No horizontal overflow, no remote requests, and no page / console errors. Screenshots inspected for layout and copy.
- These are renderer / browser checks, **not Electron preload/main, Minecraft, Java-process, socket, public-connectivity, or real snapshot proof**. Parent integration verification must exercise the visible real Electron application and actual backend independently.

Temporary harnesses and screenshots live under the Hermes scratch directory, not the app or repository; none is a production fallback. Only the four assigned renderer / documentation files are changed by this renderer task.
