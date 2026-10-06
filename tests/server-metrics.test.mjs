import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

// Real child resources, not Minecraft or Electron proof. No application state is used.
async function liveProcess(t) {
  const scratch = process.env.TMPDIR;
  assert.ok(scratch, 'resource fixtures require the approved scratch directory');
  const child = spawn(process.execPath, ['-e', `
    globalThis.pages = Buffer.alloc(64 * 1024 * 1024, 7);
    process.stdout.write('ready\\n');
    function work() { const until = performance.now() + 50; while (performance.now() < until) Math.sqrt(Math.random()); setImmediate(work); }
    work();
  `], { cwd: scratch, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  await once(child.stdout, 'data');
  assert.ok(child.pid > 0);
  return child;
}

let ServerMetrics;
try {
  ({ ServerMetrics } = await import('../dist/src/core/server-metrics.js'));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

test('an absent server PID produces unavailable resources, never app or system metrics', async () => {
  assert.equal(typeof ServerMetrics, 'function', 'ServerMetrics must be implemented');
  const before = Date.now();
  const sample = await new ServerMetrics().sample(undefined);
  assert.deepEqual({ ...sample, sampledAt: 0 }, {
    pid: null, cpuPercent: null, memoryMiB: null, uptimeSeconds: null, sampledAt: 0, error: null,
  });
  assert.ok(sample.sampledAt >= before && sample.sampledAt <= Date.now());
});

test('invalid PIDs fail closed rather than entering a process command', async () => {
  for (const pid of [0, -1, 1.5, NaN, Infinity, 2 ** 31, '123;exit', null]) {
    const sample = await new ServerMetrics().sample(pid);
    assert.equal(sample.pid, null);
    assert.equal(sample.cpuPercent, null);
    assert.equal(sample.memoryMiB, null);
    assert.equal(sample.uptimeSeconds, null);
    assert.match(sample.error ?? '', /invalid.*pid/i);
  }
});

test('the first live server-process sample measures its working set and uptime without inventing CPU', { timeout: 15_000 }, async t => {
  const child = await liveProcess(t);
  assert.notEqual(child.pid, process.pid);
  const sample = await new ServerMetrics().sample(child.pid);
  assert.equal(sample.error, null);
  assert.equal(sample.pid, child.pid);
  assert.equal(sample.cpuPercent, null, 'first sample has no measured CPU delta');
  assert.ok(sample.memoryMiB >= 32, `working set: ${sample.memoryMiB}`);
  assert.ok(sample.uptimeSeconds >= 0 && sample.uptimeSeconds < 30);
  console.log('LIVE_FIRST_RESOURCE_SAMPLE', JSON.stringify(sample));
});

test('CPU is a real cumulative-time delta for the busy server child, relative to one core', { timeout: 15_000 }, async t => {
  const child = await liveProcess(t);
  const metrics = new ServerMetrics();
  const first = await metrics.sample(child.pid);
  await delay(2_100);
  const second = await metrics.sample(child.pid);
  assert.equal(first.error, null);
  assert.equal(second.error, null);
  assert.ok(Number.isFinite(second.cpuPercent) && second.cpuPercent > 0, `measured CPU: ${second.cpuPercent}`);
  assert.ok(second.uptimeSeconds > first.uptimeSeconds);
  console.log('LIVE_CPU_RESOURCE_SAMPLE', JSON.stringify(second));
});

const reading = (pid, cpuSeconds = 1, identity = 'start-A') => ({
  pid, cpuSeconds, identity, memoryBytes: 64 * 1024 * 1024, uptimeSeconds: 10,
});

test('completed process samples are reused for two seconds, then refreshed', async () => {
  let now = 100;
  let calls = 0;
  const metrics = new ServerMetrics({ testOnly: {
    monotonicNow: () => now,
    readProcess: async pid => { calls++; return reading(pid, calls); },
  } });
  const first = await metrics.sample(777);
  assert.equal(calls, 1, 'the process reader is used');
  now = 2_099;
  assert.deepEqual(await metrics.sample(777), first);
  assert.equal(calls, 1, 'no second OS process read inside the cache interval');
  now = 2_100;
  const next = await metrics.sample(777);
  assert.equal(calls, 2);
  assert.equal(next.cpuPercent, 50, 'one CPU second over two wall seconds is 50% of a core');
});

test('concurrent dashboard requests share one in-flight read for the same PID', async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const metrics = new ServerMetrics({ testOnly: {
    readProcess: async pid => { calls++; await gate; return reading(pid); },
  } });
  const pending = Array.from({ length: 12 }, () => metrics.sample(888));
  release();
  const results = await Promise.all(pending);
  assert.equal(calls, 1);
  for (const result of results) assert.deepEqual(result, results[0]);
  results[0].memoryMiB = -1;
  assert.equal((await metrics.sample(888)).memoryMiB, 64, 'caller mutation cannot corrupt the cache');
});

test('PID reuse starts a fresh CPU baseline even when the replacement CPU counter is larger', async () => {
  let now = 0;
  let current = reading(444, 1, 'start-A');
  const metrics = new ServerMetrics({ testOnly: { monotonicNow: () => now, readProcess: async () => current } });
  assert.equal((await metrics.sample(444)).cpuPercent, null);
  now = 2_000;
  current = reading(444, 5, 'start-B');
  assert.equal((await metrics.sample(444)).cpuPercent, null, 'same PID does not mean same process');
  now = 4_000;
  current = reading(444, 9, 'start-B');
  assert.equal((await metrics.sample(444)).cpuPercent, 200, 'multi-core use is not clamped to 100%');
});

test('reset invalidates a pending read and cannot repopulate an old CPU baseline', async () => {
  let release;
  let calls = 0;
  let now = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const metrics = new ServerMetrics({ testOnly: {
    monotonicNow: () => now,
    readProcess: async pid => { calls++; if (calls === 1) await gate; return reading(pid, calls); },
  } });
  assert.equal(typeof metrics.reset, 'function', 'reset must be implemented');
  const pending = metrics.sample(444);
  metrics.reset();
  release();
  const invalidated = await pending;
  assert.equal(invalidated.memoryMiB, null);
  assert.match(invalidated.error ?? '', /reset/i);
  now = 2_000;
  assert.equal((await metrics.sample(444)).cpuPercent, null);
  assert.equal(calls, 2);
});

test('Linux samples read cumulative CPU and RSS for only the requested /proc PID', async () => {
  const pid = 321;
  const fields = Array(49).fill('0');
  fields[0] = 'S'; fields[11] = '250'; fields[12] = '50'; fields[19] = '2000';
  const stat = `${pid} (name with ) parentheses) ${fields.join(' ')}\n`;
  const reads = [];
  const commands = [];
  const metrics = new ServerMetrics({ testOnly: {
    platform: 'linux',
    readText: async file => {
      reads.push(file);
      if (file === `/proc/${pid}/stat`) return stat;
      if (file === `/proc/${pid}/status`) return 'Name:\tfixture\nVmRSS:\t65536 kB\n';
      if (file === '/proc/uptime') return '40.00 100.00\n';
      throw new Error('unexpected file');
    },
    runFile: async (file, args, options) => { commands.push({ file, args, options }); return { stdout: '100\n' }; },
  } });
  const result = await metrics.sample(pid);
  assert.equal(result.error, null);
  assert.equal(result.pid, pid);
  assert.equal(result.memoryMiB, 64);
  assert.equal(result.uptimeSeconds, 20);
  assert.equal(result.cpuPercent, null);
  assert.ok(reads.every(file => file === '/proc/uptime' || file.startsWith(`/proc/${pid}/`)));
  assert.equal(commands[0].file, 'getconf');
  assert.deepEqual(commands[0].args, ['CLK_TCK']);
  assert.equal(commands[0].options.shell, false);
  assert.ok(commands[0].options.timeout <= 5_000);
});

test('macOS uses a PID-filtered, headerless BSD ps command for cumulative CPU, RSS, and elapsed time', async () => {
  let command;
  const metrics = new ServerMetrics({ testOnly: {
    platform: 'darwin',
    runFile: async (file, args, options) => {
      command = { file, args, options };
      return { stdout: '  456  1:02.50 65536  2-03:04:05 Mon Oct  5 08:00:00 2026\n' };
    },
  } });
  const result = await metrics.sample(456);
  assert.equal(result.error, null);
  assert.equal(result.memoryMiB, 64);
  assert.equal(result.uptimeSeconds, 183_845);
  assert.equal(command.file, 'ps');
  assert.deepEqual(command.args, ['-p', '456', '-o', 'pid=', '-o', 'time=', '-o', 'rss=', '-o', 'etime=', '-o', 'lstart=']);
  assert.equal(command.options.shell, false);
  assert.equal(command.options.env.LC_ALL, 'C');
  assert.equal(command.options.env.TZ, 'UTC');
});

test('Windows metrics invokes PowerShell by absolute SystemRoot path, never through PATH search', async () => {
  let command;
  const metrics = new ServerMetrics({ testOnly: {
    platform: 'win32',
    systemRoot: 'D:\\SystemRoot',
    runFile: async (file, args, options) => {
      command = { file, args, options };
      return { stdout: JSON.stringify({ pid: 456, cpuSeconds: 2, memoryBytes: 1_048_576, uptimeSeconds: 3, identity: 'fixture-start' }) };
    },
  } });
  const result = await metrics.sample(456);
  assert.equal(result.error, null);
  assert.equal(command.file, 'D:\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(command.options.shell, false);
});

test('invalid or cross-PID process readings never become dashboard resources', async () => {
  for (const bad of [
    null, {}, { ...reading(123), pid: 124 }, { ...reading(123), cpuSeconds: NaN },
    { ...reading(123), memoryBytes: -1 }, { ...reading(123), memoryBytes: 1.5 },
    { ...reading(123), uptimeSeconds: -1 }, { ...reading(123), identity: '' },
  ]) {
    const result = await new ServerMetrics({ testOnly: { readProcess: async () => bad } }).sample(123);
    assert.equal(result.pid, 123);
    assert.equal(result.memoryMiB, null, 'invalid reading is not a memory measurement');
    assert.equal(result.cpuPercent, null);
    assert.equal(result.uptimeSeconds, null);
    assert.ok(result.error);
  }
});

test('an OS read failure invalidates the old CPU baseline before recovery', async () => {
  let now = 0;
  let calls = 0;
  const metrics = new ServerMetrics({ testOnly: {
    monotonicNow: () => now,
    readProcess: async pid => { calls++; if (calls === 2) throw new Error('process exited'); return reading(pid, calls); },
  } });
  await metrics.sample(321);
  now = 2_000;
  const failed = await metrics.sample(321);
  assert.match(failed.error ?? '', /process exited/);
  assert.equal(failed.memoryMiB, null);
  now = 4_000;
  assert.equal((await metrics.sample(321)).cpuPercent, null, 'no delta bridges a failed process read');
});
