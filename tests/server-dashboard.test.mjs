import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { createIdentity } from '../dist/src/core/peer-transport.js';
import { SeedHostApplication } from '../dist/src/core/application.js';
import { OwnershipLedger } from '../dist/src/core/ownership.js';

async function fixture(t) {
  const scratch = process.env.TMPDIR || path.resolve('.test-data');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'seedhost-dashboard-'));
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'logs'), { recursive: true });
  await writeFile(path.join(source, 'eula.txt'), 'eula=true\n');
  await writeFile(path.join(source, 'server.properties'), '# Preserve this comment\nmotd=My world\nserver-port=25565\nmax-players=20\nonline-mode=true\n');
  await writeFile(path.join(source, 'logs', 'latest.log'), 'A real fixture log\n');
  await writeFile(path.join(source, 'world.bin'), Buffer.from([0, 1, 255]));
  const identity = await createIdentity();
  const app = new SeedHostApplication(path.join(root, 'profile'), identity);
  await app.open();
  await app.importExisting(source, true);
  const server = (await app.getState()).server;
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { root, source, identity, app, server };
}

test('each server console keeps its own output when returning to the library', async (t) => {
  const { app, server, root } = await fixture(t);
  await app.saveProfile({ executable: process.execPath, args: [path.resolve('tools/fake-java-server.mjs'), '--lifetime-ms=30000'] });
  await app.startServer(true); app.sendCommand('say first-server-only');
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await app.getState()).logs.some(line => line.includes('console:say first-server-only'))) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await app.stopServer();
  const other = path.join(root, 'other'); await mkdir(other); await writeFile(path.join(other, 'eula.txt'), 'eula=true\n');
  await app.importExisting(other, true);
  assert.ok(!(await app.getState()).logs.some(line => line.includes('first-server-only')), 'another server console must not leak this server’s output');
  await app.selectServer(server.id);
  assert.ok((await app.getState()).logs.some(line => line.includes('console:say first-server-only')));
});

test('server file boundaries refuse traversal, junctions, binary data and oversized reads', async (t) => {
  const { app, server, root } = await fixture(t);
  for (const unsafe of ['../state.json', 'C:/outside.txt', 'logs\\latest.log', 'CON', 'logs/../eula.txt']) await assert.rejects(app.readServerFile(server.id, unsafe), /unsafe|reserved/i);
  await assert.rejects(app.readServerFile(server.id, 'world.bin'), /binary/i);
  await writeFile(path.join(server.serverDir, 'large.txt'), 'x'.repeat(256 * 1024 + 1));
  await assert.rejects(app.readServerFile(server.id, 'large.txt'), /large/i);
  const outside = path.join(root, 'outside'); await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'must not read');
  await symlink(outside, path.join(server.serverDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(app.listServerFiles(server.id, 'linked'), /links|junction|ordinary/i);
  await assert.rejects(app.readServerFile(server.id, 'linked/secret.txt'), /links|junction|ordinary/i);
});

test('file and settings mutations refuse running, uncertain and stale-server authority', async (t) => {
  const { app, server, identity } = await fixture(t);
  const file = await app.readServerFile(server.id, 'eula.txt');
  await assert.rejects(app.writeServerFile('f'.repeat(32), 'eula.txt', file.text, file.hash), /selected|changed/i);
  await app.saveProfile({ executable: process.execPath, args: [path.resolve('tools/fake-java-server.mjs'), '--lifetime-ms=30000'] });
  await app.startServer(true);
  try {
    await assert.rejects(app.writeServerFile(server.id, 'eula.txt', file.text, file.hash), /stop/i);
    await assert.rejects(app.saveServerSettings(server.id, { motd: 'Cannot save' }), /stop/i);
  } finally { await app.stopServer(); }
  await new OwnershipLedger(server.ledgerFile, identity.fingerprint).markUncertain();
  await assert.rejects(app.writeServerFile(server.id, 'eula.txt', file.text, file.hash), /ownership/i);
  await assert.rejects(app.saveServerSettings(server.id, { motd: 'Cannot save' }), /ownership/i);
});

test('scheduler refuses unowned work and records failure without pretending it ran', async (t) => {
  const { app, server, identity } = await fixture(t);
  const [job] = await app.saveServerSchedule(server.id, { name: 'Refused', action: 'backup', intervalMinutes: 1, enabled: true });
  await new OwnershipLedger(server.ledgerFile, identity.fingerprint).markUncertain();
  await assert.rejects(app.runServerSchedule(server.id, job.id), /ownership/i);
  const state = await app.getServerDashboard(server.id);
  assert.match(state.schedules[0].lastOutcome, /^Failed:/);
  assert.equal((await app.getState()).server.snapshotId, server.snapshotId);
  await app.deleteServerSchedule(server.id, job.id);
});

test('malformed persisted schedules are preserved and disabled rather than silently reset', async (t) => {
  const { app, server, root, identity } = await fixture(t);
  await app.close();
  const file = path.join(root, 'profile', 'schedules.json'); await writeFile(file, '{malformed');
  const reopened = new SeedHostApplication(path.join(root, 'profile'), identity);
  await reopened.open();
  try {
    assert.match((await reopened.getServerDashboard(server.id)).scheduleError, /disabled/i);
    await assert.rejects(reopened.saveServerSchedule(server.id, { name: 'No overwrite', action: 'backup', intervalMinutes: 1, enabled: true }), /disabled/i);
    assert.equal(await readFile(file, 'utf8'), '{malformed');
  } finally { await reopened.close(); }
});

test('player management sends bounded commands only to the matching owned process', async (t) => {
  const { app, server } = await fixture(t);
  await assert.rejects(app.managePlayer(server.id, 'kick', 'TestPlayer'), /running/i);
  await app.saveProfile({ executable: process.execPath, args: [path.resolve('tools/fake-java-server.mjs'), '--lifetime-ms=30000'] });
  await app.startServer(true);
  try {
    const result = await app.managePlayer(server.id, 'whitelist-add', 'TestPlayer');
    assert.equal(result.command, 'whitelist add TestPlayer');
    await assert.rejects(app.managePlayer(server.id, 'kick', 'Player\nstop'), /invalid/i);
    await assert.rejects(app.managePlayer('1'.repeat(32), 'kick', 'TestPlayer'), /selected|changed/i);
    await assert.rejects(app.managePlayer(server.id, 'op', 'TestPlayer'), /invalid/i);
  } finally { await app.stopServer(); }
});

test('due schedules run once while enabled and never switch the active server', async (t) => {
  const { app, server, root } = await fixture(t);
  const [job] = await app.saveServerSchedule(server.id, { name: 'Background backup', action: 'backup', intervalMinutes: 1, enabled: true });
  const other = path.join(root, 'other'); await mkdir(other);
  await writeFile(path.join(other, 'eula.txt'), 'eula=true\n');
  await writeFile(path.join(other, 'server.properties'), 'motd=Another server\n');
  await app.importExisting(other, true);
  const selected = (await app.getState()).server.id;
  const now = job.nextRunAt + 1;
  await app.tickServerSchedules(now);
  assert.equal((await app.getState()).server.id, selected);
  await app.selectServer(server.id);
  const ran = (await app.getServerDashboard(server.id)).schedules[0];
  assert.equal(ran.lastRunAt, now);
  assert.match(ran.lastOutcome, /completed backup/i);
  await app.tickServerSchedules(now);
  assert.deepEqual((await app.getServerDashboard(server.id)).schedules[0], ran);
  await app.saveServerSchedule(server.id, { id: job.id, name: job.name, action: 'backup', intervalMinutes: 1, enabled: false });
  await app.tickServerSchedules(now + 600000);
  assert.equal((await app.getServerDashboard(server.id)).schedules[0].lastRunAt, now);
  await app.deleteServerSchedule(server.id, job.id);
  assert.deepEqual((await app.getServerDashboard(server.id)).schedules, []);
});

test('a scheduled stop uses graceful shutdown and commits the final owned revision', async (t) => {
  const { app, server } = await fixture(t);
  await app.saveProfile({ executable: process.execPath, args: [path.resolve('tools/fake-java-server.mjs'), '--lifetime-ms=30000'] });
  await app.startServer(true);
  const [job] = await app.saveServerSchedule(server.id, { name: 'Stop', action: 'stop', intervalMinutes: 5, enabled: true });
  const result = await app.runServerSchedule(server.id, job.id);
  assert.match(result[0].lastOutcome, /stopped|completed/i);
  const after = (await app.getState()).server;
  assert.equal(after.state, 'offline');
  assert.equal(after.ownership.state, 'owned');
  assert.equal(after.snapshotId, after.ownership.snapshotId);
});

test('a scheduled command reaches only the selected owned running server console', async (t) => {
  const { app, server } = await fixture(t);
  await app.saveProfile({ executable: process.execPath, args: [path.resolve('tools/fake-java-server.mjs'), '--lifetime-ms=30000'] });
  await app.startServer(true);
  try {
    const [job] = await app.saveServerSchedule(server.id, { name: 'Message', action: 'command', command: 'say scheduled fixture', intervalMinutes: 5, enabled: true });
    await app.runServerSchedule(server.id, job.id);
    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await app.getState()).logs.some(line => line.includes('console:say scheduled fixture'))) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok((await app.getState()).logs.some(line => line.includes('console:say scheduled fixture')));
    assert.equal((await app.getState()).server.state, 'running');
  } finally { await app.stopServer(); }
});

test('a running server reports measured process metrics and a real local status probe', async (t) => {
  const { app, server } = await fixture(t);
  await app.saveProfile({ executable: process.execPath, args: [path.resolve('tools/fake-java-server.mjs'), '--lifetime-ms=30000'] });
  await app.startServer(true);
  try {
    const first = await app.getServerDashboard(server.id);
    assert.equal(first.state, 'running');
    assert.ok(Number.isSafeInteger(first.performance.pid) && first.performance.pid > 0);
    assert.equal(first.performance.pid, app.process.pid, 'the metric PID is the actual launched server child, not the app');
    assert.ok(first.performance.memoryMiB > 0, 'memory is measured for the actual server PID');
    assert.ok(first.performance.uptimeSeconds >= 0);
    assert.equal(first.performance.error, null);
    // The fixture is not a Minecraft server: the loopback probe must report that honestly, not invent players.
    assert.equal(first.players.online, null, 'a refused status socket cannot prove zero online players on a running process');
    assert.ok(first.players.error, 'unavailable Minecraft status must be explicit');
    assert.deepEqual(first.players.sample, []);
    await new Promise(resolve => setTimeout(resolve, 2300)); // the metrics cache window is 2 s; a delta needs the cache to expire
    const second = await app.getServerDashboard(server.id);
    assert.ok(Number.isFinite(second.performance.cpuPercent), 'second sample has a measured CPU delta');
  } finally { await app.stopServer(); }
});

test('running a backup schedule creates a real revision and records its result', async (t) => {
  const { app, server } = await fixture(t);
  const [job] = await app.saveServerSchedule(server.id, { name: 'Backup now', action: 'backup', intervalMinutes: 1, enabled: true });
  await writeFile(path.join(server.serverDir, 'logs', 'latest.log'), 'Changed before backup\n');
  const result = await app.runServerSchedule(server.id, job.id);
  assert.ok(result[0].lastRunAt > 0);
  assert.match(result[0].lastOutcome, /completed|saved|backup/i);
  assert.notEqual((await app.getState()).server.snapshotId, server.snapshotId);
  assert.equal((await app.listSnapshots()).length, 2);
});

test('per-server schedules persist their interval and survive reopening without executing early', async (t) => {
  const { app, server, root, identity } = await fixture(t);
  const before = Date.now();
  const schedules = await app.saveServerSchedule(server.id, { name: 'Regular backup', action: 'backup', intervalMinutes: 5, enabled: true });
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].serverId, server.id);
  assert.equal(schedules[0].action, 'backup');
  assert.ok(schedules[0].nextRunAt >= before + 5 * 60000);
  assert.equal(schedules[0].lastRunAt, null);
  await app.close();
  const reopened = new SeedHostApplication(path.join(root, 'profile'), identity);
  await reopened.open();
  try { assert.deepEqual((await reopened.getServerDashboard(server.id)).schedules, schedules); }
  finally { await reopened.close(); }
});

test('the dashboard reports selected-server data and no fabricated stopped-process metrics', async (t) => {
  const { app, server } = await fixture(t);
  const state = await app.getServerDashboard(server.id);
  assert.equal(state.serverId, server.id);
  assert.equal(state.state, 'offline');
  assert.equal(state.settings.motd, 'My world');
  assert.equal(state.performance.pid, null);
  assert.equal(state.performance.cpuPercent, null);
  assert.equal(state.performance.memoryMiB, null);
  assert.equal(state.players.online, null);
  assert.match(state.players.error, /not running|stopped/i);
  assert.ok(Array.isArray(state.schedules));
  const library = (await app.getState()).servers[0];
  assert.equal(library.state, 'offline');
  assert.equal(library.ownerName, 'this PC');
  assert.equal(library.configured, false);
});

test('settings saves update the managed copy and preserve source properties', async (t) => {
  const { app, server, source } = await fixture(t);
  const before = await app.readServerFile(server.id, 'server.properties');
  const saved = await app.saveServerSettings(server.id, { motd: 'Settings saved', 'max-players': 12, 'white-list': true, difficulty: 'hard' });
  const after = await app.readServerFile(server.id, 'server.properties');
  assert.match(after.text, /motd=Settings saved/);
  assert.match(after.text, /max-players=12/);
  assert.match(after.text, /white-list=true/);
  assert.match(after.text, /# Preserve this comment/);
  assert.equal(await readFile(saved.backupFile, 'utf8'), before.text);
  assert.equal(await readFile(path.join(source, 'server.properties'), 'utf8'), before.text);
  await assert.rejects(app.saveServerSettings(server.id, { 'max-players': -1 }), /invalid/i);
  await assert.rejects(app.saveServerSettings(server.id, { 'online-mode': false }), /supported|invalid/i);
  await assert.rejects(app.saveServerSettings(server.id, { motd: 'evil\nserver-port=1' }), /invalid/i);
});

test('text editing publishes only the managed copy with a byte-exact backup and rejects stale saves', async (t) => {
  const { app, server, source, root } = await fixture(t);
  const before = await app.readServerFile(server.id, 'server.properties');
  const changed = before.text.replace('My world', 'New world');
  const saved = await app.writeServerFile(server.id, 'server.properties', changed, before.hash);
  assert.equal((await app.readServerFile(server.id, 'server.properties')).text, changed);
  assert.equal(await readFile(saved.backupFile, 'utf8'), before.text);
  await assert.rejects(app.writeServerFile(server.id, 'server.properties', 'stale', before.hash), /changed|refresh/i);
  assert.equal(await readFile(path.join(source, 'server.properties'), 'utf8'), before.text);
  assert.ok((await readdir(server.serverDir)).every(name => !name.startsWith('.seedhost-edit-')));
});

test('server files list and read the selected managed copy, never the original', async (t) => {
  const { app, server, source } = await fixture(t);
  const listing = await app.listServerFiles(server.id, '');
  assert.equal(listing.serverId, server.id);
  assert.ok(listing.entries.some(entry => entry.name === 'logs' && entry.kind === 'directory'));
  assert.ok(listing.entries.some(entry => entry.path === 'server.properties' && entry.editable));
  const file = await app.readServerFile(server.id, 'logs/latest.log');
  assert.equal(file.text, 'A real fixture log\n');
  assert.match(file.hash, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(path.join(source, 'logs', 'latest.log'), 'utf8'), file.text);
});
