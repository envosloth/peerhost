import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SeedHostApplication } from '../dist/src/core/application.js';
import { OwnershipLedger } from '../dist/src/core/ownership.js';
import { ServerMetrics } from '../dist/src/core/server-metrics.js';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { validateCall } from '../dist/src/core/ipc-policy.js';
import { validateScheduleInput, readSchedules, writeSchedules } from '../dist/src/core/server-scheduler.js';
import { readServerProperties, patchServerProperties } from '../dist/src/core/server-properties.js';
import { readManagedText, writeManagedText } from '../dist/src/core/server-files.js';

const scratch = 'C:/Users/angel/AppData/Local/hermes/cache/scratch';
async function fixture(t) {
  assert.equal(path.resolve(process.env.TMPDIR), path.resolve(scratch));
  const sandbox = await fs.mkdtemp(path.join(scratch, 'dashboard-review-safe-'));
  const root = path.join(sandbox, 'profile');
  const serverDir = path.join(root, 'managed', 'servers', 'fixture');
  await fs.mkdir(serverDir, { recursive: true });
  await fs.writeFile(path.join(serverDir, 'server.properties'), 'server-port=25565\nmotd=Fixture\n');
  const identity = { fingerprint: 'a'.repeat(64) };
  const server = { id: 'a'.repeat(32), name: 'Fixture', serverDir, storeDir: path.join(root, 'managed', 'store'), snapshotId: 'c'.repeat(64), ledgerFile: path.join(root, 'ownership.sqlite'), profile: { executable: 'fixture', args: ['fixture'], startTimeoutSeconds: 1, stopTimeoutSeconds: 1 } };
  const app = new SeedHostApplication(root, identity);
  await app.open(); clearInterval(app.scheduleTimer); app.scheduleTimer = undefined;
  app.saved.servers = [server]; app.saved.activeServerId = server.id;
  const ledger = new OwnershipLedger(server.ledgerFile, identity.fingerprint);
  await ledger.initialize(server.snapshotId);
  t.after(async () => { app.process = undefined; await app.close(); await fs.rm(sandbox, { recursive: true, force: true }); });
  return { sandbox, root, app, ledger, server };
}

test('managed Windows writes publish new bytes and preserve byte-exact durable backups', async t => {
  const { app, server, root } = await fixture(t);
  const file = path.join(server.serverDir, 'bom.txt');
  const bytes = Buffer.from('\ufeffOriginal\r\n'); await fs.writeFile(file, bytes);
  const before = await readManagedText(root, server.serverDir, 'bom.txt');
  const saved = await writeManagedText(root, server.serverDir, 'bom.txt', 'replacement\n', before.hash);
  assert.equal((await readManagedText(root, server.serverDir, 'bom.txt')).text, 'replacement\n');
  assert.deepEqual(await fs.readFile(saved.backupFile), bytes);
  await assert.rejects(writeManagedText(root, server.serverDir, 'bom.txt', 'stale\n', before.hash), /changed|refresh/i);
  const current = await app.readServerFile(server.id, 'bom.txt');
  await app.writeServerFile(server.id, 'bom.txt', 'application save\n', current.hash);
  await app.saveServerSettings(server.id, { motd: 'replacement' });
  assert.match((await app.readServerFile(server.id, 'server.properties')).text, /motd=replacement/);
});

test('concurrent junction replacements cannot redirect working writes or mutate existing backups', async t => {
  const { sandbox, root, server } = await fixture(t);
  const config = path.join(server.serverDir, 'config');
  const parked = path.join(server.serverDir, 'config-parked');
  const outside = path.join(sandbox, 'outside-copy');
  await fs.mkdir(config); await fs.mkdir(outside);
  const original = Buffer.from('\ufeffManaged original\r\n');
  const victim = Buffer.from('Outside victim must not change\r\n');
  await fs.writeFile(path.join(config, 'settings.properties'), original);
  await fs.writeFile(path.join(outside, 'settings.properties'), victim);
  const previous = await readManagedText(root, server.serverDir, 'config/settings.properties');
  const backupRoot = path.join(root, 'file-backups');
  await fs.mkdir(backupRoot); await fs.writeFile(path.join(backupRoot, 'previous.bytes'), original);
  let swaps = 0, done = false, successes = 0, refusals = 0;
  const attacker = (async () => {
    while (!done) {
      try { await fs.rename(config, parked); }
      catch (error) { assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(error.code)); await new Promise(resolve => setImmediate(resolve)); continue; }
      await fs.symlink(outside, config, process.platform === 'win32' ? 'junction' : 'dir'); swaps++;
      await new Promise(resolve => setImmediate(resolve));
      await fs.rm(config); await fs.rename(parked, config);
    }
  })();
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const result = await writeManagedText(root, server.serverDir, 'config/settings.properties', 'dashboard replacement\n', previous.hash);
        successes++;
        assert.deepEqual(await fs.readFile(result.backupFile), original);
      } catch (error) {
        assert.match(error.message, /junction|links|ordinary|changed|refresh|refused|ENOENT/i); refusals++;
      }
    }
  } finally { done = true; await attacker; }
  assert.ok(swaps > 0);
  assert.equal(successes + refusals, 6);
  assert.deepEqual(await fs.readFile(path.join(outside, 'settings.properties')), victim);
  assert.deepEqual(await fs.readdir(outside), ['settings.properties'], 'no escaped stage/backup creations');
  assert.deepEqual(await fs.readFile(path.join(backupRoot, 'previous.bytes')), original);
  assert.deepEqual(await fs.readdir(backupRoot), ['previous.bytes']);
  t.diagnostic(`junction swaps=${swaps}; working-save successes=${successes}; safe refusals=${refusals}`);
});

test('Java properties escaped duplicate keys use last assignment and patch removes every decoded duplicate', () => {
  const original = String.raw`# preserve
white-list=true
white\u002dlist=false
white\-list : false
online-mode=true
`;
  assert.equal(readServerProperties(original)['white-list'], 'false');
  const patched = patchServerProperties(original, { 'white-list': true });
  assert.equal(readServerProperties(patched)['white-list'], 'true');
  assert.equal(patched.match(/^white-list=/gm)?.length, 1);
  assert.ok(!patched.includes(String.raw`white\u002dlist`));
  assert.ok(!patched.includes(String.raw`white\-list`));
  assert.ok(patched.includes('online-mode=true'));
});

test('Java properties parser decodes whitespace separators, escaped delimiters and logical continuation lines', () => {
  const text = '  ! comment\rmotd  hello\\ world\rmax\\u002dplayers:12\rwhite-list true\rwhite\\\n  -list=false\r';
  assert.deepEqual(readServerProperties(text), { motd: 'hello world', 'max-players': '12', 'white-list': 'false' });
  assert.equal(readServerProperties(patchServerProperties('motd=before\n', { motd: '  leading spaces' })).motd, '  leading spaces');
  assert.throws(() => readServerProperties(String.raw`white\u00xxlist=false`), /unicode|escape/i);
});

for (const seam of ['metrics', 'status']) {
  for (const change of ['replacement', 'pid', 'state', 'stopped']) {
    test(`dashboard discards samples when process ${change} occurs during ${seam} await`, async t => {
      const { app, server } = await fixture(t);
      const originalConnect = net.connect;
      let begin, release;
      const began = new Promise(resolve => { begin = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      net.connect = () => {
        const socket = new EventEmitter(); socket.destroy = () => socket; socket.end = () => socket;
        if (seam === 'status') { begin(); void gate.then(() => socket.emit('error', Object.assign(new Error('fixture refused'), { code: 'ECONNREFUSED' }))); }
        else queueMicrotask(() => socket.emit('error', Object.assign(new Error('fixture refused'), { code: 'ECONNREFUSED' })));
        return socket;
      };
      syncBuiltinESMExports();
      t.after(() => { net.connect = originalConnect; syncBuiltinESMExports(); });
      app.process = { state: 'running', pid: 4242 };
      app.metrics = new ServerMetrics({ testOnly: { readProcess: async pid => {
        if (seam === 'metrics') { begin(); await gate; }
        return { pid, cpuSeconds: 1, memoryBytes: 1024, uptimeSeconds: 10, identity: 'fixture-A' };
      } } });
      const pending = app.getServerDashboard(server.id);
      await began;
      if (change === 'replacement') app.process = { state: 'running', pid: 4242 };
      else if (change === 'pid') app.process.pid = 4243;
      else if (change === 'state') app.process.state = 'stopping';
      else app.process = undefined;
      release();
      await assert.rejects(pending, /process.*changed|refresh/i);
    });
  }
}

for (const boundary of ['tick', 'save', 'delete', 'run']) {
  for (const mutation of ['corrupt', 'unexpected-valid', 'missing']) {
    test(`runtime ${mutation} schedule metadata disables ${boundary} without side effects or overwrite`, async t => {
      const { app, root, server, ledger } = await fixture(t);
      const [job] = await app.saveServerSchedule(server.id, { name: 'Authorised command', action: 'command', command: 'say fixture', intervalMinutes: 1, enabled: true });
      await ledger.startHosting();
      const commands = [];
      app.process = { state: 'running', pid: 4242, sendCommand(command) { commands.push(command); } };
      const file = path.join(root, 'schedules.json');
      const bytes = mutation === 'corrupt' ? '{corrupt while open' : JSON.stringify({ version: 1, jobs: [{ ...job, command: 'stop' }] });
      if (mutation === 'missing') await fs.rm(file); else await fs.writeFile(file, bytes);
      if (boundary === 'tick') await app.tickServerSchedules(job.nextRunAt + 1);
      else if (boundary === 'save') await assert.rejects(app.saveServerSchedule(server.id, { name: 'No overwrite', action: 'backup', intervalMinutes: 1, enabled: false }), /disabled|metadata|changed/i);
      else if (boundary === 'delete') await assert.rejects(app.deleteServerSchedule(server.id, job.id), /disabled|metadata|changed/i);
      else await assert.rejects(app.runServerSchedule(server.id, job.id), /disabled|metadata|changed/i);
      assert.deepEqual(commands, []);
      assert.match(app.scheduleError, /disabled/i);
      if (mutation === 'missing') await assert.rejects(fs.readFile(file), { code: 'ENOENT' });
      else assert.equal(await fs.readFile(file, 'utf8'), bytes);
      await app.tickServerSchedules(job.nextRunAt + 600000);
      assert.deepEqual(commands, []);
    });
  }
}

test('non-string schedule actions are rejected at IPC, direct input, persistence and execution boundaries', async t => {
  const { app, root, server } = await fixture(t);
  const bad = { name: 'Array backup', action: ['backup'], intervalMinutes: 1, enabled: false };
  const url = 'file:///fixture.html';
  assert.throws(() => validateCall('saveServerSchedule', { id: server.id, schedule: bad }, url, url, { senderId: 1, expectedSenderId: 1, isMainFrame: true }), /invalid/i);
  assert.throws(() => validateScheduleInput(bad), /invalid/i);
  await assert.rejects(app.saveServerSchedule(server.id, bad), /invalid/i);
  const job = { ...bad, id: 'b'.repeat(32), serverId: server.id, nextRunAt: 100, lastRunAt: null, lastOutcome: null };
  await assert.rejects(writeSchedules(root, [job]), /invalid/i);
  await fs.writeFile(path.join(root, 'schedules.json'), JSON.stringify({ version: 1, jobs: [job] }));
  await assert.rejects(readSchedules(root), /invalid/i);
  app.schedules = [job];
  let stopped = false;
  app.stopServerInsideOperation = async () => { stopped = true; };
  await assert.rejects(app.runServerSchedule(server.id, job.id), /invalid|disabled/i);
  assert.equal(stopped, false);
});
