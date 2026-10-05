# Browse and install mods

Open **Operate → Mods → Browse Modrinth**. Popular compatible mods appear when a complete loader/version target is available. Search by name, use Previous/Next, or open a project's Modrinth page in your browser. API calls are made in the portable core, not by the sandboxed renderer; icons are restricted to Modrinth's CDN.

## Compatibility

Fabric, Quilt, Forge and NeoForge launcher layouts are detected on a best-effort basis. Detection is not a promise that a server is correctly configured. If the target is unknown or incorrect, choose the loader, enter the Minecraft version, and **Save compatibility** while this PC owns the stopped server. This records the selection inside the managed server; it does not install a loader or change Java arguments.

Only versions declaring the selected loader and game version are selected. Quilt includes declared Fabric-compatible versions. Releases are preferred over beta/alpha versions. No automatic upgrade or replacement of existing mods occurs; remove a conflicting version explicitly first. Existing projects offer **Repair / check** rather than an inert Installed button: this re-resolves the graph and restores missing destinations/dependencies without replacing matching files. If a newer version conflicts with the remaining installed version, explicit removal is still required.

## Server versus client

Project side metadata determines placement: client-only mods go into `seedhost-client-mods/`; server mods go into `mods/`; projects requiring both sides go into both. Optional-on-both projects default to server placement. Required dependencies follow their parent's placement, and unsupported destinations are refused. Export the client pack to distribute its files to players; SeedHost does not edit a player's launcher instance.

Client pack export contains only the client pack, not every server mod. Imported/local jars are not automatically classified or copied to the client pack; add the appropriate player-side files yourself.

## Verification and limits

Installation first resolves the required dependency graph, detects declared conflicts, downloads every needed file to staging outside the server, and verifies its size and SHA-512. Only then are files published without overwriting existing paths and the provenance index updated. Proven ordinary operation failures roll back published files. Before publication, SeedHost flushes an exclusive `seedhost-mod-install.json` intent journal and its directory; it removes the journal durably only after complete commit/cleanup or verified rollback. Forced process exits during publication or after index rename retain the journal. An interrupted or uncertain install blocks Start, ordinary snapshots, new handoffs/parking, mod changes and export; clean Stop/safe quit remain available and retain a final local snapshot. This is fail-closed fencing, not automatic crash recovery or proof of hardware power-loss behavior. Filesystems/platforms without supported directory flushing refuse installation rather than silently weakening durability; this path has not been verified on Windows.

### Repair an interrupted install

Stop all SeedHost/server processes for the affected managed copy and back up its files before repair. The journal lists intended jar names/destinations, but is not proof that every jar was installed. Inspect both destinations and provenance and either complete a verified set or restore the pre-install set from a retained snapshot/backup. Remove the journal only after the files and metadata have been reconciled; never delete it merely to enable Start. The catalogue's **Repair / check** action repairs ordinarily missing files, not an uncertain crash transaction.

Malformed or oversized `seedhost-mods.json` and invalid mod directories report a scoped Mods unavailable error without disabling core ownership/process controls. Status verification caches content hashes by file identity, size, nanosecond mtime and ctime; unchanged one-second polls do not reread jars, while installer validation always hashes freshly.

Downloads use HTTPS from `cdn.modrinth.com`, reject redirects and unsafe file names, and are bounded to 512 MiB per jar and 1 GiB per download batch. Dependency resolution is bounded to 100 projects and depth 32. Unknown, externally altered or imported jars do not have enough provenance to prove all mod compatibility/conflicts.

The managed `seedhost-mods.json` stores compatibility and provenance and travels with snapshots. SHA-512 proves that a file matches the provider's published bytes, not that its code is safe. Nothing runs automatically after installation.

The visible QA downloads Lithium from live Modrinth, checks native cancellation/approval and persistence, and transfers that disposable server through a real loopback relay. It does not launch Minecraft or establish modpack compatibility.
