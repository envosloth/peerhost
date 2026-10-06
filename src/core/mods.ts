import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, readdir, rm, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { validateRelativePath } from './paths.js';
import { writeZip } from './zip.js';
import type { ModSource } from './mod-index.js';
import { assertModInstallComplete, beginModInstall, finishModInstall, modIndexFingerprint, syncModDirectory, syncOpenFlags } from './mod-transaction.js';

export type ModKind = 'server' | 'client';
/** Client-only mods live here inside the managed server, so they travel with snapshots but are never loaded. */
export const CLIENT_PACK_DIR = 'seedhost-client-mods';
export interface ModEntry { name: string; size: number; source?: ModSource }

const MAX_MOD_BYTES = 512 * 1024 ** 2;
const MAX_BATCH = 200;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export const isModKind = (value: unknown): value is ModKind => value === 'server' || value === 'client';

/** A single safe `.jar` filename (no separators, no Windows device names, no trailing dots or spaces). */
export function isModName(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 255 || /[\\/]/.test(value) || !/\.jar$/i.test(value)) return false;
  try { return validateRelativePath(value) === value; } catch { return false; }
}

export function modsDirectory(serverDir: string, kind: ModKind): string {
  return path.join(serverDir, kind === 'server' ? 'mods' : CLIENT_PACK_DIR);
}

export async function ordinaryDirectory(directory: string, create: boolean): Promise<boolean> {
  try {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing to use ${directory}: it is not an ordinary folder`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (!create) return false;
    await mkdir(directory);
    return true;
  }
}

/** `.jar` files in the folder, sorted by name. Other files (configs, disabled jars) are left alone and not listed. */
export async function listMods(serverDir: string, kind: ModKind): Promise<ModEntry[]> {
  const directory = modsDirectory(serverDir, kind);
  if (!await ordinaryDirectory(directory, false)) return [];
  const mods: ModEntry[] = [];
  for (const name of await readdir(directory)) {
    if (!/\.jar$/i.test(name)) continue;
    const stat = await lstat(path.join(directory, name));
    if (stat.isFile()) mods.push({ name, size: stat.size });
  }
  return mods.sort((a, b) => a.name.localeCompare(b.name));
}

async function inspectSource(source: string, name = path.basename(source)): Promise<{ name: string; size: number }> {
  if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error(`Mod paths must be absolute: ${String(source)}`);

  if (!/\.jar$/i.test(name)) throw new Error(`${name} is not a .jar file`);
  if (!isModName(name)) throw new Error(`${name} has a reserved or unsafe file name`);
  const stat = await lstat(source);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${name} must be a regular file, not a symlink or folder`);
  if (stat.size > MAX_MOD_BYTES) throw new Error(`${name} is larger than 512 MiB`);
  const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    if (bytesRead !== 4 || !header.equals(ZIP_MAGIC)) throw new Error(`${name} is not a valid jar (it is not a zip archive)`);
  } finally { await handle.close(); }
  return { name, size: stat.size };
}

/**
 * Copy jars into the server's mods folder or the client pack. The whole batch is validated before anything is
 * copied; each copy goes to a temporary name and is published by hard link, so a name is never overwritten and an
 * interrupted copy never leaves a half-written `.jar` for the server to load.
 */
export async function addMods(serverDir: string, kind: ModKind, sources: string[]): Promise<string[]> {
  if (!Array.isArray(sources)) throw new Error('Choose at least one .jar file');
  return addModBatch(serverDir, sources.map((source) => ({ kind, source })));
}

/** Fenced transaction across both folders. Proven ordinary failures roll back; uncertainty requires explicit repair. */
export async function addModBatch(serverDir: string, items: Array<{ kind: ModKind; source: string }>, commit?: () => Promise<void>): Promise<string[]> {
  await assertModInstallComplete(serverDir);
  if (!Array.isArray(items) || !items.length) throw new Error('Choose at least one .jar file');
  if (items.length > MAX_BATCH) throw new Error(`Add at most ${MAX_BATCH} mods at a time`);
  const existing = new Set<string>();
  for (const kind of ['server', 'client'] as const) {
    const directory = modsDirectory(serverDir, kind);
    if (await ordinaryDirectory(directory, false)) {
      for (const name of await readdir(directory)) existing.add(`${kind}:${name.toLowerCase()}`);
    }
  }
  const batch = new Set<string>();
  const inspected = [];
  for (const { kind, source } of items) {
    if (!isModKind(kind)) throw new Error('Mod kind must be server or client');
    const mod = await inspectSource(source);
    const key = `${kind}:${mod.name.toLowerCase()}`;
    if (existing.has(key)) throw new Error(`${mod.name} is already installed. Remove the old copy first to replace it.`);
    if (batch.has(key)) throw new Error(`${mod.name} was chosen twice`);
    batch.add(key);
    inspected.push({ source, kind, ...mod });
  }
  const added: string[] = [];
  const staged: Array<{ temporary: string; destination: string; name: string; identity?: { dev: number; ino: number; size: number; mtimeMs: number } }> = [];
  const published: typeof staged = [];
  const created: string[] = [];
  const metadataBefore = commit ? await modIndexFingerprint(serverDir) : null;
  const transaction = await beginModInstall(serverDir, inspected.map(({ kind, name }) => ({ kind, name })));
  let complete = false;
  let commitStarted = false, commitSucceeded = false;
  let publishUncertain = false;
  try {
    for (const mod of inspected) {
      const directory = modsDirectory(serverDir, mod.kind);
      if (!await ordinaryDirectory(directory, false)) { await ordinaryDirectory(directory, true); created.push(directory); }
      const temporary = path.join(directory, `.seedhost-adding-${randomUUID()}.tmp`);
      const entry: (typeof staged)[number] = { temporary, destination: path.join(directory, mod.name), name: mod.name };
      staged.push(entry);
      await copyFile(mod.source, temporary, constants.COPYFILE_EXCL);
      const stagedMod = await inspectSource(temporary, mod.name);
      if (stagedMod.size !== mod.size) throw new Error(`${mod.name} changed during the copy`);
      const handle = await open(temporary, syncOpenFlags('file'));
      try { await handle.sync(); entry.identity = await handle.stat(); } finally { await handle.close(); }
    }
    for (const mod of staged) {
      publishUncertain = true;
      await link(mod.temporary, mod.destination);
      published.push(mod);
      publishUncertain = false;
      added.push(mod.name);
    }
    for (const directory of new Set(staged.map((mod) => path.dirname(mod.destination)))) await syncModDirectory(directory);
    commitStarted = !!commit;
    await commit?.();
    commitSucceeded = !!commit;
    await syncModDirectory(serverDir);
    complete = true;
  } catch (error) {
    // A callback may have renamed its index and THEN failed. Never delete jars on an uncertain commit.
    if (commitSucceeded || publishUncertain) throw error;
    if (commitStarted) {
      let metadataAfter;
      try { metadataAfter = await modIndexFingerprint(serverDir); }
      catch (verificationError) { throw new AggregateError([error, verificationError], 'Mod install failed; explicit repair is required'); }
      if (metadataAfter !== metadataBefore) throw error;
    }
    for (const mod of published) {
      const stat = await lstat(mod.destination);
      const owned = mod.identity;
      if (!owned || !stat.isFile() || stat.isSymbolicLink() || stat.dev !== owned.dev || stat.ino !== owned.ino || stat.size !== owned.size || stat.mtimeMs !== owned.mtimeMs) {
        throw new AggregateError([error], 'Mod install rollback ownership is uncertain; explicit repair is required');
      }
    }
    for (const mod of published.reverse()) await rm(mod.destination);
    for (const directory of new Set(published.map((mod) => path.dirname(mod.destination)))) await syncModDirectory(directory);
    complete = true;
    throw error;
  } finally {
    for (const mod of staged) await rm(mod.temporary, { force: true });
    for (const directory of new Set(staged.map((mod) => path.dirname(mod.temporary)))) await syncModDirectory(directory);
    for (const directory of created) {
      if (!(await readdir(directory)).length) await rmdir(directory);
    }
    await syncModDirectory(serverDir);
    if (complete) await finishModInstall(serverDir, transaction);
  }
  return added;
}

export async function removeMod(serverDir: string, kind: ModKind, name: string): Promise<void> {
  if (!isModKind(kind) || !isModName(name)) throw new Error('Unsafe mod name');
  if (!(await listMods(serverDir, kind)).some((mod) => mod.name === name)) throw new Error(`${name} is not installed`);
  await rm(path.join(modsDirectory(serverDir, kind), name));
}

const README = `Client mods for this server
===========================

1. Install the same mod loader (Fabric, Forge, NeoForge...) and Minecraft version the server uses.
2. Copy every .jar from the "mods" folder in this zip into your game's mods folder:
     Windows: %APPDATA%\\.minecraft\\mods
     macOS:   ~/Library/Application Support/minecraft/mods
     Linux:   ~/.minecraft/mods
   (Launchers such as Prism or CurseForge use the instance's own mods folder instead.)
3. Start the game and join the server.

Only install mods from people you trust: mods run code on your computer.
Exported by SeedHost.
`;

/** Zip the client pack (plus install instructions) for players. The destination must be outside the server folder. */
export async function exportClientPack(serverDir: string, destination: string): Promise<{ mods: number; bytes: number }> {
  if (typeof destination !== 'string' || !path.isAbsolute(destination) || !/\.zip$/i.test(destination)) {
    throw new Error('Choose an absolute destination ending in .zip');
  }
  const server = path.resolve(serverDir), target = path.resolve(destination);
  const relative = path.relative(server, target);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    throw new Error('Save the client pack outside the server folder, or it would be copied into every snapshot');
  }
  const mods = await listMods(serverDir, 'client');
  if (!mods.length) throw new Error('There are no client mods to export. Add some to the client pack first.');
  const directory = modsDirectory(serverDir, 'client');
  const { bytes } = await writeZip(target, [
    { name: 'README.txt', data: Buffer.from(README.replace(/\n/g, '\r\n')) },
    ...mods.map((mod) => ({ name: `mods/${mod.name}`, file: path.join(directory, mod.name) })),
  ]);
  return { mods: mods.length, bytes };
}
