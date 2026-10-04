# Add friends through a hosting relay

Invitations simplify enrollment into an existing PeerHost relay. They do not create an always-on relay, discover friends, open ports, tunnel Minecraft connections, or start a server.

## First member

Build the source on your always-on PC and initialize the relay (Node with `node:sqlite` required):

```sh
npm run build
node dist/src/relay/cli.js init --root /absolute/path/to/relay-data --name "Our server relay"
```

Start it using the reachable address you have already configured on that PC. A loopback listener/code can only be used on the same machine; the following LAN example does not change any firewall:

```sh
node dist/src/relay/cli.js serve --root /absolute/path/to/relay-data --host 0.0.0.0 --port 47625 --advertise YOUR_RELAY_LAN_OR_TAILSCALE_HOST
```

In another terminal on the relay PC:

```sh
node dist/src/relay/cli.js invite --root /absolute/path/to/relay-data --hours 24
```

Copy the `PEERHOST-…` line privately to the first member. In PeerHost they open **Friends → I have an invitation code**, enter their name, paste the code, and approve the native confirmation. The relay becomes trusted and park-on-stop is enabled. Nothing is downloaded or started; use **Take over hosting** once a server has been parked there.

## Invite another friend

A member chooses **Add friend → Create invitation**, approves the access warning, and copies the code. Each code permits one new certificate to enroll and expires after 24 hours by default. Send it privately, not in a public channel. **Refresh members** shows membership and relay custody; it is not an online-presence indicator. Before the first park the holder is unknown, parked means custody is on the relay, checkout pending means ownership acknowledgment is not yet confirmed, and a confirmed checkout names the holder. A locally owned unrelated world never substitutes a holder.

A relay group currently shares one server lineage. Membership authorizes access to its world/configuration files and the ability to claim hosting. There are no read-only roles. Enrollment cannot silently replace a different configured relay; clear that relay explicitly in Settings first.

## Owner controls

These commands operate on the relay PC and take effect without restarting its listener:

```sh
node dist/src/relay/cli.js member-invites --root /absolute/path/to/relay-data --enabled off
node dist/src/relay/cli.js untrust --root /absolute/path/to/relay-data --fingerprint EXACT_MEMBER_FINGERPRINT
```

Disabling member invitations revokes their outstanding codes. Removing a member blocks future requests and revokes codes that member issued. It cannot recall files already received or recover hosting authority held by that PC. Arrange a clean park before removing a current host; never edit ownership databases to force takeover.

## Trust and recovery

The code carries the relay address and certificate pin plus a random 128-bit single-use bearer token. Its checksum detects paste damage, not authenticity: trust the private channel through which you receive it. TLS proves possession of the pinned relay certificate before any token is sent.

The relay stores token digests, not plaintext bearer tokens. A join receipt allows the same certificate to retry after a lost acknowledgment; a different certificate cannot reuse the token. Unknown connections get only the narrow invite handshake and cannot read status, files or membership or claim ownership.

Mutation locks serialize relay/CLI writers. After a crash, an orphaned `.friends-mutation.lock` fails closed. Stop **all** relay processes and CLI writers before manually removing that lock; never delete identity or ownership files. Back up the relay's whole profile independently.

Verified scope: two isolated desktop profiles, a real loopback relay, TLS invite authorization/refusal, concurrent redemption and CLI updates. Real cross-household routing and hardware power-loss behavior remain untested.
