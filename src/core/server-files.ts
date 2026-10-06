import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { windowsServerWrite } from './windows-server-writer.js';
import { recoverManagedServerFiles, assertServerFileTransactionsComplete } from './server-file-recovery.js';
import { validateRelativePath } from './paths.js';

export const MAX_SERVER_TEXT_BYTES = 256 * 1024;
const writableExtensions = new Set(['.properties', '.json', '.txt', '.yaml', '.yml', '.toml', '.cfg', '.conf', '.md', '.csv', '.xml']);
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
export const textHash = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
export function editableServerPath(relative: string): boolean {
  return writableExtensions.has(path.extname(relative).toLowerCase()) && !relative.split('/').some(part => /^\.seedhost/i.test(part));
}

/** Only ordinary components in this profile's managed copy. Never follow links or Windows junctions. */
export async function resolveServerPath(profileRoot: string, serverDir: string, relative: string, directory = false): Promise<string> {
  if (typeof relative !== 'string' || relative.length > 4096 || relative.includes('\\')) throw new Error('Unsafe server file path');
  const clean = relative === '' && directory ? '' : validateRelativePath(relative);
  const root = path.resolve(profileRoot);
  const managed = path.relative(root, path.resolve(serverDir)).replaceAll('\\', '/');
  if (!/^managed\/servers\/[^/]+$/.test(managed)) throw new Error('Server files must stay inside this profile’s managed server copy');
  const base = await lstat(root);
  if (!base.isDirectory() || base.isSymbolicLink() || !samePath(await realpath(root), root)) throw new Error('Profile must be an ordinary directory');
  let current = root;
  const components = [...managed.split('/'), ...clean.split('/').filter(Boolean)];
  for (let i = 0; i < components.length; i++) {
    current = path.join(current, components[i]!);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !samePath(await realpath(current), current)) throw new Error('Server file links and junctions are not allowed');
    if (i < components.length - 1 || directory) {
      if (!stat.isDirectory()) throw new Error('Server file path is not an ordinary directory');
    } else if (!stat.isFile()) throw new Error('Server file path is not an ordinary file');
  }
  return current;
}

export async function listManagedFiles(profileRoot: string, serverDir: string, relative: string) {
  const directory = await resolveServerPath(profileRoot, serverDir, relative, true);
  const names = (await readdir(directory)).sort((a, b) => a.localeCompare(b));
  const entries = [];
  for (const name of names.slice(0, 1000)) {
    const relativePath = relative ? relative + '/' + name : name;
    const stat = await lstat(path.join(directory, name));
    entries.push({ name, path: relativePath, kind: stat.isDirectory() && !stat.isSymbolicLink() ? 'directory' : 'file', bytes: stat.size,
      editable: stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_SERVER_TEXT_BYTES && editableServerPath(relativePath) });
  }
  await resolveServerPath(profileRoot, serverDir, relative, true);
  return { path: relative, entries, truncated: names.length > 1000 };
}

export function validateServerText(relative: string, text: unknown, expectedHash: unknown): asserts text is string {
  validateRelativePath(relative);
  if (!editableServerPath(relative)) throw new Error('This file is read-only; use the supported mod/launch controls for executable or internal files');
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_SERVER_TEXT_BYTES || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) || /[\ud800-\udfff]/u.test(text)) throw new Error('Use valid UTF-8 text of at most 256 KiB');
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('Read the file before editing it');
}

export async function writeManagedText(profileRoot: string, serverDir: string, relative: string, text: string, expectedHash: string): Promise<{ path: string; hash: string; bytes: number; backupFile: string }> {
  validateServerText(relative, text, expectedHash);
  await recoverManagedServerFiles(profileRoot, serverDir);
  const file = await resolveServerPath(profileRoot, serverDir, relative);
  const directory = path.dirname(file);
  const nonce = randomUUID();
  const backupFile = path.join(directory, `.seedhost-backup-${nonce}.bak`);
  const stage = path.join(directory, `.seedhost-edit-${nonce}.tmp`);
  try { await windowsServerWrite(file, text, expectedHash, backupFile, stage); }
  catch (error) { throw new Error((error as Error).message + '. Recovery copy, if created: ' + backupFile + '. Refresh before retrying.'); }
  const saved = await readManagedText(profileRoot, serverDir, relative);
  if (saved.hash !== textHash(text)) throw new Error('Server file changed after saving; refresh before retrying. Previous bytes retained in ' + backupFile);
  return { path: relative, hash: saved.hash, bytes: saved.bytes, backupFile };
}

export async function readManagedText(profileRoot: string, serverDir: string, relative: string, recover = true) {
  if (recover) await recoverManagedServerFiles(profileRoot, serverDir);
  else {
    await resolveServerPath(profileRoot, serverDir, '', true);
    await assertServerFileTransactionsComplete(serverDir);
  }
  const file = await resolveServerPath(profileRoot, serverDir, relative);
  const before = await lstat(file);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_SERVER_TEXT_BYTES || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('Server file changed or is too large (256 KiB maximum)');
    const data = Buffer.alloc(MAX_SERVER_TEXT_BYTES + 1);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead > MAX_SERVER_TEXT_BYTES) throw new Error('Server text file is too large (256 KiB maximum)');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data.subarray(0, bytesRead)); }
    catch { throw new Error('Binary files cannot be opened in the text editor'); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error('Binary files cannot be opened in the text editor');
    await resolveServerPath(profileRoot, serverDir, relative);
    const after = await lstat(file);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || bytesRead !== stat.size) throw new Error('Server file changed while reading; refresh it');
    return { path: relative, text, hash: textHash(data.subarray(0, bytesRead)), bytes: bytesRead };
  } finally { await handle.close(); }
}
