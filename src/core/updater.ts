// In-app updates for the packaged desktop app.
//
// Flow: check the project's official GitHub releases for the newest non-draft release with a matching
// Windows package, download that package into the profile, verify it against the published SHA-256,
// extract it, and hand off to a small PowerShell script that waits for this app to exit, mirrors the
// staged files over the install folder and relaunches the executable.
//
// Everything network-facing is deliberately narrow: HTTPS only (or one explicit test origin), no URL
// credentials/ports/queries/hashes, bounded response sizes, manual redirects with every hop re-validated
// against the allowed hosts, and a checksum verified before anything is staged. Nothing is replaced
// while the app is open; the swap happens only after the app has fully exited.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

export const UPDATE_REPO = 'envosloth/seedhost';
const RELEASES_ORIGIN = 'https://api.github.com';
const METADATA_HOSTS = ['api.github.com'];
const ASSET_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_CHECKSUM_BYTES = 64 * 1024;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;

export interface UpdaterOptions {
  /** Directory that holds downloaded/staged updates (inside the profile). */
  root: string;
  currentVersion: string;
  packaged: boolean;
  platform: NodeJS.Platform;
  arch: string;
  /** Test-only origin override; when set, every URL (and redirect) must stay on this exact origin. */
  apiOrigin?: string;
  repo?: string;
  /** Executable to replace/relaunch; defaults to the running app. Injectable for tests. */
  executablePath?: string;
  /** Process id the apply script must wait for before swapping; defaults to this process. */
  waitPid?: number;
}
export interface UpdateAssetRef { name: string; url: string; size: number; }
export interface UpdateCandidate { version: string; tag: string; notes: string; publishedAt: string; asset: UpdateAssetRef; checksum: UpdateAssetRef | null; }
export interface UpdateStaged { version: string; tag: string; directory: string; payloadRoot: string; }
export interface UpdaterStatus {
  current: string; packaged: boolean; platform: string; checkedAt: string | null;
  latest: UpdateCandidate | null; upToDate: boolean; error: string | null;
  busy: 'checking' | 'downloading' | null;
  downloading: { received: number; total: number } | null;
  staged: UpdateStaged | null;
}

/** Parse `1.2.3` / `1.2.3-alpha` / `1.2.3-alpha.2`; null when it is not a strict three-part version. */
export function parseVersion(value: string): { numbers: [number, number, number]; prerelease: string[] } | null {
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z][0-9A-Za-z.-]{0,63}))?$/.exec(value.trim());
  if (!match || match[1] === undefined || match[2] === undefined || match[3] === undefined) return null;
  const numbers: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (numbers.some((part) => !Number.isSafeInteger(part))) return null;
  return { numbers, prerelease: match[4] ? match[4].split('.') : [] };
}

/** Standard semver-ish ordering (prerelease < release, numeric identifiers sort below text). */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index++) {
    const x = left.numbers[index] ?? 0, y = right.numbers[index] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  const l = left.prerelease, r = right.prerelease;
  if (l.length === 0 && r.length === 0) return 0;
  if (l.length === 0) return 1;
  if (r.length === 0) return -1;
  for (let index = 0; index < Math.max(l.length, r.length); index++) {
    const x = l[index], y = r[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x), yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) { const xn = Number(x), yn = Number(y); if (xn !== yn) return xn < yn ? -1 : 1; continue; }
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** `v0.6.0-alpha` -> `0.6.0-alpha`; null when the tag is not a plain version. */
export function normalizeTag(tag: unknown): string | null {
  if (typeof tag !== 'string') return null;
  const version = tag.startsWith('v') ? tag.slice(1) : tag;
  return parseVersion(version) ? version : null;
}

export function packageNameFor(version: string, platform: NodeJS.Platform, arch: string): string | null {
  if (platform !== 'win32' || arch !== 'x64') return null;
  return `SeedHost-${version}-win32-x64.zip`;
}

interface ParsedRelease { version: string; tag: string; notes: string; publishedAt: string; asset: UpdateAssetRef; checksum: UpdateAssetRef | null }
function parseRelease(raw: unknown, platform: NodeJS.Platform, arch: string): ParsedRelease | null {
  if (!raw || typeof raw !== 'object') return null;
  const release = raw as Record<string, unknown>;
  if (release.draft === true) return null;
  const version = normalizeTag(release.tag_name);
  if (!version) return null;
  const expected = packageNameFor(version, platform, arch);
  if (!expected) return null;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const ref = (name: string): UpdateAssetRef | null => {
    const found = assets.find((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const asset = entry as Record<string, unknown>;
      return asset.name === name && typeof asset.browser_download_url === 'string' && Number.isSafeInteger(asset.size) && Number(asset.size) > 0;
    });
    if (!found) return null;
    const asset = found as Record<string, unknown>;
    return { name, url: asset.browser_download_url as string, size: Number(asset.size) };
  };
  const asset = ref(expected) ?? assets.reduce<UpdateAssetRef | null>((best, entry) => {
    if (!entry || typeof entry !== 'object') return best;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.name !== 'string' || !/^SeedHost-.+-win32-x64\.zip$/.test(candidate.name)) return best;
    if (typeof candidate.browser_download_url !== 'string' || !Number.isSafeInteger(candidate.size) || Number(candidate.size) <= 0) return best;
    return { name: candidate.name, url: candidate.browser_download_url as string, size: Number(candidate.size) };
  }, null);
  if (!asset) return null;
  const checksum = ref('SHA256SUMS.txt') ?? ref(`${asset.name}.sha256`);
  return {
    version, tag: String(release.tag_name ?? version),
    notes: typeof release.body === 'string' ? release.body.slice(0, 4000) : '',
    publishedAt: typeof release.published_at === 'string' ? release.published_at : '',
    asset, checksum,
  };
}

/** Newest non-draft release that is newer than `currentVersion` and ships a matching package. */
export function selectUpdate(releases: unknown, currentVersion: string, platform: NodeJS.Platform, arch: string): UpdateCandidate | null {
  if (!Array.isArray(releases)) return null;
  let best: ParsedRelease | null = null;
  for (const raw of releases) {
    const parsed = parseRelease(raw, platform, arch);
    if (!parsed) continue;
    const order = compareVersions(parsed.version, currentVersion);
    if (order === null || order <= 0) continue;
    if (!best || (compareVersions(parsed.version, best.version) ?? 0) > 0) best = parsed;
  }
  if (!best) return null;
  return { version: best.version, tag: best.tag, notes: best.notes, publishedAt: best.publishedAt, asset: best.asset, checksum: best.checksum };
}

/** The apply script executed after the app exits. Fixed content; all paths arrive as -File parameters. */
export const APPLY_UPDATE_SCRIPT = `param(
  [Parameter(Mandatory=$true)][int]$WaitPid,
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$Target,
  [Parameter(Mandatory=$true)][string]$Exe,
  [string]$CleanupDir = ''
)
$log = Join-Path ([System.IO.Path]::GetTempPath()) ("seedhost-update-apply-" + $WaitPid + ".log")
function Write-Log([string]$message) { Add-Content -LiteralPath $log -Value ((Get-Date -Format o) + ' ' + $message) -ErrorAction SilentlyContinue }
Write-Log ("starting; source=" + $Source + " target=" + $Target + " exe=" + $Exe)
$deadline = (Get-Date).AddSeconds(180)
while ($true) {
  if (-not (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue)) { break }
  if ((Get-Date) -gt $deadline) { Write-Log 'timed out waiting for the app to exit; nothing was changed'; exit 1 }
  Start-Sleep -Milliseconds 400
}
Start-Sleep -Milliseconds 700
try {
  if (-not (Test-Path -LiteralPath (Join-Path $Source 'SeedHost.exe'))) { throw 'the staged update is missing SeedHost.exe' }
  $result = robocopy $Source $Target /MIR /R:8 /W:1 /NFL /NDL /NJH /NJS /NP
  $code = $LASTEXITCODE
  Write-Log ("robocopy exit " + $code)
  if ($code -ge 8) { throw ("robocopy failed with exit " + $code) }
  Start-Process -FilePath $Exe -WorkingDirectory $Target
  Write-Log 'relaunched'
  if ($CleanupDir -and (Test-Path -LiteralPath $CleanupDir)) {
    Start-Sleep -Seconds 4
    Remove-Item -LiteralPath $CleanupDir -Recurse -Force -ErrorAction SilentlyContinue
  }
} catch {
  Write-Log ("failed: " + $_.Exception.Message)
  Start-Process -FilePath $Exe -WorkingDirectory $Target -ErrorAction SilentlyContinue
}
`;

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export class Updater {
  private readonly options: UpdaterOptions;
  private readonly state: UpdaterStatus;

  constructor(options: UpdaterOptions) {
    this.options = options;
    this.state = { current: options.currentVersion, packaged: options.packaged, platform: options.platform, checkedAt: null, latest: null, upToDate: false, error: null, busy: null, downloading: null, staged: null };
  }

  status(): UpdaterStatus {
    return {
      ...this.state,
      latest: this.state.latest ? { ...this.state.latest } : null,
      downloading: this.state.downloading ? { ...this.state.downloading } : null,
      staged: this.state.staged ? { ...this.state.staged } : null,
    };
  }

  private testOrigin(): string | null {
    const raw = this.options.apiOrigin;
    if (!raw) return null;
    return new URL(raw).origin;
  }

  private assertUrl(raw: string, hosts: string[]): URL {
    const url = new URL(raw);
    const test = this.testOrigin();
    if (url.username || url.password || url.hash || url.search) throw new Error('Update URL is not an allowed endpoint');
    if (test) { if (url.origin !== test) throw new Error('Update URL left the allowed test origin'); return url; }
    if (url.protocol !== 'https:' || url.port !== '' || !hosts.includes(url.hostname)) throw new Error('Update URL is not an allowed endpoint');
    return url;
  }

  private headless(): string[] { return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']; }

  private async readBounded(raw: string, hosts: string[], maxBytes: number, accept: string): Promise<Buffer> {
    let url = this.assertUrl(raw, hosts);
    for (let hop = 0; hop < 4; hop++) {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'SeedHost-Updater', Accept: accept } });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new Error('An update redirect is missing its destination');
        url = this.assertUrl(new URL(location, url).href, hosts);
        continue;
      }
      if (!response.ok) throw new Error(`The update service answered ${response.status}`);
      const length = Number(response.headers.get('content-length') ?? '0');
      if (length > maxBytes) throw new Error('The update response is larger than expected');
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxBytes) throw new Error('The update response is larger than expected');
      return buffer;
    }
    throw new Error('The update download redirected too many times');
  }

  private async streamToFile(raw: string, destination: string, expectedSize: number, onProgress: (received: number) => void): Promise<void> {
    let url = this.assertUrl(raw, ASSET_HOSTS);
    let response: Response | null = null;
    for (let hop = 0; hop < 4 && !response; hop++) {
      const candidate = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60000), headers: { 'User-Agent': 'SeedHost-Updater', Accept: 'application/octet-stream' } });
      if (candidate.status >= 300 && candidate.status < 400) {
        const location = candidate.headers.get('location');
        if (!location) throw new Error('An update redirect is missing its destination');
        url = this.assertUrl(new URL(location, url).href, ASSET_HOSTS);
        continue;
      }
      response = candidate;
    }
    if (!response || !response.ok || !response.body) throw new Error('The update package could not be downloaded');
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared && declared !== expectedSize) throw new Error('The update package size does not match the release metadata');
    const handle = await open(destination, 'w');
    try {
      const reader = response.body.getReader();
      let received = 0, lastReport = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > MAX_PACKAGE_BYTES) throw new Error('The update package is larger than expected');
        await handle.write(chunk.value);
        const now = Date.now();
        if (now - lastReport > 250) { lastReport = now; onProgress(received); }
      }
      onProgress(received);
      if (received !== expectedSize) throw new Error('The update package size does not match the release metadata');
      await handle.sync();
    } finally { await handle.close(); }
  }

  private async expectedDigest(candidate: UpdateCandidate): Promise<string | null> {
    if (!candidate.checksum) return null;
    const body = await this.readBounded(candidate.checksum.url, ASSET_HOSTS, MAX_CHECKSUM_BYTES, 'text/plain');
    const text = body.toString('utf8');
    const zipName = path.basename(new URL(candidate.asset.url).pathname);
    if (/^[a-f0-9]{64}$/i.test(text.trim())) return text.trim().toLowerCase();
    for (const line of text.split(/\r?\n/)) {
      const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
      if (match && match[1] !== undefined && match[2] !== undefined) {
        const name = match[2].trim();
        if (name === candidate.asset.name || name === zipName || path.basename(name) === zipName) return match[1].toLowerCase();
      }
    }
    return null;
  }

  private extract(archive: string, destination: string): Promise<string | null> {
    if (this.options.platform !== 'win32') return Promise.resolve(null);
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const command = `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(destination)} -Force`;
    return new Promise<void>((resolve, reject) => {
      const child = spawn('powershell.exe', [...this.headless(), '-Command', command], { stdio: 'ignore', windowsHide: true });
      child.on('error', reject);
      child.on('exit', (code) => { if (code === 0) resolve(); else reject(new Error('The update package could not be extracted')); });
    }).then(async () => {
      const direct = path.join(destination, 'SeedHost.exe');
      try { await readFile(direct); return destination; } catch { /* fall through */ }
      const entries = await readdir(destination, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const root = path.join(destination, entry.name);
        try { await readFile(path.join(root, 'SeedHost.exe')); return root; } catch { /* keep looking */ }
      }
      return null;
    });
  }

  private async clearStaged(): Promise<void> {
    const staged = this.state.staged;
    this.state.staged = null;
    if (staged) await rm(staged.directory, { recursive: true, force: true }).catch(() => undefined);
  }

  private async pruneOtherStaged(keepTag: string): Promise<void> {
    let names: string[];
    try { names = await readdir(this.options.root, { withFileTypes: true }).then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)); }
    catch { return; }
    for (const name of names) {
      if (name === keepTag) continue;
      await rm(path.join(this.options.root, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async check(): Promise<UpdaterStatus> {
    if (this.state.busy) throw new Error('An update operation is already running');
    this.state.busy = 'checking';
    this.state.error = null;
    try {
      const origin = this.testOrigin() ?? RELEASES_ORIGIN;
      // No query string: the default page already lists up to 30 releases, and the URL policy bans queries.
      const url = `${origin}/repos/${this.options.repo ?? UPDATE_REPO}/releases`;
      const body = await this.readBounded(url, METADATA_HOSTS, MAX_METADATA_BYTES, 'application/vnd.github+json');
      const releases: unknown = JSON.parse(body.toString('utf8'));
      if (!Array.isArray(releases)) throw new Error('The update service answered an unexpected format');
      const candidate = selectUpdate(releases, this.options.currentVersion, this.options.platform, this.options.arch);
      this.state.latest = candidate;
      this.state.upToDate = !candidate;
      this.state.checkedAt = new Date().toISOString();
      if (this.state.staged) {
        const order = compareVersions(this.state.staged.version, this.options.currentVersion);
        if (order === null || order <= 0 || !candidate || candidate.version !== this.state.staged.version) await this.clearStaged();
      }
      return this.status();
    } catch (error) {
      this.state.error = String((error as Error).message ?? error);
      return this.status();
    } finally { this.state.busy = null; }
  }

  async download(): Promise<UpdaterStatus> {
    if (this.state.busy) throw new Error('An update operation is already running');
    const candidate = this.state.latest;
    if (!candidate) throw new Error('No update is available to download');
    if (!packageNameFor(candidate.version, this.options.platform, this.options.arch)) throw new Error('Automatic updates are not available for this platform');
    this.state.busy = 'downloading';
    this.state.error = null;
    const directory = path.join(this.options.root, candidate.tag);
    const archive = path.join(directory, candidate.asset.name);
    const temporary = `${archive}.part`;
    try {
      await mkdir(directory, { recursive: true });
      this.state.downloading = { received: 0, total: candidate.asset.size };
      await this.streamToFile(candidate.asset.url, temporary, candidate.asset.size, (received) => { this.state.downloading = { received, total: candidate.asset.size }; });
      this.state.downloading = null;
      const expected = await this.expectedDigest(candidate);
      if (!expected) throw new Error('The release has no usable SHA-256 checksum; refusing to install it');
      const digest = await sha256File(temporary);
      if (digest !== expected) throw new Error('The update package failed its SHA-256 check; nothing was installed');
      await rm(archive, { force: true });
      await rename(temporary, archive);
      const payloadRoot = await this.extract(archive, path.join(directory, 'staged'));
      if (!payloadRoot) throw new Error('The update package did not contain the app executable');
      this.state.staged = { version: candidate.version, tag: candidate.tag, directory, payloadRoot };
      await this.pruneOtherStaged(candidate.tag);
      return this.status();
    } catch (error) {
      this.state.downloading = null;
      this.state.error = String((error as Error).message ?? error);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    } finally { this.state.busy = null; }
  }

  /** Write the apply script and start it as an independent process. The caller quits the app so the swap can proceed. */
  async install(): Promise<{ scriptPath: string; targetDirectory: string; executable: string; logHint: string }> {
    const staged = this.state.staged;
    if (!staged) throw new Error('No verified update is staged');
    if (!this.options.packaged) throw new Error('Updates install only in the packaged app');
    if (this.options.platform !== 'win32') throw new Error('Automatic install is available on Windows only');
    const executable = this.options.executablePath ?? process.execPath;
    const targetDirectory = path.dirname(executable);
    const configured = this.options.waitPid;
    const waitPid = Number.isSafeInteger(configured) && (configured as number) > 0 ? configured as number : process.pid;
    const scriptPath = path.join(staged.directory, 'apply-update.ps1');
    const logHint = path.join(process.env.TEMP ?? staged.directory, `seedhost-update-apply-${waitPid}.log`);
    await writeFile(scriptPath, APPLY_UPDATE_SCRIPT, 'utf8');
    // Launch through Start-Process so the helper is independent of this app and survives the restart; a
    // direct (even 'detached') child can be torn down with its parent, which would silently cancel the swap.
    const childArguments = [
      ...this.headless(), '-WindowStyle', 'Hidden', '-File', scriptPath,
      '-WaitPid', String(waitPid), '-Source', staged.payloadRoot, '-Target', targetDirectory, '-Exe', executable, '-CleanupDir', staged.directory,
    ];
    const argumentLine = childArguments.map((value) => `"${value}"`).join(' ');
    const launch = `Start-Process -FilePath 'powershell.exe' -ArgumentList '${argumentLine.replaceAll("'", "''")}' -WindowStyle Hidden`;
    const wrapper = spawnSync('powershell.exe', [...this.headless(), '-Command', launch], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (wrapper.error || wrapper.status !== 0) {
      const detail = wrapper.error ? wrapper.error.message : String(wrapper.stderr ?? '').trim().split('\n')[0] ?? '';
      throw new Error(`The update helper could not be started${detail ? `: ${detail}` : ''}`);
    }
    return { scriptPath, targetDirectory, executable, logHint };
  }
}
