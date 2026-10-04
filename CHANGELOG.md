# Changelog

## Unreleased

### Changed
- **New look.** A clean, crisp theme with a new deep-ink standard dark mode (no glows, haze or blur), soft tonal surfaces (or skeuomorphic "Tactile" ones, with crisp bevels and a CRT-style console), a new logo and app icon, and an animated splash screen.
- **Separate pages.** My server, Console, Friends and Settings are now their own sidebar tabs instead of a right-hand inspector. Settings is split into Appearance, Network and App categories. A status marquee on My server shows the server, hosting, friends and backup state at a glance.
- **Frameless window, no title strip.** The sidebar runs to the top edge and the window buttons sit on the page itself: minimize, a fullscreen ⇄ borderless toggle (F11; Esc leaves fullscreen) and ✕. **Quit safely** now lives in the sidebar, because the native menu bar is gone with the frame.

### Added
- **Windows icon** (`apps/desktop/icon.ico`, 16–256 px), generated from the same mark, for shortcuts and packaging.
- **Appearance settings**, remembered on this PC: dark / light / system theme, five accent colours, Soft or Tactile surfaces, comfortable or compact density, reduced motion, and whether ✕ hides to the tray (default) or quits safely.

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
