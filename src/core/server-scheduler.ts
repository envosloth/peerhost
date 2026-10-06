import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isServerId, newServerId } from './saved-state.js';
import { syncDirectory } from './snapshots.js';

export interface ServerSchedule {
  id: string; serverId: string; name: string; action: 'backup' | 'stop' | 'command'; command?: string;
  intervalMinutes: number; enabled: boolean; nextRunAt: number; lastRunAt: number | null; lastOutcome: string | null;
}
export type ScheduleInput = Pick<ServerSchedule, 'name' | 'action' | 'intervalMinutes' | 'enabled'> & { id?: string; command?: string };
export function validScheduledCommand(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && Buffer.byteLength(value) <= 1024 && !/[\x00-\x1f\x7f]/.test(value);
}
export function validateScheduleInput(value: unknown): ScheduleInput {
  const input = value as Record<string, unknown>;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['id', 'name', 'action', 'command', 'intervalMinutes', 'enabled'].includes(key)) ||
      typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60 || /[\x00-\x1f\x7f]/.test(input.name) ||
      (typeof input.action !== 'string' || !['backup', 'stop', 'command'].includes(input.action)) || !Number.isInteger(input.intervalMinutes) || Number(input.intervalMinutes) < 1 || Number(input.intervalMinutes) > 10080 || typeof input.enabled !== 'boolean' ||
      ('id' in input && !isServerId(input.id)) || (input.action === 'command' ? !validScheduledCommand(input.command) : 'command' in input)) throw new Error('Invalid server schedule (1–10080 minutes; one bounded command line)');
  return { ...('id' in input ? { id: input.id as string } : {}), name: input.name.trim(), action: input.action as ScheduleInput['action'], intervalMinutes: Number(input.intervalMinutes), enabled: input.enabled,
    ...(input.action === 'command' ? { command: input.command as string } : {}) };
}
export function createSchedule(serverId: string, input: ScheduleInput, now = Date.now()): ServerSchedule {
  if (!isServerId(serverId)) throw new Error('Invalid schedule server');
  return { ...validateScheduleInput(input), id: input.id ?? newServerId(), serverId, nextRunAt: now + input.intervalMinutes * 60000, lastRunAt: null, lastOutcome: null };
}
function validateSavedSchedule(value: unknown): ServerSchedule {
  const record = value as ServerSchedule;
  if (!record || typeof record !== 'object' || !isServerId(record.id) || !isServerId(record.serverId) ||
      !Number.isSafeInteger(record.nextRunAt) || record.nextRunAt < 0 || !(record.lastRunAt === null || Number.isSafeInteger(record.lastRunAt) && record.lastRunAt >= 0) ||
      !(record.lastOutcome === null || typeof record.lastOutcome === 'string' && record.lastOutcome.length <= 300) ||
      Object.keys(record).some(key => !['id', 'serverId', 'name', 'action', 'command', 'intervalMinutes', 'enabled', 'nextRunAt', 'lastRunAt', 'lastOutcome'].includes(key))) throw new Error('Invalid saved server schedule');
  const input = validateScheduleInput({ id: record.id, name: record.name, action: record.action, intervalMinutes: record.intervalMinutes, enabled: record.enabled, ...(record.action === 'command' ? { command: record.command } : {}) });
  return { ...input, id: record.id, serverId: record.serverId, nextRunAt: record.nextRunAt, lastRunAt: record.lastRunAt, lastOutcome: record.lastOutcome };
}
async function ordinaryMetadata(root: string, file: string) {
  const base = await lstat(root);
  if (!base.isDirectory() || base.isSymbolicLink() || path.resolve(await realpath(root)).toLowerCase() !== path.resolve(root).toLowerCase()) throw new Error('Schedule profile directory is not ordinary');
  try { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) throw new Error('Schedule metadata must be a bounded ordinary file'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export async function readScheduleSnapshot(root: string): Promise<{ jobs: ServerSchedule[]; revision: string | null }> {
  const file = path.join(root, 'schedules.json');
  await ordinaryMetadata(root, file);
  let handle;
  try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { jobs: [], revision: null }; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 512 * 1024) throw new Error('Schedule metadata is oversized');
    const buffer = Buffer.alloc(512 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 512 * 1024 || bytesRead !== stat.size) throw new Error('Schedule metadata changed or is oversized');
    await ordinaryMetadata(root, file);
    const current = await lstat(file);
    if (current.ino !== stat.ino || current.dev !== stat.dev || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) throw new Error('Schedule metadata changed while reading');
    const saved = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (!saved || saved.version !== 1 || Object.keys(saved).sort().join(',') !== 'jobs,version' || !Array.isArray(saved.jobs) || saved.jobs.length > 1000) throw new Error('Invalid schedule metadata');
    const jobs = saved.jobs.map(validateSavedSchedule) as ServerSchedule[];
    if (new Set(jobs.map(job => job.id)).size !== jobs.length) throw new Error('Duplicate schedule identities');
    return { jobs, revision: createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex') };
  } finally { await handle.close(); }
}
export async function readSchedules(root: string): Promise<ServerSchedule[]> {
  return (await readScheduleSnapshot(root)).jobs;
}
export async function writeSchedules(root: string, jobs: ServerSchedule[], expectedRevision?: string | null): Promise<string> {
  if (jobs.length > 1000) throw new Error('Too many server schedules');
  const validated = jobs.map(validateSavedSchedule);
  const previous = await readScheduleSnapshot(root);
  if (expectedRevision !== undefined && previous.revision !== expectedRevision) throw new Error('Schedule metadata changed; scheduler disabled');
  const file = path.join(root, 'schedules.json');
  await ordinaryMetadata(root, file);
  const bytes = JSON.stringify({ version: 1, jobs: validated });
  const temporary = file + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    if ((await readScheduleSnapshot(root)).revision !== previous.revision) throw new Error('Schedule metadata changed; scheduler disabled');
    await ordinaryMetadata(root, file); await rename(temporary, file); await syncDirectory(root);
    return createHash('sha256').update(bytes).digest('hex');
  }
  finally { await rm(temporary, { force: true }); }
}
