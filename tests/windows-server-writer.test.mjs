import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeManagedText, readManagedText } from '../dist/src/core/server-files.js';
import { windowsServerWrite, windowsServerRecover } from '../dist/src/core/windows-server-writer.js';
const scratch = 'C:/Users/angel/AppData/Local/hermes/cache/scratch';
async function fixture(t) {
  assert.equal(path.resolve(process.env.TMPDIR), path.resolve(scratch));
  const sandbox = await fs.mkdtemp(path.join(scratch, 'windows-writer-'));
  const root = path.join(sandbox, 'profile');
  const server = path.join(root, 'managed', 'servers', 'fixture');
  const config = path.join(server, 'config'); await fs.mkdir(config, { recursive: true });
  const file = path.join(config, 'settings.txt'); const bytes = Buffer.from('\ufefforiginal\r\n'); await fs.writeFile(file, bytes);
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  return { sandbox, root, server, config, file, bytes, before: await readManagedText(root, server, 'config/settings.txt') };
}
function intercept(t, hook) {
  const original = cp.execFile; cp.execFile = (...args) => hook(original, args); syncBuiltinESMExports();
  t.after(() => { cp.execFile = original; syncBuiltinESMExports(); });
}
test('native save refuses a same-path parent identity replacement after JS validation', async t => {
  const f = await fixture(t); const parked = f.config + '-old';
  intercept(t, (original, args) => {
    // Deterministically reproduce the former path-validation/native-open gap.
    // The replacement is ordinary and byte-identical, so hash/path checks alone miss it.
    const move = fs.rename(f.config, parked).then(() => fs.mkdir(f.config)).then(() => fs.writeFile(f.file, f.bytes));
    const payload = [];
    const child = { stdin: { on() {}, end(data) { payload.push(data); } } };
    void move.then(() => { const actual = original(...args); actual.stdin.end(payload[0]); });
    return child;
  });
  await assert.rejects(writeManagedText(f.root, f.server, 'config/settings.txt', 'replacement', f.before.hash), /identity.*changed|changed.*identity/i);
  assert.deepEqual(await fs.readFile(f.file), f.bytes);
  assert.deepEqual(await fs.readdir(f.config), ['settings.txt']);
  assert.deepEqual(await fs.readFile(path.join(parked, 'settings.txt')), f.bytes);
});

function instrument(t, transform, onChild) {
  intercept(t, (original, args) => {
    const index = args[1].indexOf('-EncodedCommand') + 1;
    const source = Buffer.from(args[1][index], 'base64').toString('utf16le');
    args[1][index] = Buffer.from(transform(source), 'utf16le').toString('base64');
    assert.equal(args[2].shell, false); assert.ok(args[2].timeout <= 30000); assert.ok(args[2].maxBuffer <= 65536);
    const child = original(...args); onChild?.(child); return child;
  });
}
async function waitUntil(predicate) {
  for (let n = 0; n < 200; n++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('native helper did not reach test barrier');
}
test('real Windows leases prevent ancestor junction swaps and target replacement during staging', async t => {
  const f = await fixture(t); const marker = path.join(f.sandbox, 'leased'); const release = path.join(f.sandbox, 'release');
  instrument(t, source => source.replace('temp=Create(stage,data);',
    `File.WriteAllText(${JSON.stringify(marker)},"leased");while(!File.Exists(${JSON.stringify(release)}))System.Threading.Thread.Sleep(5);temp=Create(stage,data);`));
  t.after(async () => { try { await fs.writeFile(release, 'release'); } catch (error) { if (error.code !== 'ENOENT') throw error; } });
  const pending = writeManagedText(f.root, f.server, 'config/settings.txt', 'replacement\n', f.before.hash);
  await waitUntil(async () => { try { await fs.stat(marker); return true; } catch { return false; } });
  try {
    for (const directory of [f.root, path.join(f.root, 'managed'), f.server, f.config]) {
      await assert.rejects(fs.rename(directory, directory + '-parked'), error => ['EPERM','EACCES','EBUSY'].includes(error.code));
    }
    await assert.rejects(fs.rename(f.file, f.file + '-parked'), error => ['EPERM','EACCES','EBUSY'].includes(error.code));
    await assert.rejects(fs.writeFile(f.file, 'attacker write'), error => ['EPERM','EACCES','EBUSY'].includes(error.code));
  } finally { await fs.writeFile(release, 'release'); }
  const result = await pending;
  assert.equal(await fs.readFile(f.file, 'utf8'), 'replacement\n');
  assert.deepEqual(await fs.readFile(result.backupFile), f.bytes);
  t.diagnostic('4 ancestor renames, target rename and target write denied by actual Windows handles');
});
for (const phase of ['before staging', 'after backup rename']) {
  test(`native failure ${phase} restores original without stray stages`, async t => {
    const f = await fixture(t);
    instrument(t, source => source.replace(phase === 'before staging' ? 'temp=Create(stage,data);' : 'Rename(temp,p);published=true;', 'throw new IOException("Injected native fault");'));
    await assert.rejects(writeManagedText(f.root, f.server, 'config/settings.txt', 'replacement', f.before.hash), /Injected native fault/);
    assert.deepEqual(await fs.readFile(f.file), f.bytes);
    assert.deepEqual(await fs.readdir(f.config), ['settings.txt']);
  });
}
test('a competing destination never gets overwritten during publish or rollback', async t => {
  const f = await fixture(t);
  instrument(t, source => source.replace('Rename(temp,p);published=true;', 'File.WriteAllText(p,"competing destination");Rename(temp,p);published=true;'));
  await assert.rejects(writeManagedText(f.root, f.server, 'config/settings.txt', 'replacement', f.before.hash), error => /no-overwrite handle rename/.test(error.message) && /rollback.*refused|restore.*refused/i.test(error.message));
  assert.equal(await fs.readFile(f.file, 'utf8'), 'competing destination');
  const names = await fs.readdir(f.config); const backups = names.filter(n => n.startsWith('.seedhost-backup-'));
  assert.equal(backups.length, 1); assert.deepEqual(await fs.readFile(path.join(f.config, backups[0])), f.bytes);
  assert.ok(names.some(n => n.startsWith('.seedhost-edit-')));
  assert.ok(names.some(n => n.startsWith('.seedhost-transaction-')));
  await assert.rejects(readManagedText(f.root, f.server, 'config/settings.txt'), /recovery.*ambiguous|ambiguous.*evidence/i);
  assert.equal(await fs.readFile(f.file, 'utf8'), 'competing destination');
  assert.deepEqual(await fs.readdir(f.config), names);
});
test('native hard-linked targets are refused without modifying either name', async t => {
  const f = await fixture(t); const outside = path.join(f.sandbox, 'outside.txt'); await fs.link(f.file, outside);
  await assert.rejects(writeManagedText(f.root, f.server, 'config/settings.txt', 'replacement', f.before.hash), /Hard-linked/i);
  assert.deepEqual(await fs.readFile(outside), f.bytes); assert.deepEqual(await fs.readFile(f.file), f.bytes);
  assert.deepEqual(await fs.readdir(f.config), ['settings.txt']);
});
test('missing native helper refuses the individual call before any file mutation', async t => {
  const f = await fixture(t); const original = process.env.SystemRoot;
  process.env.SystemRoot = path.join(f.sandbox, 'no-windows'); t.after(() => { process.env.SystemRoot = original; });
  await assert.rejects(writeManagedText(f.root, f.server, 'config/settings.txt', 'replacement', f.before.hash), /helper failed/i);
  assert.deepEqual(await fs.readFile(f.file), f.bytes); assert.deepEqual(await fs.readdir(f.config), ['settings.txt']);
});
test('native helper rejects backup destinations outside its leased directory before mutation', async t => {
  const f = await fixture(t); const backup = path.join(f.sandbox, 'escaped.bak'); const stage = path.join(f.config, '.seedhost-edit-test.tmp');
  await assert.rejects(windowsServerWrite(f.file, 'replacement', f.before.hash, backup, stage), /destination.*directory|directory.*destination/i);
  assert.deepEqual(await fs.readFile(f.file), f.bytes);
  await assert.rejects(fs.stat(backup), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(f.config), ['settings.txt']);
});
test('a junction swapped after JS validation is rejected by the real native helper', async t => {
  const f = await fixture(t); const outside = path.join(f.sandbox, 'outside'); await fs.mkdir(outside);
  const victim = Buffer.from('outside victim'); await fs.writeFile(path.join(outside, 'settings.txt'), victim);
  intercept(t, (original, args) => {
    const move = fs.rename(f.config, f.config + '-old').then(() => fs.symlink(outside, f.config, 'junction'));
    let payload;
    void move.then(() => { const actual = original(...args); actual.stdin.end(payload); });
    return { stdin: { on() {}, end(data) { payload = data; } } };
  });
  await assert.rejects(writeManagedText(f.root, f.server, 'config/settings.txt', 'replacement', f.before.hash), /links|junctions/i);
  assert.deepEqual(await fs.readFile(path.join(outside, 'settings.txt')), victim);
  assert.deepEqual(await fs.readdir(outside), ['settings.txt']);
  assert.deepEqual(await fs.readFile(path.join(f.config + '-old', 'settings.txt')), f.bytes);
});
test('Unicode filenames and content remain JSON data, not executable helper source', async t => {
  const f = await fixture(t); const name = "雪-$x-'literal'.txt"; const file = path.join(f.config, name);
  await fs.writeFile(file, 'old'); const before = await readManagedText(f.root, f.server, 'config/' + name);
  const text = 'Unicode 🙂\n$(throw unsafe)\n'; const result = await writeManagedText(f.root, f.server, 'config/' + name, text, before.hash);
  assert.equal(await fs.readFile(file, 'utf8'), text); assert.equal(await fs.readFile(result.backupFile, 'utf8'), 'old');
});
test('malformed native helper output is an error, never a successful save', async t => {
  const f = await fixture(t); instrument(t, () => '[Console]::Out.WriteLine("not-json")');
  await assert.rejects(writeManagedText(f.root, f.server, 'config/settings.txt', 'replacement', f.before.hash), /helper failed/i);
  assert.deepEqual(await fs.readFile(f.file), f.bytes); assert.deepEqual(await fs.readdir(f.config), ['settings.txt']);
});
test('an expired real helper process is terminated and the save reports failure', async t => {
  const f = await fixture(t);
  intercept(t, (original, args) => { args[2].timeout = 150; args[1][args[1].indexOf('-EncodedCommand') + 1] = Buffer.from('[Threading.Thread]::Sleep(10000)', 'utf16le').toString('base64'); return original(...args); });
  await assert.rejects(writeManagedText(f.root, f.server, 'config/settings.txt', 'replacement', f.before.hash), /helper failed/i);
  assert.deepEqual(await fs.readFile(f.file), f.bytes); assert.deepEqual(await fs.readdir(f.config), ['settings.txt']);
});
test('forced helper death between renames recovers the original on next read', async t => {
  const f = await fixture(t);
  instrument(t, source => source.replace('Rename(temp,p);published=true;', 'Environment.Exit(17);Rename(temp,p);published=true;'));
  await assert.rejects(writeManagedText(f.root, f.server, 'config/settings.txt', 'replacement', f.before.hash), error => /helper failed/i.test(error.message) && /Recovery copy.*\.seedhost-backup-/i.test(error.message));
  await assert.rejects(fs.readFile(f.file), { code: 'ENOENT' });
  const names = await fs.readdir(f.config); const backup = names.find(n => n.startsWith('.seedhost-backup-')); const stage = names.find(n => n.startsWith('.seedhost-edit-'));
  assert.ok(backup && stage); assert.deepEqual(await fs.readFile(path.join(f.config, backup)), f.bytes);
  assert.equal(await fs.readFile(path.join(f.config, stage), 'utf8'), 'replacement');
  const recovered = await readManagedText(f.root, f.server, 'config/settings.txt');
  assert.equal(recovered.hash, f.before.hash);
  assert.deepEqual(await fs.readFile(f.file), f.bytes);
  assert.ok(!(await fs.readdir(f.config)).some(n => n.startsWith('.seedhost-transaction-')));
});

test('recovery cleanup retries after real helper death between stage and journal disposition', async t => {
  const f = await fixture(t); const original = cp.execFile;
  instrument(t, source => source
    .replace('Rename(temp,p);published=true;', 'System.Diagnostics.Process.GetCurrentProcess().Kill();System.Threading.Thread.Sleep(10000);Rename(temp,p);published=true;')
    .replace('Delete(temp);Delete(log);', 'Delete(temp);CloseHandle(temp);temp=IntPtr.Zero;System.Diagnostics.Process.GetCurrentProcess().Kill();System.Threading.Thread.Sleep(10000);Delete(log);'));
  await assert.rejects(writeManagedText(f.root, f.server, 'config/settings.txt', 'replacement', f.before.hash), /helper failed/i);
  const journal = path.join(f.config, (await fs.readdir(f.config)).find(n => n.startsWith('.seedhost-transaction-')));
  const record = (await fs.readFile(journal, 'utf8')).split('\n');
  await assert.rejects(windowsServerRecover(journal), /helper failed/i);
  assert.deepEqual(await fs.readFile(f.file), f.bytes);
  const stat = await fs.lstat(f.file, { bigint: true });
  assert.equal(`${stat.dev}:${stat.ino}`, record[4]);
  assert.deepEqual((await fs.readdir(f.config)).sort(), [path.basename(journal), 'settings.txt'].sort());
  cp.execFile = original; syncBuiltinESMExports();
  const recovered = await readManagedText(f.root, f.server, 'config/settings.txt');
  assert.equal(recovered.hash, f.before.hash);
  assert.deepEqual(await fs.readdir(f.config), ['settings.txt']);
  t.diagnostic(`actual helper termination seam; restored identity ${record[4]}; 0 stages, 1 journal before retry, 0 journals after: ${f.config}`);
});

test('recovery cleanup retries after real journal disposition failure', async t => {
  const f = await fixture(t); const original = cp.execFile;
  instrument(t, source => source
    .replace('Rename(temp,p);published=true;', 'Environment.Exit(17);Rename(temp,p);published=true;')
    .replace('Delete(temp);Delete(log);', 'Delete(temp);if(!SetFileInformationByHandle(log,4,IntPtr.Zero,0))Fail("evidence cleanup disposition");Delete(log);'));
  await assert.rejects(writeManagedText(f.root, f.server, 'config/settings.txt', 'replacement', f.before.hash), /helper failed/i);
  const journal = path.join(f.config, (await fs.readdir(f.config)).find(n => n.startsWith('.seedhost-transaction-')));
  await assert.rejects(windowsServerRecover(journal), /cleanup disposition.*Win32/i);
  assert.deepEqual(await fs.readFile(f.file), f.bytes);
  assert.deepEqual((await fs.readdir(f.config)).sort(), [path.basename(journal), 'settings.txt'].sort());
  cp.execFile = original; syncBuiltinESMExports();
  assert.equal((await readManagedText(f.root, f.server, 'config/settings.txt')).hash, f.before.hash);
  assert.deepEqual(await fs.readdir(f.config), ['settings.txt']);
  t.diagnostic(`real invalid journal disposition refused; 0 stages, 1 journal before ordinary retry, 0 journals after: ${f.config}`);
});

for (const mutation of ['byte-identical rival', 'changed original hash', 'hard-linked original', 'byte-identical rival stage', 'hard-linked stage', 'junction stage']) {
  test(`cleanup retry refuses ${mutation} and retains journal`, async t => {
    const f = await fixture(t); const original = cp.execFile;
    instrument(t, source => source
      .replace('Rename(temp,p);published=true;', 'Environment.Exit(17);Rename(temp,p);published=true;')
      .replace('Delete(temp);Delete(log);', 'Delete(temp);CloseHandle(temp);temp=IntPtr.Zero;Environment.Exit(18);Delete(log);'));
    await assert.rejects(writeManagedText(f.root, f.server, 'config/settings.txt', 'replacement', f.before.hash), /helper failed/i);
    const journal = path.join(f.config, (await fs.readdir(f.config)).find(n => n.startsWith('.seedhost-transaction-')));
    const record = (await fs.readFile(journal, 'utf8')).split('\n');
    await assert.rejects(windowsServerRecover(journal), /helper failed/i);
    cp.execFile = original; syncBuiltinESMExports();
    const stage = Buffer.from(record[3], 'base64').toString('utf8');
    if (mutation === 'byte-identical rival') { await fs.rename(f.file, path.join(f.sandbox, 'parked-original')); await fs.writeFile(f.file, f.bytes); }
    if (mutation === 'changed original hash') await fs.writeFile(f.file, 'tampered');
    if (mutation === 'hard-linked original') await fs.link(f.file, path.join(f.sandbox, 'alias'));
    if (mutation === 'byte-identical rival stage') await fs.writeFile(stage, 'replacement');
    if (mutation === 'hard-linked stage') { await fs.writeFile(stage, 'replacement'); await fs.link(stage, path.join(f.sandbox, 'alias')); }
    if (mutation === 'junction stage') await fs.symlink(f.sandbox, stage, 'junction');
    const names = await fs.readdir(f.config); const bytes = await fs.readFile(f.file);
    await assert.rejects(readManagedText(f.root, f.server, 'config/settings.txt'), /recovery/i);
    assert.deepEqual(await fs.readFile(f.file), bytes);
    assert.deepEqual(await fs.readdir(f.config), names);
    assert.equal(await fs.readFile(journal, 'utf8'), record.join('\n'));
  });
}

for (const [field, value] of [[4, ''], [5, ''], [6, ''], [7, ''], [6, 'invalid'], [7, 'not-a-sha256']]) {
  test(`missing-stage cleanup refuses malformed journal field ${field}=${value}`, async t => {
    const f = await fixture(t); const original = cp.execFile;
    instrument(t, source => source
      .replace('Rename(temp,p);published=true;', 'Environment.Exit(17);Rename(temp,p);published=true;')
      .replace('Delete(temp);Delete(log);', 'Delete(temp);CloseHandle(temp);temp=IntPtr.Zero;Environment.Exit(18);Delete(log);'));
    await assert.rejects(writeManagedText(f.root, f.server, 'config/settings.txt', 'replacement', f.before.hash), /helper failed/i);
    const journal = path.join(f.config, (await fs.readdir(f.config)).find(n => n.startsWith('.seedhost-transaction-')));
    await assert.rejects(windowsServerRecover(journal), /helper failed/i);
    cp.execFile = original; syncBuiltinESMExports();
    const record = (await fs.readFile(journal, 'utf8')).split('\n'); record[field] = value;
    await fs.writeFile(journal, record.join('\n'));
    await assert.rejects(windowsServerRecover(journal), /recovery/i);
    assert.equal(await fs.readFile(journal, 'utf8'), record.join('\n'));
    assert.deepEqual(await fs.readFile(f.file), f.bytes);
  });
}

test('native recovery does not suppress failed evidence cleanup', async t => {
  const f = await fixture(t);
  instrument(t, source => source.replace('Rename(temp,p);published=true;', 'Environment.Exit(17);Rename(temp,p);published=true;').replace('SetFileInformationByHandle(h,4,b,4)', 'SetFileInformationByHandle(h,4,b,0)'));
  await assert.rejects(writeManagedText(f.root, f.server, 'config/settings.txt', 'replacement', f.before.hash), /helper failed/i);
  const journal = path.join(f.config, (await fs.readdir(f.config)).find(n => n.startsWith('.seedhost-transaction-')));
  await assert.rejects(windowsServerRecover(journal), /cleanup|delete|disposition/i);
  assert.deepEqual(await fs.readFile(f.file), f.bytes);
  assert.ok((await fs.readdir(f.config)).some(n => n.startsWith('.seedhost-transaction-')));
});

for (const boundary of ['before original rename', 'after published rename']) {
  test(`real process kill ${boundary} is resolved on the next read`, async t => {
    const f = await fixture(t);
    const needle = boundary === 'before original rename' ? 'Rename(target,backup);moved=true;' : 'CheckRenamed(temp,p);';
    instrument(t, source => source.replace(needle, 'System.Diagnostics.Process.GetCurrentProcess().Kill();System.Threading.Thread.Sleep(10000);' + needle));
    await assert.rejects(writeManagedText(f.root, f.server, 'config/settings.txt', 'replacement', f.before.hash), /helper failed/i);
    const names = await fs.readdir(f.config);
    assert.ok(names.some(n => n.startsWith('.seedhost-transaction-')));
    const expected = boundary === 'before original rename' ? f.bytes.toString('utf8') : 'replacement';
    const result = await readManagedText(f.root, f.server, 'config/settings.txt');
    assert.equal(result.text, expected);
    assert.ok(!(await fs.readdir(f.config)).some(n => n.startsWith('.seedhost-transaction-')));
  });
}

for (const artifact of ['backup', 'edit', 'transaction']) {
  test(`recovery refuses tampered ${artifact} and retains all evidence`, async t => {
    const f = await fixture(t);
    instrument(t, source => source.replace('Rename(temp,p);published=true;', 'System.Diagnostics.Process.GetCurrentProcess().Kill();System.Threading.Thread.Sleep(10000);Rename(temp,p);published=true;'));
    await assert.rejects(writeManagedText(f.root, f.server, 'config/settings.txt', 'replacement', f.before.hash), /helper failed/i);
    const names = await fs.readdir(f.config);
    const evidence = path.join(f.config, names.find(n => n.startsWith('.seedhost-' + artifact + '-')));
    await fs.writeFile(evidence, 'tampered');
    await assert.rejects(readManagedText(f.root, f.server, 'config/settings.txt'), /recovery/i);
    await assert.rejects(writeManagedText(f.root, f.server, 'config/settings.txt', 'not published', f.before.hash), /recovery/i);
    assert.deepEqual(await fs.readdir(f.config), names);
    await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
    assert.equal(await fs.readFile(evidence, 'utf8'), 'tampered');
  });
}
