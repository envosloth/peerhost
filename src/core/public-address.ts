import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { IdentityVault } from './identity-store.js';

/*
 * One-click public address.
 *
 * Seed Hosting downloads playit.gg's official agent (pinned release, SHA-256 checked), asks playit to approve it
 * (the one step only the user can do: playit opens in their browser and they press Approve while signed in),
 * receives the agent key directly from playit, runs the agent hidden inside the app, and creates one Minecraft
 * tunnel to this always-on PC's player port. The key is kept OS-encrypted; it touches disk in plain form only
 * for the few seconds the agent needs to read it at start.
 */

export const PLAYIT_VERSION = '1.0.10';
const RELEASE = `https://github.com/playit-cloud/playit-agent/releases/download/v${PLAYIT_VERSION}/`;
/** SHA-256 digests published with the v1.0.10 release. */
const BINARIES: Record<string, { file: string; sha256: string }> = {
  'linux-x64': { file: 'playit-linux-amd64', sha256: '2df7d9f10227ab312b1ad341853db4e8a8243df5cfcdbae58713a4271711c339' },
  'linux-arm64': { file: 'playit-linux-aarch64', sha256: '4c0db3e7b3a8158e249441c2f0b73f54e83429395890c7b1ca45fd7a6303d763' },
  'linux-arm': { file: 'playit-linux-armv7', sha256: '92ec60988b1246e07ac090c663128bd04bdc0d7ff388db520e1ff7bb4e5003e0' },
  'linux-ia32': { file: 'playit-linux-i686', sha256: 'd7215f3995e486bc231b3b542aa5f1ac6b0d604f8dae97bb14a9a64b49b3ed50' },
  'win32-x64': { file: 'playit-windows-x86_64-signed.exe', sha256: '2dbdaad119844cbbc062cc9774b8b462afa5f1b4b7832a9fc5ef4676cae887cf' },
  'win32-ia32': { file: 'playit-windows-x86-signed.exe', sha256: '9cec088fa4ee9ad4d59acd27512cf914078bdb31742e9abc946b81ea705f9d35' },
};
const DOWNLOAD_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const MAX_BINARY = 32 * 1024 * 1024;
const PLAYIT_HOST = /^[a-z0-9][a-z0-9-]{0,62}\.(?:tun\.ply\.gg|joinmc\.link)$/;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const hexKey = (v: unknown): v is string => typeof v === 'string' && /^[a-fA-F0-9]{32,256}$/.test(v);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type PublicState = 'off' | 'unsupported' | 'downloading' | 'approve' | 'starting' | 'creating' | 'pending' | 'reserved' | 'reachable' | 'error';
export interface PublicStatus { state: PublicState; address: string | null; detail: string; approveUrl: string | null }
export interface PublicAddressDeps {
  vault: IdentityVault;
  /** Where the tunnel forwards players (the always-on PC's player listener, or this PC's server), else null. */
  target: () => { host: string; port: number } | null;
  /** Authenticated playit API (allowlisted routes; throws on failure). */
  api: (key: string, route: string, payload?: unknown) => Promise<any>;
  /** Unauthenticated claim API; returns the raw {status, data} envelope. */
  claim: (route: '/claim/setup' | '/claim/exchange', payload: unknown) => Promise<{ status: string; data: unknown }>;
  probe: (endpoint: { host: string; port: number; serverName: string }) => Promise<boolean>;
  /** Opens playit's approval page. Optional: a headless always-on PC hands the URL to the gaming PC instead. */
  openBrowser?: (url: string) => Promise<void>;
  /** An agent key the owner already approved (e.g. an existing playit install). Skips the browser step. */
  adoptKey?: () => Promise<string | null>;
  /** The agent is run by something else (an existing service); only manage the tunnel and checks. */
  externalAgent?: boolean;
  /** Tests only: a different binary source and its digest. */
  binary?: { url: string; sha256: string; file: string };
  fetchBinary?: (url: string) => Promise<Buffer>;
  claimTimeoutMs?: number;
  pollMs?: number;
}
interface Saved { version: 1; enabled: boolean; agentId: string; encryptedKey: string; tunnelId?: string }

/** Official binaries only: pinned URL, allowlisted redirect hosts, bounded size. Checked against SHA-256 by the caller. */
export async function fetchPlayitBinary(url: string): Promise<Buffer> {
  let current = new URL(url);
  for (let hop = 0; hop < 4; hop++) {
    if (current.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(current.hostname)) throw new Error('playit download left the official GitHub release');
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(60000) });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); current = new URL(response.headers.get('location') ?? '', current); continue; }
    if (!response.ok || !response.body) throw new Error(`playit download failed (HTTP ${response.status})`);
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > MAX_BINARY) throw new Error('playit download is too large'); chunks.push(r.value); } }
    finally { await reader.cancel().catch(() => undefined); }
    return Buffer.concat(chunks);
  }
  throw new Error('Too many redirects downloading playit');
}

export async function playitClaim(route: '/claim/setup' | '/claim/exchange', payload: unknown): Promise<{ status: string; data: unknown }> {
  const response = await fetch('https://api.playit.gg' + route, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const text = await response.text();
  if (text.length > 65536) throw new Error('Unexpected playit reply');
  const value = JSON.parse(text);
  if (!value || typeof value.status !== 'string') throw new Error('Unexpected playit reply');
  return value;
}

export class PublicAddress {
  private readonly dir: string;
  private agent?: ChildProcess;
  private stopping = false;
  private restarts: number[] = [];
  private progress: PublicStatus = { state: 'off', address: null, detail: 'Off. One click gives your friends an address that works from anywhere.', approveUrl: null };
  private running?: Promise<void>;
  private cancelled = false;
  private lastCheck = 0;

  constructor(root: string, private readonly deps: PublicAddressDeps) { this.dir = path.join(root, 'public-address'); }

  private get savedFile(): string { return path.join(this.dir, 'playit.json'); }
  private get binary(): { url: string; sha256: string; file: string } | null {
    if (this.deps.binary) return this.deps.binary;
    const entry = BINARIES[`${process.platform}-${process.arch}`];
    return entry ? { url: RELEASE + entry.file, sha256: entry.sha256, file: entry.file } : null;
  }

  private async read(): Promise<Saved | null> {
    try {
      const value = JSON.parse(await readFile(this.savedFile, 'utf8'));
      if (value?.version !== 1 || typeof value.enabled !== 'boolean' || !uuid(value.agentId) || typeof value.encryptedKey !== 'string' || !value.encryptedKey || value.encryptedKey.length > 8192 || (value.tunnelId !== undefined && !uuid(value.tunnelId))) return null;
      return value;
    } catch { return null; }
  }
  private async write(saved: Saved): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const temporary = `${this.savedFile}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(saved)); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, this.savedFile); } finally { await rm(temporary, { force: true }); }
  }

  /** Restore at app start: restart the agent if the public address was on. Never throws. */
  async restore(): Promise<void> {
    const saved = await this.read();
    if (!saved?.enabled) return;
    this.running = this.run(saved).catch((error) => this.fail(error));
  }

  status(): PublicStatus { return { ...this.progress }; }

  /** Starts (or resumes) the one-click flow in the background; the UI polls status(). */
  async enable(): Promise<PublicStatus> {
    if (!this.binary) { this.progress = { state: 'unsupported', address: null, detail: 'Automatic public addresses aren’t available on this kind of computer yet. Use playit.gg’s own app instead.', approveUrl: null }; return this.status(); }
    if (this.deps.target() === null) throw new Error('Create or join a world first, so the address has something to point at.');
    if (this.running) return this.status();
    this.cancelled = false;
    this.running = this.run(await this.read()).catch((error) => this.fail(error)).finally(() => { if (this.progress.state === 'error' || this.cancelled) this.running = undefined; });
    await sleep(0);
    return this.status();
  }

  /** Turn the public address off: stop the agent. The approved agent is remembered, so turning it back on is instant. */
  async disable(): Promise<PublicStatus> {
    this.cancelled = true;
    await this.stopAgent();
    const saved = await this.read();
    if (saved) await this.write({ ...saved, enabled: false });
    this.running = undefined;
    this.progress = { state: 'off', address: null, detail: 'Off. Friends can’t join from outside your network.', approveUrl: null };
    return this.status();
  }

  private fail(error: unknown): void {
    if (this.cancelled) return;
    this.progress = { state: 'error', address: this.progress.address, detail: String((error as Error)?.message ?? error).slice(0, 300), approveUrl: null };
  }

  private async run(saved: Saved | null): Promise<void> {
    const executable = this.deps.externalAgent ? null : await this.ensureBinary();
    let key: string;
    if (saved) key = this.deps.vault.decrypt(Buffer.from(saved.encryptedKey, 'base64'));
    else {
      const adopted = await this.deps.adoptKey?.().catch(() => null) ?? null;
      key = adopted && hexKey(adopted) ? adopted : await this.approve();
      this.progress = { state: 'starting', address: null, detail: 'Approved. Starting the public address…', approveUrl: null };
      const data = await this.deps.api(key, '/v1/agents/rundata');
      if (!uuid(data?.agent_id)) throw new Error('playit did not return a valid agent');
      saved = { version: 1, enabled: true, agentId: data.agent_id, encryptedKey: this.deps.vault.encrypt(key).toString('base64') };
    }
    if (!hexKey(key)) throw new Error('The saved playit key is damaged. Turn the public address off and on again.');
    saved = { ...saved, enabled: true };
    await this.write(saved);
    if (this.cancelled) return;
    this.progress = { state: 'starting', address: this.progress.address, detail: 'Starting the public address…', approveUrl: null };
    if (executable) await this.startAgent(executable, key);
    this.progress = { state: 'creating', address: this.progress.address, detail: 'Reserving your public address…', approveUrl: null };
    await this.ensureTunnel(key, saved);
    await this.refresh(true);
  }

  private async ensureBinary(): Promise<string> {
    const binary = this.binary!;
    const target = path.join(this.dir, 'bin', binary.file);
    const ok = async () => createHash('sha256').update(await readFile(target)).digest('hex') === binary.sha256;
    if (await ok().catch(() => false)) return target;
    this.progress = { state: 'downloading', address: null, detail: 'Downloading playit.gg’s official app (about 6 MB)…', approveUrl: null };
    const bytes = await (this.deps.fetchBinary ?? fetchPlayitBinary)(binary.url);
    if (createHash('sha256').update(bytes).digest('hex') !== binary.sha256) throw new Error('The playit download failed its checksum, so it was not used. Try again later.');
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { await open(temporary, 'wx', 0o700).then(async (h) => { try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); } }); await chmod(temporary, 0o755); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
    return target;
  }

  /** playit's claim flow: open the approval page, poll until the user approves, receive the key. */
  private async approve(): Promise<string> {
    const code = randomBytes(5).toString('hex');
    const approveUrl = `https://playit.gg/claim/${code}`;
    const deadline = Date.now() + (this.deps.claimTimeoutMs ?? 15 * 60_000);
    const poll = this.deps.pollMs ?? 1500;
    this.progress = { state: 'approve', address: null, detail: 'Approve Seed Hosting on playit.gg (it opened in your browser). Sign in or make a free account if asked.', approveUrl };
    await this.deps.openBrowser?.(approveUrl).catch(() => undefined);
    for (;;) {
      if (this.cancelled) throw new Error('Cancelled');
      if (Date.now() > deadline) throw new Error('playit approval timed out. Press the button again to get a new approval page.');
      const setup = await this.deps.claim('/claim/setup', { code, agent_type: 'self-managed', version: `playit ${PLAYIT_VERSION}` }).catch(() => null);
      if (setup?.status === 'success' && setup.data === 'UserRejected') throw new Error('The approval was declined on playit.gg.');
      if (setup?.status === 'success' && setup.data === 'UserAccepted') {
        for (let attempt = 0; attempt < 30; attempt++) {
          const exchange = await this.deps.claim('/claim/exchange', { code }).catch(() => null);
          const secret = (exchange?.data as { secret_key?: unknown } | undefined)?.secret_key;
          if (exchange?.status === 'success' && hexKey(secret)) return secret;
          if (exchange?.status === 'fail' && exchange.data === 'UserRejected') throw new Error('The approval was declined on playit.gg.');
          await sleep(poll);
        }
        throw new Error('playit approved the app but didn’t send its key. Try again.');
      }
      await sleep(poll);
    }
  }

  private async startAgent(executable: string, key: string): Promise<void> {
    await this.stopAgent();
    this.stopping = false;
    // Verify the binary again right before running it.
    if (createHash('sha256').update(await readFile(executable)).digest('hex') !== this.binary!.sha256) throw new Error('The playit app changed on disk and was not started.');
    const secretFile = path.join(this.dir, 'agent-key.txt');
    await rm(secretFile, { force: true });
    const handle = await open(secretFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await handle.writeFile(key); await handle.sync(); } finally { await handle.close(); }
    const socket = process.platform === 'win32' ? `\\\\.\\pipe\\seedhost-playit-${createHash('sha256').update(this.dir).digest('hex').slice(0, 12)}` : path.join(this.dir, 'agent.sock');
    const child = spawn(executable, ['--secret-path', secretFile, '--socket-path', socket, '-l', path.join(this.dir, 'agent.log')], { stdio: 'ignore', windowsHide: true, detached: false });
    this.agent = child;
    child.once('exit', () => {
      if (this.agent === child) this.agent = undefined;
      if (this.stopping || this.cancelled) return;
      // Restart a crashed agent, at most 5 times in 10 minutes.
      const now = Date.now(); this.restarts = this.restarts.filter((t) => now - t < 600_000);
      if (this.restarts.length >= 5) { this.fail(new Error('The public address keeps stopping. Turn it off and on again.')); return; }
      this.restarts.push(now);
      void this.read().then((saved) => saved && this.startAgent(executable, this.deps.vault.decrypt(Buffer.from(saved.encryptedKey, 'base64')))).catch((error) => this.fail(error));
    });
    // The agent reads its key once at start; remove the plain copy shortly after.
    setTimeout(() => { void rm(secretFile, { force: true }); }, 15000).unref();
    await new Promise<void>((resolve, reject) => {
      const early = (code: number | null) => reject(new Error(`The playit app stopped right away (code ${code}). See ${path.join(this.dir, 'agent.log')}.`));
      child.once('error', reject); child.once('exit', early);
      setTimeout(() => { child.off('exit', early); child.off('error', reject); resolve(); }, 1500).unref();
    });
  }

  private async stopAgent(): Promise<void> {
    const child = this.agent; this.agent = undefined;
    if (!child || child.exitCode !== null) return;
    this.stopping = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 4000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
    await rm(path.join(this.dir, 'agent-key.txt'), { force: true });
  }

  private matches(tunnel: any, agentId: string, target: { host: string; port: number }): boolean {
    const fields = tunnel?.origin?.details?.config_data?.fields;
    if (tunnel?.tunnel_type !== 'minecraft-java' || tunnel.origin?.type !== 'agent' || tunnel.origin.details?.agent_id !== agentId || !Array.isArray(fields)) return false;
    const ip = fields.filter((f: any) => f?.name === 'local_ip'), lp = fields.filter((f: any) => f?.name === 'local_port');
    return ip.length === 1 && lp.length === 1 && ip[0].value === target.host && lp[0].value === String(target.port);
  }

  private async ensureTunnel(key: string, saved: Saved): Promise<void> {
    const target = this.deps.target();
    if (target === null) throw new Error('There is no world to point the address at right now');
    const list = await this.deps.api(key, '/v1/tunnels/list');
    if (!Array.isArray(list?.tunnels) || list.tunnels.length > 1000) throw new Error('Unexpected playit tunnel list');
    let tunnel = list.tunnels.find((t: any) => this.matches(t, saved.agentId, target));
    if (!tunnel) {
      await this.deps.api(key, '/tunnels/create', { name: 'Seed Hosting', tunnel_type: 'minecraft-java', port_type: 'tcp', port_count: 1,
        origin: { type: 'agent', data: { agent_id: saved.agentId, local_ip: target.host, local_port: target.port } }, enabled: true,
        alloc: { type: 'region', details: { region: 'global' } }, firewall_id: null, proxy_protocol: null });
      const again = await this.deps.api(key, '/v1/tunnels/list');
      tunnel = Array.isArray(again?.tunnels) ? again.tunnels.find((t: any) => this.matches(t, saved.agentId, target)) : undefined;
      if (!tunnel) throw new Error('playit didn’t create the address. Try again in a minute.');
    }
    if (uuid(tunnel.id) && tunnel.id !== saved.tunnelId) await this.write({ ...saved, tunnelId: tunnel.id });
  }

  /** Re-check the tunnel and whether Minecraft answers through it. Cheap enough to call from a 15 s UI poll. */
  async refresh(force = false): Promise<PublicStatus> {
    if (!force && Date.now() - this.lastCheck < 10_000) return this.status();
    if (!['creating', 'pending', 'reserved', 'reachable'].includes(this.progress.state)) return this.status();
    this.lastCheck = Date.now();
    const saved = await this.read();
    const target = this.deps.target();
    if (!saved?.enabled || target === null) return this.status();
    try {
      const key = this.deps.vault.decrypt(Buffer.from(saved.encryptedKey, 'base64'));
      const list = await this.deps.api(key, '/v1/tunnels/list');
      const tunnel = Array.isArray(list?.tunnels) ? list.tunnels.find((t: any) => this.matches(t, saved.agentId, target)) : undefined;
      if (!tunnel) { this.progress = { state: 'creating', address: null, detail: 'Reserving your public address…', approveUrl: null }; await this.ensureTunnel(key, saved); return this.status(); }
      const address = Array.isArray(tunnel.connect_addresses) ? tunnel.connect_addresses.map((a: any) => a?.value?.address).find((a: unknown) => typeof a === 'string' && PLAYIT_HOST.test(a)) ?? null : null;
      const offline = Array.isArray(tunnel.offline_reasons) && tunnel.offline_reasons.length;
      if (!address || offline) { this.progress = { state: 'pending', address, detail: offline ? 'Connecting to playit…' : 'playit is assigning your address (usually under a minute)…', approveUrl: null }; return this.status(); }
      const answered = await this.deps.probe({ host: address, port: 25565, serverName: address });
      this.progress = answered
        ? { state: 'reachable', address, detail: 'Live. Anyone can join this address from anywhere.', approveUrl: null }
        : { state: 'reserved', address, detail: 'Your address is ready. It answers whenever someone is hosting the world.', approveUrl: null };
    } catch { this.progress = { ...this.progress, detail: 'Couldn’t reach playit to check the address. It will retry.' }; }
    return this.status();
  }

  async close(): Promise<void> { this.cancelled = true; this.running = undefined; await this.stopAgent(); if (this.progress.state !== 'off') this.progress = { state: 'off', address: null, detail: 'Off while this PC isn’t the always-on PC.', approveUrl: null }; }
}
