import { mkdir, readFile, readdir, lstat, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { defaultSettings, validateSettings, type Settings } from './settings.js';
import { importServer, createSnapshot, materializeSnapshot, pruneStore, syncDirectory, type SnapshotManifest } from './snapshots.js';
import { ServerProcess } from './launcher.js';
import { OwnershipLedger, canAcceptOffer, type TransferOffer } from './ownership.js';
import { receiveSnapshot, sendSnapshotToPeer } from './transfers.js';
import { listenPeer, type PeerIdentity } from './peer-transport.js';
import { openRelayOperation, relayRequest, relayStatus, type RelayStatus } from './relay-client.js';
import {
  parseSavedState, validateLaunchProfile, validatePeer, validateRelayConfig,
  type LaunchProfileInput, type RelayConfig, type SavedPeer, type SavedServer, type SavedState,
} from './saved-state.js';

export interface LaunchApproval {
  readonly root: string;
  readonly serverDir: string;
  readonly snapshotId: string;
  readonly profile: { readonly executable: string; readonly args: readonly string[] };
}
export interface CleanUpResult { serverDirsRemoved: number; snapshotsRemoved: number; objectsRemoved: number; bytesFreed: number }
interface ApplicationOptions {
  confirmIncomingHandoff?: (source: string, snapshot: SnapshotManifest, offer: TransferOffer) => Promise<boolean>;
}

/** Revisions kept by cleanup: the current one plus this many ancestors. */
const CLEANUP_ANCESTORS = 2;

export class PeerHostApplication {
  private saved: SavedState = { version: 1, settings: defaultSettings(), server: null, peers: [], relay: null };
  private logs: string[] = [];
  private busy: string | null = null;
  private operationToken?: symbol;
  private process?: ServerProcess;
  private controlledProcess?: ServerProcess;
  private unexpectedExit?: OwnershipLedger;
  private listener?: { host: string; port: number; close: () => Promise<void> };

  constructor(readonly root: string, readonly identity: PeerIdentity, private readonly options: ApplicationOptions = {}) {}

  // ---------------------------------------------------------------- state and locking

  async open(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    let text: string | undefined;
    try { text = await readFile(path.join(this.root, 'state.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (text !== undefined) {
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new Error('Invalid saved application state: state.json is not valid JSON. The file was left unchanged.'); }
      this.saved = parseSavedState(value);
    }
    if (this.saved.server) {
      const ledger = this.ledger();
      if ((await ledger.status()).state === 'hosting') {
        await ledger.markUncertain();
        this.log('Previous hosting session is uncertain. Confirm that its process stopped before recovery.');
      }
    }
  }

  async getState() {
    let server = null;
    if (this.saved.server) {
      const ownership = await this.ledger().status();
      server = { ...this.saved.server, profile: { ...this.saved.server.profile, args: [...this.saved.server.profile.args] },
        state: this.process?.state ?? 'offline', ownership, ownerName: this.nameOf(ownership.owner) };
    }
    const relay = this.saved.relay;
    return {
      version: '0.1.0',
      deviceId: this.identity.fingerprint,
      settings: { ...this.saved.settings },
      server,
      relay: relay ? { ...relay, name: this.relayPeer()?.name ?? 'Relay' } : null,
      peers: this.saved.peers.map((peer) => ({ ...peer })),
      logs: [...this.logs],
      peerEndpoint: this.listener ? { host: this.listener.host, port: this.listener.port } : null,
      busy: this.busy,
    };
  }

  private assertStopped(): void {
    if (this.process?.pid || this.process?.state === 'starting' || this.process?.state === 'stopping') {
      throw new Error('Stop the server before this operation');
    }
  }

  private ledger(): OwnershipLedger {
    if (!this.saved.server) throw new Error('No server imported');
    return new OwnershipLedger(this.saved.server.ledgerFile, this.identity.fingerprint);
  }

  /** Human name for an ownership fingerprint, for status lines and errors. */
  private nameOf(fingerprint: string): string | null {
    if (fingerprint === this.identity.fingerprint) return 'this PC';
    if (fingerprint === this.saved.relay?.fingerprint) return 'the relay';
    return this.saved.peers.find((peer) => peer.fingerprint === fingerprint)?.name ?? null;
  }

  private relayPeer(): SavedPeer | undefined {
    return this.saved.relay ? this.saved.peers.find((peer) => peer.fingerprint === this.saved.relay!.fingerprint) : undefined;
  }

  private requireRelay(): SavedPeer {
    const peer = this.relayPeer();
    if (!peer) throw new Error('No relay is configured. Trust the always-on PC as a peer, then choose it as the relay in Settings.');
    return peer;
  }

  private log(line: string): void {
    this.logs.push(line.slice(0, 16384));
    if (this.logs.length > 1000) this.logs.shift();
  }

  /** Atomically replace state.json: write and flush a temporary, rename it, then flush the directory entry. */
  private async persist(): Promise<void> {
    const file = path.join(this.root, 'state.json');
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(this.saved)); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
    await syncDirectory(this.root);
  }

  private async fenceUnexpectedExit(): Promise<void> {
    while (this.unexpectedExit) {
      const ledger = this.unexpectedExit;
      this.unexpectedExit = undefined;
      try { await ledger.markUncertain(); }
      catch (error) { this.unexpectedExit = ledger; throw error; }
    }
  }

  /** One operation at a time. An unexpected server exit is fenced before the operation starts and before it releases. */
  private async operation<T>(name: string, work: (token: symbol) => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('An operation is already in progress');
    this.busy = name;
    const token = Symbol(name);
    this.operationToken = token;
    try {
      await this.fenceUnexpectedExit();
      return await work(token);
    } finally {
      try { await this.fenceUnexpectedExit(); }
      finally { this.operationToken = undefined; this.busy = null; }
    }
  }

  // ---------------------------------------------------------------- server lifecycle

  async importExisting(source: string, confirmedStopped: boolean): Promise<void> {
    this.assertStopped();
    if (!confirmedStopped) throw new Error('Confirm the source server is stopped before importing');
    await this.operation('importServer', async () => {
      if (this.saved.server) {
        throw new Error('A server is already imported. Use a separate explicit profile for a different server; existing lineage and authority cannot be replaced.');
      }
      const result = await importServer(source, path.join(this.root, 'managed'));
      const ledgerFile = path.join(this.root, `ownership-${randomUUID()}.sqlite`);
      await new OwnershipLedger(ledgerFile, this.identity.fingerprint).initialize(result.snapshot.id);
      this.saved.server = {
        name: path.basename(source), serverDir: result.serverDir, storeDir: result.storeDir, snapshotId: result.snapshot.id,
        profile: validateLaunchProfile({ executable: '', args: [] }, true), ledgerFile,
      };
      await this.persist();
      this.log('Imported a separate managed copy. Original folder was not modified.');
    });
  }

  async saveProfile(profile: LaunchProfileInput): Promise<void> {
    this.assertStopped();
    await this.operation('saveProfile', async () => {
      if (!this.saved.server) throw new Error('No server imported');
      this.saved.server.profile = validateLaunchProfile(profile);
      await this.persist();
    });
  }

  async startServer(approved: boolean): Promise<void> {
    if (!approved) throw new Error('Confirm that you trust the server executables and mods');
    await this.startServerWithApproval(async () => true);
  }

  async startServerWithApproval(confirm: (approval: LaunchApproval) => Promise<boolean>): Promise<void> {
    this.assertStopped();
    await this.operation('startServer', async () => {
      const server = this.saved.server;
      if (!server?.profile.executable) throw new Error('Configure a launch profile first');
      const original = JSON.stringify(server);
      const approval: LaunchApproval = Object.freeze({
        root: this.root, serverDir: server.serverDir, snapshotId: server.snapshotId,
        profile: Object.freeze({ executable: server.profile.executable, args: Object.freeze([...server.profile.args]) }),
      });
      if (!await confirm(approval)) return;
      // Everything launched below comes from `approval` or from metadata proven identical to what was approved.
      const revalidate = () => {
        this.assertStopped();
        if (this.saved.server !== server || JSON.stringify(server) !== original) {
          throw new Error('Server lineage or launch profile changed during approval; approve again');
        }
      };
      revalidate();
      const eula = await readFile(path.join(approval.serverDir, 'eula.txt'), 'utf8').catch(() => '');
      if (!/^\s*eula\s*=\s*true\s*$/m.test(eula)) {
        throw new Error('Minecraft EULA acceptance is missing in the managed server copy; review and accept it yourself before launching');
      }
      const ledger = this.ledger();
      if ((await ledger.status()).snapshotId !== approval.snapshotId) throw new Error('Snapshot revision mismatch; reconcile metadata before hosting');
      revalidate();
      await ledger.startHosting();
      try {
        revalidate();
        const launched = new ServerProcess({
          executable: approval.profile.executable, args: [...approval.profile.args], cwd: approval.serverDir,
          startTimeoutMs: server.profile.startTimeoutSeconds * 1000, stopTimeoutMs: server.profile.stopTimeoutSeconds * 1000,
        });
        this.process = launched;
        this.controlledProcess = launched;
        launched.on('line', (line: string) => this.log(line));
        launched.on('state', (state: string) => {
          if ((state !== 'offline' && state !== 'failed') || this.process !== launched || this.controlledProcess === launched) return;
          this.unexpectedExit = ledger;
          if (!this.busy) void this.operation('processExit', async () => {}).catch((error) => this.log('Ownership recovery error: ' + String(error)));
        });
        await launched.start();
      } catch (error) {
        await ledger.markUncertain();
        throw error;
      } finally {
        this.controlledProcess = undefined;
      }
    });
  }

  sendCommand(command: string): void {
    if (this.busy) throw new Error('An operation is in progress');
    if (!this.process) throw new Error('Server not running');
    this.process.sendCommand(command);
  }

  async stopServer(): Promise<void> {
    await this.operation('stopServer', async () => {
      const server = this.saved.server;
      if (!server || !this.process?.pid) throw new Error('No owned process is running');
      this.controlledProcess = this.process;
      try {
        await this.process.stop();
        // createSnapshot returns only after objects, the manifest and their directories are flushed,
        // so the ledger never points at a revision that a power cut could lose.
        const snapshot = await createSnapshot(server.serverDir, server.storeDir, server.snapshotId);
        await this.ledger().stopHosting(snapshot.id);
        server.snapshotId = snapshot.id;
        await this.persist();
        this.log('Stopped cleanly and committed final snapshot ' + snapshot.id);
      } catch (error) {
        await this.ledger().markUncertain();
        throw error;
      } finally {
        this.controlledProcess = undefined;
      }
      if (this.saved.relay?.parkOnStop) {
        // The stop itself succeeded; a park failure is reported, not thrown.
        try { await this.park(); }
        catch (error) { this.log(`Could not park on the relay: ${(error as Error).message}`); }
      }
    });
  }

  async createSnapshot(): Promise<void> {
    this.assertStopped();
    await this.operation('createSnapshot', async () => {
      const server = this.saved.server;
      if (!server) throw new Error('No server imported');
      const owner = await this.ledger().status();
      if (owner.state !== 'owned' || owner.owner !== this.identity.fingerprint) throw new Error('Snapshot requires safely held ownership');
      const snapshot = await createSnapshot(server.serverDir, server.storeDir, server.snapshotId);
      await this.ledger().updateSnapshot(snapshot.id);
      server.snapshotId = snapshot.id;
      await this.persist();
      this.log('Verified snapshot ' + snapshot.id);
    });
  }

  async recoverStopped(confirmedStopped: boolean): Promise<void> {
    this.assertStopped();
    if (!confirmedStopped) throw new Error('Confirm all previous server processes are stopped');
    await this.operation('recoverStopped', async () => {
      const server = this.saved.server;
      if (!server) throw new Error('No server imported');
      const ledger = this.ledger(), state = await ledger.status();
      if (state.owner !== this.identity.fingerprint || state.state !== 'uncertain' || state.offer) {
        throw new Error('Cannot recover transferred or pending-offer authority. Reconcile with the peer.');
      }
      const snapshot = await createSnapshot(server.serverDir, server.storeDir, state.snapshotId);
      server.snapshotId = snapshot.id;
      await this.persist();
      await ledger.recoverStopped(true);
      await ledger.updateSnapshot(snapshot.id);
      this.log('Explicit stopped-process recovery completed with verified snapshot ' + snapshot.id + '. No uncertain remote takeover was performed.');
    });
  }

  /**
   * Delete old execution directories, interrupted staging, and revisions older than the current one and its two
   * parents. The current server directory and every revision the ledger references are always kept.
   */
  async cleanUp(): Promise<CleanUpResult> {
    this.assertStopped();
    return this.operation('cleanUp', async () => {
      const server = this.saved.server;
      if (!server) throw new Error('No server imported');
      const ownership = await this.ledger().status();
      if (ownership.state === 'hosting' || ownership.state === 'uncertain') {
        throw new Error('Cleanup is blocked while ownership is uncertain or hosting. Recover or stop first.');
      }
      let serverDirsRemoved = 0;
      const serversDir = path.join(this.root, 'managed', 'servers');
      if (path.dirname(server.serverDir) === serversDir) {
        for (const name of await readdir(serversDir)) {
          const entry = path.join(serversDir, name);
          if (entry === server.serverDir) continue;
          const stat = await lstat(entry);
          if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unexpected entry in managed servers; refusing cleanup: ${name}`);
          await rm(entry, { recursive: true });
          serverDirsRemoved++;
        }
      }
      for (const name of await readdir(server.storeDir)) {
        if (/^\.(?:staging|transfer)-/u.test(name)) await rm(path.join(server.storeDir, name), { recursive: true, force: true });
      }
      const keep = [...new Set([server.snapshotId, ownership.snapshotId, ...(ownership.offer ? [ownership.offer.snapshotId] : [])])];
      const pruned = await pruneStore(server.storeDir, { keep, ancestors: CLEANUP_ANCESTORS });
      this.log(`Cleanup removed ${serverDirsRemoved} old server folder(s), ${pruned.snapshotsRemoved} old revision(s) and ${pruned.objectsRemoved} unused object(s) (${(pruned.bytesFreed / 1024 ** 2).toFixed(1)} MiB of objects).`);
      return { serverDirsRemoved, ...pruned };
    });
  }

  // ---------------------------------------------------------------- settings and peers

  async saveSettings(settings: Settings): Promise<void> {
    await this.operation('saveSettings', async () => {
      this.saved.settings = validateSettings(settings);
      await this.persist();
      if (settings.persistentAddress) this.log('Persistent-address preference saved. Gateway is unconnected; no routing or public availability is established.');
    });
  }

  async addPeer(input: SavedPeer): Promise<void> {
    const peer = validatePeer(input);
    if (peer.fingerprint === this.identity.fingerprint) throw new Error('Cannot trust your own identity as a peer');
    await this.operation('addPeer', async () => {
      this.saved.peers = this.saved.peers.filter((existing) => existing.fingerprint !== peer.fingerprint);
      this.saved.peers.push(peer);
      await this.persist();
      if (this.listener) {
        // Restart so the listener's pin set includes the new peer.
        const port = this.listener.port;
        await this.listener.close();
        this.listener = undefined;
        await this.listen(port);
      }
      this.log('Saved trusted peer ' + peer.name + '. Fingerprint trust does not establish connectivity.');
    });
  }

  /** Choose (or clear) the always-on relay. It must already be a trusted peer, which supplies its endpoint. */
  async saveRelay(input: RelayConfig | null): Promise<void> {
    const relay = validateRelayConfig(input);
    if (relay && !this.saved.peers.some((peer) => peer.fingerprint === relay.fingerprint)) {
      throw new Error('The relay must be a trusted peer first: add its fingerprint and endpoint under Peers.');
    }
    if (relay?.fingerprint === this.identity.fingerprint) throw new Error('This PC cannot be its own relay');
    await this.operation('saveRelay', async () => {
      this.saved.relay = relay;
      await this.persist();
      this.log(relay ? `Relay set to ${this.relayPeer()!.name}${relay.parkOnStop ? '; the server is parked there after each clean stop' : ''}.` : 'Relay cleared.');
    });
  }

  private async listen(port = 0): Promise<void> {
    this.listener = await listenPeer(this.identity, this.saved.peers.map((peer) => peer.fingerprint),
      (socket, source) => { void this.handleIncoming(socket, source); }, { host: '127.0.0.1', port });
  }

  async startPeerListener(): Promise<void> {
    await this.operation('startPeerListener', async () => {
      if (this.listener) throw new Error('Peer listener already active');
      await this.listen();
      this.log('Peer listener is loopback-only for local testing. No public or LAN connectivity is claimed.');
    });
  }

  // ---------------------------------------------------------------- replication and handoff

  async sendSnapshot(fingerprint: string): Promise<unknown> {
    this.assertStopped();
    return this.operation('sendSnapshot', async () => {
      const peer = this.saved.peers.find((entry) => entry.fingerprint === fingerprint), server = this.saved.server;
      if (!peer || !server) throw new Error('Missing peer or imported server');
      if (this.isRelay(peer)) throw new Error('The relay stores the server only through Park; a plain snapshot send is not accepted.');
      const ownership = await this.ledger().status();
      if (ownership.owner !== this.identity.fingerprint || ownership.state !== 'owned') throw new Error('Snapshot send requires safely held ownership');
      const result = await sendSnapshotToPeer(this.identity, peer, server.storeDir, server.snapshotId);
      this.log(`Peer confirmed verified snapshot ${server.snapshotId}; ${result.filesSent} files / ${result.bytesSent} bytes transferred directly. Hosting ownership unchanged.`);
      return result;
    });
  }

  /**
   * Hand hosting to a trusted peer. The first attempt captures a final snapshot and durably fences this device with an
   * offer. If the attempt fails for any reason other than an explicit decline, the same offer can be retried: the
   * recipient re-acknowledges an offer it already committed instead of applying it twice.
   * Handing off to the configured relay is the same as parking on it.
   */
  async handoff(fingerprint: string): Promise<void> {
    this.assertStopped();
    await this.operation('handoff', async () => {
      const peer = this.saved.peers.find((entry) => entry.fingerprint === fingerprint);
      if (!peer) throw new Error('Missing peer or imported server');
      await this.transferOwnership(peer);
    });
  }

  /** Park the stopped server on the always-on relay, so any trusted PC can claim it later, even while this one is off. */
  async parkAtRelay(): Promise<void> {
    this.assertStopped();
    await this.operation('parkAtRelay', () => this.park());
  }

  private async park(): Promise<void> {
    await this.transferOwnership(this.requireRelay());
  }

  private isRelay(peer: SavedPeer): boolean {
    return peer.fingerprint === this.saved.relay?.fingerprint;
  }

  private async reachRelay(relay: SavedPeer, consequence: string): Promise<RelayStatus | null> {
    try { return await relayStatus(this.identity, relay); }
    catch (error) {
      if (/^Relay refused/.test((error as Error).message)) throw error;
      throw new Error(`The relay is unreachable (${(error as Error).message}). ${consequence}`, { cause: error });
    }
  }

  private async transferOwnership(peer: SavedPeer): Promise<void> {
    const server = this.saved.server;
    if (!server) throw new Error('Missing peer or imported server');
    const relay = this.isRelay(peer);
    const target = relay ? 'the relay' : 'the recipient';
    const ledger = this.ledger(), state = await ledger.status();
    let offer: TransferOffer;
    if (state.state === 'offered' && state.owner === this.identity.fingerprint && state.offer) {
      if (state.offer.target !== peer.fingerprint) {
        throw new Error(`A handoff is pending to another peer (${this.nameOf(state.offer.target) ?? 'unknown'}). Retry that peer; a pending offer cannot be redirected.`);
      }
      offer = state.offer;
      this.log(`Retrying the pending handoff of ${offer.snapshotId} to ${target}. This PC stays fenced until it answers.`);
    } else {
      if (state.state !== 'owned' || state.owner !== this.identity.fingerprint) throw new Error('Handoff requires safely held ownership');
      // Fencing is only worth it if the relay can actually take the server right now.
      if (relay) await this.reachRelay(peer, 'The server stays on this PC; nothing was changed.');
      const snapshot = await createSnapshot(server.serverDir, server.storeDir, server.snapshotId);
      await ledger.updateSnapshot(snapshot.id);
      server.snapshotId = snapshot.id;
      await this.persist();
      offer = await ledger.prepareTransfer(peer.fingerprint, snapshot.id);
      this.log(`Source fenced before offering ownership to ${target}. A failed or unanswered attempt keeps it fenced until a retry succeeds or ${target} declines.`);
    }
    let result: Awaited<ReturnType<typeof sendSnapshotToPeer>>;
    try {
      result = await sendSnapshotToPeer(this.identity, peer, server.storeDir, offer.snapshotId, offer,
        relay ? { preface: relayRequest('park') } : {});
    } catch (error) {
      const action = relay ? 'Park on the relay again' : 'Retry the handoff to the same peer';
      throw new Error(`Handoff did not complete (${(error as Error).message}). This PC stays fenced because ${target} may have accepted. ${action}; it will not be applied twice.`, { cause: error });
    }
    if (!result.ownershipAccepted) {
      // A pinned acknowledgment with ownershipAccepted:false is sent only when the recipient committed nothing.
      await ledger.cancelTransfer(offer.id, peer.fingerprint);
      if (relay) {
        const status = await relayStatus(this.identity, peer).catch(() => null);
        const holder = status ? ` It holds generation ${status.generation}${status.ownerName ? `, checked out by ${status.ownerName}` : ''}.` : '';
        this.log('The relay declined the server. Ownership was restored on this PC.');
        throw new Error(`The relay declined the server: this PC's copy is not the newest it has seen.${holder} Ownership was restored on this PC.`);
      }
      this.log('Recipient declined the handoff. Ownership was restored on this PC.');
      throw new Error('Recipient declined the handoff. Ownership was restored on this PC; you can host or offer again.');
    }
    await ledger.confirmTransfer(offer.id, peer.fingerprint);
    this.log(relay
      ? `Parked ${offer.snapshotId} on the relay. Any trusted PC can claim it, even while this one is off.`
      : 'Recipient confirmed verified revision and ownership. Hosting is now blocked on this device.');
  }

  /**
   * Take the server from the relay. Clicking Claim is the consent, so no second dialog is shown. A claim whose
   * acknowledgment is lost is completed by claiming again; the relay keeps it pending for this PC only.
   */
  async claimFromRelay(): Promise<void> {
    this.assertStopped();
    const relay = this.requireRelay();
    await this.operation('claimFromRelay', async (token) => {
      const me = this.identity.fingerprint;
      const status = await this.reachRelay(relay, 'Nothing was changed.');
      if (!status) throw new Error('The relay holds no server yet. Park one on it from the PC that has it.');
      if (status.state === 'transferred') {
        if (status.owner === me) throw new Error('This PC already holds the server; there is nothing to claim.');
        throw new Error(`The server is checked out by ${status.ownerName ?? 'another PC'}. That PC must park it on the relay before another PC can claim it.`);
      }
      if (status.state === 'offered' && status.pendingTarget !== me) {
        throw new Error(`The server is pending checkout to ${status.pendingName ?? 'another PC'}; that PC must retry its claim first.`);
      }
      const socket = await openRelayOperation(this.identity, relay, 'claim');
      let activation: Promise<boolean> | undefined;
      let accepted = false;
      try {
        await receiveSnapshot(socket, relay.fingerprint, path.join(this.root, 'managed', 'store'), async (snapshot, source, offer) => {
          accepted = await this.considerIncoming(socket, token, snapshot, source, offer, (pending) => { activation = pending; }, { approved: true });
          return accepted;
        });
      } catch (error) {
        throw new Error(`Claim did not complete (${(error as Error).message}). If this PC accepted, it holds the server now; the relay keeps the claim pending for this PC only. Retry the claim to finish it; it is never applied twice.`, { cause: error });
      } finally {
        await activation?.catch((error) => this.log('Claim activation failed: ' + String(error)));
        socket.destroy();
      }
      if (!accepted) throw new Error('The relay sent no ownership offer; nothing changed.');
      this.log('Claimed the server from the relay. Configure this PC\'s launch profile and approve executable/mod trust before starting.');
    });
  }

  /** What the relay currently holds and who has it checked out. Read-only. */
  async checkRelay(): Promise<RelayStatus | null> {
    return this.reachRelay(this.requireRelay(), 'Nothing was changed.');
  }

  private async handleIncoming(socket: TLSSocket, source: string): Promise<void> {
    try {
      await this.operation('receiveSnapshot', async (token) => {
        let activation: Promise<boolean> | undefined;
        try {
          await receiveSnapshot(socket, source, path.join(this.root, 'managed', 'store'),
            (snapshot, authenticatedSource, offer) => this.considerIncoming(socket, token, snapshot, authenticatedSource, offer,
              (pending) => { activation = pending; }));
        } finally {
          // Drain only activation, not a potentially abandoned native dialog, before releasing the operation.
          await activation?.catch((error) => this.log('Incoming activation failed: ' + String(error)));
        }
      });
    } catch (error) {
      this.log('Peer receive failed: ' + String(error));
    } finally {
      socket.destroy();
    }
  }

  /**
   * Decide on a verified incoming snapshot. Returning false is a definitive decline (nothing was committed);
   * throwing leaves the sender fenced because authority may or may not have committed.
   * `approved` means the user already consented by starting this transfer (a relay claim).
   */
  private async considerIncoming(socket: TLSSocket, token: symbol, snapshot: SnapshotManifest, authenticatedSource: string,
    offer: TransferOffer | undefined, track: (activation: Promise<boolean>) => void, { approved = false } = {}): Promise<boolean> {
    this.log('Received verified snapshot ' + snapshot.id + ' from ' + (this.nameOf(authenticatedSource) ?? authenticatedSource) + '. Replication alone does not grant hosting ownership.');
    if (!offer) return false;
    const previous = this.saved.server, original = JSON.stringify(this.saved.server);
    let originalAuthority: string | undefined;
    if (previous) {
      const ledger = this.ledger();
      if (offer.target === this.identity.fingerprint && await ledger.hasAccepted(offer.id)) {
        this.log('Re-acknowledged handoff ' + offer.id + ', which this PC already accepted.');
        return true;
      }
      const state = await ledger.status();
      this.assertStopped();
      originalAuthority = JSON.stringify(state);
      if (!canAcceptOffer(state, offer, authenticatedSource, this.identity.fingerprint)) {
        throw new Error('Incoming ownership conflicts with this server. Verified replica retained without activation.');
      }
    }
    this.assertStopped();
    const revalidate = (expected: SavedServer | null = previous, metadata: string = original) => {
      try {
        if (this.operationToken !== token || socket.destroyed || socket.readableEnded || socket.writableEnded) throw new Error('Incoming session or operation has ended');
        this.assertStopped();
        if (this.saved.server !== expected || JSON.stringify(this.saved.server) !== metadata) throw new Error('Incoming server lineage changed during approval');
      } catch (error) {
        this.log('Incoming handoff activation refused: ' + String(error));
        throw error;
      }
    };
    if (!approved && (!this.options.confirmIncomingHandoff || !await this.options.confirmIncomingHandoff(authenticatedSource, snapshot, offer))) return false;
    revalidate();
    if (previous) {
      const current = await this.ledger().status();
      revalidate();
      if (JSON.stringify(current) !== originalAuthority) throw new Error('Incoming ownership changed during approval');
    }
    const storeDir = path.join(this.root, 'managed', 'store');
    const serverDir = path.join(this.root, 'managed', 'servers', randomUUID());
    await materializeSnapshot(storeDir, snapshot.id, serverDir);
    revalidate();
    const ledgerFile = previous?.ledgerFile ?? path.join(this.root, `ownership-${randomUUID()}.sqlite`);
    const profile = previous ? { ...previous.profile, args: [...previous.profile.args] } : validateLaunchProfile({ executable: '', args: [] }, true);
    const candidate: SavedServer = { name: previous?.name ?? 'Received server', serverDir, storeDir, snapshotId: snapshot.id, profile, ledgerFile };
    const activation = (async () => {
      let authorityAttempted = false;
      this.saved.server = candidate;
      const candidateMetadata = JSON.stringify(candidate);
      try {
        // Record the candidate before authority. Missing/mismatched ledgers fail closed on restart.
        await this.persist();
        revalidate(candidate, candidateMetadata);
        if (previous) {
          const current = await new OwnershipLedger(ledgerFile, this.identity.fingerprint).status();
          revalidate(candidate, candidateMetadata);
          if (JSON.stringify(current) !== originalAuthority) throw new Error('Incoming ownership changed before activation');
        }
        authorityAttempted = true;
        await new OwnershipLedger(ledgerFile, this.identity.fingerprint).acceptTransfer(offer, authenticatedSource, snapshot.id);
        // Once authority may have committed, a lost acknowledgment must never roll it back.
        this.log('Accepted ownership of ' + snapshot.id + '. Previous server files retained. Configure a local launch profile and approve executable/mod trust before starting.');
        return true;
      } catch (error) {
        if (!authorityAttempted) { this.saved.server = previous; await this.persist(); }
        else this.log('Ownership acceptance may have committed; candidate retained for explicit reconciliation.');
        throw error;
      }
    })();
    track(activation);
    return activation;
  }

  async close(): Promise<void> {
    if (this.busy) throw new Error('An operation is in progress; wait before closing');
    if (this.process?.pid) await this.stopServer();
    if (this.listener) { await this.listener.close(); this.listener = undefined; }
  }
}
