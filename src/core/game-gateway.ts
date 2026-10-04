import { createServer, connect, type Socket, type Server } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { connectPeer, isVerifiedPeerSocket, readFrame, writeFrame, type PeerIdentity } from './peer-transport.js';
import { relayRequest } from './relay-client.js';

export interface GatewayStatus { enabled: boolean; host: string | null; port: number | null; ready: boolean; detail: string }
type RelayEndpoint = { host: string; port: number; fingerprint: string };
export interface GameRoute { owner: string; generation: number; lineage: string }
export const MAX_GAME_CONNECTIONS = 32;
const MAX_STANDBY_TUNNELS = 4;
const sameRoute = (a: GameRoute | null, b: GameRoute): boolean => !!a && a.owner === b.owner && a.generation === b.generation && a.lineage === b.lineage;

async function discovery(identity: PeerIdentity, relay: RelayEndpoint): Promise<GatewayStatus & { route: GameRoute | null }> {
  const socket = await connectPeer(identity, relay.fingerprint, relay.host, relay.port);
  try {
    await writeFrame(socket, relayRequest('gateway-status'));
    const reply = await readFrame(socket, 4096);
    if (reply?.type === 'error') throw new Error(`Relay refused: ${String(reply.message).slice(0, 512)}`);
    if (reply?.type !== 'relay-gateway-status' || typeof reply.enabled !== 'boolean' || typeof reply.ready !== 'boolean' ||
        typeof reply.detail !== 'string' || reply.detail.length > 512 ||
        (reply.enabled ? typeof reply.host !== 'string' || !Number.isInteger(reply.port) || reply.port < 1 || reply.port > 65535
          : reply.host !== null || reply.port !== null || reply.ready)) throw new Error('Invalid gateway status');
    const route = reply.route ?? null;
    if (route && (typeof route.owner !== 'string' || !/^[a-f0-9]{64}$/.test(route.owner) ||
        !Number.isSafeInteger(route.generation) || route.generation < 1 || typeof route.lineage !== 'string' || !route.lineage || route.lineage.length > 128)) throw new Error('Invalid gateway route');
    return { enabled: reply.enabled, host: reply.host, port: reply.port, ready: reply.ready, detail: reply.detail, route };
  } finally { socket.destroy(); }
}
export async function gatewayStatus(identity: PeerIdentity, relay: RelayEndpoint): Promise<GatewayStatus> {
  const { route: _route, ...status } = await discovery(identity, relay);
  return status;
}

/** Duplex piping keeps Node's stream backpressure; errors explicitly close both endpoints.
 * https://nodejs.org/docs/latest-v22.x/api/stream.html#readablepipedestination-options */
function bridge(a: Socket, b: Socket, idleMs = 120000): void {
  const destroy = () => { a.destroy(); b.destroy(); };
  a.once('error', destroy); b.once('error', destroy);
  a.once('close', destroy); b.once('close', destroy);
  // Node emits timeout without closing; explicitly tear down both sockets.
  // https://nodejs.org/docs/latest-v22.x/api/net.html#socketsettimeouttimeout-callback
  a.setTimeout(idleMs, destroy); b.setTimeout(idleMs, destroy);
  a.pipe(b); b.pipe(a);
}
interface Tunnel { socket: TLSSocket; route: GameRoute; active: boolean; lease: NodeJS.Timeout; rejectEarlyData: () => void }
export interface GameGatewayOptions { host?: string; port?: number; leaseMs?: number; idleMs?: number }

/** Raw player listener; route authority comes only from the relay's durable ledger. */
export class RelayGameGateway {
  private server?: Server;
  private readonly tunnels = new Set<Tunnel>();
  private readonly players = new Set<Socket>();
  private stopping = false;
  private closing?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private validating?: Promise<void>;
  endpoint?: { host: string; port: number };
  private leaseMs = 15000;
  private idleMs = 120000;
  constructor(private readonly route: () => Promise<GameRoute | null>) {}

  async listen({ host = '127.0.0.1', port = 0, leaseMs = 15000, idleMs = 120000 }: GameGatewayOptions = {}): Promise<void> {
    if (this.server) throw new Error('Player gateway is already listening');
    if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 15000) throw new Error('Gateway lease must be 100–15000 ms');
    if (!Number.isInteger(idleMs) || idleMs < 100 || idleMs > 120000) throw new Error('Gateway idle timeout must be 100–120000 ms');
    this.leaseMs = leaseMs; this.idleMs = idleMs;
    const server = createServer(player => {
      player.pause(); player.on('error', () => {});
      if (this.stopping || this.players.size >= MAX_GAME_CONNECTIONS) { player.destroy(); return; }
      this.players.add(player); player.once('close', () => this.players.delete(player));
      void this.forward(player).catch(() => player.destroy());
    });
    server.maxConnections = MAX_GAME_CONNECTIONS;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(); });
    });
    this.server = server;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Player listener has no address');
    this.endpoint = { host: address.address, port: address.port };
    this.timer = setInterval(() => { void this.validate(); }, 250);
  }

  /** Serial, fail-closed reread also notices membership changes by another CLI process. */
  validate(): Promise<void> {
    if (!this.validating) {
      this.validating = (async () => {
        let route: GameRoute | null = null;
        try { route = await this.route(); } catch { /* uncertain authority revokes all routes */ }
        for (const t of this.tunnels) if (this.stopping || !sameRoute(route, t.route)) t.socket.destroy();
      })().finally(() => { this.validating = undefined; });
    }
    return this.validating;
  }

  async status(): Promise<GatewayStatus & { route: GameRoute | null }> {
    const route = await this.route();
    const ready = !!route && [...this.tunnels].some(t => !t.active && !t.socket.destroyed && sameRoute(route, t.route));
    return { enabled: true, ...this.endpoint!, ready, route, detail: ready ? 'Player gateway is ready' : 'Waiting for the checked-out host tunnel' };
  }

  async register(socket: TLSSocket, source: string, generation: unknown, lineage: unknown): Promise<void> {
    if (!isVerifiedPeerSocket(socket) || !this.server || this.stopping) throw new Error('Player gateway is unavailable');
    const route = await this.route();
    if (!route || route.owner !== source || route.generation !== generation || route.lineage !== lineage) throw new Error('Gateway denied: no confirmed custody for this generation and lineage');
    if (this.stopping || this.tunnels.size >= MAX_GAME_CONNECTIONS || [...this.tunnels].filter(t => !t.active && !t.socket.destroyed).length >= MAX_STANDBY_TUNNELS) throw new Error('Gateway tunnel limit reached');
    const tunnel: Tunnel = { socket, route, active: false, lease: setTimeout(() => socket.destroy(), this.leaseMs), rejectEarlyData: () => {} };
    const rejectEarlyData = () => { if (!tunnel.active && socket.readableLength > 0) socket.destroy(); };
    tunnel.rejectEarlyData = rejectEarlyData;
    socket.on('readable', rejectEarlyData);
    this.tunnels.add(tunnel); socket.once('close', () => { clearTimeout(tunnel.lease); this.tunnels.delete(tunnel); });
    await writeFrame(socket, { type: 'relay-tunnel-ready' });
    rejectEarlyData();
  }

  private async forward(player: Socket): Promise<void> {
    const route = await this.route();
    if (this.stopping || player.destroyed || !route) { player.destroy(); return; }
    const tunnel = [...this.tunnels].find(t => !t.active && !t.socket.destroyed && sameRoute(route, t.route));
    if (!tunnel) { player.destroy(); return; }
    tunnel.active = true;
    tunnel.socket.off('readable', tunnel.rejectEarlyData);
    clearTimeout(tunnel.lease);
    player.once('close', () => tunnel.socket.destroy());
    tunnel.socket.once('close', () => player.destroy());
    try {
      await writeFrame(tunnel.socket, { type: 'relay-tunnel-start' });
      if ((await readFrame(tunnel.socket, 4096)).type !== 'relay-tunnel-connected') throw new Error('Host tunnel did not connect');
      if (!sameRoute(await this.route(), route) || this.stopping || player.destroyed) throw new Error('Gateway route changed');
      bridge(player, tunnel.socket, this.idleMs);
    } catch (error) { tunnel.socket.destroy(); throw error; }
  }

  async close(): Promise<void> {
    if (!this.closing) {
      this.stopping = true;
      clearInterval(this.timer);
      for (const t of this.tunnels) t.socket.destroy();
      for (const p of this.players) p.destroy();
      this.closing = new Promise<void>((resolve, reject) => this.server ? this.server.close(e => e ? reject(e) : resolve()) : resolve());
      this.endpoint = undefined;
    }
    return this.closing;
  }
}

/** Caller starts this only while safely owning and running its local server, and closes it before stop/park. */
export async function startHostGameGateway(identity: PeerIdentity, relay: RelayEndpoint, localPort: number,
  options: { expectedRoute?: { generation: number; lineage: string }; onStatus?: (status: { state: 'connecting' | 'ready' | 'error' | 'off'; detail: string }) => void } = {}): Promise<{ close: () => Promise<void> }> {
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error('Local Minecraft port must be 1–65535');
  let stopped = false, idle = 0;
  const sockets = new Set<Socket>();
  const work = new Set<Promise<void>>();
  const report = (state: 'connecting' | 'ready' | 'error' | 'off', detail: string) => {
    try { options.onStatus?.({ state, detail }); } catch { /* observers cannot own socket lifecycle */ }
  };
  const track = (socket: Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); if (stopped) socket.destroy(); };
  const launch = (promise: Promise<void>) => { work.add(promise); void promise.finally(() => work.delete(promise)); };
  async function tunnel(route: GameRoute): Promise<void> {
    idle++;
    let standby = true;
    const leaveStandby = () => { if (standby) { standby = false; idle--; } };
    let socket: TLSSocket | undefined;
    let local: Socket | undefined;
    try {
      socket = await connectPeer(identity, relay.fingerprint, relay.host, relay.port); track(socket);
      if (stopped) return;
      await writeFrame(socket, { ...relayRequest('game-tunnel'), generation: route.generation, lineage: route.lineage });
      if ((await readFrame(socket, 4096)).type !== 'relay-tunnel-ready') throw new Error('Relay refused host tunnel');
      report('ready', 'Pinned host tunnel is ready');
      const start = await readFrame(socket, 4096, 20000);
      if (start.type !== 'relay-tunnel-start' || stopped) throw new Error('Invalid tunnel activation');
      leaveStandby();
      // No requested remote target is accepted. Only the configured Minecraft port on literal loopback.
      // https://nodejs.org/docs/latest-v22.x/api/net.html#netcreateconnectionoptions-connectlistener
      local = connect({ host: '127.0.0.1', port: localPort }); track(local); local.on('error', () => {});
      const destination = local;
      socket.once('close', () => destination.destroy());
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { destination.destroy(); reject(new Error('Local Minecraft connection timed out')); }, 5000);
        const connected = () => { clearTimeout(timer); resolve(); };
        const failed = (error: Error) => { clearTimeout(timer); reject(error); };
        destination.once('connect', connected); destination.once('error', failed);
        destination.once('close', () => { clearTimeout(timer); reject(new Error('Local Minecraft connection closed')); });
      });
      if (stopped) { local.destroy(); return; }
      await writeFrame(socket, { type: 'relay-tunnel-connected' });
      bridge(socket, local);
      await new Promise<void>(resolve => socket!.once('close', resolve));
    } catch (error) { if (!stopped) report('error', (error as Error).message.slice(0, 512)); }
    finally { leaveStandby(); socket?.destroy(); local?.destroy(); }
  }
  let ticking = false;
  async function tick(): Promise<void> {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const status = await discovery(identity, relay);
      if (stopped) return;
      if (!status.enabled || !status.route || status.route.owner !== identity.fingerprint) { report('off', status.detail); return; }
      if (options.expectedRoute && (status.route.generation !== options.expectedRoute.generation || status.route.lineage !== options.expectedRoute.lineage)) {
        for (const socket of sockets) socket.destroy();
        report('error', 'Confirmed gateway route does not match local ownership lineage/generation'); return;
      }
      while (idle < 2 && work.size < MAX_GAME_CONNECTIONS && !stopped) launch(tunnel(status.route));
    } catch (error) { if (!stopped) report('error', (error as Error).message.slice(0, 512)); }
    finally { ticking = false; }
  }
  report('connecting', 'Connecting pinned host tunnels');
  const timer = setInterval(() => launch(tick()), 500);
  launch(tick());
  return { close: async () => {
    stopped = true; clearInterval(timer);
    for (const socket of sockets) socket.destroy();
    await Promise.all([...work]);
    report('off', 'Host gateway is closed');
  } };
}
