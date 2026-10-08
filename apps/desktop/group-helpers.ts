import { mkdir, readdir, access, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AlwaysOnHost, type AlwaysOnStatus } from '../../src/core/always-on.js';
import { readRelayConfig } from '../../src/core/relay-friends-store.js';
import type { PeerIdentity } from '../../src/core/peer-transport.js';

/*
 * Per-group always-on helpers.
 *
 * A hosting group is one world lineage served by one relay identity, so each group's world gets its OWN helper
 * (identity, relay store, listeners) instead of aliasing every group onto a single shared helper:
 * - the primary helper under `baseRoot` keeps the historic role (the app-wide always-on PC, pairing codes) and
 *   hosts the first group created on this PC, preserving existing installs;
 * - every further group gets a fresh durable root at `baseRoot/groups/<uuid>` with its own encrypted identity.
 *
 * The filesystem is the registry: a root is a helper exactly when it contains `identity.json`. Nothing is ever
 * rebound: a root that has served a group is never reused for a different one.
 */

export interface GroupHelperRole {
  port?: number;
  gamePorts?: number[];
  reservedGamePorts?: number[];
  discoveryPort?: number;
  host?: string;
}
export interface GroupHelper { root: string; fingerprint: string; host: AlwaysOnHost }
export interface GroupHelpersDeps {
  /** Loads the OS-encrypted identity in a helper root, creating one the first time a root is used. */
  loadIdentity(root: string): Promise<PeerIdentity>;
  /** Role options for a helper; `extra` helpers never answer the app-wide LAN pairing discovery. */
  role(extra: boolean): GroupHelperRole | Promise<GroupHelperRole>;
}

export class GroupHelpers {
  private readonly entries = new Map<string, GroupHelper>();
  /** Within one process a primary root is handed out at most once, even before its relay store records the group. */
  private primaryTaken = false;
  constructor(readonly baseRoot: string, private readonly deps: GroupHelpersDeps) {}

  get groupsDir(): string { return path.join(this.baseRoot, 'groups'); }

  private async load(root: string, extra: boolean): Promise<GroupHelper> {
    const identity = await this.deps.loadIdentity(root);
    const role = await this.deps.role(extra);
    const options = { ...role, loadGroupIdentity: this.deps.loadIdentity };
    const host = new AlwaysOnHost(root, identity, extra ? { ...options, discoveryPort: role.discoveryPort ?? 0 } : options);
    return { root, fingerprint: identity.fingerprint, host };
  }

  private async hasIdentity(root: string): Promise<boolean> {
    try { await access(path.join(root, 'identity.json')); return true; } catch { return false; }
  }

  private async groupRoots(): Promise<string[]> {
    let names: string[];
    try { names = await readdir(this.groupsDir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    return names.map((name) => path.join(this.groupsDir, name));
  }

  /**
   * Restore the primary helper plus every additional helper that is still referenced by the app state.
   * The primary identity is created on first run exactly like the historic single helper; additional roots are
   * only touched when they already carry an identity and some world (or pending group) still points at them.
   */
  async restoreAll(keep: (fingerprint: string) => boolean): Promise<void> {
    await mkdir(this.baseRoot, { recursive: true });
    const primary = await this.load(this.baseRoot, false);
    this.entries.set(primary.fingerprint, primary);
    await primary.host.restore();
    for (const root of await this.groupRoots()) {
      if (!await this.hasIdentity(root)) continue;
      const identity = await this.deps.loadIdentity(root);
      if (!keep(identity.fingerprint) && !await this.referencedGeneration(root, keep)) continue;
      const helper = await this.load(root, true);
      this.entries.set(helper.fingerprint, helper);
      await helper.host.restore();
    }
  }

  /** Inspect published generation pins without starting unreferenced listeners or inventing missing keys. */
  private async referencedGeneration(root: string, keep: (fingerprint: string) => boolean, depth = 0): Promise<boolean> {
    if (depth > 20) throw new Error('Too many nested group generations');
    let saved: Record<string, unknown>;
    try { saved = JSON.parse(await readFile(path.join(root, 'always-on.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    for (const field of ['groupGeneration', 'retainedRoleGeneration']) {
      const generation = saved[field];
      if (generation === undefined) continue;
      if (typeof generation !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(generation)) throw new Error('Invalid saved group generation');
      const child = path.join(root, 'groups', generation);
      await access(path.join(child, 'identity.json'));
      const identity = await this.deps.loadIdentity(child);
      if (keep(identity.fingerprint) || await this.referencedGeneration(child, keep, depth + 1)) return true;
    }
    return false;
  }

  /** Whether the primary helper has never served a group (its relay store carries no owner, members or history). */
  private async primaryIsFree(): Promise<boolean> {
    try {
      const config = await readRelayConfig(this.baseRoot, 'Always-on PC');
      return config.trusted.length === 0 && config.history.length === 0 && config.owner === undefined;
    } catch { return false; }
  }

  /**
   * Reserve a helper for a NEW group: the free primary root when it has never served a group (continuity with
   * existing installs), otherwise a fresh durable root. The returned helper is not started yet; the caller
   * enables it. A root that already serves any group is never rebound, and the primary root is handed out at
   * most once per process run.
   */
  async create(): Promise<GroupHelper> {
    if (!this.primaryTaken && await this.primaryIsFree() && !this.primaryTaken) {
      this.primaryTaken = true;
      for (const entry of this.list()) if (entry.root === this.baseRoot) return entry;
      const primary = await this.load(this.baseRoot, false);
      this.entries.set(primary.fingerprint, primary);
      return primary;
    }
    const root = path.join(this.groupsDir, randomUUID());
    await mkdir(root, { recursive: true });
    const helper = await this.load(root, true);
    this.entries.set(helper.fingerprint, helper);
    return helper;
  }

  list(): GroupHelper[] { return [...this.entries.values()]; }
  primary(): GroupHelper | undefined { return this.list().find((entry) => entry.root === this.baseRoot); }
  forFingerprint(fingerprint: string | undefined | null): GroupHelper | undefined {
    return fingerprint ? this.entries.get(fingerprint) ?? this.list().find(entry => entry.host.localGroupFingerprints().includes(fingerprint)) : undefined;
  }

  async statuses(): Promise<AlwaysOnStatus[]> {
    const statuses: AlwaysOnStatus[] = [];
    for (const entry of this.list()) statuses.push(await entry.host.status());
    return statuses;
  }

  /** Gateway ports of every running helper: they must be treated as reserved by managed Minecraft servers. */
  async runningGamePorts(): Promise<number[]> {
    const ports = new Set<number>();
    for (const status of await this.statuses()) if (status.running && status.gamePort !== null) ports.add(status.gamePort);
    return [...ports];
  }

  async closeAll(): Promise<void> {
    for (const entry of this.list()) await entry.host.close().catch(() => undefined);
  }
}
