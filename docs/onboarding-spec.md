# Spec: beginner-friendly PeerHost setup

Status: user approved scope, implementation plan and autonomous scoped task execution in chat. Disposable scratch-only Java download for a real-server test also approved. Implementation in progress; no commit, deployment or publishing authorized.

## Objective
Make a new user able to prepare a Minecraft Java server and understand sharing without editing JSON or guessing which PC performs a step. Preserve the existing local-first, single-owner hosting guarantees. Integrate with the currently uncommitted Modrinth/friends features; do not replace or publish them.

## Assumptions for review
- New-server creation offers Vanilla and Fabric. Existing Forge, NeoForge, Quilt and other server folders use Import; do not pretend selecting a compatibility label installs a loader.
- The user explicitly chose world storage plus a permanent player address forwarded to the active host. Implement an opt-in real TCP gateway on the relay with pinned host-initiated TLS tunnels, not just the existing persistent-address preference. The gateway closes/rejects connections unless the relay ledger confirms that tunnel's enrolled device is the current holder; no traffic while parked or ownership is pending.
- Save both onboarding progress and world revisions: the wizard is resumable, and a revision/history surface makes saved progress discoverable. A saved revision is not proof of remote backup.
- Adding friends and configuring a third PC are optional. Skipping either does not block local hosting or discard completed work.
- Java installation is not assumed. Discovery, compatibility checks and clear instructions are required; no silent executable installation or system changes. The current development shell has no Java on PATH.
- No automatic Minecraft launch, EULA acceptance, router/firewall edits, startup service installation, remote deployment or publishing.

## User experience and success criteria
1. Fresh profiles open a dismissible setup wizard. Existing profiles are not reset or interrupted while hosting. A permanent Setup / resume entry is always available.
2. First stage offers Create a server, Import an existing server, and Set up later. The Operate empty state contains a large centered button with the exact label `create a server`, and a secondary Import option. Both open the relevant wizard stage.
3. Create offers a name, release version, Vanilla/Fabric selection, RAM setting and detected or explicitly selected Java executable. Use official bounded metadata/downloads, checksum verification, a managed destination and explicit EULA consent. Never overwrite an existing server. Save a normal owned server/profile and initial revision without starting it. Cancelling/failing downloads leaves no usable partial server; uncertain persistence fails closed.
4. Import uses the native folder picker and existing stopped-source confirmation. Explain the managed-copy behavior. Offer simple Java/RAM/profile help, preserve modpack launch scripts/argument files and keep advanced JSON editing available. Never claim a guessed launch profile was verified.
5. A readiness stage explains Java compatibility, Start/Stop, clean world saves, executable trust and how players connect. Distinguish local readiness from LAN/public reachability; do not infer reachability from saved settings.
6. Friends stage is skippable, supports existing pinned invitations and explicitly says joining neither starts hosting nor claims a world. Invitation codes are transient bearer secrets, not persisted in onboarding drafts, logs or screenshots.
7. Always-on PC stage is skippable. Provide machine-labelled steps for the actual relay CLI, requirements, choosing a reachable address, first invitation and joining/pinning from each host. Offer an actual connection/status check with distinct unchecked, unreachable, configured and verified states. Never mark remote setup complete merely because instructions were viewed. If a player-address gateway is requested, its actual implementation and verification must be specified before coding; do not relabel the storage relay as one.
8. Durable, versioned onboarding progress remembers current stage, skipped choices and non-secret drafts across close/relaunch. Back/Next, Save and close, Resume and revisiting completed stages work without repeating destructive creation/import. Completion reflects real application state, not arbitrary renderer checkmarks. Missing/corrupt optional onboarding metadata cannot disable Stop, console or safe quit.
9. Operate includes accessible saved-world revision history and a plain explanation of local snapshots versus parked relay copies. Restore is explicit, stopped-only, owner-only and creates/preserves a safety revision; never rewinds ownership generations or overwrites an active/foreign-owned world. If a revision lacks executable/mod safety metadata, existing gates still apply.
10. Success page gives the next practical action without forcing friends/relay. New users see plain labels, keyboard navigation, visible validation, loading/cancellation/error feedback and layouts at the app's minimum supported width.

## Stack and commands
Existing Electron 44 / TypeScript 7 desktop; core remains independent of Electron; sandboxed renderer uses validated preload IPC. No new runtime dependency is assumed.

From repository root:
- Build: `npm run build`
- Automated regression: `npm test`
- Existing visible checks, serially: `npm run check:desktop`, `npm run check:handoff`, `npm run check:relay`, `npm run check:mods`, `npm run check:browser-friends`, `npm run check:mod-recovery`
- New onboarding visible check: add `npm run check:onboarding` during implementation.
- Hygiene: `git diff --check` and `npm audit --omit=dev --audit-level=high`

## Project structure
- `src/core/`: creation/download/Java validation, optional onboarding persistence, revision-history/restore operations and application integration.
- `src/core/ipc-policy.ts`, `apps/desktop/main.ts`, `apps/desktop/preload.cts`: narrow validated operations, native paths, explicit consent and external-link allowlist.
- `apps/desktop/index.html`, `renderer.js`, `style.css`: wizard, empty-state CTA, resumable checklist, simple profile setup and snapshot history.
- `tests/`: node:test unit and application tests, source `.mjs` security/renderer assertions.
- `tools/`: isolated real Electron onboarding verification.
- `docs/`: onboarding instructions, official source citations and verification evidence.

## Code style
Follow adjacent TypeScript and plain renderer JavaScript, explicit input validation, no shell expansion and plain user-facing errors. Example style:

```ts
if (state.server) throw new Error('This profile already has a server. Your existing world was left unchanged.');
await application.createServer(validatedInput);
```

Do not grant arbitrary filesystem paths, executable commands or download URLs from renderer payloads. Paths come from main-process native selection or trusted managed storage; runtime probing is bounded and user-directed where needed.

## Testing strategy
Strict vertical RED → GREEN → REFACTOR cycles with captured actual outputs. Test persistence/relaunch, missing/corrupt optional progress, skipped/resumed stages, cancelled native dialogs, Java missing/incompatible, bounded official downloads, wrong hashes, existing-server refusal, no implicit EULA/launch, secret non-persistence, relay failure and owner-gated history/restore. Real Electron tests operate through visible controls with disposable profiles and screenshots at minimum/default widths. Run all existing regressions on the final combined tree, serializing visible checks. Fixtures are labelled as fixtures; a Node fake server does not establish real Minecraft support. Exercise a real official server where an explicitly installed/selected compatible Java runtime is available; report any unverified platform/network boundary.

## Boundaries
- Always: preserve existing dirty changes and worlds; validate IPC and downloads; retain native consent; keep Stop/safe quit independent of optional setup; preserve single ownership; use isolated test profiles; report real failures.
- Ask first: clarify the player-address gateway scope; add runtime dependencies or change deployment/system/network policy; publish or deploy.
- Never: auto-accept EULA; silently install executables; save invitation secrets in progress; erase a live profile; open network ports or change router/firewall/startup settings; equate configuration with connectivity; commit before parent review or publish without user authorization.

## Resolved third-PC scope
The user explicitly selected world storage plus one permanent player address that forwards to whichever PC is hosting. Real pinned-tunnel gateway forwarding is required; players reconnect after host changes. Public internet availability and router/firewall/startup configuration are not automatic.

## Review gate
User approval of the scope, followed by a reviewable implementation plan and task breakdown, precedes production implementation. This draft does not claim the feature is complete.
