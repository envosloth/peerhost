import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { durableJSON, fingerprintOK } from './relay-friends-store.js';
import { isServerId } from './saved-state.js';
export interface HostingRevision { generation: number; snapshotId: string; lineage: string; reservation: string }
export interface AdmissionJournal {
  version: 1; serverId: string; deviceId: string; relayFingerprint: string;
  revision: HostingRevision; attempted: boolean; acknowledged: boolean; stopped: boolean;
  recoverySnapshot: string | null; phase: 'attempted' | 'acknowledged' | 'snapshot-retained' | 'stopped' | 'cancelled';
}
export function validRevision(value: unknown): value is HostingRevision {
  const v = value as HostingRevision;
  return !!v && typeof v === 'object' && Object.keys(v).sort().join(',') === 'generation,lineage,reservation,snapshotId' &&
    Number.isSafeInteger(v.generation) && v.generation >= 1 && fingerprintOK(v.snapshotId) &&
    typeof v.lineage === 'string' && v.lineage.length > 0 && v.lineage.length <= 512 && !/[\x00-\x1f\x7f]/.test(v.lineage) &&
    typeof v.reservation === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v.reservation);
}
function journalFile(root: string, serverId: string): string {
  if (!isServerId(serverId)) throw new Error('Invalid admission server binding');
  return path.join(root, 'admissions', serverId + '.json');
}
export async function readAdmission(root: string, serverId: string): Promise<AdmissionJournal | null> {
  let j: AdmissionJournal;
  try { j = JSON.parse(await readFile(journalFile(root, serverId), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!j || j.version !== 1 || j.serverId !== serverId || !fingerprintOK(j.deviceId) || !fingerprintOK(j.relayFingerprint) || !validRevision(j.revision) ||
      typeof j.attempted !== 'boolean' || typeof j.acknowledged !== 'boolean' || typeof j.stopped !== 'boolean' ||
      (j.recoverySnapshot !== null && !fingerprintOK(j.recoverySnapshot)) ||
      !['attempted', 'acknowledged', 'snapshot-retained', 'stopped', 'cancelled'].includes(j.phase)) throw new Error('Admission journal is invalid; recovery remains blocked');
  return j;
}
export async function saveAdmission(root: string, journal: AdmissionJournal): Promise<void> {
  const file = journalFile(root, journal.serverId);
  await mkdir(path.dirname(file), { recursive: true });
  await durableJSON(file, journal);
}
