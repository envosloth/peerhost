import test from 'node:test';
import { javaProbeFixture } from './java-probe-fixture.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, readdir, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
const api = await import('../dist/src/core/server-setup.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const scratch = process.env.TMPDIR;
assert.ok(scratch, 'Tests require TMPDIR; never use application state');
async function root(t) {
  const dir = await mkdtemp(path.join(scratch, 'server-setup-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function javaFixture(dir, version = '21.0.4', options = {}) {
  return javaProbeFixture(dir, { executable: path.join(dir, 'java fixture ; no shell' + (process.platform === 'win32' ? '.exe' : '')), version, server: false, ...options });
}
test('native Java fixture rejects extra probe arguments and propagates nonzero exits', async t => {
  const { javaProbeFixture } = await import('./java-probe-fixture.mjs');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const executable = await javaProbeFixture(await root(t), { server: false, exitCode: 7 });
  await assert.rejects(run(executable, ['-version', 'unexpected'], { timeout: 1000 }), error => error.code === 5);
  await assert.rejects(run(executable, ['-version']), error => error.code === 7);
});
const hash = (value, algorithm = 'sha1') => createHash(algorithm).update(value).digest('hex');
async function fixture(t, options = {}) {
  const dir = await root(t); const requests = []; let origin;
  const jar = Buffer.from('PK fixture server bytes, NOT real Minecraft');
  const fabricJar = Buffer.from('PK fixture Fabric library bytes, NOT executable code');
  const profile = { id: 'fabric-loader-0.19.5-1.21.1', inheritsFrom: '1.21.1', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotServer', libraries: [
    { name: 'org.ow2.asm:asm:9.10.1', url: null, sha256: hash(fabricJar, 'sha256'), size: fabricJar.length },
    { name: 'net.fabricmc:intermediary:1.21.1', url: null },
    { name: 'net.fabricmc:fabric-loader:0.19.5', url: null },
  ] };
  const metadata = () => JSON.stringify({ id: '1.21.1', javaVersion: { majorVersion: 21 }, downloads: { server: { url: options.downloadUrl ?? origin + '/server.jar', size: options.size ?? jar.length, sha1: options.hash ?? hash(jar) } }, ...options.metadata });
  const manifest = () => ({ latest: { release: '1.21.1' }, versions: [
    { id: '1.21.1', type: 'release', url: origin + '/version.json', sha1: hash(metadata()) },
    { id: '24w33a', type: 'snapshot', url: origin + '/snapshot.json', sha1: hash('{}') },
  ] });
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (options.handle?.(req, res, origin)) return;
    if (req.url === '/mc/game/version_manifest_v2.json') return res.end(JSON.stringify(options.manifest ?? manifest()));
    if (req.url === '/version.json') return res.end(options.tamperMetadata ? '{}' : metadata());
    if (req.url === '/server.jar') return res.end(options.tamperJar ? Buffer.from('corrupt') : jar);
    if (req.url === '/v2/versions/loader/1.21.1') return res.end(JSON.stringify(options.loaders ?? [{ loader: { version: '0.19.5', stable: true }, launcherMeta: { version: 2, min_java_version: options.fabricJava ?? 8 } }]));
    if (req.url === '/v2/versions/loader/1.21.1/0.19.5/server/json') return res.end(JSON.stringify(options.fabricProfile ?? { ...profile, libraries: profile.libraries.map(library => ({ ...library, url: origin + '/' })) }));
    if (req.url.endsWith('.jar.sha256')) return res.end(options.fabricHash ?? hash(fabricJar, 'sha256'));
    if (req.url.endsWith('.jar')) return res.end(options.tamperFabric ? Buffer.from('broken') : fabricJar);
    res.statusCode = 404; res.end('missing');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const executable = await javaFixture(dir, options.javaVersion ?? '21.0.4');
  const staging = path.join(dir, 'stage'); await mkdir(staging);
  const input = { name: 'Friends world', loader: 'vanilla', gameVersion: '1.21.1', javaExecutable: executable, memoryMiB: 2048, eulaAccepted: false };
  const client = new api.ServerSetupClient({ testOnly: { origin, ...options.limits } });
  return { dir, requests, origin, client, staging, input, jar };
}
test('prepare has an overall deadline even when every individual response arrives on time', async t => {
  const f = await fixture(t, { limits: { timeoutMs: 1000, operationTimeoutMs: 400 }, handle(req, res) {
    const end = res.end.bind(res); res.end = (...args) => { setTimeout(() => { if (!res.destroyed) end(...args); }, 60); return res; }; return false;
  } });
  const start = Date.now();
  await assert.rejects(f.client.prepare(f.staging, { ...f.input, loader: 'fabric' }), /timeout|abort/i);
  assert.ok(Date.now() - start < 1500);
  assert.deepEqual(await readdir(f.staging), []);
});
test('prepare bounds combined Vanilla/Fabric executable bytes and rolls back budget failures', async t => {
  const f = await fixture(t, { limits: { maxArtifactBytes: 100 } });
  await assert.rejects(f.client.prepare(f.staging, { ...f.input, loader: 'fabric' }), /budget|too large/);
  assert.deepEqual(await readdir(f.staging), []);
});
test('prepare snapshots validated consent and options before asynchronous metadata requests', async t => {
  let input;
  const f = await fixture(t, { handle(req) { if (input) input.eulaAccepted = true; return false; } });
  input = f.input;
  const prepared = await f.client.prepare(f.staging, input);
  assert.deepEqual(await readdir(prepared.sourceDir), ['server.jar']);
});
test('prepare fails clearly when official Java requirements are absent and preserves all existing staging files', async t => {
  const f = await fixture(t, { metadata: { javaVersion: undefined } });
  await writeFile(path.join(f.staging, 'existing-world'), 'leave me');
  await assert.rejects(f.client.prepare(f.staging, f.input), /Official Java requirement/);
  assert.equal(f.requests.includes('/server.jar'), false);
  assert.deepEqual(await readdir(f.staging), ['existing-world']);
});
test('prepare refuses tampered metadata/artifacts, incompatible Java, missing checksums and offsite downloads', async t => {
  for (const options of [{ tamperMetadata: true }, { tamperJar: true }, { hash: 'f'.repeat(40) }, { size: 0 }, { size: 999999999 }, { hash: 'broken' }, { javaVersion: '17.0.1' }, { metadata: { id: 'wrong' } }, { downloadUrl: 'http://evil.invalid/server.jar' }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.client.prepare(f.staging, f.input));
    assert.deepEqual(await readdir(f.staging), []);
    assert.equal(f.requests.some(url => url.includes('evil.invalid')), false);
  }
});
test('Fabric failure removes its whole private source without touching sibling files or accepting EULA', async t => {
  for (const options of [{ tamperFabric: true }, { fabricHash: '' }, { fabricJava: 25 }, { loaders: [] }, { fabricProfile: { mainClass: 'evil.Main', libraries: [] } }]) {
    const f = await fixture(t, options);
    await writeFile(path.join(f.staging, 'existing-world'), 'leave me');
    await assert.rejects(f.client.prepare(f.staging, { ...f.input, loader: 'fabric', eulaAccepted: true }));
    assert.deepEqual(await readdir(f.staging), ['existing-world']);
    assert.equal(await readFile(path.join(f.staging, 'existing-world'), 'utf8'), 'leave me');
  }
});
test('Fabric on an unobfuscated release (no intermediary mappings) prepares; mismatched profiles still fail closed', async t => {
  const unobfuscated = [{ loader: { version: '0.19.5', stable: true }, intermediary: { maven: 'net.fabricmc:intermediary:0.0.0' }, launcherMeta: { version: 2, min_java_version: 8 } }];
  const serveProfile = (withIntermediary) => (req, res, origin) => {
    if (req.url !== '/v2/versions/loader/1.21.1/0.19.5/server/json') return false;
    const fabricJar = Buffer.from('PK fixture Fabric library bytes, NOT executable code');
    const libraries = [
      { name: 'org.ow2.asm:asm:9.10.1', url: origin + '/', sha256: hash(fabricJar, 'sha256'), size: fabricJar.length },
      ...(withIntermediary ? [{ name: 'net.fabricmc:intermediary:1.21.1', url: origin + '/' }] : []),
      { name: 'net.fabricmc:fabric-loader:0.19.5', url: origin + '/' },
    ];
    res.end(JSON.stringify({ id: 'fabric-loader-0.19.5-1.21.1', inheritsFrom: '1.21.1', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotServer', libraries }));
    return true;
  };
  const ok = await fixture(t, { loaders: unobfuscated, handle: serveProfile(false) });
  const prepared = await ok.client.prepare(ok.staging, { ...ok.input, loader: 'fabric' });
  assert.ok((await readdir(prepared.sourceDir)).includes('fabric-server-launch.jar'));
  assert.deepEqual(prepared.profile.args.slice(-3), ['-jar', 'fabric-server-launch.jar', 'nogui']);
  // Declared unobfuscated but the profile carries an intermediary: refused, nothing left behind.
  const extra = await fixture(t, { loaders: unobfuscated, handle: serveProfile(true) });
  await assert.rejects(extra.client.prepare(extra.staging, { ...extra.input, loader: 'fabric' }), /intermediary/);
  assert.deepEqual(await readdir(extra.staging), []);
  // Obfuscated (no declaration) but the profile lacks its intermediary: still refused.
  const missing = await fixture(t, { handle: serveProfile(false) });
  await assert.rejects(missing.client.prepare(missing.staging, { ...missing.input, loader: 'fabric' }), /intermediary/);
  assert.deepEqual(await readdir(missing.staging), []);
});
function zipEntries(bytes) {
  const entries = {}; let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8), length = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString();
    const start = offset + 30 + nameLength + extraLength, data = bytes.subarray(start, start + length);
    entries[name] = (method === 8 ? inflateRawSync(data) : data).toString(); offset = start + length;
  }
  return entries;
}
test('prepare Fabric verifies every upstream library and builds a data-only portable launcher', async t => {
  const f = await fixture(t);
  const prepared = await f.client.prepare(f.staging, { ...f.input, loader: 'fabric' });
  assert.equal(prepared.loader, 'fabric');
  assert.deepEqual(prepared.profile.args.slice(-3), ['-jar', 'fabric-server-launch.jar', 'nogui']);
  assert.deepEqual((await readdir(prepared.sourceDir)).sort(), ['fabric-server-launch.jar', 'libraries', 'server.jar']);
  assert.equal((await readdir(path.join(prepared.sourceDir, 'libraries'))).length, 3);
  const entries = zipEntries(await readFile(path.join(prepared.sourceDir, 'fabric-server-launch.jar')));
  assert.deepEqual(Object.keys(entries).sort(), ['META-INF/MANIFEST.MF', 'fabric-server-launch.properties']);
  assert.match(entries['META-INF/MANIFEST.MF'].replace(/\r\n /g, ''), /Main-Class: net.fabricmc.loader.impl.launch.server.FabricServerLauncher/);
  assert.equal(entries['fabric-server-launch.properties'], 'launch.mainClass=net.fabricmc.loader.impl.launch.knot.KnotServer\n');
  assert.equal(f.requests.filter(url => url.endsWith('.sha256')).length, 2);
  assert.equal(f.requests.some(url => url.endsWith('/server/jar')), false, 'never uses unverifiable generated upstream bootstrap');
});
test('prepare records EULA only for explicit boolean acceptance and keeps low-memory args compatible', async t => {
  const f = await fixture(t);
  const prepared = await f.client.prepare(f.staging, { ...f.input, eulaAccepted: true, memoryMiB: 256 });
  assert.equal(await readFile(path.join(prepared.sourceDir, 'eula.txt'), 'utf8'), 'eula=true\n');
  assert.deepEqual(prepared.profile.args.slice(0, 2), ['-Xms256M', '-Xmx256M']);
  assert.deepEqual((await readdir(prepared.sourceDir)).sort(), ['eula.txt', 'server.jar']);
});
test('prepare validates input and trusted staging before any network or filesystem mutation', async t => {
  const f = await fixture(t);
  for (const patch of [{ name: '../world' }, { name: 'CON' }, { name: 'world.' }, { name: '  ' }, { name: 'a'.repeat(101) }, { name: 'a\n' }, { gameVersion: '../x' }, { loader: 'forge' }, { memoryMiB: 255 }, { memoryMiB: 2048.5 }, { memoryMiB: 1048577 }, { eulaAccepted: 'true' }, { javaExecutable: 'java' }, { javaExecutable: '/tmp/x.cmd' }, { extra: true }]) {
    await assert.rejects(f.client.prepare(f.staging, { ...f.input, ...patch }), /Invalid|Choose/);
  }
  const link = path.join(f.dir, 'stage-link'); await symlink(f.staging, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const stage of ['relative', link, f.input.javaExecutable]) await assert.rejects(f.client.prepare(stage, f.input), /staging/);
  assert.deepEqual(f.requests, []); assert.deepEqual(await readdir(f.staging), []);
});
test('prepare Vanilla returns a unique verified stopped source and launch profile without implicit EULA', async t => {
  const f = await fixture(t);
  assert.equal(typeof f.client.prepare, 'function', 'prepare is implemented');
  const prepared = await f.client.prepare(f.staging, f.input);
  assert.equal(path.dirname(prepared.sourceDir), f.staging);
  assert.equal(prepared.loader, 'vanilla'); assert.equal(prepared.gameVersion, '1.21.1');
  assert.deepEqual(await readFile(path.join(prepared.sourceDir, 'server.jar')), f.jar);
  assert.deepEqual(await readdir(prepared.sourceDir), ['server.jar']);
  assert.deepEqual(prepared.profile, { executable: f.input.javaExecutable, args: ['-Xms512M', '-Xmx2048M', '-jar', 'server.jar', 'nogui'], startTimeoutSeconds: 600, stopTimeoutSeconds: 180 });
  const second = await f.client.prepare(f.staging, f.input);
  assert.notEqual(second.sourceDir, prepared.sourceDir);
  assert.equal((await readdir(f.staging)).length, 2);
});
test('metadata streaming is bounded and redirects are never followed', async t => {
  const oversized = await fixture(t, { handle(req, res, origin) {
    res.end(JSON.stringify({ latest: { release: '1' }, versions: [{ id: '1', type: 'release', url: origin + '/v', sha1: 'f'.repeat(40) }] }) + ' '.repeat(9 * 1024 * 1024)); return true;
  } });
  await assert.rejects(oversized.client.listVersions(), /too large/);
  const redirect = await fixture(t, { handle(req, res) { res.writeHead(302, { location: 'http://example.invalid/never' }); res.end(); return true; } });
  await assert.rejects(redirect.client.listVersions(), /request failed/);
  assert.equal(redirect.requests.length, 1);
  const stalled = await fixture(t, { limits: { timeoutMs: 50 }, handle(req, res) { res.write(' '); return true; } });
  await assert.rejects(stalled.client.listVersions(), /abort|timeout/i);
});
test('metadata trust fails closed for arbitrary endpoints and malformed release manifests', async t => {
  for (const options of [{ origin: 'https://evil.test' }, { downloadHosts: ['evil.test'] }, { testOnly: { origin: 'https://evil.test' } }, { testOnly: { origin: 'http://localhost:8080' } }, { testOnly: { origin: 'http://127.0.0.1:8080/path' } }]) {
    assert.throws(() => new api.ServerSetupClient(options), /options|loopback/);
  }
  for (const manifest of [
    { latest: { release: '../bad' }, versions: [] },
    { latest: { release: '1.21.1' }, versions: [] },
    { latest: { release: '1.21.1' }, versions: [{ id: '1.21.1', type: 'release', url: 'https://evil.test/v', sha1: 'f'.repeat(40) }] },
  ]) {
    const f = await fixture(t, { manifest });
    await assert.rejects(f.client.listVersions(), /manifest|allowed/);
  }
});
test('listVersions lists official releases with a valid latest identifier', async t => {
  assert.equal(typeof api.ServerSetupClient, 'function', 'ServerSetupClient is implemented');
  const f = await fixture(t);
  assert.deepEqual(await f.client.listVersions(), { latest: '1.21.1', versions: [{ id: '1.21.1' }] });
  assert.deepEqual(f.requests, ['/mc/game/version_manifest_v2.json']);
});
test('discoverJava returns deduplicated working JAVA_HOME/PATH executables without shell lookup', async t => {
  assert.equal(typeof api.discoverJava, 'function', 'discoverJava is implemented');
  const dir = await root(t);
  await mkdir(path.join(dir, 'bin'));
  const name = process.platform === 'win32' ? 'java.exe' : 'java';
  const executable = process.platform === 'win32'
    ? await javaProbeFixture(dir, { executable: path.join(dir, 'bin', name), server: false })
    : await javaFixture(path.join(dir, 'bin'));
  if (process.platform !== 'win32') await symlink(executable, path.join(dir, 'bin', name));
  const previous = { PATH: process.env.PATH, JAVA_HOME: process.env.JAVA_HOME };
  process.env.PATH = path.join(dir, 'bin') + path.delimiter + '.';
  process.env.JAVA_HOME = dir;
  try {
    assert.deepEqual(await api.discoverJava(), [{ executable, major: 21, version: '21.0.4' }]);
    await rm(path.join(dir, 'bin', name));
    assert.deepEqual(await api.discoverJava(), []);
  } finally {
    for (const key of Object.keys(previous)) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});
test('probeJava bounds output/time and refuses non-native-selected paths', async t => {
  const dir = await root(t);
  const executable = await javaFixture(dir, '', { stdout: 'openjdk version "21"\n' + 'x'.repeat(32768), stderr: '' });
  await assert.rejects(api.probeJava(executable), /probe failed/);
  await javaFixture(dir, '21', { delayMs: 6500 });
  const before = Date.now();
  await assert.rejects(api.probeJava(executable), /probe failed/);
  assert.ok(Date.now() - before < 6000);
  for (const invalid of ['java', '', '/java\n', '/java\0', '/tmp/java.cmd', '/tmp/java.bat']) {
    await assert.rejects(api.probeJava(invalid), /selected Java executable/);
  }
});
test('probeJava understands legacy and unquoted modern stdout, rejects malformed versions', async t => {
  const dir = await root(t);
  const executable = await javaFixture(dir, '1.8.0_402');
  assert.equal((await api.probeJava(executable)).major, 8);
  await javaFixture(dir, '', { stdout: 'openjdk 25.0.1 2025-10-21\n', stderr: '' });
  assert.equal((await api.probeJava(executable)).major, 25);
  await javaFixture(dir, '21.bad');
  await assert.rejects(api.probeJava(executable), /version/);
});
test('probeJava runs a selected path with only -version and parses modern stderr', async t => {
  assert.equal(typeof api.probeJava, 'function', 'probeJava is implemented');
  const executable = await javaFixture(await root(t));
  assert.deepEqual(await api.probeJava(executable), { executable, major: 21, version: '21.0.4' });
});
