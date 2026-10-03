import { createHash, createPrivateKey, randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';
import { createIdentity, listenPeer, readFrame, writeFrame, type PeerIdentity } from './peer-transport.js';
import { OwnershipLedger, canAcceptOffer } from './ownership.js';
import { receiveSnapshot, sendSnapshot } from './transfers.js';
import { pruneStore, syncDirectory } from './snapshots.js';
import { RELAY_PROTOCOL_VERSION, type RelayCustody } from './relay-client.js';

export interface RelayOptions {
  /** Received revisions to keep (the held revision is always kept). Default 10. */
  keepRevisions?: number;
  log?: (line: string) => void;
}
interface TrustedHost { name: string; fingerprint: string }
interface RelayConfig { version: 1; trusted: TrustedHost[]; history: string[] }

const DEFAULT_PORT = 47625;
const REQUEST_TIMEOUT_MS = 5000;

/**
 * An always-on custodian for one server lineage. Hosts park the server here (a normal handoff with the relay as
 * the target), and any trusted host can later claim it (a normal handoff from the relay), so the PCs that run the
 * server never need to be online at the same time. The relay never runs Minecraft and never materializes a world.
 */
export class RelayNode {
  private config: RelayConfig = { version: 1, trusted: [], history: [] };
  private listener?: { host: string; port: number; close: () => Promise<void> };
  /** Park and claim run one at a time, in arrival order. Status reads never wait. */
  private queue: Promise<void> = Promise.resolve();
  private readonly keepRevisions: number;
  private readonly log: (line: string) => void;

  constructor(readonly root: string, readonly identity: PeerIdentity, options: RelayOptions = {}) {
    this.keepRevisions = options.keepRevisions ?? 10;
    if (!Number.isInteger(this.keepRevisions) || this.keepRevisions < 1) throw new RangeError('keepRevisions must be a positive integer');
    this.log = options.log ?? ((line) => console.log(line));
  }

  get endpoint(): { host: string; port: number } | undefined {
    return this.listener && { host: this.listener.host, port: this.listener.port };
  }
  get trusted(): TrustedHost[] { return this.config.trusted.map((host) => ({ ...host })); }
  private get store(): string { return path.join(this.root, 'store'); }
  private ledger(): OwnershipLedger { return new OwnershipLedger(path.join(this.root, 'ownership.sqlite'), this.identity.fingerprint); }

  async open(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    let text: string | undefined;
    try { text = await readFile(path.join(this.root, 'relay.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (text === undefined) return;
    const value = JSON.parse(text) as RelayConfig;
    if (value?.version !== 1 || !Array.isArray(value.trusted) || !Array.isArray(value.history) ||
        value.trusted.some((host) => typeof host?.name !== 'string' || !/^[a-f0-9]{64}$/.test(host.fingerprint)) ||
        value.history.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) {
      throw new Error('Invalid relay.json; it was left unchanged');
    }
    this.config = value;
  }

  private async persist(): Promise<void> {
    const file = path.join(this.root, 'relay.json'), temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(this.config)); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, file); } finally { await rm(temporary, { force: true }); }
    await syncDirectory(this.root);
  }

  async trust(name: string, fingerprint: string): Promise<void> {
    if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('Trusted host name must be 1–100 characters');
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Fingerprint must be exactly 64 lowercase SHA256 hex digits');
    if (fingerprint === this.identity.fingerprint) throw new Error('The relay cannot trust its own identity');
    this.config.trusted = [...this.config.trusted.filter((host) => host.fingerprint !== fingerprint), { name: name.trim(), fingerprint }];
    await this.persist();
    if (this.listener) { const { host, port } = this.listener; await this.listener.close(); this.listener = undefined; await this.listen({ host, port }); }
  }

  /** Loopback by default. Binding a LAN address is an explicit choice of the person running the relay. */
  async listen({ host = '127.0.0.1', port = 0 }: { host?: string; port?: number } = {}): Promise<void> {
    if (this.listener) throw new Error('Relay is already listening');
    this.listener = await listenPeer(this.identity, this.config.trusted.map((entry) => entry.fingerprint),
      (socket, source) => { void this.handle(socket, source); }, { host, port });
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
    try {
      const request = await readFrame(socket, 4096, REQUEST_TIMEOUT_MS) as Record<string, unknown>;
      if (!request || request.type !== 'relay' || request.version !== RELAY_PROTOCOL_VERSION || !['status', 'park', 'claim'].includes(request.op as string) ||
          Object.keys(request).length !== 3) {
        throw new Error('Unsupported relay request; both ends must run the same PeerHost alpha');
      }
      if (request.op === 'status') {
        const custody = await this.custody();
        await writeFrame(socket, { type: 'relay-status', custody,
          ownerName: this.nameOf(custody?.owner ?? null), pendingName: this.nameOf(custody?.pendingTarget ?? null) });
        socket.end();
        return;
      }
      const run = this.queue.then(() => request.op === 'park' ? this.receivePark(socket, source, who) : this.serveClaim(socket, source, who));
      this.queue = run.catch(() => {});
      await run;
    } catch (error) {
      this.log(`Relay ${who}: ${(error as Error).message}`);
      if (!socket.destroyed) await writeFrame(socket, { type: 'error', message: (error as Error).message.slice(0, 512) }).catch(() => {});
    } finally {
      socket.destroy();
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
      // Bookkeeping happens before the acknowledgment, so the host's next request never races it.
      // It is best-effort: authority has already committed and must not be reported as failed.
      try {
        this.config.history = [...this.config.history.filter((id) => id !== snapshot.id), snapshot.id].slice(-this.keepRevisions);
        await this.persist();
        const pruned = await pruneStore(this.store, { keep: this.config.history });
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
    this.log(`Checked the server out to ${who} at generation ${offer.generation}.`);
  }

  async close(): Promise<void> {
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
