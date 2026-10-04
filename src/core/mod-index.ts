import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { isModKind, isModName, listMods, modsDirectory, type ModEntry, type ModKind } from './mods.js';
import { detectModTarget, isGameVersion, isModLoader, isProjectKey, type ModLoader, type ModTarget } from './modrinth.js';

export interface ModSource { provider: 'modrinth'; projectId: string; versionId: string; slug: string; title: string; versionNumber: string; sha512: string; loader: ModLoader; gameVersion: string }
export interface IndexedMod { kind: ModKind; name: string; source: ModSource }
export interface ModIndex { version: 1; target: ModTarget | null; mods: IndexedMod[] }
export const MOD_INDEX_FILE = 'peerhost-mods.json';
const LIMIT = 1024 * 1024;

function validateIndex(value: unknown): ModIndex {
  const v = value as ModIndex;
  if (!v || v.version !== 1 || !Array.isArray(v.mods) || v.mods.length > 2000 || v.target !== null && (!v.target || !isModLoader(v.target.loader) || !isGameVersion(v.target.gameVersion))) throw new Error('Invalid server mod index');
  const names = new Set<string>();
  for (const mod of v.mods) {
    const s = mod?.source;
    const key = `${mod?.kind}:${mod?.name?.toLowerCase()}`;
    if (!mod || !isModKind(mod.kind) || !isModName(mod.name) || names.has(key) || !s || s.provider !== 'modrinth' ||
        !isProjectKey(s.projectId) || !isProjectKey(s.versionId) || !isProjectKey(s.slug) || !isModLoader(s.loader) || !isGameVersion(s.gameVersion) ||
        typeof s.sha512 !== 'string' || !/^[a-f0-9]{128}$/.test(s.sha512) || typeof s.title !== 'string' || s.title.length > 120 || typeof s.versionNumber !== 'string' || s.versionNumber.length > 64) throw new Error('Invalid server mod provenance');
    names.add(key);
  }
  return v;
}

export async function readModIndex(serverDir: string): Promise<ModIndex> {
  let handle;
  try { handle = await open(path.join(serverDir, MOD_INDEX_FILE), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, target: null, mods: [] };
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > LIMIT) throw new Error('Server mod index is not an ordinary bounded file');
    const data = Buffer.alloc(LIMIT + 1);
    let size = 0;
    while (size <= LIMIT) {
      const { bytesRead } = await handle.read(data, size, data.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > LIMIT) throw new Error('Server mod index is too large');
    return validateIndex(JSON.parse(data.subarray(0, size).toString('utf8')));
  } finally { await handle.close(); }
}

/** An atomic, flushed index inside the server: snapshots and handoffs carry it without local profile changes. */
export async function writeModIndex(serverDir: string, index: ModIndex): Promise<void> {
  validateIndex(index);
  const text = JSON.stringify(index);
  if (Buffer.byteLength(text) > LIMIT) throw new Error('Server mod index is too large');
  const file = path.join(serverDir, MOD_INDEX_FILE);
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Server mod index must be an ordinary file');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o644);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export async function modTarget(serverDir: string, index?: ModIndex): Promise<ModTarget & { detected: boolean }> {
  const saved = index ?? await readModIndex(serverDir);
  return saved.target ? { ...saved.target, detected: false } : { ...await detectModTarget(serverDir), detected: true };
}

import type { BigIntStats } from 'node:fs';

export type ModVerificationCache = Map<string, { stamp: string; matches: boolean }>;
const fileStamp = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

/** Cache is for UI status only. Mutations omit it and always verify the complete file. */
export async function sourceMatches(serverDir: string, mod: IndexedMod, cache?: ModVerificationCache): Promise<boolean> {
  const directory = modsDirectory(serverDir, mod.kind);
  const folder = await lstat(directory).catch(() => null);
  if (!folder?.isDirectory() || folder.isSymbolicLink()) return false;
  let handle;
  try { handle = await open(path.join(directory, mod.name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch { return false; }
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.size > BigInt(512 * 1024 ** 2)) return false;
    const key = `${path.join(directory, mod.name)}:${mod.source.sha512}`;
    const stamp = fileStamp(stat);
    const cached = cache?.get(key);
    if (cached?.stamp === stamp) return cached.matches;
    const hash = createHash('sha512');
    const chunk = Buffer.alloc(64 * 1024);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > stat.size) return false;
      hash.update(chunk.subarray(0, bytesRead));
    }
    const matches = BigInt(size) === stat.size && hash.digest('hex') === mod.source.sha512;
    if (fileStamp(await handle.stat({ bigint: true })) !== stamp) return false;
    if (cache) {
      if (cache.size >= 4000) cache.clear();
      cache.set(key, { stamp, matches });
    }
    return matches;
  } finally { await handle.close(); }
}

export async function indexedMods(serverDir: string, kind: ModKind, index: ModIndex, cache?: ModVerificationCache): Promise<ModEntry[]> {
  const entries = await listMods(serverDir, kind);
  for (const entry of entries) {
    const indexed = index.mods.find((mod) => mod.kind === kind && mod.name === entry.name);
    if (indexed && await sourceMatches(serverDir, indexed, cache)) entry.source = { ...indexed.source };
  }
  return entries;
}
