import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync, crc32 } from 'node:zlib';
import { createIdentity } from '../src/core/peer-transport.js';
import { PeerHostApplication } from '../src/core/application.js';
import { OwnershipLedger } from '../src/core/ownership.js';
import { RelayNode } from '../src/core/relay.js';
import { validateCall } from '../src/core/ipc-policy.js';
import { CLIENT_PACK_DIR } from '../src/core/mods.js';
import { writeZip } from '../src/core/zip.js';

const fixture = path.resolve('tools/fake-java-server.mjs');
const renderer = 'file:///app/index.html';
const trusted = { senderId: 1, expectedSenderId: 1, isMainFrame: true };

/** A minimal but real jar: a zip containing a mod manifest. */
async function jar(directory: string, name: string, marker = name): Promise<string> {
  const file = path.join(directory, name);
  await writeZip(file, [{ name: 'META-INF/mods.toml', data: Buffer.from(`modId="${marker}"\n`) }]);
  return file;
}
/** Independent reader: parses the central directory and inflates each entry. */
function readZip(bytes: Buffer): Map<string, Buffer> {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'end of central directory');
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10), checksum = bytes.readUInt32LE(cursor + 16), size = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const body = bytes.subarray(start, start + size);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    assert.equal(crc32(data) >>> 0, checksum, `${name} crc`);
    files.set(name, data);
    cursor += 46 + nameLength + extra + comment;
  }
  return files;
}
async function setup(t: TestContext, prefix: string) {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(path.resolve('.test-data/' + prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), downloads = path.join(root, 'downloads');
  await mkdir(path.join(source, 'mods'), { recursive: true });
  await mkdir(downloads);
  await writeFile(path.join(source, 'eula.txt'), 'eula=true\n');
  await writeFile(path.join(source, 'mods', 'existing-mod.jar'), (await readFile(await jar(downloads, 'seed.jar'))));
  const identity = await createIdentity();
  const app = new PeerHostApplication(path.join(root, 'profile'), identity);
  t.after(() => app.close().catch(() => {}));
  await app.open();
  await app.importExisting(source, true);
  return { root, source, downloads, identity, app };
}
const serverDir = async (app: PeerHostApplication) => (await app.getState()).server!.serverDir;

test('server mods are installed into mods/, listed, and travel with the next snapshot', async (t) => {
  const { downloads, app } = await setup(t, 'mods-server-');
  assert.deepEqual((await app.getState()).server!.mods.server.map((mod) => mod.name), ['existing-mod.jar']);
  const create = await jar(downloads, 'create-1.21.jar');
  const jei = await jar(downloads, 'jei-19.jar');
  assert.deepEqual(await app.addMods('server', [create, jei]), ['create-1.21.jar', 'jei-19.jar']);
  const mods = (await app.getState()).server!.mods;
  assert.deepEqual(mods.server.map((mod) => mod.name), ['create-1.21.jar', 'existing-mod.jar', 'jei-19.jar']);
  assert.deepEqual(mods.client, []);
  assert.deepEqual(await readFile(path.join(await serverDir(app), 'mods', 'create-1.21.jar')), await readFile(create));
  await app.createSnapshot();
  const state = await app.getState();
  const manifest = JSON.parse(await readFile(path.join(state.server!.storeDir, 'snapshots', state.server!.snapshotId + '.json'), 'utf8'));
  assert.ok(manifest.files.some((file: { path: string }) => file.path === 'mods/jei-19.jar'));
  await app.removeMod('server', 'jei-19.jar');
  assert.deepEqual((await app.getState()).server!.mods.server.map((mod) => mod.name), ['create-1.21.jar', 'existing-mod.jar']);
  await assert.rejects(app.removeMod('server', 'jei-19.jar'), /not installed/i);
});

test('client mods are kept apart from the server and exported as a zip for players', async (t) => {
  const { root, downloads, app } = await setup(t, 'mods-client-');
  const shaders = await jar(downloads, 'iris-shaders.jar', 'iris');
  const minimap = await jar(downloads, 'xaeros-minimap.jar', 'xaero');
  await assert.rejects(app.exportClientPack(path.join(root, 'empty.zip')), /no client mods/i);
  await app.addMods('client', [shaders, minimap]);
  const dir = await serverDir(app);
  assert.deepEqual((await readdir(path.join(dir, 'mods'))).sort(), ['existing-mod.jar'], 'the server never loads client mods');
  assert.deepEqual((await readdir(path.join(dir, CLIENT_PACK_DIR))).sort(), ['iris-shaders.jar', 'xaeros-minimap.jar']);
  assert.deepEqual((await app.getState()).server!.mods.client.map((mod) => mod.name), ['iris-shaders.jar', 'xaeros-minimap.jar']);
  const destination = path.join(root, 'out', 'My Server client mods.zip');
  await mkdir(path.dirname(destination));
  const result = await app.exportClientPack(destination);
  assert.equal(result.mods, 2);
  const zip = readZip(await readFile(destination));
  assert.deepEqual([...zip.keys()].sort(), ['README.txt', 'mods/iris-shaders.jar', 'mods/xaeros-minimap.jar']);
  assert.deepEqual(zip.get('mods/iris-shaders.jar'), await readFile(shaders), 'byte-exact');
  assert.match(zip.get('README.txt')!.toString(), /\.minecraft[\\/]mods/);
  assert.deepEqual((await readdir(path.dirname(destination))), ['My Server client mods.zip'], 'no temporary left behind');
  await assert.rejects(app.exportClientPack(path.join(dir, 'pack.zip')), /outside the server folder/i);
  await assert.rejects(app.exportClientPack(path.join(root, 'pack.txt')), /\.zip/i);
});

test('a batch is refused as a whole when any file is not a real, unique jar', async (t) => {
  const { root, downloads, app } = await setup(t, 'mods-invalid-');
  const good = await jar(downloads, 'good.jar');
  const text = path.join(downloads, 'fake.jar');
  await writeFile(text, 'this is not a zip');
  const notJar = await jar(downloads, 'archive.zip');
  const duplicate = await jar(downloads, 'EXISTING-MOD.jar');
  const reserved = await jar(downloads, 'con.jar');
  for (const [batch, pattern] of [
    [[good, text], /not a valid jar/i],
    [[good, notJar], /\.jar/i],
    [[good, duplicate], /already installed/i],
    [[good, good], /twice/i],
    [[good, path.join(downloads, 'missing.jar')], /ENOENT|not found/i],
    [[good, 'relative/path.jar'], /absolute/i],
    [[good, reserved], /reserved|unsafe/i],
    [[], /at least one/i],
  ] as const) {
    await assert.rejects(app.addMods('server', [...batch]), pattern);
    assert.deepEqual((await app.getState()).server!.mods.server.map((mod) => mod.name), ['existing-mod.jar'], `nothing copied for ${pattern}`);
  }
  if (process.platform !== 'win32') {
    const link = path.join(downloads, 'link.jar');
    await symlink(good, link);
    await assert.rejects(app.addMods('server', [link]), /symlink|regular file/i);
  }
  assert.deepEqual((await readdir(path.join(await serverDir(app), 'mods'))), ['existing-mod.jar'], 'no temporaries left behind');
  await assert.rejects(app.removeMod('server', '../eula.txt'), /not installed|unsafe/i);
  await access(path.join(await serverDir(app), 'eula.txt'));
  void root;
});

test('mods can only change while this PC holds the stopped server', async (t) => {
  const { downloads, identity, app } = await setup(t, 'mods-ownership-');
  const mod = await jar(downloads, 'late.jar');
  await app.saveProfile({ executable: process.execPath, args: [fixture, '--lifetime-ms=30000'] });
  await app.startServer(true);
  await assert.rejects(app.addMods('server', [mod]), /stop/i);
  await app.stopServer();
  await new OwnershipLedger((await app.getState()).server!.ledgerFile, identity.fingerprint).markUncertain();
  await assert.rejects(app.addMods('client', [mod]), /ownership/i);
  await assert.rejects(app.removeMod('server', 'existing-mod.jar'), /ownership/i);
});

test('both mod lists travel with a relay claim to another PC', async (t) => {
  const { root, downloads, identity, app: a } = await setup(t, 'mods-relay-');
  const relay = new RelayNode(path.join(root, 'relay'), await createIdentity(), { log: () => {} });
  await relay.open(); await relay.listen();
  t.after(() => relay.close());
  const ib = await createIdentity();
  const b = new PeerHostApplication(path.join(root, 'b'), ib);
  t.after(() => b.close().catch(() => {}));
  await b.open();
  for (const [app, id] of [[a, identity], [b, ib]] as const) {
    await relay.trust(id.fingerprint.slice(0, 8), id.fingerprint);
    await app.addPeer({ name: 'Relay', fingerprint: relay.identity.fingerprint, ...relay.endpoint! });
    await app.saveRelay({ fingerprint: relay.identity.fingerprint, parkOnStop: false });
  }
  await a.addMods('server', [await jar(downloads, 'server-only.jar')]);
  await a.addMods('client', [await jar(downloads, 'client-only.jar')]);
  await a.parkAtRelay();
  await b.claimFromRelay();
  const mods = (await b.getState()).server!.mods;
  assert.deepEqual(mods.server.map((mod) => mod.name), ['existing-mod.jar', 'server-only.jar']);
  assert.deepEqual(mods.client.map((mod) => mod.name), ['client-only.jar']);
});

test('mod IPC payloads are validated', () => {
  assert.deepEqual(validateCall('addMods', { kind: 'server' }, renderer, renderer, trusted), { kind: 'server' });
  assert.deepEqual(validateCall('removeMod', { kind: 'client', name: 'x.jar' }, renderer, renderer, trusted), { kind: 'client', name: 'x.jar' });
  assert.deepEqual(validateCall('exportClientPack', undefined, renderer, renderer, trusted), {});
  for (const payload of [{ kind: 'both' }, {}, { kind: 'server', extra: 1 }]) assert.throws(() => validateCall('addMods', payload, renderer, renderer, trusted), /mod/i);
  for (const payload of [{ kind: 'server', name: '' }, { kind: 'server', name: 'a/b.jar' }, { kind: 'server', name: 'x'.repeat(300) }]) {
    assert.throws(() => validateCall('removeMod', payload, renderer, renderer, trusted), /mod/i);
  }
});
