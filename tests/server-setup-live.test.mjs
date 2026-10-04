import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ServerSetupClient, probeJava } from '../dist/src/core/server-setup.js';

// Opt-in official network/download exercise, never a Minecraft launch or Java install.
// Use an already installed/parent-owned runtime selected with an absolute native path.
const executable = process.env.PEERHOST_SETUP_LIVE_JAVA;
test('LIVE official Vanilla/Fabric preparation with real Java and checksum-verified upstream jars', { skip: !executable, timeout: 240000 }, async t => {
  assert.ok(process.env.TMPDIR, 'Live artifacts must stay in TMPDIR');
  const stage = await mkdtemp(path.join(process.env.TMPDIR, 'peerhost-setup-live-'));
  t.after(() => rm(stage, { recursive: true, force: true }));
  const runtime = await probeJava(executable);
  const client = new ServerSetupClient();
  const versions = await client.listVersions();
  assert.ok(versions.versions.some(version => version.id === '1.21.1'));
  const input = { name: 'Official download verification', loader: 'vanilla', gameVersion: '1.21.1', javaExecutable: executable, memoryMiB: 2048, eulaAccepted: false };
  const vanilla = await client.prepare(stage, input);
  const fabric = await client.prepare(stage, { ...input, loader: 'fabric' });
  const jar = await readFile(path.join(vanilla.sourceDir, 'server.jar'));
  assert.equal(jar.readUInt32LE(0), 0x04034b50);
  assert.ok(jar.includes(Buffer.from('META-INF/MANIFEST.MF')));
  assert.deepEqual(await readFile(path.join(fabric.sourceDir, 'server.jar')), jar);
  const names = await readdir(path.join(fabric.sourceDir, 'libraries'));
  let loaderPresent = false; const libraries = [];
  for (const name of names) {
    const bytes = await readFile(path.join(fabric.sourceDir, 'libraries', name));
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    loaderPresent ||= bytes.includes(Buffer.from('net/fabricmc/loader/impl/launch/server/FabricServerLauncher.class'));
    libraries.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  assert.ok(loaderPresent, 'launcher executable code exists in verified upstream loader');
  assert.equal((await readdir(vanilla.sourceDir)).includes('eula.txt'), false);
  assert.equal((await readdir(fabric.sourceDir)).includes('eula.txt'), false);
  assert.equal((await readdir(fabric.sourceDir)).includes('world'), false);
  t.diagnostic(JSON.stringify({ runtime, latest: versions.latest, releaseCount: versions.versions.length, gameVersion: input.gameVersion, fabricLoader: '0.19.5', serverBytes: jar.length, serverSha1: createHash('sha1').update(jar).digest('hex'), libraries, vanillaProfile: vanilla.profile, fabricProfile: fabric.profile, minecraftLaunched: false, eulaAccepted: false }));
});
