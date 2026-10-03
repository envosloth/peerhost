#!/usr/bin/env node
// Headless PeerHost relay: an always-on custodian that stores the latest server revision between hosts.
import { parseArgs } from 'node:util';
import { RelayNode, loadOrCreateRelayIdentity, DEFAULT_RELAY_PORT } from '../core/relay.js';
import { isValidEndpointHost } from '../core/endpoints.js';

const USAGE = `Usage:
  peerhost-relay init   --root <dir>
  peerhost-relay trust  --root <dir> --name <name> --fingerprint <64 hex>
  peerhost-relay serve  --root <dir> [--host 127.0.0.1] [--port ${DEFAULT_RELAY_PORT}] [--keep 10]
  peerhost-relay status --root <dir>

serve binds 127.0.0.1 unless --host is given. To reach it from other PCs, pass your LAN or
Tailscale address (for example --host 0.0.0.0) and allow the port in your firewall yourself.`;

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
  } }).values as Record<string, string | undefined>;
} catch (error) { fail((error as Error).message); }
if (!values.root) fail('--root is required');
const root = values.root;

const identity = await loadOrCreateRelayIdentity(root);
const keep = values.keep === undefined ? undefined : Number(values.keep);
if (keep !== undefined && (!Number.isInteger(keep) || keep < 1)) fail('--keep must be a positive whole number');
const relay = new RelayNode(root, identity, { keepRevisions: keep });
await relay.open();

switch (command) {
  case 'init':
    console.log(`FINGERPRINT=${identity.fingerprint}`);
    console.log('Add this fingerprint as a trusted peer on each host PC, then trust each host here with `trust`.');
    break;
  case 'trust':
    if (!values.name || !values.fingerprint || !/^[a-f0-9]{64}$/.test(values.fingerprint)) fail('trust needs --name and a 64-character lowercase --fingerprint');
    await relay.trust(values.name, values.fingerprint);
    console.log(`TRUSTED=${values.name.trim()} ${values.fingerprint}`);
    break;
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
    if (!relay.trusted.length) console.log('WARNING: no trusted hosts yet; every connection will be refused.');
    await relay.listen({ host, port });
    console.log(`FINGERPRINT=${identity.fingerprint}`);
    console.log(`LISTENING=${relay.endpoint!.host}:${relay.endpoint!.port}`);
    const stop = () => { void relay.close().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); }); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    break;
  }
  default:
    fail(command ? `Unknown command: ${command}` : 'A command is required');
}
