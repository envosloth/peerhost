import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { watch, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import * as api from '../src/core/snapshots.js';

async function fixture(t: TestContext) {
  const root = path.resolve('.test-data');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'snapshots-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const store = path.join(dir, 'store');
  const destination = path.join(dir, 'destination');
  await mkdir(path.join(source, 'world', 'region'), { recursive: true });
  await mkdir(path.join(source, 'mods'), { recursive: true });
  await writeFile(path.join(source, 'world', 'region', 'r.0.0.mca'), Buffer.from([0, 255, 10, 13, 128]));
  await writeFile(path.join(source, 'mods', 'example.jar'), 'fixture mod bytes');
  await writeFile(path.join(source, 'server.properties'), 'server-port=25565\r\n');
  return { dir, source, store, destination };
}

function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

test('refuses to replace a file with a server directory', async (t) => {
  const { source, store, destination } = await fixture(t);
  const snapshot = await api.createSnapshot(source, store);
  await writeFile(destination, 'non-directory destination bytes');
  await assert.rejects(api.materializeSnapshot(store, snapshot.id, destination), /directory/i);
  assert.equal(await readFile(destination, 'utf8'), 'non-directory destination bytes');
});

test('rejects Windows device namespace roots rather than bypassing nesting checks', async (t) => {
  const { source } = await fixture(t);
  // Do not actually access device namespaces; preflight must reject them on every platform.
  for (const unsafe of ['\\\\?\\C:\\server', '\\\\.\\C:\\server']) {
    await assert.rejects(api.createSnapshot(unsafe, path.join(source, 'store')), /unsafe|namespace/i);
    await assert.rejects(api.importServer(source, unsafe), /unsafe|namespace/i);
  }
});

test('rejects ambiguous Windows trailing-dot roots before checking nesting', async (t) => {
  const { source } = await fixture(t);
  const aliasedSource = process.platform === 'win32' ? `${source}.` : source;
  const nestedStore = path.join(source, 'nested-store');
  await assert.rejects(api.createSnapshot(aliasedSource, nestedStore), /nest|overlap|disjoint/i);
  await assert.rejects(readdir(nestedStore), /ENOENT/, 'preflight must not create a store in source');
});

test('detects corruption of a just-published write before committing its manifest', async (t) => {
  const { source, store } = await fixture(t);
  const previous = await api.createSnapshot(source, store);
  const newBytes = 'new object subject to simulated write corruption';
  await writeFile(path.join(source, 'mods', 'example.jar'), newBytes);
  let corrupted = false;
  const watcher = watch(path.join(store, 'objects'), (_event, filename) => {
    if (!corrupted && filename?.toString() === digest(newBytes)) {
      corrupted = true;
      writeFileSync(path.join(store, 'objects', filename.toString()), 'corruption at publication');
    }
  });
  try {
    await assert.rejects(api.createSnapshot(source, store), /integrity|hash|corrupt/i);
    assert.equal(corrupted, true, 'real filesystem event must exercise write verification');
    assert.deepEqual(await api.readSnapshot(store, previous.id), previous);
    assert.equal((await readdir(path.join(store, 'snapshots'))).length, 1);
    assert.equal(await readFile(path.join(source, 'mods', 'example.jar'), 'utf8'), newBytes);
  } finally { watcher.close(); }
});

test('copy-only import leaves source bytes unchanged and creates separately writable managed servers', async (t) => {
  const { dir, source } = await fixture(t);
  const managedRoot = path.join(dir, 'managed');
  const names = ['mods/example.jar', 'server.properties', 'world/region/r.0.0.mca'];
  const before = await Promise.all(names.map((name) => readFile(path.join(source, name))));
  assert.equal(typeof api.importServer, 'function', 'copy-only import API must exist');
  const imported = await api.importServer(source, managedRoot);
  assert.equal(path.isAbsolute(imported.serverDir), true);
  assert.equal(path.isAbsolute(imported.storeDir), true);
  assert.deepEqual(await api.readSnapshot(imported.storeDir, imported.snapshot.id), imported.snapshot);
  for (const [index, name] of names.entries()) {
    assert.deepEqual(await readFile(path.join(imported.serverDir, name)), before[index]);
    assert.deepEqual(await readFile(path.join(source, name)), before[index]);
  }
  await writeFile(path.join(imported.serverDir, 'server.properties'), 'managed-only-change');
  const second = await api.importServer(source, managedRoot);
  assert.notEqual(second.serverDir, imported.serverDir);
  assert.equal(second.snapshot.id, imported.snapshot.id);
  assert.equal(await readFile(path.join(imported.serverDir, 'server.properties'), 'utf8'), 'managed-only-change');
  assert.deepEqual(await Promise.all(names.map((name) => readFile(path.join(source, name)))), before);
  for (const root of [source, path.join(source, 'managed'), dir]) {
    await assert.rejects(api.importServer(source, root), /nest|overlap|disjoint/i);
  }
});

test('rejects observed source mutations instead of publishing an inconsistent revision', async (t) => {
  const { source, store } = await fixture(t);
  await writeFile(path.join(source, 'world', 'region', 'large.mca'), Buffer.alloc(16 * 1024 * 1024, 137));
  await api.createSnapshot(source, store);
  const mod = path.join(source, 'mods', 'example.jar');
  const newBytes = 'new fixture mod';
  await writeFile(mod, newBytes);
  let mutated = false;
  const watcher = watch(path.join(store, 'objects'), (_event, filename) => {
    if (!mutated && filename?.toString() === digest(newBytes)) {
      mutated = true;
      writeFileSync(mod, 'concurrent mutation after first object publication');
    }
  });
  try {
    await assert.rejects(api.createSnapshot(source, store), /changed|mutation|stopped|source/i);
    assert.equal(mutated, true, 'real filesystem watcher must exercise the mutation');
    assert.equal((await readdir(path.join(store, 'snapshots'))).length, 1);
  } finally { watcher.close(); }
});

test('rejects equal or nested source/store and store/destination roots before modifying either', async (t) => {
  const { dir, source, store } = await fixture(t);
  const original = await readFile(path.join(source, 'server.properties'));
  await assert.rejects(api.createSnapshot(source, source), /nest|overlap|disjoint/i);
  await assert.rejects(api.createSnapshot(source, path.join(source, 'nested-store')), /nest|overlap|disjoint/i);
  await assert.rejects(api.createSnapshot(source, dir), /nest|overlap|disjoint/i);
  assert.deepEqual(await readFile(path.join(source, 'server.properties')), original);
  const snapshot = await api.createSnapshot(source, store);
  await assert.rejects(api.materializeSnapshot(store, snapshot.id, store), /nest|overlap|disjoint/i);
  await assert.rejects(api.materializeSnapshot(store, snapshot.id, path.join(store, 'destination')), /nest|overlap|disjoint/i);
  await assert.rejects(api.materializeSnapshot(store, snapshot.id, dir), /nest|overlap|disjoint/i);
  assert.deepEqual(await api.readSnapshot(store, snapshot.id), snapshot);
});

test('refuses source, store, and destination junctions including linked ancestors', async (t) => {
  const { dir, source, store, destination } = await fixture(t);
  const alias = path.join(dir, 'source-alias');
  await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(api.createSnapshot(alias, store), /symlink|reparse|link/i);
  await assert.rejects(api.createSnapshot(path.join(alias, 'world'), store), /symlink|reparse|link/i);
  const nested = path.join(source, 'linked-mods');
  await symlink(path.join(source, 'mods'), nested, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(api.createSnapshot(source, store), /symlink|reparse|link/i);
  await rm(nested);
  const snapshot = await api.createSnapshot(source, store);
  const storeAlias = path.join(dir, 'store-alias');
  await symlink(store, storeAlias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(api.readSnapshot(storeAlias, snapshot.id), /symlink|reparse|link/i);
  await symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(api.materializeSnapshot(store, snapshot.id, destination), /symlink|reparse|link/i);
  await assert.rejects(api.materializeSnapshot(store, snapshot.id, path.join(destination, 'child')), /symlink|reparse|link/i);
  assert.equal(await readFile(path.join(source, 'server.properties'), 'utf8'), 'server-port=25565\r\n');
});

test('missing, tampered, or partial input never replaces an existing destination', async (t) => {
  for (const failure of ['tampered-object', 'truncated-object', 'missing-object', 'partial-manifest', 'missing-manifest']) {
    const { dir, source, store, destination } = await fixture(t);
    const snapshot = await api.createSnapshot(source, store);
    await mkdir(destination);
    await writeFile(path.join(destination, 'sentinel.txt'), 'must survive');
    const object = path.join(store, 'objects', snapshot.files[0]!.hash);
    if (failure === 'tampered-object') await writeFile(object, 'x'.repeat(snapshot.files[0]!.size));
    if (failure === 'truncated-object') await writeFile(object, 'x');
    if (failure === 'missing-object') await rm(object);
    if (failure === 'partial-manifest') await writeFile(path.join(store, 'snapshots', `${snapshot.id}.json`), '{"version":1');
    if (failure === 'missing-manifest') await rm(path.join(store, 'snapshots', `${snapshot.id}.json`));
    const before = (await readdir(dir)).sort();
    await assert.rejects(api.materializeSnapshot(store, snapshot.id, destination), failure);
    assert.equal(await readFile(path.join(destination, 'sentinel.txt'), 'utf8'), 'must survive', failure);
    assert.deepEqual(await readdir(destination), ['sentinel.txt']);
    assert.deepEqual((await readdir(dir)).sort(), before, 'no abandoned staging/backup on invalid input');
  }
});

test('never overwrites or silently reuses a corrupted published object or manifest', async (t) => {
  const { source, store } = await fixture(t);
  const snapshot = await api.createSnapshot(source, store);
  const object = path.join(store, 'objects', snapshot.files[0]!.hash);
  const originalObject = await readFile(object);
  await writeFile(object, 'corrupt object');
  await assert.rejects(api.createSnapshot(source, store), /integrity|hash|corrupt/i);
  assert.equal(await readFile(object, 'utf8'), 'corrupt object', 'immutable store must not repair by overwrite');
  await writeFile(object, originalObject);
  const manifestFile = path.join(store, 'snapshots', `${snapshot.id}.json`);
  await writeFile(manifestFile, 'corrupt manifest');
  await assert.rejects(api.createSnapshot(source, store), /integrity|hash|corrupt/i);
  assert.equal(await readFile(manifestFile, 'utf8'), 'corrupt manifest');
  assert.equal((await readdir(store)).filter((entry) => entry.startsWith('.staging-')).length, 0);
});

test('materializes independent file copies and retains the replaced directory as a backup', async (t) => {
  const { dir, source, store, destination } = await fixture(t);
  const snapshot = await api.createSnapshot(source, store);
  await mkdir(destination);
  await writeFile(path.join(destination, 'old.txt'), 'prior destination bytes');
  assert.equal(typeof api.materializeSnapshot, 'function', 'snapshot materialization API must exist');
  await api.materializeSnapshot(store, snapshot.id, destination);
  for (const file of snapshot.files) {
    assert.deepEqual(await readFile(path.join(destination, ...file.path.split('/'))),
      await readFile(path.join(source, ...file.path.split('/'))));
  }
  await assert.rejects(readFile(path.join(destination, 'old.txt')), /ENOENT/);
  const backups = (await readdir(dir)).filter((name) => name.startsWith('.peerhost-previous-'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(path.join(dir, backups[0]!, 'old.txt'), 'utf8'), 'prior destination bytes');
  const file = snapshot.files[0]!;
  const objectBefore = await readFile(path.join(store, 'objects', file.hash));
  await writeFile(path.join(destination, ...file.path.split('/')), 'managed copy changed');
  assert.deepEqual(await readFile(path.join(store, 'objects', file.hash)), objectBefore);
  assert.deepEqual(await readFile(path.join(source, ...file.path.split('/'))), objectBefore);
});

test('rejects tampered manifests and unsafe metadata even when attacker recomputes its ID', async (t) => {
  const { source, store } = await fixture(t);
  const original = await api.createSnapshot(source, store);
  await writeFile(path.join(store, 'snapshots', `${original.id}.json`), JSON.stringify({ ...original, files: [] }));
  await assert.rejects(api.readSnapshot(store, original.id), /manifest|integrity|hash/i);
  const invalidFiles = [
    [{ path: '../escape', size: 0, hash: digest('') }],
    [{ path: 'C:/escape', size: 0, hash: digest('') }],
    [{ path: 'world\\level.dat', size: 0, hash: digest('') }],
    [{ path: 'world/a', size: 0, hash: digest('') }, { path: 'WORLD/b', size: 0, hash: digest('') }],
    [{ path: 'a', size: 0, hash: digest('') }, { path: 'a/b', size: 0, hash: digest('') }],
    [{ path: 'a', size: 0, hash: digest('') }, { path: 'a', size: 0, hash: digest('') }],
    [{ path: 'b', size: 0, hash: digest('') }, { path: 'a', size: 0, hash: digest('') }],
    [{ path: 'a', size: -1, hash: digest('') }],
    [{ path: 'a', size: 1.5, hash: digest('') }],
    [{ path: 'a', size: Number.MAX_SAFE_INTEGER + 1, hash: digest('') }],
    [{ path: 'a', size: 0, hash: '../object' }],
    [{ path: 'a', size: 0, hash: digest(''), extra: true }],
    [{ path: 'S/a', size: 0, hash: digest('') }, { path: 'ſ/b', size: 0, hash: digest('') }],
  ];
  for (const files of invalidFiles) {
    const id = digest(JSON.stringify({ version: 1, parentId: null, files }));
    await writeFile(path.join(store, 'snapshots', `${id}.json`), JSON.stringify({ version: 1, id, parentId: null, files }));
    await assert.rejects(api.readSnapshot(store, id), /manifest|path|collision|canonical|size|hash/i);
  }
  for (const id of ['../escape', 'C:escape', 'a'.repeat(63), 'A'.repeat(64)]) {
    await assert.rejects(api.readSnapshot(store, id), /id|hash/i);
  }
});

for (const [kind, surrogate] of [['high', '\ud800'], ['low', '\udc00']] as const) {
  for (const hashValid of [false, true]) {
    test(`refuses ${hashValid ? 'hash-valid' : 'tampered'} manifests with unpaired ${kind} surrogates without changing destination`, async (t) => {
      const { dir, source, store, destination } = await fixture(t);
      const original = await api.createSnapshot(source, store);
      // Both objects exist and verify; only these path spellings differ from a valid snapshot.
      const files = [
        { ...original.files[0]!, path: `${surrogate}/a.txt` },
        { ...original.files[1]!, path: '\ufffd/b.txt' },
      ];
      const recomputedId = digest(JSON.stringify({ version: 1, parentId: null, files }));
      const id = hashValid ? recomputedId : original.id;
      const manifest = { version: 1, id, parentId: null, files };
      const manifestFile = path.join(store, 'snapshots', `${id}.json`);
      await writeFile(manifestFile, JSON.stringify(manifest));
      assert.deepEqual(JSON.parse(await readFile(manifestFile, 'utf8')), manifest);
      assert.notEqual(recomputedId, original.id, 'tampered paths change the manifest digest');

      const sentinel = Buffer.from([0, 255, 10, 13, 128]);
      const retained = Buffer.from([42, 0, 129, 255]);
      await mkdir(path.join(destination, 'retained'), { recursive: true });
      await writeFile(path.join(destination, 'sentinel.bin'), sentinel);
      await writeFile(path.join(destination, 'retained', 'existing.bin'), retained);
      const beforeDestination = (await readdir(destination, { recursive: true })).sort();
      const beforeParent = (await readdir(dir)).sort();

      await assert.rejects(api.materializeSnapshot(store, id, destination), /unicode|path|manifest|integrity|hash/i);
      await assert.rejects(api.readSnapshot(store, id), /unicode|path|manifest|integrity|hash/i);
      assert.deepEqual(await readFile(path.join(destination, 'sentinel.bin')), sentinel);
      assert.deepEqual(await readFile(path.join(destination, 'retained', 'existing.bin')), retained);
      assert.deepEqual((await readdir(destination, { recursive: true })).sort(), beforeDestination);
      await assert.rejects(readdir(path.join(destination, '\ufffd')), /ENOENT/, 'no merged replacement-character directory');
      assert.deepEqual((await readdir(dir)).sort(), beforeParent, 'no staging or backup directories on refusal');
    });
  }
}

test('round-trips valid paired emoji and NFC Unicode paths without merging directories', async (t) => {
  const { source, store, destination } = await fixture(t);
  const names = ['\ud83d\ude00/caf\u00e9.txt', '\ufffd/b.txt'];
  const contents = [Buffer.from([0, 255, 128]), Buffer.from('literal replacement-character directory')];
  for (const [index, name] of names.entries()) {
    await mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await writeFile(path.join(source, name), contents[index]!);
  }
  const snapshot = await api.createSnapshot(source, store);
  assert.deepEqual(await api.readSnapshot(store, snapshot.id), snapshot);
  await api.materializeSnapshot(store, snapshot.id, destination);
  for (const [index, name] of names.entries()) {
    assert.equal(snapshot.files.some((file) => file.path === name), true);
    assert.deepEqual(await readFile(path.join(destination, name)), contents[index]);
  }
  assert.deepEqual((await readdir(path.join(destination, '\ud83d\ude00'))).sort(), ['caf\u00e9.txt']);
  assert.deepEqual((await readdir(path.join(destination, '\ufffd'))).sort(), ['b.txt']);
});

test('rejects unknown or malformed parent revisions before creating a snapshot', async (t) => {
  const { source, store } = await fixture(t);
  await assert.rejects(api.createSnapshot(source, store, '../escape'), /id|hash/i);
  await assert.rejects(api.createSnapshot(source, store, 'a'.repeat(64)), /ENOENT|parent|snapshot/i);
});

test('retains independently readable prior revisions and binds parent ancestry into the ID', async (t) => {
  const { source, store } = await fixture(t);
  const first = await api.createSnapshot(source, store);
  const oldManifest = await readFile(path.join(store, 'snapshots', `${first.id}.json`));
  await writeFile(path.join(source, 'server.properties'), 'server-port=25566\n');
  const second = await api.createSnapshot(source, store, first.id);
  assert.notEqual(second.id, first.id);
  assert.equal(second.parentId, first.id);
  assert.equal(typeof api.readSnapshot, 'function', 'snapshot reading API must exist');
  assert.deepEqual(await api.readSnapshot(store, first.id), first);
  assert.deepEqual(await api.readSnapshot(store, second.id), second);
  assert.deepEqual(await readFile(path.join(store, 'snapshots', `${first.id}.json`)), oldManifest);
  assert.equal((await readdir(path.join(store, 'snapshots'))).length, 2);
});

test('creates deterministic content-addressed manifests with raw-content objects', async (t) => {
  const { source, store } = await fixture(t);
  assert.equal(typeof api.createSnapshot, 'function', 'snapshot creation API must exist');
  const first = await api.createSnapshot(source, store);
  const second = await api.createSnapshot(source, store);
  assert.deepEqual(first, second);
  assert.equal(first.version, 1);
  assert.equal(first.parentId, null);
  assert.deepEqual(first.files.map((file: { path: string }) => file.path), [
    'mods/example.jar', 'server.properties', 'world/region/r.0.0.mca',
  ]);
  assert.equal(first.id, digest(JSON.stringify({ version: 1, parentId: null, files: first.files })));
  for (const file of first.files) {
    const bytes = await readFile(path.join(source, ...file.path.split('/')));
    assert.equal(file.size, bytes.length);
    assert.equal(file.hash, digest(bytes));
    assert.deepEqual(await readFile(path.join(store, 'objects', file.hash)), bytes);
  }
  assert.deepEqual(JSON.parse(await readFile(path.join(store, 'snapshots', `${first.id}.json`), 'utf8')), first);
  assert.equal((await readdir(path.join(store, 'snapshots'))).length, 1);
});

test('skips only transient entries that vanish during recursive safety validation', { timeout: 60000 }, async (t) => {
  const { dir, source, store } = await fixture(t);
  const snapshot = await api.createSnapshot(source, store);
  // Aggressively churn .transfer-* directories inside the store root, exactly like concurrent
  // receivers creating and removing their private staging directories during validation.
  let churning = true;
  const staging: string[] = [];
  const churn = async (tag: string) => {
    for (let index = 0; churning; index++) {
      const directory = path.join(store, `.transfer-${tag}-${index}`);
      staging.push(directory);
      try {
        await mkdir(path.join(directory, 'metadata', 'snapshots'), { recursive: true });
        await mkdir(path.join(directory, 'objects'));
        for (let entry = 0; entry < 24; entry++) {
          await writeFile(path.join(directory, 'objects', `entry-${entry}`), 'transient');
        }
      } catch { /* the churner races only itself; a vanished directory is simply skipped */ }
      await rm(directory, { recursive: true, force: true });
    }
  };
  const churners = ['a', 'b', 'c'].map((tag) => churn(tag));
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      assert.deepEqual(await api.readSnapshot(store, snapshot.id), snapshot,
        `validation must skip only entries that vanished during the walk; attempt ${attempt}`);
    }
    // A junction that is present at check time is still rejected while churn continues.
    const outside = path.join(dir, 'outside');
    await mkdir(outside);
    const junction = path.join(store, `.transfer-junction-${process.pid}`);
    await symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(api.readSnapshot(store, snapshot.id), /symlink|reparse|link/i);
    await rm(junction, { recursive: true, force: true });
    // The tolerance applies only to enumerated children: a missing walk root still fails.
    await assert.rejects(api.readSnapshot(path.join(dir, 'missing-store'), snapshot.id), /ENOENT/);
  } finally {
    churning = false;
    await Promise.all(churners);
    for (const directory of staging) await rm(directory, { recursive: true, force: true });
  }
  assert.equal((await readdir(store)).filter((entry) => entry.startsWith('.transfer-')).length, 0,
    'churn leaves no abandoned staging directories');
});
