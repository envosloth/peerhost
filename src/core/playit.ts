import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IdentityVault } from './identity-store.js';
import type { GatewayStatus } from './game-gateway.js';

export type PlayitGateway = GatewayStatus & { fingerprint: string; controlPort: number };
export interface PlayitDependencies {
  vault: IdentityVault;
  gateway: () => Promise<PlayitGateway>;
  api: (key: string, route: string, payload?: unknown) => Promise<any>;
  probe: (endpoint: {host: string; port: number; serverName: string}) => Promise<boolean>;
}
interface Stored { version: 1; encryptedKey: string; agentId: string }
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
async function boundedFile(filename: string, max = 16384): Promise<Buffer> {
  const h = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const s = await h.stat();
    if (!s.isFile() || s.size > max) throw new Error('Invalid playit file');
    const data = Buffer.alloc(max + 1), { bytesRead } = await h.read(data, 0, data.length, 0);
    if (bytesRead > max) throw new Error('Invalid playit file');
    return data.subarray(0, bytesRead);
  } finally { await h.close(); }
}

/** Optional integration; never reads another profile or manages the external agent process. */
export class PlayitIntegration {
  private readonly file: string;
  constructor(private readonly root: string, private readonly deps: PlayitDependencies) { this.file = path.join(root, 'playit.json'); }
  private async read(): Promise<Stored | null> {
    try {
      const s = JSON.parse((await boundedFile(this.file)).toString());
      if (s.version !== 1 || !uuid(s.agentId) || typeof s.encryptedKey !== 'string' || !s.encryptedKey || s.encryptedKey.length > 8192) throw Error();
      return s;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Saved playit connection cannot be read. Disconnect and reconnect it; server controls are unaffected.'); }
  }
  private async save(s: Stored): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const temp = this.file + '.' + randomUUID() + '.tmp';
    try {
      const h = await open(temp, 'wx', 0o600);
      try { await h.writeFile(JSON.stringify(s)); await h.sync(); } finally { await h.close(); }
      await rename(temp, this.file);
    } finally { await rm(temp, { force: true }); }
  }
  async status() {
    try { const s = await this.read(); return { connected: !!s, state: s ? 'unchecked' : 'off', detail: s ? 'Connected. Check your public address.' : 'Optional: connect playit to let friends join without a VPN.' }; }
    catch (e) { return { connected: false, state: 'error', detail: (e as Error).message }; }
  }
  /** The filename must come from the native picker, never from renderer IPC. */
  async importAgentFile(filename: string): Promise<void> {
    let key: string;
    try { key = (await boundedFile(filename, 4096)).toString('utf8').trim(); }
    catch { throw new Error('Select the playit agent secret.txt file, not a folder or link.'); }
    if (!/^[a-fA-F0-9]{32,256}$/.test(key)) throw new Error('This is not a playit agent secret file.');
    const data = await this.deps.api(key, '/v1/agents/rundata');
    if (!uuid(data?.agent_id)) throw new Error('playit did not return a valid agent.');
    await this.save({ version: 1, agentId: data.agent_id, encryptedKey: this.deps.vault.encrypt(key).toString('base64') });
  }
  private creating = false;
  private async context() {
    const s = await this.read();
    if (!s) throw new Error('Connect a playit agent first.');
    const gateway = await this.deps.gateway();
    if (!gateway.enabled || !gateway.host || !Number.isInteger(gateway.port) || gateway.port! < 1 || gateway.port! > 65535 || gateway.port === gateway.controlPort || !/^[a-f0-9]{64}$/.test(gateway.fingerprint)) throw new Error('Configure the always-on player gateway first, separate from its control port.');
    const key = this.deps.vault.decrypt(Buffer.from(s.encryptedKey, 'base64'));
    return { s, gateway, key };
  }
  private matches(t: any, agentId: string, gateway: PlayitGateway): boolean {
    const origin = t?.origin;
    const fields = origin?.details?.config_data?.fields;
    if (!Array.isArray(fields)) return false;
    const ip = fields.filter((f: any) => f?.name === 'local_ip');
    const port = fields.filter((f: any) => f?.name === 'local_port');
    return t.tunnel_type === 'minecraft-java' && origin.type === 'agent' && origin.details.agent_id === agentId && !origin.details.config_invalid && ip.length === 1 && port.length === 1 && ip[0].value === gateway.host && port[0].value === String(gateway.port);
  }
  async check(): Promise<{connected: boolean; state: string; detail: string; address?: string}> {
    try {
      const {s, gateway, key} = await this.context();
      const data = await this.deps.api(key, '/v1/tunnels/list');
      if (!Array.isArray(data?.tunnels) || data.tunnels.length > 1000) throw Error();
      const t = data.tunnels.find((v: any) => this.matches(v, s.agentId, gateway));
      if (!t) return {connected:true,state:'missing',detail:'No Minecraft tunnel points to this always-on player gateway. Create one below.'};
      const address = Array.isArray(t.connect_addresses) ? t.connect_addresses.map((v: any) => v?.value?.address).find((v: unknown) => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,62}\.(?:tun\.ply\.gg|joinmc\.link)$/.test(v)) : undefined;
      if (!t.user_enabled || t.disabled_by_admin || (t.offline_reasons != null && (!Array.isArray(t.offline_reasons) || t.offline_reasons.length))) return {connected:true,state:'offline',detail:'The playit tunnel is offline. Check the agent on your always-on PC.'};
      if (!address) return {connected:true,state:'pending',detail:'Waiting for playit to allocate a supported public Minecraft address.'};
      if (!gateway.ready) return {connected:true,state:'offline',address,detail:'Address reserved. Start a server with a ready always-on gateway to accept players.'};
      const ok = await this.deps.probe({host:address,port:25565,serverName:address});
      return {connected:true,state:ok?'reachable':'unreachable',address,detail:ok?'Minecraft answered through the public address from this PC. Keep the agent, relay and host running.':'Address reserved, but Minecraft did not answer. Check the agent, relay and running server.'};
    } catch { return {connected:(await this.status()).connected,state:'error',detail:'Could not verify playit. Check your connection, agent and always-on gateway; local hosting is unaffected.'}; }
  }
  async create() {
    if (this.creating) throw new Error('A playit operation is already in progress.');
    this.creating = true;
    try {
      const {s, gateway, key} = await this.context();
      const data = await this.deps.api(key, '/v1/tunnels/list');
      if (!Array.isArray(data?.tunnels) || data.tunnels.length > 1000) throw Error();
      if (!data.tunnels.some((v: any) => this.matches(v, s.agentId, gateway))) {
        await this.deps.api(key, '/tunnels/create', {name:'Seed Hosting Minecraft',tunnel_type:'minecraft-java',port_type:'tcp',port_count:1,origin:{type:'agent',data:{agent_id:s.agentId,local_ip:gateway.host,local_port:gateway.port}},enabled:true,alloc:{type:'region',details:{region:'global'}},firewall_id:null,proxy_protocol:null});
      }
      return await this.check();
    } catch { throw new Error('Could not create the playit tunnel. Verify your agent and player gateway, then check for an existing tunnel before retrying.'); }
    finally { this.creating = false; }
  }
  async disconnect(): Promise<void> { await rm(this.file, { force: true }); }

}
