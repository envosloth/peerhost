# Beginner setup and saved worlds

Open **Setup guide** in the sidebar at any time. Fresh profiles open it automatically with a plain three-way choice — **Create a new world**, **Use a server I already have**, or **Join a friend’s world** — before any form appears. **Set up later**, the ✕ button, or Escape keep non-secret draft inputs and the current stage. Friends and Always-on PC stages are marked optional and have **Skip**. The stage bar ticks off stages that are actually configured (from backend state, not visits). Closing the guide never starts a server.

If no world is configured, **My server** shows the prominent lowercase **create a server** button, an import link and a four-step getting-started checklist; Mods, launch settings and Console stay hidden until a server exists. With a server, a **How to join** panel lists `localhost`, this PC’s private LAN addresses with the port from `server.properties`, and any saved always-on PC address. Paths, IDs and ownership details are folded under **Technical details**; direct fingerprint pairing is folded under **Advanced** in the Friends panel.

## Create or import

**Create** supports Vanilla and Fabric. The latest release and the newest detected Java are pre-selected; older releases sit behind **Show older versions**, and memory is a GB menu (2 GB recommended). Choose a release, Java and memory, explicitly read/accept the [Minecraft EULA](https://www.minecraft.net/en-us/eula), and approve native confirmation. SeedHost checks official metadata and downloads before adopting a separate managed copy with its own ownership ledger and first snapshot. Fabric currently uses the inspected Loader 0.19.5 layout; unsupported layouts fail closed rather than silently executing unchecked bootstrap code. Java is not bundled or installed automatically. Checksums verify download integrity, not that executable code is harmless.

**Import** supports existing stopped server folders, including Forge/NeoForge/modpacks. Use the native folder picker and confirm the original server is stopped. The original stays untouched; setup never replaces an already configured world or changes its lineage. Separate servers need separate profiles.

The **Java & memory** stage can discover Java or open a native executable picker. Selecting a file asks permission to run its bounded `-version` probe without a shell. Simple setup updates Java and RAM while preserving existing command/argument files. Empty profiles infer only unambiguous server JAR layouts; scripts, multiple candidate JARs and unknown modpack commands need **Advanced launch settings**. Preserve `@` argument files and the pack's documented Java requirements. Creation checks the selected release's minimum Java version; RAM must leave room for the OS and players' clients.

Choose **Start server** only after reviewing/trusting the saved executable, server JARs and mods. **Stop server** waits for the server's clean save and captures a local backup. Public access, firewall/router changes and startup services are not automatic.

## Optional friends and always-on PC

Friends use expiring, single-use relay invitations. Codes are bearer secrets: send privately, do not post them publicly. They are never saved in onboarding progress. Joining pins/enrolls the relay; it neither starts a server nor grants the joining PC simultaneous ownership. See [friends](friends.md).

The third PC supplies two separate capabilities:

1. **World storage:** **Hand off to always-on PC** (park) stores the stopped world; another host can **Take over hosting** (claim) later even if the previous host is off.
2. **Player forwarding:** an explicitly enabled TCP player listener accepts host-initiated pinned TLS tunnels. Only the enrolled, confirmed running holder forwards to its local Minecraft port.

The wizard labels third-PC commands separately from hosting-PC actions, and shows actual relay/route checks. Initial custody requires Park then Claim once. Enable gateway tunnels on each hosting PC; configure the correct local Minecraft port. A displayed stable address in Settings is only a display preference—it does not enable routing. A relay wildcard bind address is not a usable player address. Use the relay's reachable hostname/IP and player port, and test from the players' network. Tunnel readiness does not prove Minecraft player login or Internet reachability. Players reconnect when hosts change; no live-session migration is promised. Gateway forwarding masks player source IPs from Minecraft and affects IP-based bans/rate limits. See [gateway operation and security](game-gateway.md).

Everything remains opt-in; direct local hosting requires neither friends nor a third PC. SeedHost does not modify routers, firewalls or startup services. The relay and player listener default to loopback unless explicitly bound otherwise.

## Backups

My server → **Backups** lists the current revision and retained ancestors with size and file count. These are local snapshots, not independent backups or proof of remote storage.

To restore, stop hosting and hold local, reconciled ownership with no pending transfer or interrupted mod-install fence. Choose a retained revision and approve the native confirmation. SeedHost records a safety revision, restores into a new managed folder, and commits a new current revision without rewinding ownership generation/lineage. The previous execution folder remains intact; nothing launches automatically.

**Free up space** explicitly deletes old managed copies and keeps only the current revision plus two parents. Keep independent backups before cleanup; setup/history do not change that retention policy.

## Progress and errors

Progress lives in a separate bounded `onboarding.json`, not authoritative server state. It retains stage, dismissal/completion, skipped optional stages and name/loader/version/RAM drafts—not invitation codes or secrets. Completion requires an actual server and saved launch command. Existing configured profiles are not forced through fresh onboarding.

Unreadable optional metadata produces a scoped warning and is not silently overwritten. Server state, console, Stop and safe quit remain independent of broken setup/catalog metadata. Recover conflicting ownership only through its explicit controls, never by deleting databases or copying profile files. Gateway settings/status likewise remain separate from core ownership; a failed optional relay route is not permission to run another host.

## Verification boundaries

Automated tests, real Electron checks and disposable real-server smoke results are recorded separately in the verification documents. Socket/process fixtures are not Minecraft proof; protocol status responses are not gameplay login tests. Published in v0.2.1-alpha; see that release for its verification summary.
