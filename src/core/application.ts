import { mkdir, mkdtemp, readFile, readdir, lstat, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { defaultSettings, validateSettings, type Settings } from './settings.js';
import { importServer, createSnapshot, materializeSnapshot, readSnapshot, pruneStore, syncDirectory, type SnapshotManifest } from './snapshots.js';
import { ServerProcess } from './launcher.js';
import { OwnershipLedger, canAcceptOffer, type TransferOffer } from './ownership.js';
import { receiveSnapshot, sendSnapshotToPeer } from './transfers.js';
import { listenPeer, type PeerIdentity } from './peer-transport.js';
import { addMods, exportClientPack, modsDirectory, ordinaryDirectory, removeMod, type ModKind } from './mods.js';
import { ModrinthClient, assertModTarget, isGameVersion, isModLoader } from './modrinth.js';
import { indexedMods, modTarget, readModIndex, writeModIndex, type ModVerificationCache } from './mod-index.js';
import { installMod, assertModInstallComplete, type InstallModInput } from './mod-install.js';
import { openRelayOperation, relayRequest, relayStatus, relayInvite, relayFriends, joinRelayInvite, type RelayStatus } from './relay-client.js';
import { decodeInvite } from './invites.js';
import { friendName } from './relay-friends-store.js';
import { readOnboarding, saveOnboarding, validateOnboarding } from './onboarding.js';
import { ServerSetupClient, probeJava, type CreateServerInput } from './server-setup.js';
import { readGameGateway, saveGameGatewayConfig, validateGameGateway } from './game-gateway-config.js';
import { gatewayStatus, startHostGameGateway } from './game-gateway.js';
import { privateLanAddresses, readServerPort } from './network-info.js';
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
  serverSetup?: ServerSetupClient;
  modrinth?: ModrinthClient;
  confirmIncomingHandoff?: (source: string, snapshot: SnapshotManifest, offer: TransferOffer) => Promise<boolean>;
}

/** Revisions kept by cleanup: the current one plus this many ancestors. */
const CLEANUP_ANCESTORS = 2;

export class SeedHostApplication {
  private saved: SavedState = { version: 1, settings: defaultSettings(), server: null, peers: [], relay: null };
  private gatewayTunnel?: { close: () => Promise<void> };
  private gatewayEpoch = 0;
  private gatewayState: {state: 'off' | 'connecting' | 'ready' | 'error'; detail: string} = { state: 'off', detail: 'No local host tunnel is active' };
  private logs: string[] = [];
  private modVerificationCache: ModVerificationCache = new Map();
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
      const serverDir = this.saved.server.serverDir;
      // Optional catalogue state must never block lifecycle/ownership state or graceful shutdown.
      let mods: { server: Awaited<ReturnType<typeof indexedMods>>; client: Awaited<ReturnType<typeof indexedMods>> } = { server: [], client: [] };
      let target: Awaited<ReturnType<typeof modTarget>> = { loader: null, gameVersion: null, detected: true };
      let modsError: string | null = null;
      let modInstallError: string | null = null;
      try { await assertModInstallComplete(serverDir); }
      catch (error) { modInstallError = String((error as Error).message); }
      try {
        if (modInstallError) throw new Error(modInstallError);
        // Empty directories are not represented in snapshots. Restore only when owned.
        if (ownership.state === 'owned' && ownership.owner === this.identity.fingerprint && !this.process?.pid && !this.busy) await ordinaryDirectory(modsDirectory(serverDir, 'server'), true);
        const index = await readModIndex(serverDir);
        mods = { server: await indexedMods(serverDir, 'server', index, this.modVerificationCache), client: await indexedMods(serverDir, 'client', index, this.modVerificationCache) };
        target = await modTarget(serverDir, index);
      } catch (error) {
        modsError = `Mod information unavailable; repair the managed mod index/folders before changing mods. ${String((error as Error).message).slice(0, 240)}`;
      }
      server = { ...this.saved.server, profile: { ...this.saved.server.profile, args: [...this.saved.server.profile.args] },
        state: this.process?.state ?? 'offline', ownership, ownerName: this.nameOf(ownership.owner), mods, modsError, modInstallError, modTarget: target,
        playerPort: await readServerPort(serverDir) };
    }
    const relay = this.saved.relay;
    const gateway = await readGameGateway(this.root);
    if (gateway.error && this.gatewayTunnel) await this.closeGameGateway();
    return {
      version: '0.3.0',
      deviceId: this.identity.fingerprint,
      settings: { ...this.saved.settings },
      server,
      relay: relay ? { ...relay, name: this.relayPeer()?.name ?? 'Relay' } : null,
      peers: this.saved.peers.map((peer) => ({ ...peer })),
      logs: [...this.logs],
      peerEndpoint: this.listener ? { host: this.listener.host, port: this.listener.port } : null,
      busy: this.busy,
      onboarding: await readOnboarding(this.root, Boolean(this.saved.server)),
      gateway: { ...gateway, ...this.gatewayState, ...(gateway.error ? {state: 'error', detail: gateway.error} : {}) },
      lanAddresses: privateLanAddresses(),
    };
  }

  private assertStopped(): void {
    if (this.process?.pid || this.process?.state === 'starting' || this.process?.state === 'stopping') {
      throw new Error('Stop the server before this operation');
    }
  }

  async saveOnboarding(input: unknown): Promise<void> {
    await this.operation('saveOnboarding', async () => {
      const progress = validateOnboarding(input);
      if (progress.completed && (!this.saved.server?.profile.executable || !this.saved.server.profile.args.length)) throw new Error('Configure a server and its launch profile before completing setup');
      await saveOnboarding(this.root, progress);
    });
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

  async createServer(input: CreateServerInput): Promise<void> {
    this.assertStopped();
    if (!input || input.eulaAccepted !== true) throw new Error('Explicit Minecraft EULA acceptance is required before creating a server');
    input = { ...input }; // Capture consent before the lock's first asynchronous fence.
    await this.operation('createServer', async () => {
      if (this.saved.server) throw new Error('A server is already imported; its lineage cannot be replaced');
      const staging = await mkdtemp(path.join(this.root, 'server-setup-'));
      const prepared = await (this.options.serverSetup ?? new ServerSetupClient()).prepare(staging, input);
      if (prepared.loader === 'fabric') {
        const index = await readModIndex(prepared.sourceDir);
        await writeModIndex(prepared.sourceDir, { ...index, target: { loader: 'fabric', gameVersion: prepared.gameVersion } });
      }
      const result = await importServer(prepared.sourceDir, path.join(this.root, 'managed'));
      const ledgerFile = path.join(this.root, `ownership-${randomUUID()}.sqlite`);
      await new OwnershipLedger(ledgerFile, this.identity.fingerprint).initialize(result.snapshot.id);
      this.saved.server = {
        name: input.name, serverDir: result.serverDir, storeDir: result.storeDir, snapshotId: result.snapshot.id,
        profile: validateLaunchProfile(prepared.profile), ledgerFile,
      };
      try { await this.persist(); }
      catch (error) { await new OwnershipLedger(ledgerFile, this.identity.fingerprint).markUncertain(); throw error; }
      await rm(staging, { recursive: true, force: true });
      this.log('Created a verified managed server. Nothing was started.');
    });
  }

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

  async configureSimpleProfile(input: { javaExecutable: string; memoryMiB: number }): Promise<void> {
    this.assertStopped();
    if (!input || Object.keys(input).sort().join(',') !== 'javaExecutable,memoryMiB' || !Number.isInteger(input.memoryMiB) || input.memoryMiB < 512 || input.memoryMiB > 65536) throw new Error('Invalid simple launch profile');
    input = { ...input };
    await this.operation('configureSimpleProfile', async () => {
      const server = this.saved.server;
      if (!server) throw new Error('No server imported');
      await probeJava(input.javaExecutable);
      let args = [...server.profile.args];
      if (!args.length) {
        const entries = await readdir(server.serverDir, { withFileTypes: true });
        if (entries.some(e => e.isFile() && /\.(?:sh|bat|cmd|ps1)$/i.test(e.name))) throw new Error('Use advanced Launch profile for a scripted server');
        const candidates = entries.filter(e => e.isFile() && /^(?:server|minecraft_server[._][\w.+-]+|fabric-server-launch)\.jar$/i.test(e.name));
        const allJars = entries.filter(e => e.isFile() && /\.jar$/i.test(e.name));
        // A Fabric layout deliberately contains its Vanilla dependency beside its launcher.
        const fabric = candidates.find(e => e.name === 'fabric-server-launch.jar');
        const jar = fabric && allJars.every(e => e.name === 'server.jar' || e.name === fabric.name) ? fabric.name : allJars.length === 1 && candidates.length === 1 ? candidates[0]!.name : undefined;
        if (!jar) throw new Error('Use advanced Launch profile: no unambiguous server JAR command was found');
        args = ['-jar', jar, 'nogui'];
      }
      // JVM argument files may override later command-line heap flags; never claim a RAM change we cannot prove.
      for (const arg of args.filter(a => a.startsWith('@'))) {
        const filename = path.resolve(server.serverDir, arg.slice(1));
        if (!filename.startsWith(server.serverDir + path.sep)) throw new Error('Use advanced Launch profile for external argument files');
        let handle;
        try {
          const stat = await lstat(filename);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Use advanced Launch profile for unsafe argument files');
          handle = await open(filename, 'r');
          const buffer = Buffer.alloc(65537); const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 65536 || /-Xm[sx]|@[\w./\\]/.test(buffer.subarray(0, bytesRead).toString('utf8'))) throw new Error('Use advanced Launch profile: RAM is controlled by an argument file');
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        finally { await handle?.close(); }
      }
      args = args.filter(arg => !/^-Xm[sx]/.test(arg));
      const profile = validateLaunchProfile({ ...server.profile, executable: input.javaExecutable, args: ['-Xms512M', `-Xmx${input.memoryMiB}M`, ...args] });
      const previous = server.profile;
      server.profile = profile;
      try { await this.persist(); } catch (error) { server.profile = previous; throw error; }
    });
  }

  async saveGameGateway(input: unknown): Promise<void> {
    this.assertStopped();
    const config = validateGameGateway(input);
    await this.operation('saveGameGateway', async () => {
      if (config.enabled) this.requireRelay();
      await this.closeGameGateway();
      await saveGameGatewayConfig(this.root, config);
    });
  }

  private async closeGameGateway(): Promise<void> {
    this.gatewayEpoch++;
    const tunnel = this.gatewayTunnel;
    this.gatewayTunnel = undefined;
    this.gatewayState = { state: 'off', detail: 'No local host tunnel is active' };
    try { await tunnel?.close(); } catch (error) { this.log('Gateway cleanup error: ' + String(error)); }
  }

  private async startGameGateway(): Promise<void> {
    const config = await readGameGateway(this.root);
    if (config.error) { this.gatewayState = { state: 'error', detail: config.error }; return; }
    if (!config.enabled) return;
    const epoch = this.gatewayEpoch;
    try {
      const ownership = await this.ledger().status();
      if (this.process?.state !== 'running' || ownership.owner !== this.identity.fingerprint || ownership.state !== 'hosting' || !ownership.lineage) throw new Error('Gateway requires the running local owner');
      const relay = this.requireRelay();
      const custody = await relayStatus(this.identity, relay);
      if (!custody || custody.owner !== this.identity.fingerprint || custody.state !== 'transferred' || custody.pendingTarget !== null || custody.generation !== ownership.generation) throw new Error('Park and Claim once to establish confirmed relay custody before forwarding');
      const tunnel = await startHostGameGateway(this.identity, relay, config.localPort, {
        expectedRoute: { generation: ownership.generation, lineage: ownership.lineage },
        onStatus: status => { if (epoch === this.gatewayEpoch) this.gatewayState = status; },
      });
      if (epoch !== this.gatewayEpoch || this.process?.state !== 'running') await tunnel.close();
      else this.gatewayTunnel = tunnel;
    } catch (error) {
      if (epoch === this.gatewayEpoch) this.gatewayState = { state: 'error', detail: String((error as Error).message).slice(0, 512) };
      this.log('Player gateway unavailable; local server remains running. ' + String((error as Error).message));
    }
  }

  async checkGameGateway() {
    const config = await readGameGateway(this.root);
    if (config.error || !this.relayPeer()) return { enabled: false, host: null, port: null, ready: false, detail: config.error ?? 'No relay is configured' };
    try { return await gatewayStatus(this.identity, this.requireRelay()); }
    catch (error) { return { enabled: false, host: null, port: null, ready: false, detail: String((error as Error).message).slice(0, 512) }; }
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
      await assertModInstallComplete(server.serverDir);
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
      await assertModInstallComplete(server.serverDir);
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
          void this.closeGameGateway();
          this.unexpectedExit = ledger;
          if (!this.busy) void this.operation('processExit', async () => {}).catch((error) => this.log('Ownership recovery error: ' + String(error)));
        });
        await launched.start();
        await this.startGameGateway();
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
      await this.closeGameGateway();
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
      await assertModInstallComplete(server.serverDir);
      const snapshot = await createSnapshot(server.serverDir, server.storeDir, server.snapshotId);
      await this.ledger().updateSnapshot(snapshot.id);
      server.snapshotId = snapshot.id;
      await this.persist();
      this.log('Verified snapshot ' + snapshot.id);
    });
  }

  async listSnapshots(): Promise<Array<{ id: string; parentId: string | null; fileCount: number; bytes: number; current: boolean }>> {
    const server = this.saved.server;
    if (!server) return [];
    const rows: Array<{ id: string; parentId: string | null; fileCount: number; bytes: number; current: boolean }> = [];
    const seen = new Set<string>();
    let id: string | null = server.snapshotId;
    while (id && rows.length < 1000) {
      if (seen.has(id)) throw new Error('Snapshot history contains a cycle');
      seen.add(id);
      let manifest: SnapshotManifest;
      try { manifest = await readSnapshot(server.storeDir, id); }
      catch (error) { if (rows.length && (error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
      rows.push({ id, parentId: manifest.parentId, fileCount: manifest.files.length,
        bytes: manifest.files.reduce((sum, file) => sum + file.size, 0), current: id === server.snapshotId });
      id = manifest.parentId;
    }
    return rows;
  }

  async restoreSnapshot(snapshotId: string): Promise<void> {
    this.assertStopped();
    if (typeof snapshotId !== 'string' || !/^[a-f0-9]{64}$/.test(snapshotId)) throw new Error('Invalid snapshot revision');
    await this.operation('restoreSnapshot', async () => {
      const server = this.saved.server;
      if (!server) throw new Error('No server imported');
      const ledger = this.ledger(), ownership = await ledger.status();
      if (ownership.state !== 'owned' || ownership.owner !== this.identity.fingerprint || ownership.offer) throw new Error('Restore requires stopped, safely held ownership');
      if (ownership.snapshotId !== server.snapshotId) throw new Error('Snapshot revision mismatch; reconcile metadata before restoring');
      await assertModInstallComplete(server.serverDir);
      if (!(await this.listSnapshots()).some((row) => row.id === snapshotId)) throw new Error('Choose a retained revision from this server’s history');
      const serverDir = path.join(this.root, 'managed', 'servers', randomUUID());
      await materializeSnapshot(server.storeDir, snapshotId, serverDir);
      await assertModInstallComplete(serverDir);
      // Restored data is a NEW revision descending from a verified safety copy, not an authority rewind.
      const safety = await createSnapshot(server.serverDir, server.storeDir, server.snapshotId);
      const restored = await createSnapshot(serverDir, server.storeDir, safety.id);
      const current = await ledger.status();
      if (JSON.stringify(current) !== JSON.stringify(ownership)) throw new Error('Ownership changed while preparing restore; nothing activated');
      this.assertStopped();
      await assertModInstallComplete(server.serverDir);
      let authorityAttempted = false;
      try {
        authorityAttempted = true;
        await ledger.updateSnapshot(safety.id);
        server.snapshotId = safety.id;
        await this.persist();
        await ledger.updateSnapshot(restored.id);
        this.saved.server = { ...server, serverDir, snapshotId: restored.id };
        await this.persist();
        this.modVerificationCache.clear();
        this.log('Restored world into a separate folder. Previous world and safety revision retained: ' + safety.id);
      } catch (error) {
        if (authorityAttempted) await ledger.markUncertain();
        throw error;
      }
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
      await assertModInstallComplete(server.serverDir);
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

  // ---------------------------------------------------------------- mods

  async searchMods(input: { query: string; offset: number }) {
    const server = this.saved.server;
    if (!server) throw new Error('No server imported');
    const index = await readModIndex(server.serverDir);
    const target = await modTarget(server.serverDir, index);
    assertModTarget(target);
    const page = await (this.options.modrinth ?? new ModrinthClient()).search(input.query, input.offset, target);
    const mods = [...await indexedMods(server.serverDir, 'server', index), ...await indexedMods(server.serverDir, 'client', index)];
    const installed = new Set(mods.flatMap((mod) => mod.source ? [mod.source.projectId] : []));
    return { ...page, hits: page.hits.map((hit) => ({ ...hit, installed: installed.has(hit.projectId) })) };
  }

  async saveModTarget(input: { loader: string; gameVersion: string }): Promise<void> {
    this.assertStopped();
    if (!input || !isModLoader(input.loader)) throw new Error('Invalid mod loader');
    if (!isGameVersion(input.gameVersion)) throw new Error('Invalid Minecraft version');
    const target = { loader: input.loader, gameVersion: input.gameVersion };
    await this.operation('saveModTarget', async () => {
      const server = await this.requireEditableServer();
      const index = await readModIndex(server.serverDir);
      await writeModIndex(server.serverDir, { ...index, target });
    });
  }

  async installMod(input: InstallModInput) {
    this.assertStopped();
    return this.operation('installMod', async () => {
      const server = await this.requireEditableServer();
      const result = await installMod(server.serverDir, path.join(this.root, 'mod-downloads'), this.options.modrinth ?? new ModrinthClient(), input);
      if (result.installed.length) this.log(`Installed ${result.installed.length} verified Modrinth mod(s), including required dependencies. They travel with the next snapshot.`);
      return result;
    });
  }

  /** Mods change the world's files, so they follow the same rule as snapshots: stopped, and owned by this PC. */
  private async requireEditableServer(): Promise<SavedServer> {
    const server = this.saved.server;
    if (!server) throw new Error('No server imported');
    const ownership = await this.ledger().status();
    if (ownership.state !== 'owned' || ownership.owner !== this.identity.fingerprint) {
      throw new Error('Mods can only change while this PC safely holds ownership of the stopped server');
    }
    // Fail closed for mod mutations, but never make optional metadata a lifecycle dependency.
    await assertModInstallComplete(server.serverDir);
    await readModIndex(server.serverDir);
    await ordinaryDirectory(modsDirectory(server.serverDir, 'server'), false);
    await ordinaryDirectory(modsDirectory(server.serverDir, 'client'), false);
    return server;
  }

  /** Server mods go into mods/; client mods go into the client pack, which the server never loads. */
  async addMods(kind: ModKind, files: string[]): Promise<string[]> {
    this.assertStopped();
    return this.operation('addMods', async () => {
      const server = await this.requireEditableServer();
      const added = await addMods(server.serverDir, kind, files);
      this.log(`Added ${added.length} ${kind} mod(s): ${added.join(', ')}. ${kind === 'server' ? 'They load on the next start.' : 'Export the client pack to share them with players.'}`);
      return added;
    });
  }

  async removeMod(kind: ModKind, name: string): Promise<void> {
    this.assertStopped();
    await this.operation('removeMod', async () => {
      const server = await this.requireEditableServer();
      const index = await readModIndex(server.serverDir);
      await removeMod(server.serverDir, kind, name);
      if (index.mods.some((mod) => mod.kind === kind && mod.name === name)) await writeModIndex(server.serverDir, { ...index, mods: index.mods.filter((mod) => mod.kind !== kind || mod.name !== name) });
      this.log(`Removed ${kind} mod ${name}. Earlier snapshots still contain it.`);
    });
  }

  /** Read-only, so it is allowed while hosting and on any PC that has the files. */
  async exportClientPack(destination: string): Promise<{ mods: number; bytes: number }> {
    return this.operation('exportClientPack', async () => {
      const server = this.saved.server;
      if (!server) throw new Error('No server imported');
      await assertModInstallComplete(server.serverDir);
      await readModIndex(server.serverDir);
      const result = await exportClientPack(server.serverDir, destination);
      this.log(`Exported ${result.mods} client mod(s) to ${destination}.`);
      return result;
    });
  }

  // ---------------------------------------------------------------- friends

  async createInvite() {
    return this.operation('createInvite', () => relayInvite(this.identity, this.requireRelay()));
  }

  /** A private invitation pins the relay, enrolls this identity, then saves its endpoint locally. */
  async joinWithInvite({ code, name }: { code: string; name: string }): Promise<{ relayName: string }> {
    this.assertStopped();
    const invite = decodeInvite(code);
    const memberName = friendName(name);
    if (invite.relayFingerprint === this.identity.fingerprint) throw new Error('Cannot join your own relay');
    return this.operation('joinWithInvite', async () => {
      if (this.saved.relay && this.saved.relay.fingerprint !== invite.relayFingerprint) {
        throw new Error('This PC already uses another relay. Clear it explicitly in Settings before joining a different relay.');
      }
      const joined = await joinRelayInvite(this.identity, code, memberName);
      const peer = validatePeer({ name: joined.relayName, fingerprint: invite.relayFingerprint, host: invite.host, port: invite.port });
      const previousPeers = this.saved.peers;
      const previousRelay = this.saved.relay;
      this.saved.peers = [...previousPeers.filter(p => p.fingerprint !== peer.fingerprint), peer];
      this.saved.relay = { fingerprint: peer.fingerprint, parkOnStop: true };
      try { await this.persist(); }
      catch (error) {
        this.saved.peers = previousPeers;
        this.saved.relay = previousRelay;
        throw new Error('The relay enrolled this PC, but its local settings could not be saved. Retry the same invite on this PC.', { cause: error });
      }
      this.log(`Joined ${joined.relayName} as ${memberName}. Nothing was downloaded or started.`);
      return joined;
    });
  }

  async listFriends() {
    // Only the relay can report custody for its lineage; a local world may be unrelated.
    return relayFriends(this.identity, this.requireRelay());
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
      await this.closeGameGateway();
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
      await this.closeGameGateway();
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
      await assertModInstallComplete(server.serverDir);
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
    await this.closeGameGateway();
    if (this.process?.pid) await this.stopServer();
    if (this.listener) { await this.listener.close(); this.listener = undefined; }
  }
}
