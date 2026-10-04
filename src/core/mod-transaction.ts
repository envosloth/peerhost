import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { MOD_INDEX_FILE } from './mod-index.js';

/** Travels with the server, not the local profile. Its presence always requires explicit repair. */
export const MOD_INSTALL_FENCE_FILE = 'peerhost-mod-install.json';
const repairMessage = 'Incomplete or uncertain mod install; explicit repair is required before starting or snapshotting this server';

/** Call at start and ordinary snapshot/handoff boundaries, NOT at Stop/graceful shutdown boundaries.
 * Any fence (including a malformed file, directory or symlink) fails closed. Never auto-delete or infer recovery.
 */
export async function assertModInstallComplete(serverDir: string): Promise<void> {
  try { await lstat(path.join(serverDir, MOD_INSTALL_FENCE_FILE)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new Error(repairMessage);
}

/** Do not pretend durability on filesystems/platforms which cannot flush directories. */
export async function syncModDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isDirectory()) throw new Error('Mod transaction requires an ordinary directory');
    await handle.sync();
  } finally { await handle.close(); }
}

export interface ModInstallIntent { kind: 'server' | 'client'; name: string }
export interface ModInstallTransaction { file: string; text: string; dev: number; ino: number }

/** Failure is an ordinary rollback only if the metadata is provably unchanged, including file identity. */
export async function modIndexFingerprint(serverDir: string): Promise<string> {
  const file = path.join(serverDir, MOD_INDEX_FILE);
  let stat;
  try { stat = await lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'; throw error; }
  const identity = `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  if (!stat.isFile() || stat.isSymbolicLink()) return identity;
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.size > 1024 * 1024) throw new Error('Cannot verify mod metadata rollback');
    const data = Buffer.alloc(1024 * 1024 + 1);
    let size = 0;
    while (size < data.length) {
      const { bytesRead } = await handle.read(data, size, data.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== current.size) throw new Error('Cannot verify mod metadata rollback');
    return `${identity}:${createHash('sha256').update(data.subarray(0, size)).digest('hex')}`;
  } finally { await handle.close(); }
}

/** Exclusive intent journal is flushed, then its directory is flushed, BEFORE any jar can be published. */
export async function beginModInstall(serverDir: string, items: ModInstallIntent[]): Promise<ModInstallTransaction> {
  await assertModInstallComplete(serverDir);
  const folder = await lstat(serverDir);
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error('Mod transaction requires an ordinary server folder');
  const file = path.join(serverDir, MOD_INSTALL_FENCE_FILE);
  const text = JSON.stringify({ version: 1, transactionId: randomUUID(), items });
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(repairMessage); throw error; }
  // A failed write/flush leaves the fence too: no successful completion has been proven.
  let stat;
  try { await handle.writeFile(text); await handle.sync(); stat = await handle.stat(); }
  finally { await handle.close(); }
  await syncModDirectory(serverDir);
  return { file, text, dev: stat.dev, ino: stat.ino };
}

/** Only a completed commit or a proven complete ordinary rollback may call this. */
export async function finishModInstall(serverDir: string, transaction: ModInstallTransaction): Promise<void> {
  const stat = await lstat(transaction.file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== transaction.dev || stat.ino !== transaction.ino || stat.size !== Buffer.byteLength(transaction.text)) throw new Error(repairMessage);
  const handle = await open(transaction.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat();
    if (current.dev !== transaction.dev || current.ino !== transaction.ino || current.size !== stat.size) throw new Error(repairMessage);
    const data = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < data.length) {
      const { bytesRead } = await handle.read(data, size, data.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (data.subarray(0, size).toString('utf8') !== transaction.text) throw new Error(repairMessage);
  } finally { await handle.close(); }
  try { await unlink(transaction.file); await syncModDirectory(serverDir); }
  catch (error) {
    let present = false;
    try { await lstat(transaction.file); present = true; }
    catch (checkError) { if ((checkError as NodeJS.ErrnoException).code !== 'ENOENT') throw new AggregateError([error, checkError], repairMessage); }
    if (present) throw error;
    // Unlink durability is uncertain. Restore a visible fail-closed fence; never report success.
    let handle;
    try {
      handle = await open(transaction.file, 'wx', 0o600);
      await handle.writeFile(transaction.text); await handle.sync();
      await syncModDirectory(serverDir);
    } catch (restoreError) { throw new AggregateError([error, restoreError], repairMessage); }
    finally { await handle?.close(); }
    throw error;
  }
}
