# Local browser/friends verification

Working tree: `feature/mod-browser-friends`, uncommitted and unpublished. Public alpha remains unchanged.

## Final combined-tree results

- `npm test`: **300 passed**, **0 failed**, **0 cancelled**, **0 skipped**; includes the real Electron launch-approval regression, source `.mjs` security/transaction/renderer tests, and compiled TypeScript tests.
- `npm audit --omit=dev --audit-level=high`: **0 vulnerabilities**.
- `git diff --check`: passed.
- All six independent visible checks returned exit **0**, run serially:
  - `tools/desktop-mod-recovery-check.mjs`: corrupt/oversized metadata while hosting, reachable Stop/commands, scoped mod-action block, interrupted-install Start/snapshot controls, native safe quit and final ledger/snapshot.
  - `tools/desktop-browser-friends-check.mjs`: live Modrinth popular/pagination/search/empty results, native cancellation/approval, actual Lithium bytes/provenance, visible repair after removing its server copy while retaining its client copy, reload persistence, CDN icon loading, layouts at 1240 and 1000px, private relay invites/join/member text and unknown/parked/held status, park/claim carrying mods and matching revision IDs.
  - `tools/desktop-mods-check.mjs`: native local server/client jar import, invalid jar rejection, removal and client-pack export.
  - `tools/desktop-relay-check.mjs`: real relay process, park/claim with originating app closed, park-on-stop and newest-generation reclaim.
  - `tools/desktop-handoff-check.mjs`: real pinned loopback two-app handoff, decline restore, fenced retry, return handoff, retention/cleanup and local launch-profile isolation.
  - `tools/desktop-check.mjs`: real Electron identity encryption, native IPC, process fixture lifecycle, explicit ownership recovery and tray behavior.

Logs: `$HOME/.hermes/cache/scratch/seedhost-reviewed-final-suite.log` and `seedhost-reviewed-final-ui.log`. Feature screenshots: `$HOME/.hermes/cache/scratch/seedhost-browser-friends-zAmCD7/`. Logs/screenshots are local evidence, not release assets.

## Review corrections

Optional mod metadata no longer controls core lifecycle availability. Status provenance hashing is stat-invalidated and per-application cached; installer integrity checks remain fresh. Incomplete installations offer Repair / check. Relay custody distinguishes unknown, parked, pending and held without inventing authority from unrelated local worlds. Multi-file publication uses a durable intent fence; forced exits after first publication and metadata rename require explicit repair before Start/new snapshots/handoffs. Stop/safe quit are independent of that fence.

## Boundaries

The child process is a Node fixture, **not Minecraft**. No real modpack/game launch, physical two-PC/internet routing, hardware power-loss test, or current-feature Windows verification was performed. Unsupported directory flushing fails closed; prior Windows alpha smoke does not validate the new transaction path. No live user world/profile, router/firewall, deployment, commit, tag or release was changed by this feature verification. Invites still require an existing reachable relay; there is no automatic discovery, NAT traversal or Minecraft traffic tunnel.
