import { createHash, createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';
import { createIdentity, isVerifiedPeerSocket, listenPeer, readInviteFrame, writeInviteFrame, writeFrame, type PeerIdentity } from './peer-transport.js';
import { OwnershipLedger, canAcceptOffer } from './ownership.js';
import { receiveSnapshot, sendSnapshot } from './transfers.js';
import { pruneStore, syncDirectory } from './snapshots.js';
import { RELAY_PROTOCOL_VERSION, type RelayCustody } from './relay-client.js';
import { encodeInvite, type CreatedInvite } from './invites.js';
import { RelayGameGateway, type GameRoute, type GameGatewayOptions } from './game-gateway.js';
import type { PublicAddress } from './public-address.js';
import { durableJSON, fingerprintOK, friendName, readRelayConfig, validAdvertise, withRelayLock,
  type FriendMember, type PendingInvite, type RelayConfig } from './relay-friends-store.js';

export interface RelayOptions {
  name?: string;
  /** Received revisions to keep (the held revision is always kept). Default 10. */
  keepRevisions?: number;
  log?: (line: string) => void;
}


const DEFAULT_PORT = 47625;
const REQUEST_TIMEOUT_MS = 5000;

// Older configs lack provenance: preserve their non-loopback routes as explicit advertisements.
type RelayNodeConfig = RelayConfig & { advertiseSource?: 'explicit' | 'inferred' };

/**
 * An always-on custodian for one server lineage. Hosts park the server here (a normal handoff with the relay as
 * the target), and any trusted host can later claim it (a normal handoff from the relay), so the PCs that run the
 * server never need to be online at the same time. The relay never runs Minecraft and never materializes a world.
 */
export class RelayNode {
  private config: RelayNodeConfig = { version: 1, trusted: [], history: [] };
  private listener?: { host: string; port: number; close: () => Promise<void> };
  /** Park and claim run one at a time, in arrival order. Status reads never wait. */
  private queue: Promise<void> = Promise.resolve();
  private game?: RelayGameGateway;
  /** Optional one-click public address for this relay's player gateway; any member can turn it on. */
  publicAddress?: PublicAddress;
  private readonly keepRevisions: number;
  private readonly log: (line: string) => void;
  private readonly defaultName: string;

  constructor(readonly root: string, readonly identity: PeerIdentity, options: RelayOptions = {}) {
    this.keepRevisions = options.keepRevisions ?? 10;
    if (!Number.isInteger(this.keepRevisions) || this.keepRevisions < 1) throw new RangeError('keepRevisions must be a positive integer');
    this.log = options.log ?? ((line) => console.log(line));
    this.defaultName = friendName(options.name ?? 'SeedHost relay', 100);
    if (Buffer.byteLength(this.defaultName) > 100) throw new Error('Relay name must fit in 100 UTF-8 bytes');
  }

  get endpoint(): { host: string; port: number } | undefined {
    return this.listener && { host: this.listener.host, port: this.listener.port };
  }
  get owner(): string | undefined { return this.config.owner; }
  get trusted(): FriendMember[] { return this.config.trusted.map((host) => ({ ...host })); }
  get gameEndpoint(): { host: string; port: number } | undefined { return this.game?.endpoint; }

  /** Explicit opt-in; the player listener is independent of the TLS custody listener. */
  async listenGame(options: GameGatewayOptions = {}): Promise<void> {
    if (this.game) throw new Error('Player gateway is already listening');
    const game = new RelayGameGateway(() => this.gameRoute());
    await game.listen(options);
    this.game = game;
  }

  private async gameRoute(): Promise<GameRoute | null> {
    await this.reload();
    let state;
    try { state = await this.ledger().status(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (state.version !== 1 || state.state !== 'transferred' || state.offer !== undefined ||
        !fingerprintOK(state.owner) || !fingerprintOK(state.snapshotId) || !Number.isSafeInteger(state.generation) || state.generation < 1 ||
        typeof state.lineage !== 'string' || !state.lineage || state.lineage.length > 128 || /[\u0000-\u001f\u007f]/u.test(state.lineage) ||
        !this.config.trusted.some(m => m.fingerprint === state.owner)) return null;
    return { owner: state.owner, generation: state.generation, lineage: state.lineage };
  }
  get name(): string { return this.config.name ?? this.defaultName; }
  private get invites(): string { return path.join(this.root, 'invites'); }
  private get store(): string { return path.join(this.root, 'store'); }
  private ledger(): OwnershipLedger { return new OwnershipLedger(path.join(this.root, 'ownership.sqlite'), this.identity.fingerprint); }

  async open(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(this.invites, { recursive: true, mode: 0o700 });
    await this.reload();
  }

  async reload(): Promise<void> { this.config = await readRelayConfig(this.root, this.defaultName); }

  /** Reload inside the cross-process lock before every write, including transfer bookkeeping. */
  private mutate<T>(work: (config: RelayNodeConfig) => Promise<T>): Promise<T> {
    return withRelayLock(this.root, async () => {
      const config: RelayNodeConfig = await readRelayConfig(this.root, this.defaultName);
      const result = await work(config);
      config.redeemed = Object.fromEntries(Object.entries(config.redeemed ?? {}).filter(([, receipt]) => receipt.expiresAt > Date.now()));
      await durableJSON(path.join(this.root, 'relay.json'), config);
      this.config = config;
      return result;
    });
  }

  private requireMember(source: string, config = this.config): void {
    if (config.disbandedBy || !config.trusted.some((member) => member.fingerprint === source)) throw new Error('Invite required; untrusted device refused');
  }

  async trust(name: string, fingerprint: string): Promise<void> {
    const memberName = friendName(name, 100);
    if (!fingerprintOK(fingerprint)) throw new Error('Fingerprint must be exactly 64 lowercase SHA256 hex digits');
    if (fingerprint === this.identity.fingerprint) throw new Error('The relay cannot trust its own identity');
    await this.mutate(async (config) => {
      if (config.disbandedBy) throw new Error('This group is permanently disbanded; its identity cannot be reused');
      if (config.trusted.length >= 200 && !config.trusted.some((entry) => entry.fingerprint === fingerprint)) throw new Error('Relay friend limit reached');
      config.trusted = [...config.trusted.filter((host) => host.fingerprint !== fingerprint), { name: memberName, fingerprint }];
    });
  }

  /** Local administration only; the wire protocol has no appoint-owner operation. */
  async setOwner(fingerprint: string): Promise<void> {
    if (!fingerprintOK(fingerprint)) throw new Error('Invalid owner');
    await this.mutate(async config => { this.requireMember(fingerprint, config); config.owner = fingerprint; });
  }

  /** Permanent group-wide revocation, serialized with park/claim. Retains every world revision and ledger. */
  async disbandGroup(source: string): Promise<void> {
    const run = this.queue.then(() => this.mutate(async config => {
      this.requireMember(source, config);
      if (config.owner !== source) throw new Error('Only the group owner can disband the group');
      const custody = await this.custody();
      if (custody && (custody.state !== 'transferred' || custody.owner !== source || custody.pendingTarget)) throw new Error('Hand the world back to the group owner and finish every handoff before disbanding');
      config.disbandedBy = source;
      config.trusted = [];
      config.redeemed = {};
      config.memberInvites = false;
      delete config.owner;
    }));
    this.queue = run.catch(() => {});
    await run;
    await this.game?.validate();
  }

  async removeFriend(source: string, fingerprint: string): Promise<void> {
    if (!fingerprintOK(fingerprint)) throw new Error('Invalid friend');
    // Serialize with custody transfers, then recheck authority under the durable configuration lock.
    const run = this.queue.then(() => this.mutate(async config => {
      this.requireMember(source, config);
      if (config.owner !== source) throw new Error('Only the group owner can remove a member');
      if (fingerprint === config.owner) throw new Error('The group owner cannot be removed');
      const custody = await this.custody();
      if (custody?.owner === fingerprint || custody?.pendingTarget === fingerprint) throw new Error('Ask this friend to hand the world back before removing them');
      if (!config.trusted.some(m => m.fingerprint === fingerprint)) return;
      config.trusted = config.trusted.filter(m => m.fingerprint !== fingerprint);
      await this.removeInvites(record => record.issuer === fingerprint || record.recipient === fingerprint);
    }));
    this.queue = run.catch(() => {});
    await run;
    await this.game?.validate();
    this.log('Group member removed by the group owner.');
  }

  async untrust(fingerprint: string): Promise<void> {
    if (!fingerprintOK(fingerprint)) throw new Error('Invalid fingerprint');
    await this.mutate(async (config) => {
      if (!config.trusted.some((host) => host.fingerprint === fingerprint)) throw new Error('Not a trusted relay friend');
      config.trusted = config.trusted.filter((host) => host.fingerprint !== fingerprint);
      if (config.owner === fingerprint) delete config.owner;
      // Keep used-token tombstones: removing a friend must not revive a consumed token after a crash.
      await this.removeInvites((record) => record.issuer === fingerprint || record.recipient === fingerprint);
    });
    await this.game?.validate();
  }

  async setMemberInvites(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new Error('Member invites must be true or false');
    await this.mutate(async (config) => {
      if (!enabled) await this.removeInvites((record) => record.issuer !== null);
      config.memberInvites = enabled;
    });
  }

  async setName(name: string): Promise<void> {
    const relayName = friendName(name, 100);
    if (Buffer.byteLength(relayName) > 100) throw new Error('Relay name must fit in 100 UTF-8 bytes');
    await this.mutate(async (config) => { config.name = relayName; });
  }

  /** Local operator configuration only; this is not exposed through the relay protocol. */
  async setAdvertisedControlRoute(endpoint: { host: string; port: number }): Promise<void> {
    if (!validAdvertise(endpoint)) throw new Error('Invalid advertised control route');
    await this.mutate(async config => { config.advertise = { ...endpoint }; config.advertiseSource = 'explicit'; });
    await this.reload();
  }

  /** `token` lets a short pairing code stand in for the long invitation: both sides derive the same 16 bytes.
   * `minutes` gives a short-lived code (5–1440); otherwise `hours` (1–720) applies. */
  async createInvite({ hours = 24, minutes, advertise, token, recipient, persistAdvertise = true }: { hours?: number; minutes?: number; advertise?: { host: string; port: number }; token?: Buffer; recipient?: string; persistAdvertise?: boolean } = {}): Promise<CreatedInvite> {
    if (typeof persistAdvertise !== 'boolean') throw new Error('Persist advertised address must be true or false');
    if (recipient !== undefined && !fingerprintOK(recipient)) throw new Error('Invalid invite recipient');
    if (token !== undefined && (!Buffer.isBuffer(token) || token.length !== 16)) throw new Error('Invite token must be 16 bytes');
    if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440)) throw new Error('Invite minutes must be between 5 and 1440');
    if (minutes === undefined && (!Number.isFinite(hours) || hours < 1 || hours > 24 * 30)) throw new Error('Invite hours must be between 1 and 720');
    return this.issueInvite(minutes !== undefined ? minutes / 60 : hours, advertise, null, token, recipient, persistAdvertise);
  }

  private issueInvite(hours: number, advertise: { host: string; port: number } | undefined, issuer: string | null, fixedToken?: Buffer, recipient?: string, persistAdvertise = true): Promise<CreatedInvite> {
    if (!Number.isFinite(hours) || hours < 5 / 60 || hours > 24 * 30) return Promise.reject(new Error('Invite hours must be between 1 and 720'));
    return this.mutate(async (config) => {
      if (config.disbandedBy) throw new Error('This group is permanently disbanded');
      if (issuer !== null) {
        this.requireMember(issuer, config);
        if (!config.memberInvites && config.owner !== issuer) throw new Error('Only the relay owner can create invites');
        if (recipient !== undefined && (!fingerprintOK(recipient) || config.owner !== issuer)) throw new Error('Only the group owner can invite by username');
      }
      const endpoint = advertise ?? config.advertise ?? this.endpoint;
      if (!validAdvertise(endpoint)) throw new Error('Invite needs a reachable advertised relay address and port (not a wildcard bind address)');
      const token = fixedToken ? Buffer.from(fixedToken) : randomBytes(16);
      const expiresAt = Math.floor(Date.now() / 1000 + hours * 3600) * 1000;
      const code = encodeInvite({ relayFingerprint: this.identity.fingerprint, ...endpoint, token, expiresAt: expiresAt / 1000, relayName: config.name ?? this.defaultName });
      if (advertise && persistAdvertise) {
        config.advertise = { ...advertise };
        config.advertiseSource = 'explicit';
      }
      const files = await readdir(this.invites);
      for (const file of files.filter((file) => /^[a-f0-9]{64}\.json$/.test(file))) {
        const record = await this.readInvite(file);
        if (record && record.expiresAt <= Date.now()) await rm(path.join(this.invites, file), { force: true });
      }
      if ((await readdir(this.invites)).filter((file) => /^[a-f0-9]{64}\.json$/.test(file)).length >= 100) throw new Error('Too many pending relay invites');
      await durableJSON(path.join(this.invites, this.tokenHash(token) + '.json'), { version: 1, expiresAt, issuer, ...(recipient ? { recipient } : {}) } satisfies PendingInvite);
      return { code, expiresAt };
    });
  }

  private tokenHash(token: Buffer): string { return createHash('sha256').update(token).digest('hex'); }

  private async removeInvites(matches: (record: PendingInvite) => boolean): Promise<void> {
    for (const file of (await readdir(this.invites)).filter((file) => /^[a-f0-9]{64}\.json$/.test(file))) {
      const record = await this.readInvite(file);
      if (record && matches(record)) await rm(path.join(this.invites, file), { force: true });
    }
    await syncDirectory(this.invites);
  }

  private async readInvite(file: string): Promise<PendingInvite | null> {
    let record: PendingInvite;
    try { record = JSON.parse(await readFile(path.join(this.invites, file), 'utf8')) as PendingInvite; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (record?.version !== 1 || !Number.isSafeInteger(record.expiresAt) || (record.issuer !== null && !fingerprintOK(record.issuer)) || (record.recipient !== undefined && !fingerprintOK(record.recipient))) throw new Error('Invalid pending invite record');
    return record;
  }

  private async hasPendingInvite(): Promise<boolean> {
    for (const file of (await readdir(this.invites)).filter((file) => /^[a-f0-9]{64}\.json$/.test(file))) {
      const record = await this.readInvite(file);
      if (record && record.expiresAt > Date.now() && (record.issuer === null ||
          ((this.config.memberInvites || this.config.owner === record.issuer) && this.config.trusted.some((entry) => entry.fingerprint === record.issuer)))) return true;
    }
    return false;
  }

  private async redeemInvite(token: unknown, name: unknown, source: string): Promise<void> {
    const memberName = friendName(name);
    if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) throw new Error('Invite is not valid');
    if (source === this.identity.fingerprint) throw new Error('Cannot join your own relay');
    const hash = this.tokenHash(Buffer.from(token, 'hex'));
    await this.mutate(async (config) => {
      if (config.disbandedBy) throw new Error('Invite has been revoked: group disbanded');
      const receipt = config.redeemed?.[hash];
      if (receipt) {
        if (receipt.expiresAt <= Date.now()) throw new Error('Invite has expired');
        if (receipt.fingerprint !== source) throw new Error('Invite already used');
        this.requireMember(source, config);
        return;
      }
      const record = await this.readInvite(hash + '.json');
      if (!record) throw new Error('Invite already used or not valid');
      if (record.expiresAt <= Date.now()) throw new Error('Invite has expired');
      if (record.recipient && record.recipient !== source) throw new Error('Only the intended friend can accept this invitation');
      if (record.issuer !== null && ((!config.memberInvites && config.owner !== record.issuer) || !config.trusted.some((entry) => entry.fingerprint === record.issuer))) throw new Error('Invite has been revoked');
      if (config.trusted.length >= 200 && !config.trusted.some((entry) => entry.fingerprint === source)) throw new Error('Relay friend limit reached');
      config.trusted = [...config.trusted.filter((host) => host.fingerprint !== source), { name: memberName, fingerprint: source }];
      config.redeemed = { ...config.redeemed, [hash]: { fingerprint: source, expiresAt: record.expiresAt } };
    });
    // Receipt + membership were committed atomically before deletion; a crash here is still single-use.
    await rm(path.join(this.invites, hash + '.json'), { force: true });
    await syncDirectory(this.invites);
  }

  /** Loopback by default. Binding a LAN address is an explicit choice of the person running the relay. */
  async listen({ host = '127.0.0.1', port = 0, advertise, advertiseHost }: { host?: string; port?: number; advertise?: { host: string; port: number }; advertiseHost?: string } = {}): Promise<void> {
    if (this.listener) throw new Error('Relay is already listening');
    if (advertise !== undefined && !validAdvertise(advertise)) throw new Error('Invalid advertised relay address');
    if (advertiseHost !== undefined && !validAdvertise({ host: advertiseHost, port: 1 })) throw new Error('Invalid fallback relay address');
    this.listener = await listenPeer(this.identity, [],
      (socket, source) => { void this.handle(socket, source); }, { host, port, authorizeCertificate: async (source) => {
        await this.reload();
        if (this.config.disbandedBy) return this.config.disbandedBy === source ? 'trusted' : false;
        if (this.config.trusted.some((entry) => entry.fingerprint === source)) return 'trusted';
        // Retained unexpired receipts allow a bounded bootstrap socket to return an
        // explicit used-token refusal. This never grants membership: handle() still
        // restricts bootstrap sockets to join, and redeemInvite binds receipt reuse
        // to the original certificate. Expired receipts do not reopen admission.
        const hasReceipt = Object.values(this.config.redeemed ?? {}).some(receipt => receipt.expiresAt > Date.now());
        return await this.hasPendingInvite() || hasReceipt ? 'invite' : false;
      } });
    try {
      await this.mutate(async (config) => {
        if (advertise) { config.advertise = { ...advertise }; config.advertiseSource = 'explicit'; }
        // Only inferred endpoints follow the bind port; never rewrite deliberate public/proxy routes.
        else if (config.advertise && (config.advertiseSource === 'explicit' ||
          (config.advertiseSource === undefined && config.advertise.host !== 'localhost' && !/^127\./.test(config.advertise.host)))) { /* keep configured route */ }
        else if (advertiseHost) {
          config.advertise = { host: advertiseHost, port: this.listener!.port };
          config.advertiseSource = 'inferred';
        } else if (validAdvertise(this.endpoint)) {
          config.advertise = this.endpoint;
          config.advertiseSource = 'inferred';
        } else {
          delete config.advertise; // Never retain a stale inferred endpoint behind a wildcard bind.
          delete config.advertiseSource;
        }
      });
    } catch (error) { await this.close(); throw error; }
  }

  /** Resolves once every queued park/claim has finished (its post-acknowledgment ledger update included). */
  async settled(): Promise<void> { await this.queue; }

  async custody(): Promise<RelayCustody | null> {
    let state;
    try { state = await this.ledger().status(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (state.state === 'hosting' || state.state === 'uncertain') throw new Error(`Relay ledger is in an impossible state (${state.state})`);
    return { owner: state.owner, state: state.state, generation: state.generation, snapshotId: state.snapshotId,
      pendingTarget: state.state === 'offered' ? state.offer!.target : null };
  }

  private nameOf(fingerprint: string | null): string | null {
    if (fingerprint === null) return null;
    if (fingerprint === this.identity.fingerprint) return 'the relay';
    return this.config.trusted.find((host) => host.fingerprint === fingerprint)?.name ?? 'an untrusted device';
  }

  private async handle(socket: TLSSocket, source: string): Promise<void> {
    const who = this.nameOf(source)!;
    let retained = false;
    try {
      const request = await readInviteFrame(socket, 4096, REQUEST_TIMEOUT_MS) as Record<string, unknown>;
      if (!request || request.type !== 'relay' || request.version !== RELAY_PROTOCOL_VERSION || !['status', 'park', 'claim', 'join', 'invite', 'friends', 'gateway-status', 'game-tunnel', 'public-status', 'public-enable', 'public-disable', 'remove-friend', 'invite-for', 'disband', 'disband-status'].includes(request.op as string) ||
          Object.keys(request).length !== (request.op === 'join' || request.op === 'game-tunnel' ? 5 : request.op === 'remove-friend' || request.op === 'invite-for' ? 4 : 3)) {
        throw new Error('Unsupported relay request; both ends must run the same SeedHost alpha');
      }
      if (request.op === 'join') {
        await this.redeemInvite(request.token, request.name, source);
        await writeInviteFrame(socket, { type: 'relay-joined', relayName: this.name });
        return;
      }
      // Bootstrap sockets stay bootstrap-only even after another connection joins the same certificate.
      if (!isVerifiedPeerSocket(socket)) throw new Error('Invite required; untrusted request refused');
      await this.reload();
      if (request.op === 'disband-status') {
        if (this.config.disbandedBy !== source && this.config.owner !== source) throw new Error('Only the group owner can inspect disband status');
        await writeFrame(socket, { type: 'relay-disband-status', disbanded: this.config.disbandedBy === source, owner: source });
        return;
      }
      this.requireMember(source);
      if (request.op === 'disband') {
        await this.disbandGroup(source);
        await writeFrame(socket, { type: 'relay-disbanded', owner: source });
        return;
      }
      if (request.op === 'public-status' || request.op === 'public-enable' || request.op === 'public-disable') {
        const pa = this.publicAddress;
        if (!pa) { await writeFrame(socket, { type: 'relay-public', state: 'unsupported', address: null, detail: 'This always-on PC can’t make a public address. Update Seed Hosting on it.', approveUrl: null }); return; }
        // Serialize provider work with revocation. Recheck at admission, not just at TLS authentication.
        // Disband acknowledges only after already-admitted provider work has settled.
        const run = this.queue.then(async () => {
          await this.reload();
          this.requireMember(source);
          if (request.op !== 'public-status' && !this.game) throw new Error('Turn on the player address on the always-on PC first');
          return request.op === 'public-enable' ? pa.enable() : request.op === 'public-disable' ? pa.disable() : pa.refresh();
        });
        this.queue = run.then(() => undefined, () => undefined);
        const status = await run;
        if (request.op !== 'public-status') this.log(`Public address ${request.op === 'public-enable' ? 'turned on' : 'turned off'} by ${who}.`);
        await writeFrame(socket, { type: 'relay-public', ...status });
        return;
      }
      if (request.op === 'gateway-status') {
        await writeFrame(socket, { type: 'relay-gateway-status', ...(this.game ? await this.game.status() : { enabled: false, host: null, port: null, ready: false, detail: 'Player gateway is off' }) });
        return;
      }
      if (request.op === 'game-tunnel') {
        if (!this.game) throw new Error('Player gateway is off');
        await this.game.register(socket, source, request.generation, request.lineage);
        retained = true;
        return;
      }
      if (request.op === 'invite-for') {
        const invite = await this.issueInvite(24, undefined, source, undefined, request.fingerprint as string);
        await writeFrame(socket, { type: 'relay-invite', ...invite });
        return;
      }
      if (request.op === 'invite') {
        const invite = await this.issueInvite(24, undefined, source);
        await writeFrame(socket, { type: 'relay-invite', ...invite });
        return;
      }
      if (request.op === 'remove-friend') {
        await this.removeFriend(source, request.fingerprint as string);
        await writeFrame(socket, { type: 'relay-removed', fingerprint: request.fingerprint });
        return;
      }
      if (request.op === 'friends') {
        const custody = await this.custody();
        await writeFrame(socket, { type: 'relay-friends', canManage: this.config.owner === source, owner: this.config.owner ?? null, members: this.config.trusted.map((member) => ({ ...member, you: member.fingerprint === source })),
          custody: !custody ? 'unknown' : custody.state === 'owned' ? 'parked' : custody.state === 'offered' ? 'pending' : 'held',
          holder: custody?.state === 'transferred' ? this.nameOf(custody.owner) : null });
        return;
      }
      if (request.op === 'status') {
        const custody = await this.custody();
        await writeFrame(socket, { type: 'relay-status', custody,
          ownerName: this.nameOf(custody?.owner ?? null), pendingName: this.nameOf(custody?.pendingTarget ?? null) });
        socket.end();
        return;
      }
      const run = this.queue.then(async () => {
        await this.reload(); this.requireMember(source);
        return request.op === 'park' ? this.receivePark(socket, source, who) : this.serveClaim(socket, source, who);
      });
      this.queue = run.catch(() => {});
      await run;
    } catch (error) {
      this.log(`Relay ${who}: ${(error as Error).message}`);
      if (!socket.destroyed) await writeInviteFrame(socket, { type: 'error', message: (error as Error).message.slice(0, 512) }).catch(() => {});
    } finally {
      if (!retained) socket.destroy();
    }
  }

  /** A host hands the server to the relay. Conflicting offers are declined, which lets the host keep ownership. */
  private async receivePark(socket: TLSSocket, source: string, who: string): Promise<void> {
    const ledger = this.ledger();
    await receiveSnapshot(socket, source, this.store, async (snapshot, authenticated, offer) => {
      if (!offer) return false;
      if (await ledger.hasAccepted(offer.id)) return true; // retried park: re-acknowledge, never re-apply
      let current;
      try { current = await ledger.status(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!canAcceptOffer(current, offer, authenticated, this.identity.fingerprint)) {
        this.log(`Declined park from ${who}: relay holds generation ${current?.generation} (${current?.state}); offer was generation ${offer.generation}.`);
        return false;
      }
      await ledger.acceptTransfer(offer, authenticated, snapshot.id);
      await this.game?.validate();
      // Bookkeeping happens before the acknowledgment, so the host's next request never races it.
      // It is best-effort: authority has already committed and must not be reported as failed.
      try {
        const history = await this.mutate(async (config) => {
          config.history = [...config.history.filter((id) => id !== snapshot.id), snapshot.id].slice(-this.keepRevisions);
          return [...config.history];
        });
        const pruned = await pruneStore(this.store, { keep: history });
        this.log(`Parked ${snapshot.id} from ${who}. Pruned ${pruned.snapshotsRemoved} old revision(s).`);
      } catch (error) {
        this.log(`Parked ${snapshot.id} from ${who}, but history cleanup failed: ${(error as Error).message}`);
      }
      return true;
    });
  }

  /** The relay hands the server to a trusted host, or resends a pending claim to the host it is pending for. */
  private async serveClaim(socket: TLSSocket, target: string, who: string): Promise<void> {
    const ledger = this.ledger();
    const custody = await this.custody();
    if (!custody) throw new Error('The relay holds no server yet. Park one on it first.');
    let offer;
    if (custody.state === 'owned') {
      offer = await ledger.prepareTransfer(target, custody.snapshotId);
      await this.game?.validate();
    } else if (custody.state === 'offered') {
      if (custody.pendingTarget !== target) {
        const name = this.nameOf(custody.pendingTarget);
        throw new Error(`The server is pending checkout to ${name}; ${name} must retry its claim to finish it.`);
      }
      offer = (await ledger.status()).offer!;
    } else if (custody.owner === target) {
      throw new Error('Your device already holds the server; there is nothing to claim.');
    } else {
      const name = this.nameOf(custody.owner);
      throw new Error(`The server is checked out by ${name} (generation ${custody.generation}). Ask ${name} to park it on the relay.`);
    }
    let result;
    try { result = await sendSnapshot(socket, this.store, offer.snapshotId, offer); }
    catch (error) {
      this.log(`Claim by ${who} did not complete (${(error as Error).message}); it stays pending for ${who} to retry.`);
      throw error;
    }
    if (!result.ownershipAccepted) {
      await ledger.cancelTransfer(offer.id, target);
      this.log(`${who} declined the claim; the relay still holds the server.`);
      return;
    }
    await ledger.confirmTransfer(offer.id, target);
    await this.game?.validate();
    this.log(`Checked the server out to ${who} at generation ${offer.generation}.`);
  }

  async close(): Promise<void> {
    await this.publicAddress?.close();
    if (this.game) { await this.game.close(); this.game = undefined; }
    if (this.listener) { await this.listener.close(); this.listener = undefined; }
  }
}

/**
 * Headless identity for the relay. There is no desktop keychain on a typical always-on box, so the private key is
 * stored in an owner-only (0600) file. Protect the relay's disk accordingly.
 */
export async function loadOrCreateRelayIdentity(root: string): Promise<PeerIdentity> {
  await mkdir(root, { recursive: true });
  const file = path.join(root, 'identity.json');
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    const cert = new X509Certificate(data.certPem);
    const fingerprint = createHash('sha256').update(cert.raw).digest('hex');
    if (data.version !== 1 || fingerprint !== data.fingerprint || !cert.checkPrivateKey(createPrivateKey(data.keyPem))) {
      throw new Error('Relay identity certificate/key mismatch');
    }
    return { keyPem: data.keyPem, certPem: data.certPem, fingerprint };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const identity = await createIdentity();
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify({ version: 1, ...identity })); await handle.sync(); } finally { await handle.close(); }
  return identity;
}

export { DEFAULT_PORT as DEFAULT_RELAY_PORT };
