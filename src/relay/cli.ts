#!/usr/bin/env node
// Headless SeedHost relay: an always-on custodian that stores the latest server revision between hosts.
import { parseArgs } from 'node:util';
import { RelayNode, loadOrCreateRelayIdentity, DEFAULT_RELAY_PORT } from '../core/relay.js';
import { isValidEndpointHost } from '../core/endpoints.js';
import { PublicAddress, playitClaim } from '../core/public-address.js';
import { playitApi, probeMinecraft } from '../core/playit-network.js';
import { readFile } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

const USAGE = `Usage:
  seedhost-relay init   --root <dir>
  seedhost-relay trust  --root <dir> --name <name> --fingerprint <64 hex>
  seedhost-relay untrust --root <dir> --fingerprint <64 hex>
  seedhost-relay owner --root <dir> --fingerprint <existing member's 64 hex>
  seedhost-relay invite --root <dir> [--hours 24] [--advertise <reachable host>] [--advertise-port <port>]
  seedhost-relay member-invites --root <dir> --enabled <on|off>
  seedhost-relay serve  --root <dir> [--name <relay name>] [--host 127.0.0.1] [--port ${DEFAULT_RELAY_PORT}] [--advertise <reachable host>] [--keep 10] [--game-port <port>] [--game-host 127.0.0.1]
  seedhost-relay status --root <dir>

serve --playit-secret <file> adopts an already-approved playit agent key for the members' one-click public
address; add --playit-external yes when that agent already runs as its own service.

serve binds 127.0.0.1 unless --host is given. To reach it from other PCs, pass your LAN or
Tailscale address (for example --host 0.0.0.0) and allow the port in your firewall yourself.
Wildcard binds require --advertise for member invites. Loopback invites work only on this machine.
The player gateway is OFF unless --game-port is given; its separate --game-host defaults to loopback.
Only an enrolled, confirmed checked-out host's outbound pinned tunnel receives player bytes.
Trust/invite changes take effect on a running relay; untrust disconnects that host's players.`;

function fail(message: string): never {
  console.error(message + '\n\n' + USAGE);
  process.exit(2);
}

const [command, ...rest] = process.argv.slice(2);
let values: Record<string, string | undefined>;
try {
  values = parseArgs({ args: rest, options: {
    root: { type: 'string' }, name: { type: 'string' }, fingerprint: { type: 'string' },
    host: { type: 'string' }, port: { type: 'string' }, keep: { type: 'string' },
    'game-host': { type: 'string' }, 'game-port': { type: 'string' },
    hours: { type: 'string' }, advertise: { type: 'string' }, 'advertise-port': { type: 'string' }, enabled: { type: 'string' },
    'playit-secret': { type: 'string' }, 'playit-external': { type: 'string' },
  } }).values as Record<string, string | undefined>;
} catch (error) { fail((error as Error).message); }
if (!values.root) fail('--root is required');
const root = values.root;

const identity = await loadOrCreateRelayIdentity(root);
const keep = values.keep === undefined ? undefined : Number(values.keep);
if (keep !== undefined && (!Number.isInteger(keep) || keep < 1)) fail('--keep must be a positive whole number');
const relay = new RelayNode(root, identity, { keepRevisions: keep });
await relay.open();
if (values.name && (command === 'init' || command === 'serve')) await relay.setName(values.name);

function advertised(defaultPort: number): { host: string; port: number } | undefined {
  const host = values.advertise ?? (command === 'invite' ? values.host : undefined);
  if (!host) {
    if (values['advertise-port']) fail('--advertise-port requires --advertise');
    return undefined;
  }
  const port = Number(values['advertise-port'] ?? (command === 'invite' ? values.port : undefined) ?? defaultPort);
  if (!isValidEndpointHost(host) || host === '0.0.0.0') fail('--advertise must be a reachable host, not a wildcard address');
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('--advertise-port must be 1–65535');
  if (host === 'localhost' || /^127\./.test(host)) console.error('WARNING: this invite address is loopback; friends on other machines cannot reach it.');
  return { host, port };
}

switch (command) {
  case 'init':
    console.log(`FINGERPRINT=${identity.fingerprint}`);
    console.log('Start the relay with serve, then create a friend code with invite. Manual trust is also supported.');
    break;
  case 'trust':
    if (!values.name || !values.fingerprint || !/^[a-f0-9]{64}$/.test(values.fingerprint)) fail('trust needs --name and a 64-character lowercase --fingerprint');
    await relay.trust(values.name, values.fingerprint);
    console.log(`TRUSTED=${values.name.trim()} ${values.fingerprint}`);
    break;
  case 'owner':
    if (!values.fingerprint) fail('owner needs --fingerprint');
    await relay.setOwner(values.fingerprint);
    console.log('OWNER='+values.fingerprint);
    break;
  case 'untrust':
    if (!values.fingerprint) fail('untrust needs --fingerprint');
    await relay.untrust(values.fingerprint);
    console.log(`REMOVED=${values.fingerprint}`);
    break;
  case 'member-invites':
    if (values.enabled !== 'on' && values.enabled !== 'off') fail('--enabled must be on or off');
    await relay.setMemberInvites(values.enabled === 'on');
    console.log(`MEMBER_INVITES=${values.enabled}`);
    break;
  case 'invite': {
    const invite = await relay.createInvite({ hours: values.hours === undefined ? 24 : Number(values.hours), advertise: advertised(DEFAULT_RELAY_PORT) });
    console.log(invite.code);
    console.log(`EXPIRES=${new Date(invite.expiresAt).toISOString()}`);
    break;
  }
  case 'status': {
    console.log(`FINGERPRINT=${identity.fingerprint}`);
    const custody = await relay.custody();
    console.log(custody ? `CUSTODY=${custody.state} generation=${custody.generation} snapshot=${custody.snapshotId} owner=${custody.owner}` : 'CUSTODY=none');
    for (const host of relay.trusted) console.log(`TRUSTED=${host.name} ${host.fingerprint}`);
    break;
  }
  case 'serve': {
    const host = values.host ?? '127.0.0.1';
    const port = values.port === undefined ? DEFAULT_RELAY_PORT : Number(values.port);
    if (host !== '0.0.0.0' && !isValidEndpointHost(host)) fail('--host must be an IPv4 address or hostname');
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail('--port must be 0–65535');
    if (values['game-host'] !== undefined && values['game-port'] === undefined) fail('--game-host requires --game-port');
    const gameHost = values['game-host'] ?? '127.0.0.1';
    const gamePort = values['game-port'] === undefined ? undefined : Number(values['game-port']);
    if (gameHost !== '0.0.0.0' && !isValidEndpointHost(gameHost)) fail('--game-host must be an IPv4 address or hostname');
    if (gamePort !== undefined && (!Number.isInteger(gamePort) || gamePort < 0 || gamePort > 65535)) fail('--game-port must be 0–65535');
    if (!relay.trusted.length) console.log('No friends yet. Create an invite in another terminal to let a friend join.');
    const advertise = advertised(port);
    if (host === '0.0.0.0' && !advertise) console.error('WARNING: pass --advertise with a reachable LAN/Tailscale host to enable member invite codes.');
    await relay.listen({ host, port, advertise });
    try { if (gamePort !== undefined) await relay.listenGame({ host: gameHost, port: gamePort }); }
    catch (error) { await relay.close(); throw error; }
    if (relay.gameEndpoint) {
      // Members can turn the public address on from their own Seed Hosting with one click.
      // Headless box: the agent key is sealed with a key derived from this relay's private identity (no desktop keychain).
      const seal = createHash('sha256').update('seedhost-public-address').update(identity.keyPem).digest();
      const vault = {
        encrypt: (text: string) => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', seal, iv); const data = Buffer.concat([c.update(text, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]); },
        decrypt: (data: Buffer) => { const d = createDecipheriv('aes-256-gcm', seal, data.subarray(0, 12)); d.setAuthTag(data.subarray(12, 28)); return d.update(data.subarray(28), undefined, 'utf8') + d.final('utf8'); },
      };
      const gameTarget = relay.gameEndpoint;
      const secretFile = values['playit-secret'];
      relay.publicAddress = new PublicAddress(root, { vault, api: playitApi, claim: playitClaim, probe: probeMinecraft, externalAgent: values['playit-external'] === 'yes',
        target: () => ({ host: gameTarget.host === '0.0.0.0' ? '127.0.0.1' : gameTarget.host, port: gameTarget.port }),
        adoptKey: secretFile ? async () => (await readFile(path.resolve(secretFile), 'utf8')).trim() : undefined });
      await relay.publicAddress.restore();
      console.log('PUBLIC_ADDRESS=available to members');
    }
    const stop = () => { void relay.close().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); }); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    // Advertise readiness only after initialization and graceful-shutdown handlers are installed.
    console.log(`FINGERPRINT=${identity.fingerprint}`);
    console.log(`LISTENING=${relay.endpoint!.host}:${relay.endpoint!.port}`);
    if (relay.gameEndpoint) console.log(`GAME_LISTENING=${relay.gameEndpoint.host}:${relay.gameEndpoint.port}`);
    break;
  }
  default:
    fail(command ? `Unknown command: ${command}` : 'A command is required');
}
