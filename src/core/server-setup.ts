import { execFile } from 'node:child_process';
import path from 'node:path';
import { realpath, stat, lstat, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { writeZip } from './zip.js';
import { createHash } from 'node:crypto';
import { validateLaunchProfile, type LaunchProfile } from './saved-state.js';

export interface CreateServerInput {
  name: string;
  loader: 'vanilla' | 'fabric';
  gameVersion: string;
  javaExecutable: string;
  memoryMiB: number;
  eulaAccepted: boolean;
}
export interface PreparedServer {
  sourceDir: string;
  profile: LaunchProfile;
  loader: 'vanilla' | 'fabric';
  gameVersion: string;
}

export interface JavaRuntime { executable: string; major: number; version: string }

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid official metadata object');
  return value as JsonObject;
}
const versionId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value) && !value.includes('..');
const isHash = (value: unknown, length: number): value is string => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
type Release = { id: string; url: string; sha1: string };
export interface ServerSetupOptions {
  /** Unit tests only: explicit numeric loopback origin, never exposed via IPC or saved settings. */
  testOnly?: { origin: string; timeoutMs?: number; operationTimeoutMs?: number; maxMetadataBytes?: number; maxArtifactBytes?: number };
}
function validateJavaExecutable(executable: unknown): asserts executable is string {
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || executable.length > 4096 || /[\0\r\n]/.test(executable) || /\.(?:cmd|bat)$/i.test(executable)) throw new Error('Choose an absolute native-selected Java executable, not a shell command');
}
function validateCreateInput(input: CreateServerInput): void {
  object(input);
  if (Object.keys(input).sort().join(',') !== 'eulaAccepted,gameVersion,javaExecutable,loader,memoryMiB,name' ||
      typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || /[\x00-\x1f\x7f<>:"/\\|?*]/.test(input.name) || /[ .]$/.test(input.name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(input.name) ||
      !versionId(input.gameVersion) || !['vanilla', 'fabric'].includes(input.loader) || !Number.isInteger(input.memoryMiB) || input.memoryMiB < 256 || input.memoryMiB > 1048576 || typeof input.eulaAccepted !== 'boolean') throw new Error('Invalid new-server input');
  validateJavaExecutable(input.javaExecutable);
}
const UNOBFUSCATED_INTERMEDIARY = 'net.fabricmc:intermediary:0.0.0';
/** Requires exactly the mappings Fabric's loader metadata declares. Releases from Minecraft 26.1 on are
 * unobfuscated: Fabric declares the placeholder intermediary 0.0.0 and the server profile carries none.
 * Older releases declare (or, in older metadata, imply) `intermediary:<gameVersion>`, which must be present.
 * Anything else fails closed. */
export function checkFabricMappings(declared: unknown, names: ReadonlySet<string>, loaderVersion: string, gameVersion: string): void {
  if (!names.has(`net.fabricmc:fabric-loader:${loaderVersion}`)) throw new Error(`Fabric profile is missing its loader ${loaderVersion}`);
  const intermediaries = [...names].filter(name => name.startsWith('net.fabricmc:intermediary:'));
  if (declared === UNOBFUSCATED_INTERMEDIARY) {
    if (intermediaries.length) throw new Error('Fabric profile lists intermediary mappings for an unobfuscated release');
    return;
  }
  const expected = `net.fabricmc:intermediary:${gameVersion}`;
  if (declared !== undefined && declared !== expected) throw new Error('Fabric loader metadata declares unexpected intermediary mappings');
  if (intermediaries.length !== 1 || intermediaries[0] !== expected) throw new Error('Fabric profile is missing its intermediary mappings for this release');
}
export class ServerSetupClient {
  private readonly timeoutMs: number;
  private readonly operationTimeoutMs: number;
  private readonly maxMetadataBytes: number;
  private readonly maxArtifactBytes: number;
  private readonly testOrigin?: string;
  private readonly origin: string;
  constructor(options: ServerSetupOptions = {}) {
    if (!options || Object.keys(options).some(key => key !== 'testOnly')) throw new Error('Invalid server setup options');
    if (options.testOnly !== undefined) {
      if (!options.testOnly || Object.keys(options.testOnly).some(key => !['origin', 'timeoutMs', 'operationTimeoutMs', 'maxMetadataBytes', 'maxArtifactBytes'].includes(key))) throw new Error('Invalid test options');
      const url = new URL(options.testOnly.origin);
      if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.origin !== options.testOnly.origin) throw new Error('Tests require an explicit numeric loopback origin');
      this.testOrigin = url.origin;
    }
    this.origin = this.testOrigin ?? 'https://piston-meta.mojang.com';
    const lowerBound = (value: number | undefined, maximum: number) => {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum)) throw new Error('Invalid test limit options');
      return value ?? maximum;
    };
    this.timeoutMs = lowerBound(options.testOnly?.timeoutMs, 30000);
    this.operationTimeoutMs = lowerBound(options.testOnly?.operationTimeoutMs, 600000);
    this.maxMetadataBytes = lowerBound(options.testOnly?.maxMetadataBytes, 8 * 1024 ** 2);
    this.maxArtifactBytes = lowerBound(options.testOnly?.maxArtifactBytes, 256 * 1024 ** 2);
  }
  private allowed(raw: unknown, hosts: string[]): string {
    if (typeof raw !== 'string' || raw.length > 2048) throw new Error('URL is not allowed');
    const url = new URL(raw);
    if (url.username || url.password || url.hash || url.search || (this.testOrigin ? url.origin !== this.testOrigin : url.protocol !== 'https:' || url.port !== '' || !hosts.includes(url.hostname))) throw new Error('URL is not an allowed official HTTPS endpoint');
    return url.href;
  }
  private async bytes(raw: unknown, hosts: string[], maxBytes = this.maxMetadataBytes, operation?: AbortSignal): Promise<Buffer> {
    const url = this.allowed(raw, hosts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Official download timeout')), this.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const signal = operation ? AbortSignal.any([controller.signal, operation]) : controller.signal;
      const response = await fetch(url, { redirect: 'manual', signal });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Official metadata request failed (redirects are refused)'); }
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) { await response.body?.cancel(); throw new Error('Official response is too large'); }
      if (!response.body) throw new Error('Empty official response');
      reader = response.body.getReader();
      const chunks: Buffer[] = []; let total = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.length;
        if (total > maxBytes) throw new Error('Official response is too large');
        chunks.push(Buffer.from(chunk.value));
      }
      return Buffer.concat(chunks, total);
    } finally {
      clearTimeout(timer);
      await reader?.cancel().catch(() => undefined);
      controller.abort();
    }
  }
  private async releases(operation?: AbortSignal): Promise<{ latest: string; versions: Release[] }> {
    const manifest = object(JSON.parse((await this.bytes(this.origin + '/mc/game/version_manifest_v2.json', ['piston-meta.mojang.com'], this.maxMetadataBytes, operation)).toString('utf8')));
    const latest = object(manifest.latest).release;
    if (!versionId(latest) || !Array.isArray(manifest.versions) || manifest.versions.length > 10000) throw new Error('Invalid official release manifest');
    const versions: Release[] = []; const ids = new Set<string>();
    for (const raw of manifest.versions) {
      const entry = object(raw);
      if (entry.type !== 'release') continue;
      if (!versionId(entry.id) || ids.has(entry.id) || !isHash(entry.sha1, 40)) throw new Error('Invalid official release manifest');
      const url = this.allowed(entry.url, ['piston-meta.mojang.com', 'launchermeta.mojang.com']);
      ids.add(entry.id); versions.push({ id: entry.id, url, sha1: entry.sha1 });
    }
    if (!ids.has(latest)) throw new Error('Latest version is missing from release manifest');
    return { latest, versions };
  }
  /** Mirrors Fabric's ServerInstaller data-only manifest bootstrap; executable code remains
   * in checksum-verified Maven jars. The Meta /server/jar endpoint has no published checksum.
   * https://github.com/FabricMC/fabric-installer/blob/master/src/main/java/net/fabricmc/installer/server/ServerInstaller.java
   */
  private async prepareFabric(sourceDir: string, gameVersion: string, javaMajor: number, remainingBytes: number, operation: AbortSignal): Promise<void> {
    const meta = this.testOrigin ?? 'https://meta.fabricmc.net';
    const maven = this.testOrigin ?? 'https://maven.fabricmc.net';
    const loaderVersion = '0.19.5'; // Audited modern launcher layout; fail closed on unsupported upstream changes.
    const loaders: unknown = JSON.parse((await this.bytes(`${meta}/v2/versions/loader/${gameVersion}`, ['meta.fabricmc.net'], this.maxMetadataBytes, operation)).toString('utf8'));
    if (!Array.isArray(loaders) || loaders.length > 1024) throw new Error('Invalid Fabric loader metadata');
    const selected = loaders.map(object).find(entry => object(entry.loader).version === loaderVersion);
    if (!selected) throw new Error(`Verified Fabric Loader ${loaderVersion} is not available for this game version`);
    const launcher = object(selected.launcherMeta);
    if (launcher.version !== 2 || typeof launcher.min_java_version !== 'number' || !Number.isInteger(launcher.min_java_version) || launcher.min_java_version < 8 || launcher.min_java_version > 100) throw new Error('Unsupported Fabric launcher metadata');
    if (javaMajor < launcher.min_java_version) throw new Error(`Fabric requires Java ${launcher.min_java_version} or newer`);
    const profile = object(JSON.parse((await this.bytes(`${meta}/v2/versions/loader/${gameVersion}/${loaderVersion}/server/json`, ['meta.fabricmc.net'], this.maxMetadataBytes, operation)).toString('utf8')));
    if (profile.id !== `fabric-loader-${loaderVersion}-${gameVersion}` || profile.inheritsFrom !== gameVersion || profile.mainClass !== 'net.fabricmc.loader.impl.launch.knot.KnotServer' || !Array.isArray(profile.libraries) || profile.libraries.length < 2 || profile.libraries.length > 64) throw new Error('Unsupported Fabric server profile');
    const names = new Set<string>();
    const libraries = profile.libraries.map((raw, index) => {
      const library = object(raw);
      if (typeof library.name !== 'string' || !/^[a-z0-9]+(?:\.[a-z0-9]+)*:[A-Za-z0-9_-]+:[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(library.name) || library.name.includes('..') || names.has(library.name)) throw new Error('Unsafe Fabric Maven coordinate');
      names.add(library.name);
      if (this.allowed(library.url, ['maven.fabricmc.net']) !== maven + '/') throw new Error('Fabric library is not from official Maven');
      const [group, artifact, version] = library.name.split(':') as [string, string, string];
      const url = `${maven}/${group.replaceAll('.', '/')}/${artifact}/${version}/${artifact}-${version}.jar`;
      const size = library.size;
      if (size !== undefined && (!Number.isSafeInteger(size) || (size as number) < 1 || (size as number) > this.maxArtifactBytes)) throw new Error('Invalid Fabric library size');
      if (library.sha256 !== undefined && !isHash(library.sha256, 64)) throw new Error('Invalid Fabric library integrity metadata');
      return { url, size, checksum: library.sha256 as string | undefined, filename: `libraries/lib-${index}.jar` };
    });
    checkFabricMappings(selected.intermediary === undefined ? undefined : object(selected.intermediary).maven, names, loaderVersion, gameVersion);
    await mkdir(path.join(sourceDir, 'libraries'));
    for (const library of libraries) {
      const checksum = library.checksum ?? (await this.bytes(library.url + '.sha256', ['maven.fabricmc.net'], 256, operation)).toString('utf8').trim();
      if (!isHash(checksum, 64)) throw new Error('Fabric Maven SHA-256 checksum is missing or invalid; no unverified fallback');
      if (remainingBytes < 1 || library.size !== undefined && (library.size as number) > remainingBytes) throw new Error('Server executable download budget exceeded');
      const bytes = await this.bytes(library.url, ['maven.fabricmc.net'], Math.min((library.size as number | undefined) ?? this.maxArtifactBytes, remainingBytes), operation);
      remainingBytes -= bytes.length;
      if (!bytes.length || library.size !== undefined && bytes.length !== library.size || createHash('sha256').update(bytes).digest('hex') !== checksum) throw new Error('Fabric library integrity check failed');
      await writeFile(path.join(sourceDir, library.filename), bytes, { flag: 'wx', mode: 0o600 });
    }
    const header = (name: string, value: string) => {
      let line = `${name}: ${value}`; const lines: string[] = [];
      while (line.length > 72) { lines.push(line.slice(0, 72)); line = ' ' + line.slice(72); }
      return [...lines, line].join('\r\n') + '\r\n';
    };
    const manifest = 'Manifest-Version: 1.0\r\n' + header('Main-Class', 'net.fabricmc.loader.impl.launch.server.FabricServerLauncher') + header('Class-Path', libraries.map(library => library.filename).join(' ')) + '\r\n';
    await writeZip(path.join(sourceDir, 'fabric-server-launch.jar'), [
      { name: 'META-INF/MANIFEST.MF', data: Buffer.from(manifest) },
      { name: 'fabric-server-launch.properties', data: Buffer.from(`launch.mainClass=${profile.mainClass}\n`) },
    ]);
  }
  async prepare(stagingParent: string, input: CreateServerInput): Promise<PreparedServer> {
    validateCreateInput(input);
    input = { ...input }; // Consent and selected runtime/version cannot change while downloads await.
    const operation = AbortSignal.timeout(this.operationTimeoutMs);
    if (typeof stagingParent !== 'string' || !path.isAbsolute(stagingParent) || /[\0\r\n]/.test(stagingParent) || stagingParent.length > 4096) throw new Error('Invalid trusted staging parent');
    const stage = await lstat(stagingParent).catch(() => null);
    if (!stage?.isDirectory() || stage.isSymbolicLink()) throw new Error('Choose an existing non-symlink staging directory');
    const release = (await this.releases(operation)).versions.find(version => version.id === input.gameVersion);
    if (!release) throw new Error('Choose a supported official release version');
    const raw = await this.bytes(release.url, ['piston-meta.mojang.com', 'launchermeta.mojang.com'], this.maxMetadataBytes, operation);
    if (createHash('sha1').update(raw).digest('hex') !== release.sha1) throw new Error('Version metadata integrity check failed');
    const metadata = object(JSON.parse(raw.toString('utf8')));
    if (metadata.id !== input.gameVersion) throw new Error('Version metadata does not match selected release');
    let required: unknown;
    try { required = object(metadata.javaVersion).majorVersion; } catch { throw new Error('Official Java requirement is missing or unsupported; use Import for this release'); }
    if (typeof required !== 'number' || !Number.isInteger(required) || required < 8 || required > 100) throw new Error('Official Java requirement is missing or unsupported');
    const java = await probeJava(input.javaExecutable);
    if (java.major < required) throw new Error(`Minecraft ${input.gameVersion} requires Java ${required} or newer; selected Java is ${java.major}`);
    const download = object(object(metadata.downloads).server);
    if (!Number.isSafeInteger(download.size) || (download.size as number) < 1 || (download.size as number) > this.maxArtifactBytes || !isHash(download.sha1, 40)) throw new Error('Missing verifiable official server download');
    const bytes = await this.bytes(download.url, ['piston-data.mojang.com', 'launcher.mojang.com'], download.size as number, operation);
    if (bytes.length !== download.size || createHash('sha1').update(bytes).digest('hex') !== download.sha1) throw new Error('Server download integrity check failed');
    const sourceDir = await mkdtemp(path.join(stagingParent, 'peerhost-setup-'));
    try {
      await writeFile(path.join(sourceDir, 'server.jar'), bytes, { flag: 'wx', mode: 0o600 });
      if (input.loader === 'fabric') await this.prepareFabric(sourceDir, input.gameVersion, java.major, this.maxArtifactBytes - bytes.length, operation);
      operation.throwIfAborted();
      if (input.eulaAccepted === true) await writeFile(path.join(sourceDir, 'eula.txt'), 'eula=true\n', { flag: 'wx', mode: 0o600 });
      const jarName = input.loader === 'fabric' ? 'fabric-server-launch.jar' : 'server.jar';
      return { sourceDir, loader: input.loader, gameVersion: input.gameVersion, profile: validateLaunchProfile({ executable: java.executable, args: [`-Xms${Math.min(512, input.memoryMiB)}M`, `-Xmx${input.memoryMiB}M`, '-jar', jarName, 'nogui'] }) };
    } catch (error) {
      await rm(sourceDir, { recursive: true, force: true });
      throw error;
    }
  }
  async listVersions(): Promise<{ latest: string; versions: Array<{ id: string }> }> {
    const manifest = await this.releases();
    return { latest: manifest.latest, versions: manifest.versions.map(({ id }) => ({ id })) };
  }
}

/** Bounded environment discovery; no recursive disk scan, shell, registry or Java installation.
 * At most 32 directories, 16 unique executables, four concurrent three-second probes.
 * An unlisted runtime can be selected by the parent's native file picker.
 */
export async function discoverJava(): Promise<JavaRuntime[]> {
  const filename = process.platform === 'win32' ? 'java.exe' : 'java';
  const home = process.env.JAVA_HOME;
  const directories = [home && path.isAbsolute(home) ? path.join(home, 'bin') : '', ...(process.env.PATH ?? '').slice(0, 32768).split(path.delimiter)].filter(dir => dir && path.isAbsolute(dir)).slice(0, 32);
  const candidates = new Map<string, string>();
  for (const dir of directories) {
    try {
      const executable = await realpath(path.join(dir, filename));
      if ((await stat(executable)).isFile()) candidates.set(process.platform === 'win32' ? executable.toLowerCase() : executable, executable);
    } catch { /* Missing/unreadable entries do not block a native selection. */ }
    if (candidates.size >= 16) break;
  }
  const paths = [...candidates.values()];
  const found: JavaRuntime[] = [];
  for (let index = 0; index < paths.length; index += 4) {
    const batch = await Promise.all(paths.slice(index, index + 4).map(executable => probeJava(executable).catch(() => null)));
    found.push(...batch.filter((runtime): runtime is JavaRuntime => runtime !== null));
  }
  return found;
}

/** Runs only the native-selected executable; never passes a command to a shell.
 * https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback
 */
export async function probeJava(executable: string): Promise<JavaRuntime> {
  validateJavaExecutable(executable);
  const output = await new Promise<string>((resolve, reject) => {
    const env = { ...process.env };
    // Environment-injected JVM agents/options must not run during discovery.
    delete env.JAVA_TOOL_OPTIONS; delete env.JDK_JAVA_OPTIONS; delete env._JAVA_OPTIONS;
    execFile(executable, ['-version'], { shell: false, windowsHide: true, timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 16384, env }, (error, stdout, stderr) => {
      if (error) reject(new Error('Java probe failed', { cause: error }));
      else resolve(stderr + '\n' + stdout);
    });
  });
  const version = /^(?:openjdk|java)(?: version)? ["']?(\d+(?:\.\d+)*(?:_\d+)?(?:[-+][A-Za-z0-9.-]+)?)(?:["']|\s|$)/m.exec(output)?.[1];
  if (!version) throw new Error('Java version could not be determined');
  const parts = version.split('.');
  const major = Number(parts[0] === '1' ? parts[1] : parts[0]);
  if (!Number.isInteger(major) || major < 2 || major > 100) throw new Error('Invalid Java version');
  return { executable, major, version };
}
