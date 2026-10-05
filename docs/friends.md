# Add friends through a hosting relay

Invitations simplify enrollment into an existing SeedHost relay. They do not create an always-on relay, discover friends, open ports, tunnel Minecraft connections, or start a server.

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

Copy the complete `SEEDHOST-…` line privately to the first member. In Seed Hosting they open **Friends → I have an invitation**, paste the code, enter their own display name, and choose **Check invitation**. Review the group, always-on PC address and expiry; expand **Verify details with your friend** to compare the full certificate fingerprint through a trusted channel. These are details from the code, not proof of authenticity or a successful connection. Codes from a pre-rename build are not accepted; ask for a fresh invitation.

**Review & join group** requests native confirmation displaying independently decoded details before any enrollment. The relay becomes trusted and park-on-stop is enabled only after joining and saving its settings. Nothing is downloaded or started; use **Take over hosting** once a server has been parked there. Stop any running local server before joining. A different configured relay is never silently replaced.

## Invite another friend

A member chooses **Friends → Invite a friend → Create invitation**, approves the access warning, then uses **Copy invitation**. The sharing steps stay beside the code. Each code permits one new certificate to enroll and expires after 24 hours by default. Send it privately, not in a public channel. Creating a new code does not revoke earlier invitations.

**Refresh members** shows membership and relay custody; it is not an online-presence indicator. A successful refresh shows **Members confirmed** and its check time. A failed refresh clears stale member entries and offers retry guidance. Before the first park the holder is unknown, parked means custody is on the relay, checkout pending means ownership acknowledgment is not yet confirmed, and a confirmed checkout names the holder. A locally owned unrelated world never substitutes a holder.

### Players do not need a hosting invitation

Friends who only want to play use a Minecraft address, not this code. **Show how to join Minecraft** opens the player instructions under **My server**. When you do not host a server on this PC, ask the current host for their address. This action does not create a server, join a hosting group, or configure any network service.

### Invitation recovery

- **Damaged/incomplete:** copy the entire code again. Do not change its case or try to repair its contents.
- **Expired or already used by another PC:** ask the sender for a new code.
- **No response:** check that the always-on PC is running and reachable on the same network/VPN. Retry the same code on the same PC: it may already have been enrolled before an acknowledgment was lost.
- **Cancelled native confirmation:** no join is attempted; the pasted entries are kept.
- **Different group already configured:** deliberately clear the existing relay under **Settings → Network** before joining another. No automatic switch occurs.

Editing the code or display name requires another check. Closing the setup guide clears the invitation and preview; secrets are not saved in setup progress.

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
