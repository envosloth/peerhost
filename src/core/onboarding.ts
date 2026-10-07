import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { syncDirectory } from './snapshots.js';
import { isServerId } from './saved-state.js';

export const SETUP_STEPS = ['server', 'runtime', 'friends', 'gateway', 'ready'] as const;
export interface OnboardingProgress {
  version: 1;
  step: typeof SETUP_STEPS[number];
  dismissed: boolean;
  completed: boolean;
  skipped: Array<'friends' | 'gateway'>;
  draft: { name: string; loader: 'vanilla' | 'fabric'; gameVersion: string; memoryMiB: number };
}
export type OnboardingInput = Omit<OnboardingProgress, 'version'>;
export type SetupCheck = 'complete' | 'skipped' | 'pending' | 'unavailable';
export interface SetupConfiguration {
  server: { profile: { executable: string; args: readonly string[] }; modInstallError?: string | null } | null;
  relay?: { fingerprint: string } | null;
  gateway?: { enabled: boolean; error?: string | null };
  alwaysOn?: { enabled: boolean; error?: string | null } | null;
}
/** Configured is not proof of network reachability. Visits and draft values never count as completion. */
export function onboardingChecks(progress: Pick<OnboardingInput, 'completed' | 'skipped'>, config: SetupConfiguration): Record<typeof SETUP_STEPS[number], SetupCheck> {
  const server: SetupCheck = config.server ? 'complete' : 'pending';
  const runtime: SetupCheck = config.server?.modInstallError ? 'unavailable' : config.server?.profile.executable && config.server.profile.args.length ? 'complete' : 'pending';
  const friends: SetupCheck = config.relay ? 'complete' : progress.skipped.includes('friends') ? 'skipped' : 'pending';
  const configuredGateway = Boolean(config.alwaysOn?.enabled && !config.alwaysOn.error || config.gateway?.enabled && config.relay && !config.gateway.error);
  const gateway: SetupCheck = configuredGateway ? 'complete' : progress.skipped.includes('gateway') ? 'skipped' : config.gateway?.error || config.alwaysOn?.error ? 'unavailable' : 'pending';
  const resolved = [server, runtime].every(check => check === 'complete') && [friends, gateway].every(check => check === 'complete' || check === 'skipped');
  return { server, runtime, friends, gateway, ready: progress.completed && resolved ? 'complete' : 'pending' };
}
export function defaultOnboarding(existingServer = false): OnboardingProgress {
  return { version: 1, step: existingServer ? 'runtime' : 'server', dismissed: existingServer, completed: false,
    skipped: [], draft: { name: 'My Minecraft server', loader: 'vanilla', gameVersion: '', memoryMiB: 2048 } };
}
export function validateOnboarding(value: unknown): OnboardingInput {
  const p = value as Record<string, any>;
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).sort().join(',') !== 'completed,dismissed,draft,skipped,step' ||
      !SETUP_STEPS.includes(p.step) || typeof p.dismissed !== 'boolean' || typeof p.completed !== 'boolean' ||
      !Array.isArray(p.skipped) || p.skipped.length > 2 || new Set(p.skipped).size !== p.skipped.length || p.skipped.some((v: unknown) => v !== 'friends' && v !== 'gateway')) throw new Error('Invalid setup progress');
  const d = p.draft;
  if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).sort().join(',') !== 'gameVersion,loader,memoryMiB,name' ||
      typeof d.name !== 'string' || !d.name.trim() || d.name.length > 80 || /[\x00-\x1f]/.test(d.name) ||
      (d.loader !== 'vanilla' && d.loader !== 'fabric') || typeof d.gameVersion !== 'string' || !/^[\w.+-]{0,32}$/.test(d.gameVersion) ||
      !Number.isInteger(d.memoryMiB) || d.memoryMiB < 512 || d.memoryMiB > 65536) throw new Error('Invalid non-secret setup draft');
  return { step: p.step, dismissed: p.dismissed, completed: p.completed, skipped: [...p.skipped], draft: { ...d } };
}
function onboardingFile(root: string, serverId?: string | null): string {
  if (serverId !== undefined && serverId !== null && !isServerId(serverId)) throw new Error('Invalid server id');
  return path.join(root, serverId === undefined ? 'onboarding.json' : serverId === null ? 'onboarding-new.json' : `onboarding-server-${serverId}.json`);
}
async function readMetadata(file: string, limit = 16384): Promise<any> {
  // Windows does not provide O_NOFOLLOW; reject links explicitly there too.
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Setup metadata must be an ordinary file');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Setup metadata exceeds the allowed size');
    const buffer = Buffer.alloc(limit + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error('Setup metadata exceeds the allowed size');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}
interface LegacyOnboardingScope { version: 1; serverId: string | null; ledgerKey?: string }
async function readLegacyScope(root: string): Promise<LegacyOnboardingScope> {
  const value = await readMetadata(path.join(root, 'onboarding-legacy-scope.json'), 256);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['serverId,version', 'ledgerKey,serverId,version'].includes(Object.keys(value).sort().join(',')) ||
      value.version !== 1 || value.serverId !== null && !isServerId(value.serverId) ||
      value.ledgerKey !== undefined && (value.serverId === null || typeof value.ledgerKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.ledgerKey))) throw new Error('Invalid legacy setup scope');
  return value;
}
/** Attribute the immutable legacy source once, before selection can change. Never alter application/world state.
 * A partial/invalid marker fails closed for optional progress, not hosting; it is never repaired or reassigned. */
export async function initializeOnboardingScope(root: string, serverId: string | null, ledgerKey?: string): Promise<LegacyOnboardingScope | null> {
  onboardingFile(root, serverId);
  if (ledgerKey !== undefined && (serverId === null || !/^[a-f0-9]{64}$/.test(ledgerKey))) throw new Error('Invalid legacy setup scope');
  try { return await readLegacyScope(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { await lstat(onboardingFile(root)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; if (!ledgerKey) return null; }
  const scope: LegacyOnboardingScope = { version: 1, serverId, ...(ledgerKey ? { ledgerKey } : {}) };
  const handle = await open(path.join(root, 'onboarding-legacy-scope.json'), 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(scope)); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(root);
  return scope;
}
async function readScopedMetadata(root: string, serverId: string | null): Promise<any> {
  try { return await readMetadata(onboardingFile(root, serverId)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let legacyScope: LegacyOnboardingScope;
  try { legacyScope = await readLegacyScope(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { await lstat(onboardingFile(root)); }
    catch (missing) { if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw missing; }
    throw new Error('Legacy setup metadata has no safely saved scope');
  }
  if (legacyScope.serverId !== serverId) return undefined;
  return readMetadata(onboardingFile(root));
}
export async function readOnboarding(root: string, existingServer = false, serverId?: string | null): Promise<OnboardingProgress & { error: string | null }> {
  onboardingFile(root, serverId);
  try {
    const value = serverId === undefined ? await readMetadata(onboardingFile(root)) : await readScopedMetadata(root, serverId);
    if (value === undefined) return { ...defaultOnboarding(existingServer), error: null };
    if (value?.version !== 1) throw new Error('Unsupported setup metadata version');
    const { version: _version, ...input } = value;
    const progress = validateOnboarding(input);
    // A pending new-world draft has no world to finish, including after deletion of an old legacy world.
    if (serverId === null) progress.completed = false;
    return { version: 1, ...progress, error: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaultOnboarding(existingServer), error: null };
    return { ...defaultOnboarding(true), error: 'Saved setup progress is unreadable; existing server controls remain available. Original metadata was left unchanged.' };
  }
}
export async function saveOnboarding(root: string, input: unknown, serverId?: string | null): Promise<void> {
  const file = onboardingFile(root, serverId);
  const progress = { version: 1, ...validateOnboarding(input) };
  const current = await readOnboarding(root, false, serverId);
  if (current.error) throw new Error(current.error);
  await mkdir(root, { recursive: true });
  const temporary = path.join(root, `onboarding-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(progress)); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, file); await syncDirectory(root); }
  finally { await rm(temporary, { force: true }); }
}
