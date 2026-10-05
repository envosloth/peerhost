import { createHmac, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { mkdir, readFile, rename, rm, open } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RelayNode, DEFAULT_RELAY_PORT } from './relay.js';
import { encodeInvite } from './invites.js';
import { privateLanAddresses, tailnetAddresses } from './network-info.js';
import type { PeerIdentity } from './peer-transport.js';

/*
 * One-click always-on PC.
 *
 * The always-on PC runs the relay inside Seed Hosting itself (no Node.js, terminal or commands) and shows a short
 * pairing code such as 7KQ4-M2XD-9PRT. A gaming PC types that code; it finds the always-on PC on the local network
 * with a UDP broadcast and joins it through the ordinary invitation path.
 *
 * Trust: both sides stretch the code with scrypt into a lookup id, a 16-byte invitation token and a MAC key. Only a
 * PC that knows the code can answer the lookup with a valid MAC over its certificate fingerprint, so the TLS pin comes
 * from the code itself rather than from whoever answered first. Codes expire after 30 minutes and are single-use
 * (the relay's invitation is single-use); a wrong code reveals nothing usable.
 */

export const DISCOVERY_PORT = 47625; // UDP; the relay's TLS listener uses the same number on TCP.
const DEFAULT_GAME_PORT = 25565;
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U.
const CODE_MINUTES = 30;
const SALT = 'seedhost-pairing-v1';

export interface PairingSecrets { id: string; token: Buffer; macKey: Buffer }
export interface FoundAlwaysOn { host: string; port: number; gamePort: number | null; fingerprint: string; name: string }

/** 60-bit code, shown as three groups of four. */
export function newPairingCode(): string {
  const chars = Array.from({ length: 12 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8).join('')}`;
}

/** Forgiving input: any case, spaces or dashes, and the usual look-alikes (O→0, I/L→1). */
export function normalizePairingCode(input: unknown): string {
  if (typeof input !== 'string' || input.length > 64) throw new Error('Enter the 12-character code shown on the always-on PC');
  const raw = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (raw.length !== 12 || [...raw].some((c) => !CODE_ALPHABET.includes(c))) throw new Error('Enter the 12-character code shown on the always-on PC');
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

export async function pairingSecrets(code: string): Promise<PairingSecrets> {
  const normalized = normalizePairingCode(code);
  const bytes = await new Promise<Buffer>((resolve, reject) => scryptCallback(normalized, SALT, 64, { N: 1 << 14, r: 8, p: 1 }, (error, key) => error ? reject(error) : resolve(key)));
  return { id: bytes.subarray(0, 16).toString('hex'), token: Buffer.from(bytes.subarray(16, 32)), macKey: Buffer.from(bytes.subarray(32)) };
}

function replyMac(macKey: Buffer, reply: { id: string; port: number; gamePort: number | null; fingerprint: string; name: string }): string {
  return createHmac('sha256', macKey).update(JSON.stringify([reply.id, reply.port, reply.gamePort, reply.fingerprint, reply.name])).digest('hex');
}

/** Directed broadcast addresses of this PC's IPv4 networks, plus the limited broadcast. */
function broadcastTargets(): string[] {
  const targets = new Set<string>(['255.255.255.255']);
  for (const entries of Object.values(networkInterfaces())) for (const entry of entries ?? []) {
    if (entry.internal || entry.family !== 'IPv4' || !entry.netmask) continue;
    const ip = entry.address.split('.').map(Number), mask = entry.netmask.split('.').map(Number);
    targets.add(ip.map((octet, i) => (octet | (~mask[i]! & 255)) & 255).join('.'));
  }
  return [...targets].slice(0, 16);
}

/** Gaming PC side: broadcast the code's lookup id and accept only an answer carrying a valid MAC. */
export async function findAlwaysOnPC(code: string, options: { targets?: string[]; port?: number; timeoutMs?: number } = {}): Promise<FoundAlwaysOn> {
  const secrets = await pairingSecrets(code);
  const port = options.port ?? DISCOVERY_PORT;
  const targets = options.targets ?? broadcastTargets();
  const socket = createSocket('udp4');
  try {
    return await new Promise<FoundAlwaysOn>((resolve, reject) => {
      let resend: NodeJS.Timeout | undefined;
      const deadline = setTimeout(() => { clearInterval(resend); reject(new Error('No always-on PC answered. Check the code, that Seed Hosting is open on the always-on PC, and that both PCs are on the same network.')); }, options.timeoutMs ?? 6000);
      socket.on('error', (error) => { clearTimeout(deadline); clearInterval(resend); reject(error); });
      socket.on('message', (message, from) => {
        let reply: Record<string, unknown>;
        try { reply = JSON.parse(message.toString('utf8')); } catch { return; }
        if (!reply || reply.type !== 'seedhost-here' || reply.v !== 1 || reply.id !== secrets.id) return;
        const { fingerprint, name } = reply;
        const relayPort = reply.port, gamePort = reply.gamePort;
        if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint) || typeof name !== 'string' || !name.trim() || name.length > 100 ||
            !Number.isInteger(relayPort) || (relayPort as number) < 1 || (relayPort as number) > 65535 ||
            !(gamePort === null || (Number.isInteger(gamePort) && (gamePort as number) >= 1 && (gamePort as number) <= 65535)) || typeof reply.mac !== 'string') return;
        const expected = Buffer.from(replyMac(secrets.macKey, { id: secrets.id, port: relayPort as number, gamePort: gamePort as number | null, fingerprint, name }), 'hex');
        const actual = Buffer.from(reply.mac, 'hex');
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return; // Someone who does not know the code.
        clearTimeout(deadline); clearInterval(resend);
        resolve({ host: from.address, port: relayPort as number, gamePort: gamePort as number | null, fingerprint, name });
      });
      socket.bind(0, () => {
        socket.setBroadcast(true);
        const ask = Buffer.from(JSON.stringify({ type: 'seedhost-find', v: 1, id: secrets.id }));
        const send = () => { for (const target of targets) socket.send(ask, port, target, () => undefined); };
        send(); resend = setInterval(send, 700);
      });
    });
  } finally { socket.close(); }
}

/** The invitation a pairing code stands for: the same single-use token, pinned to the MAC-verified fingerprint. */
export async function pairingInvite(code: string, found: FoundAlwaysOn): Promise<string> {
  const secrets = await pairingSecrets(code);
  return encodeInvite({ relayFingerprint: found.fingerprint, host: found.host, port: found.port, token: secrets.token,
    expiresAt: Math.floor(Date.now() / 1000) + CODE_MINUTES * 60, relayName: found.name });
}

export interface AlwaysOnStatus {
  enabled: boolean; running: boolean; name: string; error: string | null;
  addresses: string[]; port: number | null; gamePort: number | null;
  code: string | null; codeExpiresAt: number | null;
  members: Array<{ name: string; fingerprint: string }>;
  custody: string;
}

/** Always-on PC side: the relay, its player address and the pairing responder, all inside the desktop app. */
export class AlwaysOnHost {
  private relay?: RelayNode;
  private udp?: UdpSocket;
  private session?: { code: string; expiresAt: number; secrets: PairingSecrets };
  private error: string | null = null;
  private enabled = false;
  constructor(readonly root: string, private readonly identity: PeerIdentity, private readonly options: { port?: number; gamePorts?: number[]; discoveryPort?: number; host?: string } = {}) {}

  private get settingsFile(): string { return path.join(this.root, 'always-on.json'); }

  /** Restore the saved choice at app start; failures are reported in status, never thrown at startup. */
  async restore(): Promise<void> {
    try { this.enabled = JSON.parse(await readFile(this.settingsFile, 'utf8'))?.enabled === true; } catch { this.enabled = false; }
    if (this.enabled) await this.start().catch((error) => { this.error = (error as Error).message; });
  }

  private async save(enabled: boolean): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const temporary = `${this.settingsFile}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ version: 1, enabled })); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, this.settingsFile); } finally { await rm(temporary, { force: true }); }
    this.enabled = enabled;
  }

  async enable(name?: string): Promise<AlwaysOnStatus> {
    await this.start(name);
    await this.save(true);
    return this.status();
  }

  /** Called only by this PC's main process, never by a network request. */
  async ownerInvite(name: string, fingerprint: string) {
    if (!this.relay) throw new Error('Turn on the always-on PC first');
    await this.relay.reload();
    if (this.relay.owner && this.relay.owner !== fingerprint) throw new Error('This group already has an owner');
    await this.relay.trust(name, fingerprint);
    if (!this.relay.owner) await this.relay.setOwner(fingerprint);
    const endpoint = this.relay.endpoint!;
    return this.relay.createInvite({ minutes: 5, recipient: fingerprint, advertise: { host: endpoint.host === '0.0.0.0' ? this.advertiseHost() ?? '127.0.0.1' : endpoint.host, port: endpoint.port } });
  }

  async disable(): Promise<AlwaysOnStatus> {
    await this.save(false);
    await this.close();
    return this.status();
  }

  private advertiseHost(): string | undefined {
    if (this.options.host && this.options.host !== '0.0.0.0') return this.options.host;
    return privateLanAddresses()[0] ?? tailnetAddresses()[0];
  }

  private async start(name?: string): Promise<void> {
    if (this.relay) { if (name) await this.relay.setName(name); return; }
    this.error = null;
    const relay = new RelayNode(this.root, this.identity, { log: () => undefined });
    await relay.open();
    if (name) await relay.setName(name);
    const host = this.options.host ?? '0.0.0.0';
    try {
      // First free port from the usual one upward; paired PCs learn the actual port from the code lookup.
      let listenError: unknown;
      for (const port of this.options.port !== undefined ? [this.options.port] : [DEFAULT_RELAY_PORT, 47626, 47627, 47628, 47629]) {
        try { await relay.listen({ host, port }); listenError = undefined; break; }
        catch (error) { listenError = error; }
      }
      if (listenError) throw new Error(`Couldn’t open Seed Hosting’s port: ${(listenError as Error).message}`);
      // The player address: first free port from the usual Minecraft one upward.
      let lastError: unknown;
      for (const gamePort of this.options.gamePorts ?? [DEFAULT_GAME_PORT, 25566, 25567, 25568]) {
        try { await relay.listenGame({ host, port: gamePort }); lastError = undefined; break; }
        catch (error) { lastError = error; }
      }
      if (lastError) throw new Error(`Couldn’t open a player port: ${(lastError as Error).message}`);
      await this.listenDiscovery(host);
    } catch (error) {
      await relay.close().catch(() => undefined);
      await this.closeDiscovery();
      throw error;
    }
    this.relay = relay;
  }

  private async listenDiscovery(host: string): Promise<void> {
    const udp = createSocket({ type: 'udp4', reuseAddr: true });
    let answered = 0, windowStart = Date.now();
    udp.on('message', (message, from) => {
      const session = this.session, relay = this.relay;
      if (!session || !relay?.endpoint || session.expiresAt <= Date.now() || message.length > 512) return;
      let ask: Record<string, unknown>;
      try { ask = JSON.parse(message.toString('utf8')); } catch { return; }
      if (ask?.type !== 'seedhost-find' || ask.v !== 1 || ask.id !== session.secrets.id) return;
      if (Date.now() - windowStart > 10000) { windowStart = Date.now(); answered = 0; }
      if (++answered > 40) return; // Bound replies; a lookup only needs a few.
      const body = { id: session.secrets.id, port: relay.endpoint.port, gamePort: relay.gameEndpoint?.port ?? null, fingerprint: this.identity.fingerprint, name: relay.name };
      udp.send(Buffer.from(JSON.stringify({ type: 'seedhost-here', v: 1, ...body, mac: replyMac(session.secrets.macKey, body) })), from.port, from.address, () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      udp.once('error', reject);
      udp.bind(this.options.discoveryPort ?? DISCOVERY_PORT, host, () => { udp.off('error', reject); udp.on('error', () => undefined); resolve(); });
    });
    this.udp = udp;
  }

  private async closeDiscovery(): Promise<void> {
    const udp = this.udp; this.udp = undefined;
    if (udp) await new Promise<void>((resolve) => udp.close(() => resolve()));
  }

  /** A fresh single-use code; the previous unused one stops working when it expires. */
  async newCode(): Promise<AlwaysOnStatus> {
    if (!this.relay) throw new Error('Turn on “This PC is the always-on PC” first');
    const code = newPairingCode();
    const secrets = await pairingSecrets(code);
    const created = await this.relay.createInvite({ minutes: CODE_MINUTES, token: secrets.token, advertise: this.relay.endpoint && this.advertiseHost() ? { host: this.advertiseHost()!, port: this.relay.endpoint.port } : undefined });
    this.session = { code, expiresAt: created.expiresAt, secrets };
    return this.status();
  }

  async status(): Promise<AlwaysOnStatus> {
    const relay = this.relay;
    if (relay) await relay.reload().catch(() => undefined);
    let custody = 'empty';
    try {
      const held = relay ? await relay.custody() : null;
      if (held) custody = held.state;
    } catch { custody = 'unknown'; }
    const advertised = this.advertiseHost();
    const session = this.session && this.session.expiresAt > Date.now() ? this.session : undefined;
    return {
      enabled: this.enabled, running: Boolean(relay), name: relay?.name ?? 'Always-on PC', error: this.error,
      addresses: [...new Set([advertised, ...privateLanAddresses(), ...tailnetAddresses()].filter((a): a is string => Boolean(a)))],
      port: relay?.endpoint?.port ?? null, gamePort: relay?.gameEndpoint?.port ?? null,
      code: session?.code ?? null, codeExpiresAt: session?.expiresAt ?? null,
      members: relay?.trusted ?? [], custody,
    };
  }

  async close(): Promise<void> {
    this.session = undefined;
    await this.closeDiscovery();
    const relay = this.relay; this.relay = undefined;
    await relay?.close();
  }
}
