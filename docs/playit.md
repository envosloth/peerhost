# Public Minecraft address with playit.gg

Optional. Local hosting and the relay never need it.

A **relay player address** (see [game gateway](game-gateway.md)) lets friends reach your server over
Tailscale or your LAN. That is not a public address: a friend with no VPN, on another network, cannot
use it. To give everyone one ordinary Minecraft address — `something.tun.ply.gg` — Seed Hosting can
connect to a free [playit.gg](https://playit.gg) agent that already runs on your always-on PC.

The one-click option below downloads and runs playit's official agent for you. The advanced option uses an
agent you already run. Seed Hosting never changes your router, firewall or startup entries either way.

## Why the address points at the always-on PC

The public address always forwards to the relay's player gateway, not to whichever PC currently
hosts. That is what keeps one address stable: when hosting moves between PCs, players keep using the
same address, and the relay keeps forwarding to the current confirmed holder. The relay and the
playit agent must both be online, and a server must be running, for the address to answer.

If no always-on PC is configured, set one up first — **Setup guide → Always-on PC** — and make sure
the player gateway is enabled on it.

## One click (recommended)

On the always-on PC: **Setup guide → Always-on PC** (turn on **This PC stays on** first) → **Get a public address**.

1. Seed Hosting downloads playit.gg's official agent for this computer from the pinned GitHub release
   (v1.0.10) and refuses it unless its SHA-256 matches the published digest. Nothing is installed
   system-wide; it lives in Seed Hosting's profile folder and needs no admin rights.
2. playit.gg opens in your browser. Sign in (or make a free account) and press **Approve**. This is the
   only step Seed Hosting can't do for you. playit then hands the agent key straight to Seed Hosting,
   which keeps it OS-encrypted.
3. Seed Hosting runs the agent hidden in the background, creates one Minecraft tunnel to this PC's player
   port (reusing it if it already exists), and shows the address — something like `name.tun.ply.gg` —
   once playit has assigned it. **Live** means a real Minecraft status ping answered through that public
   address; **ready** means the address exists and will answer whenever someone is hosting.

The agent restarts with the app (and after a crash, up to five times in ten minutes). **Turn off** stops the
agent; turning it back on reuses the approved agent and the same address, with no browser step. The plain
agent key is on disk only for the first seconds of each agent start, in an owner-only file, then deleted.

## Advanced: use your own playit agent

If you already run playit yourself (for example as a system service), keep using it:

Do this on the machine that runs the relay, not on the PC that hosts Minecraft.

1. Download and install the playit agent from <https://playit.gg/download> and approve it in the
   browser when it asks. The agent keeps running in the background afterwards.
2. Find its agent secret file. It is a text file containing one long hexadecimal string; on Linux
   the agent prints the path with `playit-cli secret-path`, and it is usually
   `~/.local/share/playit/secret.txt`.
3. In Seed Hosting open **My server → Public address · playit.gg → Connect existing agent…** and pick
   that file through the native picker. Approve the confirmation.

Seed Hosting stores only an OS-encrypted copy (`safeStorage`: Windows DPAPI, macOS Keychain, Linux
Secret Service) inside its own profile folder, in `playit.json`. It refuses to store the credential
if OS-protected storage is unavailable. The credential is never written to a snapshot, a handoff, a
relay transfer, the console log, or any screen.

## Create and check the address

1. **Create public address.** Seed Hosting reuses a compatible tunnel if one already exists and only
   creates one when there is none, so pressing it twice does not litter your account with tunnels.
   If the always-on player gateway is missing, or its player port equals its control port, creation
   is refused instead of guessing a target.
2. The playit account may need a moment to allocate the address. **Waiting for playit** means the
   tunnel exists but has no address yet.
3. **Check address** verifies all of this before calling the address reachable: the tunnel belongs to
   *this* agent, it is enabled, it is not disabled by playit, its target IP and port are exactly the
   configured always-on player gateway, and a real Minecraft Server List Ping answered through the
   public address. The ping follows the same `_minecraft._tcp` SRV record a Minecraft client uses, so
   a pass means the address a friend types — without a port — is the address that answered. A reserved
   address is reported as **reserved** until that ping succeeds.
4. **Copy address** copies the address the check just confirmed. The address is only shown after a
   check, and it is cleared when a later check fails, so a stale address is never presented as live.

## What "reachable" does and does not mean

- **Reachable** means a Minecraft 26.2 Server List Ping from this PC to the public address returned a
  real status response. It is protocol-level proof, not proof that a specific friend's network,
  client version or account can join, and not proof that the relay will stay up.
- The address stays reserved while the tunnel exists. Stopping the agent, the relay, or the server
  makes it stop answering without losing the address.
- Anyone who knows the address can attempt to join. Keep Minecraft's `online-mode` on, and add a
  whitelist for private play. A public address is not access control.
- Free playit tunnels are rate-limited and have no uptime guarantee. Seed Hosting cannot promise
  always-on availability.

## Disconnecting

**Disconnect from app** removes only Seed Hosting's encrypted copy of the credential. The tunnel and
the external agent keep running, and the address stays public. To stop public access, disable or
delete the tunnel in your playit account (or stop the agent). Seed Hosting never operates your
playit account on your behalf beyond creating the one Minecraft Java tunnel described above.

## Troubleshooting

| What you see | What it means |
|---|---|
| *No Minecraft tunnel points to this always-on player gateway* | The agent has no tunnel for this target. Use **Create public address**. |
| *The playit tunnel is offline* | playit or the agent reports it disabled or offline. Check the agent on the always-on PC. |
| *Address reserved, but Minecraft did not answer* | The tunnel and gateway agree, but the public ping failed: the server may be stopped, the relay down, or the tunnel still warming up. |
| *Could not verify playit* | A network or approval problem. Local hosting is unaffected; nothing else changes. |
| *Configure the always-on player gateway first* | The relay endpoint is missing, or the player port is the relay's control port. Fix **Setup guide → Always-on PC**. |

This feature is new in the alpha and is verified only against one playit agent and one always-on PC
on Tailscale. It has not been tested across regions, with a paid allocation, or with a dedicated IP.
