import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { APPLY_UPDATE_SCRIPT, Updater, compareVersions, normalizeTag, packageNameFor, parseVersion, selectUpdate } from '../dist/src/core/updater.js';

const scratch = process.env.TMPDIR || process.env.TEMP || process.env.TMP || path.resolve('.test-data');
const waitFor = async (check, { timeout = 20000, interval = 150 } = {}) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
};
const powershell = (args) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8' });
const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;

async function makeFixtureZip(root) {
  const source = path.join(root, 'zip-source');
  const payload = path.join(source, 'SeedHost-win32-x64');
  await mkdir(path.join(payload, 'resources', 'app'), { recursive: true });
  await writeFile(path.join(payload, 'SeedHost.exe'), 'new-exe-bytes');
  await writeFile(path.join(payload, 'LICENSE'), 'MIT fixture license');
  await writeFile(path.join(payload, 'resources', 'app', 'package.json'), JSON.stringify({ name: 'seedhost', version: '0.6.0-alpha' }));
  // Doubles as the relaunch marker for the apply-script test: a file that reports when it started.
  await writeFile(path.join(payload, 'SeedHost.cmd'), '@echo off\r\necho launched > "%~dp0relaunched.marker"\r\nexit /b 0\r\n');
  const zip = path.join(root, 'SeedHost-0.6.0-alpha-win32-x64.zip');
  const result = powershell(['-Command', `Compress-Archive -LiteralPath ${psQuote(payload)} -DestinationPath ${psQuote(zip)} -Force`]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const bytes = await readFile(zip);
  return { zip, bytes, name: path.basename(zip), sha: createHash('sha256').update(bytes).digest('hex') };
}

function releasesServer(shape) {
  const server = createServer((request, response) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (request.url?.startsWith('/repos/envosloth/seedhost/releases')) {
      const assets = [];
      if (shape.withZip !== false) assets.push({ name: shape.name, browser_download_url: `${base}/dl/${shape.name}`, size: shape.bytes.length });
      if (shape.withChecksum !== false) assets.push({ name: 'SHA256SUMS.txt', browser_download_url: `${base}/dl/SHA256SUMS.txt`, size: 120 });
      const releases = [
        { tag_name: 'v0.7.0-alpha', draft: false, prerelease: true, published_at: '2026-10-07T00:00:00Z', body: 'no asset here', assets: [] },
        { tag_name: 'v0.6.0-alpha', draft: false, prerelease: true, published_at: '2026-10-07T00:00:00Z', body: 'In-app updates.\n\n- check, verify, install', assets },
      ];
      const body = Buffer.from(JSON.stringify(releases));
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
      return response.end(body);
    }
    // GitHub serves release assets through a redirect to a CDN URL that carries signed query parameters,
    // so the fixture does the same: the clean /dl/ URL 302s to a query-carrying /cdn/ URL.
    if (request.url === `/dl/${shape.name}`) {
      response.writeHead(302, { location: `${base}/cdn/${shape.name}?sig=fixture&jwt=fixture-token` });
      return response.end();
    }
    if (request.url?.startsWith(`/cdn/${shape.name}?`)) {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': shape.bytes.length });
      return response.end(shape.bytes);
    }
    if (request.url === '/dl/SHA256SUMS.txt') {
      response.writeHead(302, { location: `${base}/cdn/SHA256SUMS.txt?sig=fixture&jwt=fixture-token` });
      return response.end();
    }
    if (request.url?.startsWith('/cdn/SHA256SUMS.txt?')) {
      const body = Buffer.from(`${shape.sha}  ${shape.name}\n`);
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': body.length });
      return response.end(body);
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('version handling: parsing, ordering, tags and package names', () => {
  assert.deepEqual(parseVersion('0.6.0-alpha'), { numbers: [0, 6, 0], prerelease: ['alpha'] });
  assert.equal(parseVersion('0.6'), null);
  assert.equal(parseVersion('v0.6.0'), null);
  assert.equal(parseVersion('0.6.0-'), null);
  assert.equal(compareVersions('0.5.0', '0.6.0-alpha'), -1);
  assert.equal(compareVersions('0.6.0-alpha', '0.6.0-beta'), -1);
  assert.equal(compareVersions('0.6.0-beta', '0.6.0'), -1);
  assert.equal(compareVersions('0.6.0', '0.6.0'), 0);
  assert.equal(compareVersions('0.6.1-alpha', '0.6.0'), 1);
  assert.equal(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10'), -1);
  assert.equal(compareVersions('nope', '1.0.0'), null);
  assert.equal(normalizeTag('v0.6.0-alpha'), '0.6.0-alpha');
  assert.equal(normalizeTag('0.6.0'), '0.6.0');
  assert.equal(normalizeTag('latest'), null);
  assert.equal(packageNameFor('0.6.0-alpha', 'win32', 'x64'), 'SeedHost-0.6.0-alpha-win32-x64.zip');
  assert.equal(packageNameFor('0.6.0-alpha', 'linux', 'x64'), null);
});

test('release selection skips drafts, old versions, and releases without a matching package', () => {
  const zip = (version) => ({ name: `SeedHost-${version}-win32-x64.zip`, browser_download_url: `https://github.com/envosloth/seedhost/releases/download/v${version}/SeedHost-${version}-win32-x64.zip`, size: 1000 });
  const releases = [
    { tag_name: 'v9.9.9', draft: true, assets: [zip('9.9.9')] },
    { tag_name: 'v0.4.0-alpha', draft: false, assets: [zip('0.4.0-alpha')] },
    { tag_name: 'v0.7.0-alpha', draft: false, assets: [] },
    { tag_name: 'not-a-version', draft: false, assets: [zip('nope')] },
    { tag_name: 'v0.6.1-alpha', draft: false, prerelease: true, published_at: '2026-10-07T00:00:00Z', body: 'notes', assets: [zip('0.6.1-alpha'), { name: 'SHA256SUMS.txt', browser_download_url: 'https://github.com/envosloth/seedhost/releases/download/v0.6.1-alpha/SHA256SUMS.txt', size: 50 }] },
    { tag_name: 'v0.6.0-alpha', draft: false, prerelease: true, assets: [zip('0.6.0-alpha')] },
  ];
  const chosen = selectUpdate(releases, '0.5.0', 'win32', 'x64');
  assert.equal(chosen?.version, '0.6.1-alpha');
  assert.equal(chosen?.asset.name, 'SeedHost-0.6.1-alpha-win32-x64.zip');
  assert.equal(chosen?.checksum?.name, 'SHA256SUMS.txt');
  assert.equal(selectUpdate(releases, '0.6.1-alpha', 'win32', 'x64'), null);
  assert.equal(selectUpdate(releases, '0.5.0', 'linux', 'x64'), null);
  assert.equal(selectUpdate('garbage', '0.5.0', 'win32', 'x64'), null);
});

test('check, download, verify and stage a fixture release through the real pipeline', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(scratch, 'updater-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => undefined));
  const fixture = await makeFixtureZip(root);
  const { server, base } = await releasesServer({ ...fixture, sha: fixture.sha });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const updater = new Updater({ root: path.join(root, 'updates'), currentVersion: '0.5.0', packaged: false, platform: 'win32', arch: 'x64', apiOrigin: base });

  const checked = await updater.check();
  assert.equal(checked.error, null);
  assert.equal(checked.latest?.version, '0.6.0-alpha', 'newer unusable release (0.7.0 without asset) is skipped');
  assert.equal(checked.upToDate, false);
  assert.ok(checked.checkedAt);

  // A stale staging directory from a different version is pruned once a new one stages.
  await mkdir(path.join(root, 'updates', 'v0.5.5-alpha'), { recursive: true });
  const downloaded = await updater.download();
  assert.equal(downloaded.staged?.version, '0.6.0-alpha');
  assert.equal(await readFile(path.join(downloaded.staged.payloadRoot, 'SeedHost.exe'), 'utf8'), 'new-exe-bytes');
  const stagingFiles = await readdir(downloaded.staged.directory);
  assert.ok(stagingFiles.includes(fixture.name), 'the verified archive is kept for reference');
  assert.ok(!stagingFiles.some((name) => name.endsWith('.part')), 'no partial download remains');
  await assert.rejects(readdir(path.join(root, 'updates', 'v0.5.5-alpha')), /ENOENT/, 'older staged versions are pruned');

  // The same fixture against a newer installed version reports up to date.
  const current = new Updater({ root: path.join(root, 'updates-current'), currentVersion: '0.6.0-alpha', packaged: true, platform: 'win32', arch: 'x64', apiOrigin: base });
  const second = await current.check();
  assert.equal(second.upToDate, true);
  assert.equal(second.latest, null);
});

test('a wrong SHA-256 fails closed and leaves nothing staged', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(scratch, 'updater-badsum-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => undefined));
  const fixture = await makeFixtureZip(root);
  const { server, base } = await releasesServer({ ...fixture, sha: '0'.repeat(64) });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const updater = new Updater({ root: path.join(root, 'updates'), currentVersion: '0.5.0', packaged: false, platform: 'win32', arch: 'x64', apiOrigin: base });
  await updater.check();
  await assert.rejects(updater.download(), /SHA-256/);
  assert.equal(updater.status().staged, null);
  const files = await readdir(path.join(root, 'updates', 'v0.6.0-alpha')).catch(() => []);
  assert.ok(!files.some((name) => name.endsWith('.part')), 'the failed partial download is removed');
});

test('a release without a checksum asset refuses to download', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(scratch, 'updater-nosum-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => undefined));
  const fixture = await makeFixtureZip(root);
  const { server, base } = await releasesServer({ ...fixture, withChecksum: false });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const updater = new Updater({ root: path.join(root, 'updates'), currentVersion: '0.5.0', packaged: false, platform: 'win32', arch: 'x64', apiOrigin: base });
  await updater.check();
  await assert.rejects(updater.download(), /checksum/i);
  assert.equal(updater.status().staged, null);
});

test('install refuses when the app is not packaged or nothing is staged', async () => {
  const updater = new Updater({ root: path.join(scratch, 'updater-guards'), currentVersion: '0.5.0', packaged: false, platform: 'win32', arch: 'x64' });
  await assert.rejects(updater.install(), /staged/i);
});

test('the apply script waits for the app, swaps the install folder and relaunches', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(scratch, 'updater-apply-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => undefined));
  const fixture = await makeFixtureZip(root);
  const { server, base } = await releasesServer({ ...fixture, sha: fixture.sha });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const install = path.join(root, 'fake-install');
  await mkdir(install, { recursive: true });
  await writeFile(path.join(install, 'SeedHost.exe'), 'old-exe-bytes');
  await writeFile(path.join(install, 'stale-only-file.txt'), 'should be removed by the mirror');
  // The "app" the script must wait for: a real process that exits on its own shortly.
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2400)'], { stdio: 'ignore' });
  t.after(() => sleeper.kill());
  const updater = new Updater({
    root: path.join(root, 'updates'), currentVersion: '0.5.0', packaged: true, platform: 'win32', arch: 'x64', apiOrigin: base,
    executablePath: path.join(install, 'SeedHost.cmd'), waitPid: sleeper.pid,
  });
  await updater.check();
  await updater.download();
  const started = await updater.install();
  assert.ok(started.scriptPath.endsWith('apply-update.ps1'));
  await waitFor(async () => (await readFile(path.join(install, 'relaunched.marker'), 'utf8')).includes('launched'), { timeout: 25000 });
  assert.equal(await readFile(path.join(install, 'SeedHost.exe'), 'utf8'), 'new-exe-bytes');
  assert.equal(await readFile(path.join(install, 'LICENSE'), 'utf8'), 'MIT fixture license');
  await assert.rejects(readFile(path.join(install, 'stale-only-file.txt')), /ENOENT/, 'mirror removes files that are no longer part of the app');
  const stagedDirectory = updater.status().staged?.directory;
  assert.ok(stagedDirectory);
  await waitFor(async () => { try { await readdir(stagedDirectory); return false; } catch { return true; } }, { timeout: 25000 });
});
