# Relay: an always-on PC that stores the server between hosts

Direct handoff needs both PCs online at the same moment. A relay removes that requirement: the PC that last hosted
**parks** the server on the relay, and any trusted PC can later **claim** it, even while the first PC is switched off.

The relay is a small headless Node program (`seedhost-relay`). It never runs Minecraft, never unpacks the world, and
needs no Java. A mini PC, NAS, Raspberry Pi-class box or an always-on desktop all work; storage is roughly one copy of
the server plus changed files from the last ten parks.

## How it works

Parking and claiming are ordinary SeedHost handoffs, so every existing guarantee carries over: pinned mutual TLS,
SHA256-verified head-only transfers, and exactly one owner at a time.

| Step | Ownership |
| --- | --- |
| A parks | A is fenced, the relay owns the server (generation *n*) |
| B claims | The relay is fenced, B owns it (*n*+1). While B has it, nobody else can claim it |
| B parks | The relay owns it again (*n*+2) |
| A comes back and claims | A owns it (*n*+3), skipping the generations it missed while off |

What keeps this safe:

- **Lineage.** Each import gets a random lineage id, carried by every offer. A device that gave the server away
  accepts it back only from the *same lineage* with a *higher generation*, from any trusted device. A different server,
  however high its generation, is refused. A replayed old offer is refused.
- **Checked out means checked out.** While a PC holds the server, the relay refuses other claims and names the holder.
  To move the server, that PC parks it (or hands it off directly).
- **Lost acknowledgments.** If a claim's reply is lost, the claim stays pending for *that PC only*, and claiming again
  finishes it without a second copy or a second owner. If that PC parks again instead, the relay treats the new park as
  proof that the claim landed.
- **An unreachable relay changes nothing.** Before fencing, SeedHost checks that the relay answers. If it doesn't,
  the server simply stays on this PC.
- **A newer copy wins.** The relay declines a park that isn't newer than what it has seen, so a stale PC gets its
  ownership restored with an explanation instead of overwriting newer work.

The relay keeps the last ten parked revisions (`--keep`) and never prunes the one it holds.

## Setup — one click (recommended)

No Node.js, terminal or commands. Install Seed Hosting on the always-on PC too, then:

1. **On the always-on PC:** Setup guide → **Always-on PC** → **This PC stays on**. Approve the confirmation. Seed
   Hosting starts the relay and the shared player address inside the app and shows a pairing code such as
   `7KQ4-M2XD-9PRT`. It restarts automatically whenever the app opens; keep the PC on with the app in the tray.
2. **On each gaming PC:** Setup guide → **Always-on PC** → **I play on this PC**, type the code, **Connect**.

The gaming PC finds the always-on PC on the local network (UDP broadcast on port 47625), joins it, enables
park-on-stop and turns on the shared player address. Players join the always-on PC's address shown on its screen.

How the code stays safe: both PCs stretch the code with scrypt into a lookup id, a single-use invitation token and a
MAC key. The always-on PC answers a lookup only with a MAC over its certificate fingerprint, so the gaming PC pins a
certificate proven by the code — not whoever answered first. Codes expire after 30 minutes, work once, and a wrong code
connects to nothing. Seed Hosting still never changes routers or firewalls: if Windows asks to allow Seed Hosting on
private networks, allow it. For PCs on different networks, put both on Tailscale; the always-on PC also shows its
Tailscale address.

## Setup — manual (headless relay)

For a NAS or a box without a desktop:

On the always-on PC (needs Node 22.5+ with `node:sqlite`; development used Node 26):

```sh
git clone https://github.com/envosloth/seedhost && cd seedhost
npm ci --ignore-scripts && npm run build
node dist/src/relay/cli.js init --root ~/seedhost-relay
# prints FINGERPRINT=<64 hex>
```

On each host PC, copy **Your device fingerprint** from the Peers panel, then on the relay:

```sh
node dist/src/relay/cli.js trust --root ~/seedhost-relay --name "Desktop" --fingerprint <host fingerprint>
```

Start it. It binds `127.0.0.1` unless you choose an address, so reaching it from other PCs is an explicit decision:

```sh
node dist/src/relay/cli.js serve --root ~/seedhost-relay --host 0.0.0.0 --port 47625
```

SeedHost does not open firewall ports or change routers. Allow TCP 47625 yourself on the relay's firewall, or bind the
relay's Tailscale address and skip the LAN entirely. Run `serve` under systemd, a Windows service wrapper or similar
to keep it up; `SIGTERM` is a clean shutdown.

In SeedHost on each host PC: **Peers → Trust a peer** with the relay's fingerprint and `host:47625`, then
**Settings → Relay**, pick it, and optionally enable **Park on the relay after every clean stop**.

`node dist/src/relay/cli.js status --root ~/seedhost-relay` shows what the relay holds and whom it trusts.

## Day to day

- **Done playing:** Stop, then **Hand off to always-on PC** (or let park-on-stop do it).
- **Want to host:** **Take over hosting**. The world appears in a new folder; set the launch profile once per PC.
- **Check relay** shows whether the server is stored, pending, or checked out and by whom.

## Limits

- The relay's private key is stored in `identity.json` with owner-only permissions (0600), because headless boxes
  have no desktop keychain. Protect the relay's disk. Host PCs still keep their keys in the OS keychain.
- The desktop app's own peer listener is still loopback-only; the relay is the supported way to move a server between
  machines that aren't on at the same time.
- One relay stores one server lineage. Run a second relay root (with a different port) for another server.
- This is tested with real TLS on loopback, real processes and disposable fixture servers, **not** real Minecraft
  worlds, cross-household networks, or power loss on the relay.
