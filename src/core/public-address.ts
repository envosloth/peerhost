import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { IdentityVault } from './identity-store.js';
import { PlayitApiRefusal } from './playit-network.js';

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
  /** Exact world identity for a scoped binding. Legacy unscoped tunnels are never inferred as belonging to it. */
  serverId?: string;
  /** Where the tunnel forwards players (the always-on PC's player listener, or this PC's server), else null. */
  target: () => { host: string; port: number } | null;
  /** Revalidate a captured server route before external mutation/readback. */
  validateTarget?: () => Promise<void>;
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
  /** Shared agent owner: prepare credentials/process without creating a tunnel. */
  agentOnly?: boolean;
  /** Tests only: a different binary source and its digest. */
  binary?: { url: string; sha256: string; file: string };
  fetchBinary?: (url: string) => Promise<Buffer>;
  claimTimeoutMs?: number;
  pollMs?: number;
}
interface Saved { version: 1; enabled: boolean; agentId: string; encryptedKey: string; serverId?: string; tunnelId?: string; tunnelName?: string; target?: { host: string; port: number } }

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
  private epoch = 0;
  private checkGeneration = 0;
  private writing: Promise<void> = Promise.resolve();

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
      if (this.deps.serverId !== undefined && value?.serverId !== this.deps.serverId) throw new Error('Saved binding belongs to another server');
      if (value?.version !== 1 || typeof value.enabled !== 'boolean' || !uuid(value.agentId) || typeof value.encryptedKey !== 'string' || !value.encryptedKey || value.encryptedKey.length > 8192 || (value.tunnelId !== undefined && !uuid(value.tunnelId)) ||
        (value.tunnelName !== undefined && (typeof value.tunnelName !== 'string' || !/^Seed Hosting [a-f0-9-]{36}$/.test(value.tunnelName))) ||
        (value.target !== undefined && (value.target?.host !== '127.0.0.1' || !Number.isInteger(value.target?.port) || value.target.port < 1 || value.target.port > 65535))) throw new Error('Invalid saved binding');
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('The saved playit binding cannot be read or is damaged. No new tunnel was created.'); }
  }
  private write(saved: Saved, epoch = this.epoch): Promise<void> {
    const next = this.writing.catch(() => undefined).then(async () => {
      if (epoch !== this.epoch) return;
      await this.persist(saved, epoch);
    });
    this.writing = next; return next;
  }
  private guard(epoch: number): void { if (this.cancelled || epoch !== this.epoch) throw new Error('Public address operation cancelled'); }
  private async persist(saved: Saved, epoch: number): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const temporary = `${this.savedFile}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      try { await handle.writeFile(JSON.stringify(saved)); await handle.sync(); } finally { await handle.close(); }
      // Cancellation may happen at every filesystem await, not just when enqueued.
      if (epoch !== this.epoch) return;
      await rename(temporary, this.savedFile);
    } finally { await rm(temporary, { force: true }); }
  }

  /** Restore at app start: restart the agent if the public address was on. Never throws. */
  async restore(): Promise<void> {
    try {
      const saved = await this.read();
      if (!saved?.enabled) return;
      this.running = this.run(saved).catch((error) => this.fail(error));
    } catch (error) { this.fail(error); }
  }

  status(): PublicStatus { return { ...this.progress }; }
  async validateSaved(): Promise<void> { await this.read(); }
  async settled(): Promise<void> { await this.running; }
  async approvedKey(): Promise<string> {
    await this.enable(); await this.settled();
    if (this.progress.state === 'error') throw new Error(this.progress.detail);
    const saved = await this.read();
    if (!saved) throw new Error('No approved playit agent');
    return this.deps.vault.decrypt(Buffer.from(saved.encryptedKey, 'base64'));
  }

  /** Starts (or resumes) the one-click flow in the background; the UI polls status(). */
  async enable(): Promise<PublicStatus> {
    if (!this.binary) { this.progress = { state: 'unsupported', address: null, detail: 'Automatic public addresses aren’t available on this kind of computer yet. Use playit.gg’s own app instead.', approveUrl: null }; return this.status(); }
    if (this.deps.target() === null) throw new Error('Create or join a world first, so the address has something to point at.');
    if (this.running) return this.status();
    this.cancelled = false;
    const epoch = ++this.epoch;
    const saved = await this.read();
    this.guard(epoch);
    this.progress = { state: 'starting', address: null, detail: 'Starting the public address…', approveUrl: null };
    this.running = this.run(saved, epoch).catch((error) => { if (epoch === this.epoch) this.fail(error); }).finally(() => { if (epoch === this.epoch && (this.progress.state === 'error' || this.cancelled)) this.running = undefined; });
    await sleep(0);
    return this.status();
  }

  /** Turn the public address off: stop the agent. The approved agent is remembered, so turning it back on is instant. */
  async disable(): Promise<PublicStatus> {
    this.cancelled = true; ++this.epoch;
    await this.stopAgent();
    // A rename already issued cannot be cancelled. Drain it before reading, then
    // publish off last; otherwise a first credential write can appear after ENOENT.
    await this.writing;
    const saved = await this.read();
    if (saved) await this.write({ ...saved, enabled: false });
    this.running = undefined;
    this.progress = { state: 'off', address: null, detail: this.deps.externalAgent ? 'Disconnected in Seed Hosting only. The external playit tunnel may still forward players. Disable it in your playit account to stop public access.' : 'Off. The public agent on this PC is stopped.', approveUrl: null };
    return this.status();
  }

  private fail(error: unknown): void {
    if (this.cancelled) return;
    this.progress = { state: 'error', address: this.progress.address, detail: String((error as Error)?.message ?? error).slice(0, 300), approveUrl: null };
  }

  private async run(saved: Saved | null, epoch = this.epoch): Promise<void> {
    const executable = this.deps.externalAgent ? null : await this.ensureBinary();
    this.guard(epoch);
    let key: string;
    if (saved) key = this.deps.vault.decrypt(Buffer.from(saved.encryptedKey, 'base64'));
    else {
      const adopted = await this.deps.adoptKey?.().catch(() => null) ?? null;
      this.guard(epoch);
      key = adopted && hexKey(adopted) ? adopted : await this.approve();
      this.guard(epoch);
      this.progress = { state: 'starting', address: null, detail: 'Approved. Starting the public address…', approveUrl: null };
      const data = await this.deps.api(key, '/v1/agents/rundata');
      this.guard(epoch);
      if (!uuid(data?.agent_id)) throw new Error('playit did not return a valid agent');
      saved = { version: 1, enabled: true, serverId: this.deps.serverId, agentId: data.agent_id, encryptedKey: this.deps.vault.encrypt(key).toString('base64') };
    }
    if (!hexKey(key)) throw new Error('The saved playit key is damaged. Turn the public address off and on again.');
    saved = { ...saved, enabled: true };
    await this.write(saved, epoch);
    this.guard(epoch);
    this.progress = { state: 'starting', address: this.progress.address, detail: 'Starting the public address…', approveUrl: null };
    if (executable) await this.startAgent(executable, key, epoch);
    this.guard(epoch);
    this.progress = { state: 'creating', address: this.progress.address, detail: 'Reserving your public address…', approveUrl: null };
    if (this.deps.agentOnly) {
      this.progress = { state: 'reserved', address: null, detail: 'Approved agent ready.', approveUrl: null }; return;
    }
    await this.ensureTunnel(key, saved, epoch);
    this.guard(epoch);
    // Status polls must not validate the intermediate reservation without a tunnel ID.
    this.progress = { ...this.progress, state: 'pending' };
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

  private async startAgent(executable: string, key: string, epoch = this.epoch): Promise<void> {
    this.guard(epoch);
    await this.stopAgent();
    this.guard(epoch);
    this.stopping = false;
    // Verify the binary again right before running it.
    if (createHash('sha256').update(await readFile(executable)).digest('hex') !== this.binary!.sha256) throw new Error('The playit app changed on disk and was not started.');
    this.guard(epoch);
    const secretFile = path.join(this.dir, 'agent-key.txt');
    await rm(secretFile, { force: true });
    this.guard(epoch);
    const handle = await open(secretFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await handle.writeFile(key); await handle.sync(); } finally { await handle.close(); }
    try { this.guard(epoch); } catch (error) { await rm(secretFile, { force: true }); throw error; }
    const socket = process.platform === 'win32' ? `\\\\.\\pipe\\seedhost-playit-${createHash('sha256').update(this.dir).digest('hex').slice(0, 12)}` : path.join(this.dir, 'agent.sock');
    const child = spawn(executable, ['--secret-path', secretFile, '--socket-path', socket, '-l', path.join(this.dir, 'agent.log')], { stdio: 'ignore', windowsHide: true, detached: false });
    this.agent = child;
    child.once('exit', () => {
      if (this.agent !== child) return;
      this.agent = undefined;
      if (this.stopping || this.cancelled || epoch !== this.epoch) return;
      // Restart a crashed agent, at most 5 times in 10 minutes.
      const now = Date.now(); this.restarts = this.restarts.filter((t) => now - t < 600_000);
      if (this.restarts.length >= 5) { this.fail(new Error('The public address keeps stopping. Turn it off and on again.')); return; }
      this.restarts.push(now);
      void this.read().then((saved) => saved && this.startAgent(executable, this.deps.vault.decrypt(Buffer.from(saved.encryptedKey, 'base64')), epoch)).catch((error) => { if (epoch === this.epoch) this.fail(error); });
    });
    // The agent reads its key once at start; remove the plain copy shortly after.
    setTimeout(() => { if (this.agent === child || !this.agent && epoch === this.epoch) void rm(secretFile, { force: true }); }, 15000).unref();
    await new Promise<void>((resolve, reject) => {
      const early = (code: number | null) => reject(new Error(`The playit app stopped right away (code ${code}). See ${path.join(this.dir, 'agent.log')}.`));
      child.once('error', reject); child.once('exit', early);
      setTimeout(() => { child.off('exit', early); child.off('error', reject); resolve(); }, 1500).unref();
    });
  }

  private async stopAgent(): Promise<void> {
    const child = this.agent; this.agent = undefined;
    if (!child || child.exitCode !== null) { await rm(path.join(this.dir, 'agent-key.txt'), { force: true }); return; }
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

  private async ensureTunnel(key: string, saved: Saved, epoch: number): Promise<void> {
    await this.deps.validateTarget?.(); this.guard(epoch);
    const target = this.deps.target();
    if (target === null) throw new Error('There is no world to point the address at right now');
    const list = await this.deps.api(key, '/v1/tunnels/list');
    this.guard(epoch);
    if (!Array.isArray(list?.tunnels) || list.tunnels.length > 1000) throw new Error('Unexpected playit tunnel list');
    if (saved.target && (saved.target.host !== target.host || saved.target.port !== target.port)) throw new Error('The saved public binding targets a different Minecraft port. It was not rebound.');
    let tunnel = saved.tunnelId ? list.tunnels.find((t: any) => t.id === saved.tunnelId && this.matches(t, saved.agentId, target)) : undefined;
    if (saved.tunnelId && !tunnel) throw new Error('The saved playit tunnel is missing or its route changed. It was not replaced or rebound.');
    if (!tunnel) {
      const tunnelName = saved.tunnelName ?? `Seed Hosting ${randomUUID()}`;
      // Persist the unique reservation before sending a mutation. An uncertain create must never be retried.
      if (saved.tunnelName) {
        tunnel = list.tunnels.find((t: any) => t.name === tunnelName && this.matches(t, saved.agentId, target));
        if (!tunnel) throw new Error('The previous playit reservation is uncertain. Check your playit account; no duplicate tunnel was created.');
        if (!uuid(tunnel.id)) throw new Error('Invalid playit tunnel identity');
        await this.write({ ...saved, target, tunnelId: tunnel.id }, epoch);
        return;
      }
      saved = { ...saved, target, tunnelName };
      await this.write(saved, epoch);
      this.guard(epoch);
      await this.deps.validateTarget?.(); this.guard(epoch);
      const previousIds = new Set(list.tunnels.map((t: any) => t.id));
      try {
        await this.deps.api(key, '/tunnels/create', { name: tunnelName, tunnel_type: 'minecraft-java', port_type: 'tcp', port_count: 1,
          origin: { type: 'agent', data: { agent_id: saved.agentId, local_ip: target.host, local_port: target.port } }, enabled: true,
          alloc: { type: 'region', details: { region: 'global' } }, firewall_id: null, proxy_protocol: null });
      } catch (error) {
        if (error instanceof PlayitApiRefusal) await this.write({ ...saved, tunnelName: undefined }, epoch);
        throw error;
      }
      this.guard(epoch);
      const again = await this.deps.api(key, '/v1/tunnels/list');
      this.guard(epoch);
      const candidates = Array.isArray(again?.tunnels) ? again.tunnels.filter((t: any) => uuid(t.id) && !previousIds.has(t.id) && this.matches(t, saved.agentId, target) && t.name === tunnelName) : [];
      tunnel = candidates.length === 1 ? candidates[0] : undefined;
      if (!tunnel) throw new Error('playit didn’t create the address. Try again in a minute.');
    }
    if (uuid(tunnel.id) && tunnel.id !== saved.tunnelId) await this.write({ ...saved, tunnelId: tunnel.id }, epoch);
  }

  /** Re-check the tunnel and whether Minecraft answers through it. Cheap enough to call from a 15 s UI poll. */
  async refresh(force = false): Promise<PublicStatus> {
    if (!force && Date.now() - this.lastCheck < 10_000) return this.status();
    if (!['pending', 'reserved', 'reachable'].includes(this.progress.state)) return this.status();
    this.lastCheck = Date.now();
    const epoch = this.epoch, check = ++this.checkGeneration;
    const saved = await this.read();
    const target = this.deps.target();
    if (!saved?.enabled || target === null) return this.status();
    try {
      const key = this.deps.vault.decrypt(Buffer.from(saved.encryptedKey, 'base64'));
      const list = await this.deps.api(key, '/v1/tunnels/list');
      if (epoch !== this.epoch || check !== this.checkGeneration || this.cancelled) return this.status();
      const tunnel = Array.isArray(list?.tunnels) ? list.tunnels.find((t: any) => t.id === saved.tunnelId && this.matches(t, saved.agentId, target)) : undefined;
      if (!tunnel || saved.target && (saved.target.host !== target.host || saved.target.port !== target.port)) {
        this.progress = { state: 'error', address: null, detail: 'The saved playit tunnel is missing or its route changed. It was not replaced or rebound.', approveUrl: null }; return this.status();
      }
      if (epoch !== this.epoch || check !== this.checkGeneration || this.cancelled) return this.status();
      const address = Array.isArray(tunnel.connect_addresses) ? tunnel.connect_addresses.map((a: any) => a?.value?.address).find((a: unknown) => typeof a === 'string' && PLAYIT_HOST.test(a)) ?? null : null;
      const offline = tunnel.user_enabled === false || tunnel.disabled_by_admin === true || tunnel.origin?.details?.config_invalid ||
        (tunnel.offline_reasons != null && (!Array.isArray(tunnel.offline_reasons) || tunnel.offline_reasons.length));
      if (!address || offline) { this.progress = { state: 'pending', address, detail: offline ? 'Connecting to playit…' : 'playit is assigning your address (usually under a minute)…', approveUrl: null }; return this.status(); }
      const answered = await this.deps.probe({ host: address, port: 25565, serverName: address });
      if (epoch !== this.epoch || check !== this.checkGeneration || this.cancelled) return this.status();
      this.progress = answered
        ? { state: 'reachable', address, detail: 'Live. Anyone can join this address from anywhere.', approveUrl: null }
        : { state: 'reserved', address, detail: 'Your address is ready. It answers whenever someone is hosting the world.', approveUrl: null };
    } catch { if (epoch !== this.epoch || check !== this.checkGeneration || this.cancelled) return this.status(); this.progress = { ...this.progress, state: this.progress.address ? 'reserved' : 'pending', detail: 'Couldn’t reach playit to check the address. Reachability is not verified; it will retry.' }; }
    return this.status();
  }

  /** Runtime shutdown is not the user's off choice. Fence all continuations and
   * drain already-issued publication without clearing enabled or route ownership. */
  async close(): Promise<void> { this.cancelled = true; ++this.epoch; this.running = undefined; await this.stopAgent(); await this.writing; this.progress = { state: 'off', address: null, detail: 'Public agent stopped on this PC.', approveUrl: null }; }
}

export interface PublicServer { id: string; playerPort: number; state: string }
export type PerServerPublicDeps = Omit<PublicAddressDeps, 'target' | 'agentOnly' | 'validateTarget'> & {
  servers?: () => Promise<PublicServer[]>;
  reservedPorts?: () => Promise<number[]>;
};

/** One approved agent, independent pinned local-server tunnels. Never infers a world from a group/port. */
export class PerServerPublicAddresses {
  private readonly owner: PublicAddress;
  private readonly bindings = new Map<string, { port: number; public: PublicAddress; pending?: Promise<void>; error?: string; generation: number }>();
  private key?: Promise<string>;
  private closed = false;
  private reservationRevision = 0;
  constructor(private readonly root: string, private readonly deps: PerServerPublicDeps) {
    this.owner = new PublicAddress(root, { ...deps, agentOnly: true, target: () => ({ host: '127.0.0.1', port: 1 }) });
  }
  private binding(server: PublicServer) {
    let binding = this.bindings.get(server.id);
    if (!binding) {
      const port = server.playerPort;
      const id = server.id;
      const directory = createHash('sha256').update(server.id).digest('hex');
      binding = { port, generation: 0, public: new PublicAddress(path.join(this.root, 'public-servers', directory), {
        ...this.deps, serverId: id, agentOnly: false, externalAgent: true, openBrowser: undefined,
        adoptKey: () => this.agentKey(), target: () => ({ host: '127.0.0.1', port }),
        validateTarget: async () => {
          if (this.deps.servers) {
            const servers = await this.deps.servers(), current = servers.find(server => server.id === id);
            if (!current || current.playerPort !== port) throw new Error('The captured server or Minecraft port changed. No public tunnel was rebound.');
            if (servers.some(other => other.id !== id && other.playerPort === port)) throw new Error('This Minecraft port conflicts with another server. The public binding is not safe.');
          }
          if ((await this.deps.reservedPorts?.())?.includes(port)) throw new Error('This Minecraft port conflicts with the shared-hosting gateway. The public binding is not safe.');
        },
      }) };
      this.bindings.set(server.id, binding);
    }
    return binding;
  }
  /** Local disconnect is not provider deactivation. Retain every uncertain/created route,
   * including deleted worlds, across restart. Never assign its port to another identity. */
  async assertCanStart(server: Pick<PublicServer, 'id' | 'playerPort'>): Promise<void> {
    const revision = this.reservationRevision;
    for (const [id, binding] of this.bindings) {
      if (id !== server.id && binding.port === server.playerPort && binding.pending) throw new Error('Minecraft port is reserved by another public server operation');
    }
    const base = path.join(this.root, 'public-servers');
    const entries = await readdir(base, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    if (entries.length > 10000) throw new Error('Too many saved public port reservations');
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) throw new Error('Damaged public port reservation directory');
      let saved: Saved;
      try { saved = JSON.parse(await readFile(path.join(base, entry.name, 'public-address', 'playit.json'), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw new Error('Damaged public port reservation; server launch refused'); }
      if (saved.version !== 1 || typeof saved.serverId !== 'string' || createHash('sha256').update(saved.serverId).digest('hex') !== entry.name) throw new Error('Damaged public port ownership reservation');
      if (!saved.tunnelName && !saved.tunnelId) continue;
      if (saved.target?.host !== '127.0.0.1' || !Number.isInteger(saved.target.port) || saved.target.port < 1 || saved.target.port > 65535) throw new Error('Damaged public port reservation target');
      if (saved.target.port === server.playerPort && saved.serverId !== server.id) throw new Error('Minecraft port is reserved by another public server tunnel (possibly retired or locally disconnected). Choose a different server-port.');
    }
    // Older singleton routes have no world ownership and cannot be safely inherited.
    const legacy = await readFile(path.join(this.root, 'public-address', 'playit.json'), 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return null; throw new Error('Damaged legacy public port reservation');
    });
    if ((legacy?.tunnelName || legacy?.tunnelId) && (!legacy.target || legacy.target.port === server.playerPort)) throw new Error('Minecraft port is reserved by a legacy public tunnel without server ownership');
    // Setup runs in the background. If it started or completed during disk reads,
    // rescan; a finished operation must not escape both disk and pending checks.
    if (revision !== this.reservationRevision) await this.assertCanStart(server);
  }
  /** Allocate only a local Minecraft port. Never creates/repoints a provider tunnel. */
  async newServerPort(serverId: string, occupied: number[]): Promise<number> {
    if (this.closed) throw new Error('Public address manager is closed');
    const excluded = new Set([...occupied, ...await this.deps.reservedPorts?.() ?? []]);
    for (let port = 25565; port < 25821; port++) {
      if (excluded.has(port)) continue;
      try { await this.assertCanStart({ id: serverId, playerPort: port }); return port; }
      catch (error) {
        const message = (error as Error).message;
        if (!message.startsWith('Minecraft port is reserved by another public server') && !message.startsWith('Minecraft port is reserved by a legacy public tunnel')) throw error;
      }
    }
    throw new Error('No unreserved Minecraft port is available for a new server');
  }
  private agentKey(): Promise<string> {
    return this.key ??= this.owner.approvedKey().catch(error => { this.key = undefined; throw error; });
  }
  status(server: PublicServer): PublicStatus {
    const binding = this.bindings.get(server.id);
    if (!binding) return { state: 'off', address: null, detail: 'No public address is set for this server.', approveUrl: null };
    if (binding.error || binding.port !== server.playerPort) return { state: 'error', address: null, detail: binding.error ?? 'Minecraft port changed. The saved public tunnel was not rebound.', approveUrl: null };
    let status = binding.public.status();
    if (status.address && [...this.bindings.entries()].some(([id, other]) => id !== server.id && other.public.status().address === status.address)) {
      return { state: 'error', address: null, detail: 'playit returned the same address for different server tunnels. No conflicting address is advertised. Check the provider bindings.', approveUrl: null };
    }
    if (binding.pending && status.state === 'off') {
      status = this.owner.status();
      return { ...status, address: null, state: status.state === 'reserved' || status.state === 'off' ? 'starting' : status.state };
    }
    if (status.state === 'reachable' && server.state !== 'running') return { ...status, state: 'reserved', detail: 'Address reserved. No running Minecraft process is tracked for this server on this PC.' };
    if (status.state === 'reserved') return { ...status, detail: 'Address reserved, but this server is not reachable through it. Start Minecraft on this PC and check again.' };
    return status;
  }
  async enable(server: PublicServer, servers: PublicServer[]): Promise<PublicStatus> {
    if (this.closed) throw new Error('Public address manager is closed');
    if (!Number.isInteger(server.playerPort) || server.playerPort < 1 || server.playerPort > 65535) throw new Error('Invalid Minecraft port');
    if (servers.some(other => other.id !== server.id && other.playerPort === server.playerPort)) throw new Error('This Minecraft port is used by another server. Set a distinct server-port in Server settings first.');
    if ((await this.deps.reservedPorts?.())?.includes(server.playerPort)) throw new Error('This Minecraft port conflicts with the shared-hosting gateway. Set a distinct port first.');
    await this.assertCanStart(server);
    const binding = this.binding(server);
    if (binding.pending) return this.status(server);
    const generation = ++binding.generation;
    ++this.reservationRevision;
    binding.error = undefined;
    binding.pending = (async () => {
      await binding.public.validateSaved();
      if (this.closed || binding.generation !== generation) return;
      await this.agentKey();
      if (this.closed || binding.generation !== generation) return;
      await binding.public.enable(); await binding.public.settled();
    })().catch(error => { if (binding.generation === generation) binding.error = String((error as Error).message).slice(0, 300); })
      .finally(() => { ++this.reservationRevision; if (binding.generation === generation) binding.pending = undefined; });
    return this.status(server);
  }
  async refresh(server: PublicServer, force = false): Promise<PublicStatus> {
    const binding = this.bindings.get(server.id);
    if (binding && !binding.pending && !binding.error && binding.port === server.playerPort) await binding.public.refresh(force);
    return this.status(server);
  }
  async disable(server: PublicServer): Promise<PublicStatus> {
    ++this.reservationRevision;
    const binding = this.bindings.get(server.id);
    if (binding) { ++binding.generation; binding.pending = undefined; await binding.public.disable(); binding.error = undefined; }
    return this.status(server);
  }
  async restore(servers: PublicServer[]): Promise<void> {
    for (const server of servers) {
      const directory = createHash('sha256').update(server.id).digest('hex');
      const saved = await readFile(path.join(this.root, 'public-servers', directory, 'public-address', 'playit.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (saved?.enabled === true) {
        try { await this.enable(server, servers); }
        catch (error) { this.binding(server).error = String((error as Error).message).slice(0, 300); }
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const binding of this.bindings.values()) { ++binding.generation; await binding.public.close(); }
    await this.owner.close();
  }
}
