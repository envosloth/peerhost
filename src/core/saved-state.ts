import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isValidEndpointHost } from './endpoints.js';
import { validateSettings, type Settings } from './settings.js';

export const DEFAULT_START_TIMEOUT_SECONDS = 600;
export const DEFAULT_STOP_TIMEOUT_SECONDS = 180;
export const MIN_TIMEOUT_SECONDS = 5;
export const MAX_TIMEOUT_SECONDS = 3600;

export interface LaunchProfile {
  executable: string;
  args: string[];
  /** Seconds to wait for the server's "Done (" line. Large modpacks routinely need several minutes. */
  startTimeoutSeconds: number;
  /** Seconds to wait for a clean `stop`, which includes saving every loaded chunk. */
  stopTimeoutSeconds: number;
}
export interface SavedServer {
  /** Stable identity for this entry in the server library. */
  id: string;
  name: string;
  serverDir: string;
  storeDir: string;
  snapshotId: string;
  profile: LaunchProfile;
  ledgerFile: string;
}
export interface SavedPeer { name: string; fingerprint: string; host: string; port: number }
/** An always-on trusted peer that stores the server between hosts. Its endpoint lives in the matching peer entry. */
export interface RelayConfig { fingerprint: string; parkOnStop: boolean }
export interface SavedState { version: 2; settings: Settings; servers: SavedServer[]; activeServerId: string | null; peers: SavedPeer[]; relay: RelayConfig | null }

export type LaunchProfileInput = { executable: string; args: string[]; startTimeoutSeconds?: number; stopTimeoutSeconds?: number };

function invalid(detail: string): never {
  throw new Error(`Invalid saved application state: ${detail}. The file was left unchanged; restore it from a backup.`);
}
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isAbsolutePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && path.isAbsolute(value) && !value.includes('\0');

export function validTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_TIMEOUT_SECONDS && value <= MAX_TIMEOUT_SECONDS;
}

/** Validate a user-supplied launch profile. Missing timeouts take the modpack-friendly defaults. */
export function validateLaunchProfile(input: unknown, allowEmptyExecutable = false): LaunchProfile {
  if (!isObject(input)) throw new Error('Invalid structured launch profile');
  const { executable, args, startTimeoutSeconds, stopTimeoutSeconds } = input;
  if (typeof executable !== 'string' || /[\0\r\n]/.test(executable) || executable.length > 4096 || (!allowEmptyExecutable && !executable.trim())) {
    throw new Error('Invalid structured launch profile');
  }
  if (!Array.isArray(args) || args.length > 100 || args.some((arg) => typeof arg !== 'string' || /[\0\r\n]/.test(arg) || arg.length > 4096)) {
    throw new Error('Invalid structured launch profile');
  }
  for (const value of [startTimeoutSeconds, stopTimeoutSeconds]) {
    if (value !== undefined && !validTimeout(value)) {
      throw new Error(`Launch timeouts must be whole seconds from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS}`);
    }
  }
  return {
    executable,
    args: [...args],
    startTimeoutSeconds: (startTimeoutSeconds as number | undefined) ?? DEFAULT_START_TIMEOUT_SECONDS,
    stopTimeoutSeconds: (stopTimeoutSeconds as number | undefined) ?? DEFAULT_STOP_TIMEOUT_SECONDS,
  };
}

export function validateRelayConfig(input: unknown): RelayConfig | null {
  if (input === null) return null;
  if (!isObject(input) || Object.keys(input).sort().join(',') !== 'fingerprint,parkOnStop' ||
      typeof input.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.fingerprint) || typeof input.parkOnStop !== 'boolean') {
    throw new Error('Invalid relay configuration');
  }
  return { fingerprint: input.fingerprint, parkOnStop: input.parkOnStop };
}

export function validatePeer(input: unknown): SavedPeer {
  if (!isObject(input)) throw new Error('Invalid peer identity or endpoint');
  const { name, fingerprint, host, port } = input;
  if (typeof name !== 'string' || !name.trim() || name.length > 100 || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint) ||
      !isValidEndpointHost(host) || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid peer identity or endpoint');
  }
  return { name, fingerprint, host, port };
}

export const SERVER_ID_PATTERN = /^[a-f0-9]{32}$/;
export function newServerId(): string { return randomUUID().replace(/-/g, ''); }
export function isServerId(value: unknown): value is string { return typeof value === 'string' && SERVER_ID_PATTERN.test(value); }

function validateSavedServer(value: unknown, index: number): SavedServer {
  if (!isObject(value)) invalid(`server ${index + 1}`);
  const saved = value;
  if (!isServerId(saved.id)) invalid(`server ${index + 1} id`);
  if (typeof saved.name !== 'string' || saved.name.length > 4096) invalid('server name');
  for (const key of ['serverDir', 'storeDir', 'ledgerFile'] as const) if (!isAbsolutePath(saved[key])) invalid(`server ${key}`);
  if (typeof saved.snapshotId !== 'string' || !/^[a-f0-9]{64}$/.test(saved.snapshotId)) invalid('server snapshotId');
  let profile: LaunchProfile;
  try { profile = validateLaunchProfile(saved.profile, true); } catch { invalid('server launch profile'); }
  return { id: saved.id, name: saved.name, serverDir: saved.serverDir as string, storeDir: saved.storeDir as string,
    snapshotId: saved.snapshotId, profile, ledgerFile: saved.ledgerFile as string };
}

/** Parse state.json without repairing it. State written by earlier alphas (single server, no launch timeouts) is migrated in memory. */
export function parseSavedState(value: unknown): SavedState {
  if (!isObject(value) || (value.version !== 1 && value.version !== 2)) invalid('unsupported version');
  let settings: Settings;
  try { settings = validateSettings(value.settings); } catch (error) { invalid(`settings (${(error as Error).message})`); }
  if (!Array.isArray(value.peers)) invalid('peers must be a list');
  const peers = value.peers.map((peer, index) => {
    try { return validatePeer(peer); } catch { return invalid(`peer ${index + 1}`); }
  });
  let servers: SavedServer[];
  let activeServerId: string | null;
  if (value.version === 1) {
    // Every older alpha held exactly one server, and owning it was mandatory to host.
    const single = value.server;
    if (single === null) { servers = []; activeServerId = null; }
    else { const migrated = validateSavedServer({ ...(isObject(single) ? single : {}), id: newServerId() }, 0); servers = [migrated]; activeServerId = migrated.id; }
  } else {
    if (!Array.isArray(value.servers) || value.servers.length > 200) invalid('servers must be a list');
    servers = value.servers.map((entry, index) => validateSavedServer(entry, index));
    if (new Set(servers.map((entry) => entry.id)).size !== servers.length) invalid('server ids must be unique');
    if (value.activeServerId === null || value.activeServerId === undefined) activeServerId = null;
    else if (!isServerId(value.activeServerId)) invalid('active server id');
    else activeServerId = value.activeServerId;
    if (activeServerId !== null && !servers.some((entry) => entry.id === activeServerId)) invalid('active server is missing from the library');
    if (activeServerId === null && servers.length > 0) invalid('a library with servers needs an active server');
  }
  let relay: RelayConfig | null = null;
  try { relay = validateRelayConfig(value.relay ?? null); } catch { invalid('relay'); }
  if (relay && !peers.some((peer) => peer.fingerprint === relay.fingerprint)) invalid('relay is not a trusted peer');
  return { version: 2, settings, servers, activeServerId, peers, relay };
}
