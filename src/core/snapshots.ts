import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { validateRelativePath } from './paths.js';

export interface SnapshotManifest {
  version: 1;
  id: string;
  parentId: string | null;
  files: Array<{ path: string; size: number; hash: string }>;
}

const runFile = promisify(execFile);

function validateRoot(root: string): void {
  const normalized = root.replaceAll('\\', '/');
  if (normalized.startsWith('//?/') || normalized.startsWith('//./') || normalized.includes('\u0000')) {
    throw new Error('Unsafe Windows device namespace root');
  }
  if (normalized.split('/').some((part) => part !== '.' && part !== '..' && /[. ]$/u.test(part))) {
    throw new Error('Unsafe root alias: nesting checks require unambiguous directory names');
  }
}

function pathKey(value: string): string {
  // Uppercase before lowercase catches Windows ordinal aliases such as long-s/S and final sigma.
  // Unicode expansions are intentionally conservative: reject extra aliases rather than overwrite.
  return value.toUpperCase().toLowerCase();
}

function assertDisjoint(first: string, second: string): void {
  validateRoot(first);
  validateRoot(second);
  const a = pathKey(path.resolve(first).replaceAll('\\', '/')).replace(/\/$/u, '');
  const b = pathKey(path.resolve(second).replaceAll('\\', '/')).replace(/\/$/u, '');
  if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
    throw new Error('Source/store/destination roots must be disjoint; nesting is forbidden');
  }
}

// Run only after link/reparse preflight. Resolve existing ancestors to catch 8.3/root aliases,
// including a destination whose final components have not been created yet.
async function canonicalRoot(root: string): Promise<string> {
  let current = path.resolve(root);
  const missing: string[] = [];
  for (;;) {
    try { return path.join(await realpath(current), ...missing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || current === path.dirname(current)) throw error;
      missing.unshift(path.basename(current));
      current = path.dirname(current);
    }
  }
}

async function assertPhysicalDisjoint(first: string, second: string): Promise<void> {
  assertDisjoint(await canonicalRoot(first), await canonicalRoot(second));
}

async function assertSafeRoots(roots: string[]): Promise<void> {
  // A concurrent store writer may remove its private staging directory (.transfer-*, .staging-*)
  // between our enumeration and our inspection of it. Only an enumerated child that is gone
  // (plain ENOENT, before its stat or its own enumeration) is skipped: the walk root itself,
  // any junction/reparse point present at check time, and every other error still fail closed.
  async function inspect(filename: string, recursive: boolean, missingAllowed: boolean, enumeratedChild = false): Promise<void> {
    let stat;
    try { stat = await lstat(filename); }
    catch (error) {
      if ((missingAllowed || enumeratedChild) && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Symlink/reparse point forbidden: ${filename}`);
    if (!stat.isDirectory() && !stat.isFile()) throw new Error(`Unsupported file type: ${filename}`);
    if (recursive && stat.isDirectory()) {
      let names: string[];
      try { names = await readdir(filename); }
      catch (error) {
        if (enumeratedChild && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const name of names) await inspect(path.join(filename, name), true, false, true);
    }
  }
  const absoluteRoots = roots.map((root) => { validateRoot(root); return path.resolve(root); });
  for (const root of absoluteRoots) {
    for (let current = root; ; current = path.dirname(current)) {
      await inspect(current, false, true);
      if (current === path.dirname(current)) break;
    }
  }
  // Node lstat detects junctions, but not every Windows reparse tag (e.g. cloud placeholders).
  // Inspect the native attribute bit as well, and fail closed if the platform probe is unavailable.
  if (process.platform === 'win32') {
    const literal = JSON.stringify(absoluteRoots).replaceAll("'", "''");
    const script = `$ErrorActionPreference = 'Stop'
function TestVanished([System.Exception]$exception) {
  $current = $exception
  while ($null -ne $current) {
    if ($current -is [System.IO.FileNotFoundException] -or $current -is [System.IO.DirectoryNotFoundException]) { return $true }
    $current = $current.InnerException
  }
  return $false
}
function CheckPath([string]$p, [bool]$recursive, [bool]$enumeratedChild) {
  try { $attrs = [System.IO.File]::GetAttributes($p) }
  catch { if (TestVanished $_.Exception) { return } else { throw } }
  if (($attrs -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point forbidden: $p" }
  if ($recursive -and (($attrs -band [System.IO.FileAttributes]::Directory) -ne 0)) {
    try { $entries = [System.IO.Directory]::GetFileSystemEntries($p) }
    catch {
      # An enumerated child may legitimately vanish before enumeration (a concurrent transfer
      # removing its staging directory); the walk root must not be skipped this way.
      if ($enumeratedChild -and (TestVanished $_.Exception)) { return } else { throw }
    }
    foreach ($entry in $entries) { CheckPath $entry $true $true }
  }
}
try {
  foreach ($rootPath in (ConvertFrom-Json '${literal}')) {
    $current = $rootPath
    while ($current) { CheckPath $current $false $false; $current = [System.IO.Path]::GetDirectoryName($current) }
    CheckPath $rootPath $true $false
  }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`;
    try {
      await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
    } catch (error) {
      throw new Error('Windows reparse-point safety check failed; refusing filesystem access', { cause: error });
    }
  }
  for (const root of absoluteRoots) await inspect(root, true, true);
}

function manifestId(parentId: string | null, files: SnapshotManifest['files']): string {
  return createHash('sha256').update(JSON.stringify({ version: 1, parentId, files })).digest('hex');
}

async function publish(temporary: string, target: string, expected: { size: number; hash: string }): Promise<void> {
  const staged = await hashFile(temporary);
  if (staged.hash !== expected.hash || staged.size !== expected.size) {
    throw new Error(`Staged artifact integrity hash mismatch: ${temporary}`);
  }
  try {
    await link(temporary, target); // Atomic, never overwrites a published revision/object.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const actual = await hashFile(target);
  if (actual.hash !== expected.hash || actual.size !== expected.size) {
    throw new Error(`Published artifact integrity hash mismatch: ${target}`);
  }
}

async function hashFile(filename: string): Promise<{ size: number; hash: string }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(filename)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, hash: hash.digest('hex') };
}

async function streamObject(source: string, temporary: string): Promise<{ size: number; hash: string }> {
  const before = await lstat(source, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`Unsafe source file/symlink: ${source}`);
  const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(Number.isSafeInteger(size) ? null : new Error('Source file size exceeds safe integer range'), chunk);
    } });
    await pipeline(handle.createReadStream({ autoClose: false }), meter, createWriteStream(temporary, { flags: 'wx' }));
    const after = await lstat(source, { bigint: true });
    const opened = await handle.stat({ bigint: true });
    if (statIdentity(before) !== statIdentity(after) || statIdentity(before) !== statIdentity(opened) || BigInt(size) !== before.size) {
      throw new Error(`Source changed while copying; stop the server before snapshotting: ${source}`);
    }
    return { size, hash: hash.digest('hex') };
  } finally { await handle.close(); }
}

function statIdentity(stat: import('node:fs').BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(':');
}

async function sourceInventory(source: string): Promise<string> {
  const inventory: Array<[string, string]> = [];
  const seen = new Map<string, { spelling: string; directory: boolean }>();
  async function visit(absolute: string, relative: string): Promise<void> {
    const stat = await lstat(absolute, { bigint: true });
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`Unsafe source link/type: ${absolute}`);
    if (relative) {
      if (validateRelativePath(relative) !== relative) throw new Error(`Source path is not canonical: ${relative}`);
      registerPath(seen, relative, stat.isDirectory());
    }
    inventory.push([relative, statIdentity(stat)]);
    if (stat.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await visit(path.join(absolute, name), relative ? `${relative}/${name}` : name);
    }
  }
  await visit(path.resolve(source), '');
  return JSON.stringify(inventory);
}

function validateId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid SHA256 hash snapshot/object id');
}

function exactKeys(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error('Invalid manifest fields');
  }
}

/** Includes implied directories: World/a and world/b are a collision too. */
function registerPath(seen: Map<string, { spelling: string; directory: boolean }>, relative: string, directory: boolean): void {
  const parts = relative.split('/');
  for (let count = 1; count <= parts.length; count++) {
    const spelling = parts.slice(0, count).join('/');
    const isDirectory = count < parts.length || directory;
    const key = pathKey(spelling);
    const prior = seen.get(key);
    if (prior && (prior.spelling !== spelling || !prior.directory || !isDirectory)) {
      throw new Error(`Unsafe path collision: ${spelling}`);
    }
    seen.set(key, { spelling, directory: isDirectory });
  }
}

function validateManifest(value: unknown, expectedId: string): SnapshotManifest {
  exactKeys(value, ['version', 'id', 'parentId', 'files']);
  if (value.version !== 1 || value.id !== expectedId || !Array.isArray(value.files)) {
    throw new Error('Invalid snapshot manifest');
  }
  if (value.parentId !== null) validateId(value.parentId);
  const files: SnapshotManifest['files'] = [];
  const seen = new Map<string, { spelling: string; directory: boolean }>();
  let previous: string | undefined;
  for (const entry of value.files) {
    exactKeys(entry, ['path', 'size', 'hash']);
    if (typeof entry.path !== 'string' || validateRelativePath(entry.path) !== entry.path) {
      throw new Error('Manifest path is not canonical');
    }
    if (previous !== undefined && entry.path <= previous) throw new Error('Manifest paths must be sorted and unique');
    previous = entry.path;
    if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error('Invalid manifest file size');
    }
    validateId(entry.hash);
    registerPath(seen, entry.path, false);
    files.push({ path: entry.path, size: entry.size, hash: entry.hash });
  }
  if (manifestId(value.parentId as string | null, files) !== expectedId) throw new Error('Manifest integrity hash mismatch');
  return { version: 1, id: expectedId, parentId: value.parentId as string | null, files };
}

export async function readSnapshot(storeDir: string, id: string): Promise<SnapshotManifest> {
  validateId(id);
  await assertSafeRoots([storeDir]);
  return validateManifest(JSON.parse(await readFile(path.join(storeDir, 'snapshots', `${id}.json`), 'utf8')), id);
}

export async function materializeSnapshot(storeDir: string, id: string, destinationDir: string): Promise<void> {
  assertDisjoint(storeDir, destinationDir);
  await assertSafeRoots([destinationDir]);
  const manifest = await readSnapshot(storeDir, id);
  await assertPhysicalDisjoint(storeDir, destinationDir);
  const destination = path.resolve(destinationDir);
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.peerhost-staging-${randomUUID()}`);
  await mkdir(staging);
  try {
    for (const file of manifest.files) {
      const target = path.join(staging, ...file.path.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      const copied = await streamObject(path.join(storeDir, 'objects', file.hash), target);
      if (copied.hash !== file.hash || copied.size !== file.size) {
        throw new Error(`Snapshot object integrity hash/size mismatch: ${file.path}`);
      }
      const verified = await hashFile(target);
      if (verified.hash !== file.hash || verified.size !== file.size) {
        throw new Error(`Staged file integrity hash/size mismatch: ${file.path}`);
      }
    }
    let exists = false;
    try {
      const stat = await lstat(destination);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Destination must be an ordinary directory');
      exists = true;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const backup = path.join(parent, `.peerhost-previous-${path.basename(destination)}-${randomUUID()}`);
    if (exists) await rename(destination, backup);
    try { await rename(staging, destination); }
    catch (error) {
      if (exists) await rename(backup, destination);
      throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function importServer(sourceDir: string, managedRoot: string): Promise<{
  serverDir: string; storeDir: string; snapshot: SnapshotManifest;
}> {
  assertDisjoint(sourceDir, managedRoot);
  await assertSafeRoots([sourceDir, managedRoot]);
  await assertPhysicalDisjoint(sourceDir, managedRoot);
  const root = path.resolve(managedRoot);
  const storeDir = path.join(root, 'store');
  const serverDir = path.join(root, 'servers', randomUUID());
  const snapshot = await createSnapshot(sourceDir, storeDir);
  await materializeSnapshot(storeDir, snapshot.id, serverDir);
  return { serverDir, storeDir, snapshot };
}

export async function createSnapshot(
  sourceDir: string, storeDir: string, parentId: string | null = null,
): Promise<SnapshotManifest> {
  assertDisjoint(sourceDir, storeDir);
  await assertSafeRoots([sourceDir, storeDir]);
  await assertPhysicalDisjoint(sourceDir, storeDir);
  if (!(await lstat(sourceDir)).isDirectory()) throw new Error('Source must be a directory');
  if (parentId !== null) await readSnapshot(storeDir, parentId);
  const before = await sourceInventory(sourceDir);
  const store = path.resolve(storeDir);
  await mkdir(path.join(store, 'objects'), { recursive: true });
  await mkdir(path.join(store, 'snapshots'), { recursive: true });
  const staging = path.join(store, `.staging-${randomUUID()}`);
  await mkdir(staging);
  const files: SnapshotManifest['files'] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = validateRelativePath(prefix ? `${prefix}/${entry.name}` : entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else {
        const temporary = path.join(staging, randomUUID());
        const result = await streamObject(absolute, temporary);
        await publish(temporary, path.join(store, 'objects', result.hash), result);
        files.push({ path: relative, size: result.size, hash: result.hash });
      }
    }
  }
  try {
    await visit(path.resolve(sourceDir), '');
    if (await sourceInventory(sourceDir) !== before) {
      throw new Error('Source changed during snapshot; a stopped, quiescent server is required');
    }
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const manifest: SnapshotManifest = { version: 1, id: manifestId(parentId, files), parentId, files };
    const temporary = path.join(staging, 'manifest.json');
    const encoded = JSON.stringify(manifest);
    await writeFile(temporary, encoded, { flag: 'wx' });
    await publish(temporary, path.join(store, 'snapshots', `${manifest.id}.json`), {
      size: Buffer.byteLength(encoded), hash: createHash('sha256').update(encoded).digest('hex'),
    });
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
