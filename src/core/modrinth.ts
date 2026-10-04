import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { isModName } from './mods.js';
import path from 'node:path';

export type ModLoader = 'fabric' | 'quilt' | 'forge' | 'neoforge';
export type ModSide = 'server' | 'client';
export const MOD_LOADERS: readonly ModLoader[] = ['fabric', 'quilt', 'forge', 'neoforge'];
export interface ModTarget { loader: ModLoader | null; gameVersion: string | null }

export const isModLoader = (value: unknown): value is ModLoader => typeof value === 'string' && (MOD_LOADERS as readonly string[]).includes(value);
export const isGameVersion = (value: unknown): value is string => typeof value === 'string' && value.length <= 32 && /^\d+(?:\.\d+){1,2}(?:-[0-9A-Za-z.]+)?$/.test(value);
/** Modrinth project ids are base62; slugs are short url-safe names. Both are accepted as a project key. */
export const isProjectKey = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{2,64}$/.test(value);

/**
 * Where a project belongs, from Modrinth's side metadata. "Optional" on both sides (common for libraries and
 * performance mods) defaults to the server; a dependency additionally inherits its parent's placement.
 */
export function placementFor(clientSide: string, serverSide: string): ModSide[] {
  const server = serverSide === 'required' || serverSide === 'optional';
  const client = clientSide === 'required';
  if (serverSide === 'unsupported') return ['client'];
  if (clientSide === 'unsupported') return ['server'];
  if (!['required', 'optional', 'unsupported'].includes(serverSide) || !['required', 'optional', 'unsupported'].includes(clientSide)) return ['server', 'client'];
  return server && client ? ['server', 'client'] : ['server'];
}

async function names(directory: string): Promise<string[]> {
  try { return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
  catch { return []; }
}
async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch { return false; }
}
const newest = (versions: string[]) => versions.filter(isGameVersion)
  .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] ?? null;

/** NeoForge numbers releases after the Minecraft version: 21.1.x is 1.21.1, 21.0.x is 1.21. */
function neoforgeGameVersion(version: string): string | null {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (!match) return null;
  const major = Number(match[1]), minor = Number(match[2]);
  if (major < 20 || major >= 26) return null;
  return minor === 0 ? `1.${major}` : `1.${major}.${minor}`;
}

/** Best-effort detection of the mod loader and Minecraft version from a server folder's launcher layout. */
export async function detectModTarget(serverDir: string): Promise<ModTarget> {
  const libraries = path.join(serverDir, 'libraries');
  const neoforge = newest(await names(path.join(libraries, 'net', 'neoforged', 'neoforge')).then((all) => all.map((v) => v.replace(/-beta$/, ''))))
    ?? (await names(path.join(libraries, 'net', 'neoforged', 'neoforge')))[0];
  if (neoforge) return { loader: 'neoforge', gameVersion: neoforgeGameVersion(neoforge) };
  const forge = (await names(path.join(libraries, 'net', 'minecraftforge', 'forge'))).map((v) => v.split('-')[0]!);
  if (forge.length) return { loader: 'forge', gameVersion: newest(forge) };
  const vanilla = newest([
    ...await names(path.join(serverDir, '.fabric', 'server')),
    ...await names(path.join(serverDir, 'versions')),
    ...await names(path.join(libraries, 'net', 'minecraft', 'server')),
  ]);
  if (await exists(path.join(serverDir, 'quilt-server-launcher.properties')) || await exists(path.join(serverDir, '.quilt'))) {
    return { loader: 'quilt', gameVersion: vanilla };
  }
  if (await exists(path.join(serverDir, '.fabric')) || await exists(path.join(serverDir, 'fabric-server-launcher.properties')) ||
      await exists(path.join(serverDir, 'fabric-server-launch.jar'))) {
    return { loader: 'fabric', gameVersion: vanilla };
  }
  return { loader: null, gameVersion: null };
}

export interface ModSearchHit {
  projectId: string; slug: string; title: string; author: string; description: string; downloads: number;
  iconUrl: string | null; placement: ModSide[];
}
export interface ModVersionFile { url: string; filename: string; size: number; sha512: string }
export interface ModDependency { projectId: string | null; versionId: string | null }
export interface ModVersion { id: string; projectId: string; versionNumber: string; file: ModVersionFile; loaders: string[]; gameVersions: string[]; requiredProjects: ModDependency[]; incompatibleProjects: ModDependency[] }
export interface ModProject { id: string; slug: string; title: string; placement: ModSide[]; supportedSides: ModSide[] }

export function assertModTarget(target: ModTarget): asserts target is { loader: ModLoader; gameVersion: string } {
  if (!isModLoader(target.loader) || !isGameVersion(target.gameVersion)) throw new Error('Set the mod loader and Minecraft version before browsing mods');
}
export function versionCompatible(version: ModVersion, target: { loader: ModLoader; gameVersion: string }): boolean {
  return version.gameVersions.includes(target.gameVersion) && version.loaders.some((loader) => loader === target.loader || target.loader === 'quilt' && loader === 'fabric');
}

const MAX_DOWNLOAD_BYTES = 512 * 1024 ** 2;
const MAX_JSON_BYTES = 8 * 1024 ** 2;
const ICON_HOSTS = new Set(['cdn.modrinth.com']);
const str = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : '';

/**
 * Minimal Modrinth v2 client. Only HTTPS to api.modrinth.com and downloads from Modrinth's CDN are allowed by
 * default; every downloaded file is checked against the SHA-512 published in its version metadata.
 */
export class ModrinthClient {
  private readonly apiBase: string;
  private readonly downloadHosts: Set<string>;
  private readonly userAgent: string;
  private readonly timeoutMs: number;

  constructor({ apiBase = 'https://api.modrinth.com/v2', downloadHosts = ['cdn.modrinth.com'], userAgent = 'envosloth/peerhost/0.2.1 (github.com/envosloth/peerhost)', timeoutMs = 20000 } = {}) {
    const api = new URL(apiBase);
    const local = api.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(api.hostname);
    if (api.username || api.password || api.search || api.hash || api.pathname.replace(/\/$/, '') !== '/v2' ||
        !(local || api.origin === 'https://api.modrinth.com')) throw new Error('Invalid Modrinth API endpoint');
    if (downloadHosts.some((host) => host !== 'cdn.modrinth.com' && !(local && host === api.host))) throw new Error('Only Modrinth CDN or the injected loopback fixture is trusted');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Invalid Modrinth timeout');
    this.apiBase = apiBase.replace(/\/$/, '');
    this.downloadHosts = new Set(downloadHosts);
    this.userAgent = userAgent;
    this.timeoutMs = timeoutMs;
  }

  private async request(url: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, { headers: { 'user-agent': this.userAgent, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new Error(`Modrinth is unreachable (${(error as Error).message}). Check your internet connection.`, { cause: error });
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) throw new Error('Modrinth rate limit reached. Wait a minute and try again.');
      if (response.status === 404) throw Object.assign(new Error('Mod not found on Modrinth (404)'), { code: 'ENOENT' });
      throw new Error(`Modrinth returned HTTP ${response.status}`);
    }
    return response;
  }

  private async json(pathAndQuery: string): Promise<unknown> {
    const response = await this.request(this.apiBase + pathAndQuery);
    if (!response.body) throw new Error('Modrinth returned no JSON');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) throw new Error('Modrinth response is unexpectedly large');
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try { return JSON.parse(text); } catch { throw new Error('Modrinth returned invalid JSON'); }
  }

  private static facets(target: Required<{ loader: ModLoader; gameVersion: string }>): string[][] {
    // Quilt runs Fabric mods, so a Quilt server can use either.
    const loaders = target.loader === 'quilt' ? ['categories:quilt', 'categories:fabric'] : [`categories:${target.loader}`];
    return [loaders, [`versions:${target.gameVersion}`], ['project_type:mod']];
  }

  async search(query: string, offset: number, target: { loader: ModLoader; gameVersion: string }, limit = 20): Promise<{ hits: ModSearchHit[]; total: number }> {
    assertModTarget(target);
    if (typeof query !== 'string' || query.length > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid mod query or offset');
    const params = new URLSearchParams({ query, offset: String(offset), limit: String(limit), index: query ? 'relevance' : 'downloads',
      facets: JSON.stringify(ModrinthClient.facets(target)) });
    const value = await this.json(`/search?${params}`) as { hits?: unknown[]; total_hits?: unknown };
    if (!value || !Array.isArray(value.hits)) throw new Error('Modrinth returned an unexpected search response');
    const hits: ModSearchHit[] = [];
    for (const raw of value.hits) {
      if (!raw || typeof raw !== 'object') continue;
      const hit = raw as Record<string, unknown>;
      if (!isProjectKey(hit.project_id) || !isProjectKey(hit.slug)) continue;
      let iconUrl: string | null = null;
      try {
        const icon = new URL(String(hit.icon_url));
        if (icon.protocol === 'https:' && !icon.username && !icon.password && ICON_HOSTS.has(icon.host)) iconUrl = icon.href;
      } catch { /* no icon */ }
      hits.push({ projectId: hit.project_id, slug: hit.slug, title: str(hit.title, 120) || hit.slug, author: str(hit.author, 80),
        description: str(hit.description, 300), downloads: Number.isSafeInteger(hit.downloads) ? hit.downloads as number : 0, iconUrl,
        placement: placementFor(str(hit.client_side, 20), str(hit.server_side, 20)) });
    }
    return { hits, total: Number.isSafeInteger(value.total_hits) ? value.total_hits as number : hits.length };
  }

  async project(key: string): Promise<ModProject> {
    if (!isProjectKey(key)) throw new Error('Invalid Modrinth project id');
    const value = await this.json(`/project/${encodeURIComponent(key)}`) as Record<string, unknown>;
    if (!isProjectKey(value?.id) || !isProjectKey(value.slug)) throw new Error('Modrinth returned an unexpected project');
    if (value.project_type !== undefined && value.project_type !== 'mod') throw new Error(`${str(value.title, 80)} is not a mod`);
    const supportedSides: ModSide[] = [];
    if (value.server_side !== 'unsupported') supportedSides.push('server');
    if (value.client_side !== 'unsupported') supportedSides.push('client');
    if (!supportedSides.length) throw new Error('Mod supports neither server nor client');
    return { id: value.id, slug: value.slug, title: str(value.title, 120) || value.slug, placement: placementFor(str(value.client_side, 20), str(value.server_side, 20)), supportedSides };
  }

  /** Newest compatible version, preferring releases over betas and alphas. */
  async compatibleVersion(key: string, target: { loader: ModLoader; gameVersion: string }, title = key): Promise<ModVersion> {
    assertModTarget(target);
    if (!isProjectKey(key)) throw new Error('Invalid Modrinth project id');
    const loaders = target.loader === 'quilt' ? ['quilt', 'fabric'] : [target.loader];
    const params = new URLSearchParams({ loaders: JSON.stringify(loaders), game_versions: JSON.stringify([target.gameVersion]) });
    const versions = await this.json(`/project/${encodeURIComponent(key)}/version?${params}`);
    if (!Array.isArray(versions)) throw new Error('Modrinth returned an unexpected version list');
    const rank = (type: unknown) => type === 'release' ? 0 : type === 'beta' ? 1 : 2;
    const chosen = versions.map((v) => v as Record<string, unknown>)
      .filter((v) => v && Array.isArray(v.files) && v.files.length && Array.isArray(v.game_versions) && v.game_versions.includes(target.gameVersion) && Array.isArray(v.loaders) && v.loaders.some((loader) => loaders.includes(loader as ModLoader)))
      .sort((a, b) => rank(a.version_type) - rank(b.version_type) || str(b.date_published, 40).localeCompare(str(a.date_published, 40)))[0];
    if (!chosen) throw new Error(`${title} has no version for ${target.loader} ${target.gameVersion}`);
    return parseVersion(chosen);
  }

  async version(id: string): Promise<ModVersion> {
    if (!isProjectKey(id)) throw new Error('Invalid Modrinth version id');
    return parseVersion(await this.json(`/version/${encodeURIComponent(id)}`) as Record<string, unknown>);
  }

  /** Download into `directory` under a temporary name, verify size and SHA-512, and return the verified path. */
  async download(file: ModVersionFile, directory: string): Promise<string> {
    validateVersionFile(file);
    let url: URL;
    try { url = new URL(file.url); } catch { throw new Error('Modrinth returned an invalid download URL'); }
    if (url.username || url.password || !this.downloadHosts.has(url.host)) throw new Error(`${url.host} is not an allowed download host; only Modrinth's CDN is trusted`);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) {
      throw new Error('Mod downloads must use HTTPS');
    }
    if (file.size > MAX_DOWNLOAD_BYTES) throw new Error(`${file.filename} is larger than 512 MiB`);
    await mkdir(directory, { recursive: true });
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Download folder must be an ordinary directory');
    const response = await this.request(url.href);
    if (!response.body) throw new Error('Download returned no data');
    const temporary = path.join(directory, `${randomUUID()}.download`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    const hash = createHash('sha512');
    let size = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > file.size || size > MAX_DOWNLOAD_BYTES) throw new Error(`${file.filename} is larger than Modrinth says it should be`);
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
          if (!bytesWritten) throw new Error('Download write made no progress');
          offset += bytesWritten;
        }
      }
      await handle.sync();
    } catch (error) {
      await handle.close();
      await rm(temporary, { force: true });
      throw error;
    }
    await handle.close();
    if (size !== file.size || hash.digest('hex') !== file.sha512) {
      await rm(temporary, { force: true });
      throw new Error(`${file.filename} failed its integrity check (SHA-512 or size mismatch); it was discarded`);
    }
    const verified = path.join(directory, file.filename);
    try { await link(temporary, verified); }
    finally { await rm(temporary, { force: true }); }
    return verified;
  }
}

function parseVersion(value: Record<string, unknown>): ModVersion {
  if (!isProjectKey(value?.id) || !isProjectKey(value.project_id) || !Array.isArray(value.files)) throw new Error('Modrinth returned an unexpected version');
  const files = value.files.filter((f) => f && typeof f === 'object').map((f) => f as Record<string, unknown>);
  const raw = files.find((f) => f.primary === true) ?? files[0]!;
  if (!raw) throw new Error('Modrinth returned a version without a verifiable file');
  const hashes = raw.hashes as Record<string, unknown> | undefined;
  const filename = raw.filename;
  if (typeof raw.url !== 'string' || !filename || !/^[a-f0-9]{128}$/.test(String(hashes?.sha512)) || !Number.isSafeInteger(raw.size)) {
    throw new Error('Modrinth returned a version without a verifiable file');
  }
  if (!Array.isArray(value.dependencies) || value.dependencies.length > 200 || value.dependencies.some((d) => !d || typeof d !== 'object')) throw new Error('Invalid or excessive mod dependency metadata');
  const dependencies = value.dependencies as Record<string, unknown>[];
  const parseDependency = (d: Record<string, unknown>): ModDependency => {
    if ((d.project_id != null && !isProjectKey(d.project_id)) || (d.version_id != null && !isProjectKey(d.version_id)) || (!d.project_id && !d.version_id)) throw new Error('Unresolvable required mod dependency or conflict');
    return { projectId: (d.project_id as string | null) ?? null, versionId: (d.version_id as string | null) ?? null };
  };
  return {
    id: value.id, projectId: value.project_id, versionNumber: str(value.version_number, 64),
    loaders: Array.isArray(value.loaders) ? value.loaders.filter((v): v is string => typeof v === 'string') : [],
    gameVersions: Array.isArray(value.game_versions) ? value.game_versions.filter((v): v is string => typeof v === 'string') : [],
    file: checkedFile({ url: raw.url, filename: filename as string, size: raw.size as number, sha512: String(hashes!.sha512) }),
    requiredProjects: dependencies.filter((d) => d.dependency_type === 'required').map(parseDependency),
    incompatibleProjects: dependencies.filter((d) => d.dependency_type === 'incompatible').map(parseDependency),
  };
}

function validateVersionFile(file: ModVersionFile): void {
  if (!file || !isModName(file.filename)) throw new Error('Modrinth returned an unsafe mod filename');
  if (typeof file.url !== 'string' || file.url.length > 4096 || !/^[a-f0-9]{128}$/.test(file.sha512) || !Number.isSafeInteger(file.size) || file.size < 4 || file.size > MAX_DOWNLOAD_BYTES) throw new Error('Modrinth returned a file without verifiable size or SHA-512');
}
function checkedFile(file: ModVersionFile): ModVersionFile { validateVersionFile(file); return file; }
