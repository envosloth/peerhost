# Changelog

## 0.2.1-alpha

**Still an alpha. Keep your own world backups.**

### Added
- **Setup guide for new users.** First launch asks one plain question: create a new world, use a server you already have, or join a friend’s world. Progress saves automatically; reopen it any time from the sidebar. Friends and always-on PC steps are optional and skippable.
- **Create a server in-app.** Vanilla or Fabric, downloaded from official sources and checked before use. The latest Minecraft version and newest installed Java are picked for you; memory is a simple GB menu. Explicit Minecraft EULA consent; nothing starts until you press Start.
- **How to join** panel: shows `localhost`, this PC’s home-network address and port (from `server.properties`), and any always-on PC address.
- **Getting-started checklist** on an empty My server page, plus the big **create a server** button.
- **Backups** list with restore. Restoring keeps your current world and backs it up first; ownership is never rewound.
- **Mod browser** (Modrinth search, compatible versions, required dependencies) with repair/check for interrupted installs.
- **Friends groups** with single-use invitation codes on your always-on PC.
- **Player address through the always-on PC** (opt-in TCP gateway): players use one address; only the confirmed current host receives traffic.
- Simple Java & memory settings that preserve modpack argument files.

### Changed
- Plain-language UI: My server, Start/Stop server, Save backup, Free up space, Hand off to always-on PC, Take over hosting. File paths, IDs and fingerprints are folded under Technical details or Advanced.
- Mods, launch settings and console stay hidden until a server exists.

### Validation notes
- 383 automated tests pass (0 failed, 0 skipped); all 8 visible Electron desktop checks pass, including official Vanilla 1.21.1 creation through the new wizard.
- Earlier in this cycle, real Vanilla and Fabric 1.21.1 servers started, answered Minecraft status requests, saved, and moved between two profiles on one PC through the always-on PC path.
- **Not tested:** real player login/gameplay, two physical PCs over the internet, arbitrary modpacks, power loss. The Windows build is unsigned.
