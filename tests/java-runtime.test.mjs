import test from 'node:test';
import { javaProbeFixture } from './java-probe-fixture.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, mkdir, lstat, readlink } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { ServerSetupClient, mojangRuntimePlatform, discoverJava } from '../dist/src/core/server-setup.js';

// Java is provisioned automatically from Mojang's official runtime manifests (checksummed per file),
// so a beginner never installs or picks Java. Fixtures only — never a real JVM or Minecraft.
const scratch = process.env.TMPDIR;
assert.ok(scratch, 'Tests require TMPDIR; never use application state');
const hash = (value, algorithm = 'sha1') => createHash(algorithm).update(value).digest('hex');
const ALL = '/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const javaBytes = async (dir, version) => readFile(await javaProbeFixture(dir, { version, server: false }));

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(scratch, 'java-runtime-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests = []; let origin;
  const jar = Buffer.from('PK fixture server bytes, NOT real Minecraft');
  const java = await javaBytes(dir, options.runtimeVersion ?? '21.0.7');
  const license = Buffer.from('fixture licence text');
  const platform = mojangRuntimePlatform();
  const exe = platform.startsWith('windows') ? 'bin/java.exe' : platform.startsWith('mac') ? 'jre.bundle/Contents/Home/bin/java' : 'bin/java';
  const home = exe.slice(0, -'bin/java'.length - (exe.endsWith('.exe') ? 4 : 0));
  const blobs = { java: options.tamperRuntime ? Buffer.from('tampered') : java, license };
  const files = options.files ?? {
    [home + 'bin']: { type: 'directory' },
    [exe]: { type: 'file', executable: true, downloads: { raw: { url: '', sha1: hash(java), size: java.length } }, blob: 'java' },
    [home + 'legal']: { type: 'directory' },
    [home + 'legal/LICENSE']: { type: 'file', executable: false, downloads: { raw: { url: '', sha1: hash(license), size: license.length } }, blob: 'license' },
    ...(platform.startsWith('windows') ? {} : { [home + 'legal/COPY']: { type: 'link', target: 'LICENSE' } }),
  };
  const runtimeManifest = () => JSON.stringify({ files: Object.fromEntries(Object.entries(files).map(([name, entry]) => {
    const { blob, ...rest } = entry;
    return [name, rest.downloads ? { ...rest, downloads: { raw: { ...rest.downloads.raw, url: `${origin}/blob/${blob}` } } } : rest];
  })) });
  const all = () => JSON.stringify({ [platform]: { 'java-runtime-delta': [{ manifest: { sha1: hash(runtimeManifest()), size: runtimeManifest().length, url: origin + '/runtime-manifest.json' }, version: { name: '21.0.7' } }] } });
  const metadata = () => JSON.stringify({ id: '1.21.1', javaVersion: { component: 'java-runtime-delta', majorVersion: 21 }, downloads: { server: { url: origin + '/server.jar', size: jar.length, sha1: hash(jar) } } });
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/mc/game/version_manifest_v2.json') return res.end(JSON.stringify({ latest: { release: '1.21.1' }, versions: [{ id: '1.21.1', type: 'release', url: origin + '/version.json', sha1: hash(metadata()) }] }));
    if (req.url === '/version.json') return res.end(metadata());
    if (req.url === '/server.jar') return res.end(jar);
    if (req.url === ALL) return res.end(all());
    if (req.url === '/runtime-manifest.json') return res.end(runtimeManifest());
    if (req.url.startsWith('/blob/')) return res.end(blobs[req.url.slice(6)]);
    res.statusCode = 404; res.end('missing');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const staging = path.join(dir, 'stage'); await mkdir(staging);
  const runtimes = path.join(dir, 'runtimes');
  const input = { name: 'Friends world', loader: 'vanilla', gameVersion: '1.21.1', javaExecutable: '', memoryMiB: 2048, eulaAccepted: true };
  return { dir, requests, staging, runtimes, input, exe, client: new ServerSetupClient({ testOnly: { origin } }) };
}
const noSystemJava = async (t) => {
  const previous = { PATH: process.env.PATH, JAVA_HOME: process.env.JAVA_HOME };
  process.env.PATH = ''; delete process.env.JAVA_HOME;
  t.after(() => { for (const key of Object.keys(previous)) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; });
};

test('automatic Java: with no Java on the PC, the official Mojang runtime is downloaded, verified and used', async t => {
  await noSystemJava(t);
  const f = await fixture(t);
  const prepared = await f.client.prepare(f.staging, f.input, { runtimeRoot: f.runtimes });
  const expected = path.join(f.runtimes, 'java-runtime-delta', ...f.exe.split('/'));
  assert.equal(prepared.profile.executable, expected);
  assert.deepEqual(prepared.profile.args, ['-Xms512M', '-Xmx2048M', '-jar', 'server.jar', 'nogui']);
  assert.equal(await readFile(path.join(prepared.sourceDir, 'eula.txt'), 'utf8'), 'eula=true\n');
  if (process.platform !== 'win32') {
    assert.ok(((await lstat(expected)).mode & 0o100) !== 0, 'java is executable');
    const link = path.join(path.dirname(path.dirname(expected)), 'legal', 'COPY');
    assert.equal(await readlink(link), 'LICENSE', 'in-tree runtime links are recreated');
  }
  assert.deepEqual((await readdir(f.runtimes)).sort(), ['java-runtime-delta'], 'no partial download directories remain');
  // Installed runtimes are reused, and offered by discovery, without downloading again.
  const before = f.requests.filter(url => url.startsWith('/blob/')).length;
  await f.client.prepare(f.staging, f.input, { runtimeRoot: f.runtimes });
  assert.equal(f.requests.filter(url => url.startsWith('/blob/')).length, before, 'runtime reused');
  assert.deepEqual((await discoverJava(f.runtimes)).map(java => [java.executable, java.major]), [[expected, 21]]);
});

test('automatic Java fails closed on a tampered runtime file and leaves nothing behind', async t => {
  await noSystemJava(t);
  const f = await fixture(t, { tamperRuntime: true });
  await assert.rejects(f.client.prepare(f.staging, f.input, { runtimeRoot: f.runtimes }), /integrity/);
  assert.deepEqual(await readdir(f.runtimes).catch(() => []), []);
  assert.deepEqual(await readdir(f.staging), []);
});

test('automatic Java refuses runtime manifests that escape the runtime folder', async t => {
  await noSystemJava(t);
  for (const files of [
    { '../escape': { type: 'directory' } },
    { '/etc/evil': { type: 'directory' } },
    { 'bin/java': { type: 'link', target: '../../../../etc/passwd' } },
  ]) {
    const f = await fixture(t, { files });
    await assert.rejects(f.client.prepare(f.staging, f.input, { runtimeRoot: f.runtimes }), /runtime/i);
    assert.deepEqual(await readdir(f.runtimes).catch(() => []), []);
  }
});

test('automatic Java prefers a compatible Java already on the PC and needs no download', async t => {
  const f = await fixture(t);
  const bin = path.join(f.dir, 'system-bin'); await mkdir(bin);
  const name = process.platform === 'win32' ? 'java.exe' : 'java';
  await javaProbeFixture(f.dir, { executable: path.join(bin, name), version: '21.0.4', server: false });
  const previous = { PATH: process.env.PATH, JAVA_HOME: process.env.JAVA_HOME };
  process.env.PATH = bin; delete process.env.JAVA_HOME;
  t.after(() => { for (const key of Object.keys(previous)) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; });
  const prepared = await f.client.prepare(f.staging, f.input, { runtimeRoot: f.runtimes });
  assert.equal(prepared.profile.executable, path.join(bin, name));
  assert.equal(f.requests.includes(ALL), false, 'no runtime download when a compatible Java exists');
});

test('an empty Java choice without a runtime folder is refused before any download', async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.prepare(f.staging, f.input), /Java/);
  assert.deepEqual(f.requests, []);
});
