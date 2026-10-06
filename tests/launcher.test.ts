import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServerProcess, type ServerProcessProfile } from '../src/core/launcher.js';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixturePath = path.join(projectRoot, 'tools', 'fake-java-server.mjs');
// No stdin reader; the disposable file gates exit until after a stop request.
const unreadConsoleArgs = ['--input-type=module', '-e', `
  import { existsSync } from 'node:fs';
  setInterval(() => {
    if (existsSync('exit-requested')) process.exit(0);
  }, 10);
  setTimeout(() => process.exit(2), 6000);
  console.log('Done (fixture)!');
`];

// First launch never reads stdin; a later launch uses a clean readable console.
// The zero-exit gate and persistent launch marker make restart ordering explicit.
const overlappingConsoleArgs = ['--input-type=module', '-e', `
  import { existsSync, writeFileSync } from 'node:fs';
  import { createInterface } from 'node:readline';
  const first = !existsSync('first-launch-started');
  writeFileSync('first-launch-started', '');
  setTimeout(() => process.exit(2), 6000);
  if (first) {
    setInterval(() => {
      if (existsSync('exit-requested')) process.exit(0);
    }, 10);
    console.log('Done (fixture)!');
  } else {
    createInterface({ input: process.stdin }).on('line', (line) => {
      if (line === 'stop') process.exit(0);
    });
    console.log('Done (fixture)!');
  }
`];

async function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for fixture observation');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(t: TestContext, args: string[] = [], overrides: Partial<ServerProcessProfile> = {}) {
  const testRoot = process.env.TMPDIR ?? path.join(projectRoot, '.test-data');
  await mkdir(testRoot, { recursive: true });
  const cwd = await mkdtemp(path.join(testRoot, 'launcher with spaces-'));
  const profile = {
    executable: process.execPath,
    args: [fixturePath, ...args],
    cwd,
    readyPattern: 'Done (fixture)!',
    startTimeoutMs: 2000,
    stopTimeoutMs: 1000,
    ...overrides,
  };
  const server = new ServerProcess(profile);
  const lines: string[] = [];
  const states: string[] = [];
  server.on('line', (line: string) => lines.push(line));
  server.on('state', (state: string) => states.push(state));
  t.after(async () => {
    await server.forceStop();
    await rm(cwd, { recursive: true, force: true });
  });
  return { server, profile, cwd, lines, states };
}

test('zero exit before readiness reports bind failure from either startup stream with actionable port diagnostics', async (t) => {
  for (const [stream, reason] of [['stdout', '**** FAILED TO BIND TO PORT!'], ['stderr', 'java.net.BindException: Address already in use'], ['stderr', 'listen EADDRINUSE 127.0.0.1:31415']] as const) {
    const { server, states } = await fixture(t, [], { args: ['-e', `process.${stream}.write(${JSON.stringify(reason + '\n')}); process.exitCode = 0;`] });
    await assert.rejects(server.start(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /before stdout readiness.*code 0.*signal null/i);
      assert.match(error.message, /configured.*port.*unavailable/i);
      assert.ok(error.message.includes(reason));
      assert.match(error.message, /change.*port|stop.*process/i);
      return true;
    });
    assert.equal(server.state, 'failed');
    assert.equal(server.pid, undefined);
    assert.ok(!states.includes('running'));
  }
});

test('non-bind startup errors retain a bounded useful log tail without fabricating port diagnosis or stderr readiness', async (t) => {
  const { server, states } = await fixture(t, [], { args: ['-e', `
    console.log('x'.repeat(20000));
    console.error('Done (fixture)!');
    console.error('Fatal startup: missing required mod dependency');
    process.exitCode = 7;
  `] });
  await assert.rejects(server.start(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /before stdout readiness.*code 7.*signal null/i);
    assert.match(error.message, /missing required mod dependency/i);
    assert.ok(error.message.length < 9000, 'diagnostic retained output must be bounded');
    assert.doesNotMatch(error.message, /port is unavailable/i);
    return true;
  });
  assert.equal(server.state, 'failed');
  assert.equal(server.pid, undefined);
  assert.ok(!states.includes('running'));
});

test('a new ServerProcess is offline without a PID and is an EventEmitter', async () => {
  const server = new ServerProcess({ executable: process.execPath, args: [], cwd: process.cwd() });
  assert.equal(server.state, 'offline');
  assert.equal(server.pid, undefined);
  assert.ok(server instanceof EventEmitter);
});

test('start waits for literal stdout readiness and forwards exact spaced arguments without a shell', async (t) => {
  const args = ['world name with spaces', 'literal & | ; $() > text', '--lifetime-ms=3000'];
  const { server, cwd, lines, states } = await fixture(t, args);
  const started = server.start();
  assert.equal(server.state, 'starting');
  await started;
  assert.equal(server.state, 'running');
  assert.equal(typeof server.pid, 'number');
  const observation = JSON.parse(lines.find((line) => line.startsWith('fixture {'))!.slice(8));
  assert.deepEqual(observation.args, args);
  assert.equal(observation.cwd, cwd);
  assert.equal(observation.pid, server.pid);
  assert.ok(lines.includes('Done (fixture)!'));
  await waitFor(() => lines.includes('fixture stderr diagnostic'));
  assert.deepEqual(states.slice(0, 2), ['starting', 'running']);
});

test('explicit forceStop terminates only its owned child and waits for exit', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  await first.server.start();
  await second.server.start();
  const secondPid = second.server.pid;
  await first.server.forceStop();
  assert.equal(first.server.pid, undefined);
  assert.equal(first.server.state, 'offline');
  assert.equal(second.server.pid, secondPid);
  assert.equal(second.server.state, 'running');
  await second.server.forceStop();
});

test('stop writes stop and resolves only after the real child exits gracefully', async (t) => {
  const { server, lines, states } = await fixture(t, ['--stop-delay-ms=150']);
  await server.start();
  const pid = server.pid;
  const stopped = server.stop();
  assert.equal(server.state, 'stopping');
  await waitFor(() => lines.includes('console:stop'));
  assert.equal(server.pid, pid, 'receiving stop is not proof of process exit');
  assert.equal(server.state, 'stopping');
  await stopped;
  assert.equal(server.state, 'offline');
  assert.equal(server.pid, undefined);
  assert.ok(lines.includes('fixture stopped'));
  assert.deepEqual(states, ['starting', 'running', 'stopping', 'offline']);
});

test('sendCommand replies through stdout and rejects multiline or oversized console input', async (t) => {
  const { server, lines } = await fixture(t);
  await server.start();
  server.sendCommand('say hello world');
  await waitFor(() => lines.includes('console:say hello world'));
  for (const command of ['say hello\nstop', 'say hello\rstop', 'say hello\r\nstop']) {
    assert.throws(() => server.sendCommand(command), /single.line|newline/i);
  }
  assert.throws(() => server.sendCommand('x'.repeat(1025)), /1024|too long/i);
  assert.throws(() => server.sendCommand('é'.repeat(513)), /1024|too long/i);
  assert.equal(server.state, 'running');
  server.sendCommand('x'.repeat(1024));
  await waitFor(() => lines.includes(`console:${'x'.repeat(1024)}`));
  assert.ok(!lines.includes('console:stop'), 'invalid commands must not reach the child');
  await server.stop();
});

test('duplicate start is rejected during startup and while running without replacing the owned PID', async (t) => {
  const { server } = await fixture(t, ['--lifetime-ms=1000']);
  const starting = server.start();
  const pid = server.pid;
  await assert.rejects(server.start(), /already|active|starting/i);
  await starting;
  assert.equal(server.pid, pid);
  await assert.rejects(server.start(), /already|active|running/i);
  assert.equal(server.pid, pid);
  await server.stop();
});

test('stop timeout warns about explicit force-stop and leaves the owned child alive', async (t) => {
  const { server, lines } = await fixture(t, ['--ignore-stop', '--lifetime-ms=1000'], { stopTimeoutMs: 80 });
  await server.start();
  const pid = server.pid;
  await assert.rejects(server.stop(), /timed out.*force.stop.*data loss/i);
  assert.equal(server.pid, pid, 'stop timeout must never silently kill the child');
  assert.equal(server.state, 'stopping');
  assert.ok(lines.includes('console:stop'));
  await assert.rejects(server.start(), /active|already/i);
  await server.forceStop();
  assert.equal(server.pid, undefined);
  assert.equal(server.state, 'offline');
});

test('startup readiness timeout cleans its child before rejecting and ignores stderr readiness', async (t) => {
  const { server, lines, states } = await fixture(t, ['--stderr-ready', '--lifetime-ms=2000'], { startTimeoutMs: 500 });
  await assert.rejects(server.start(), /stdout readiness timed out/i);
  assert.ok(lines.includes('Done (fixture)!'), 'stderr is logged but is never readiness proof');
  assert.equal(server.state, 'failed');
  assert.equal(server.pid, undefined, 'failed startup must await cleanup');
  assert.deepEqual(states, ['starting', 'failed']);
});

test('spawn errors reject after cleanup with the underlying ENOENT cause and failed state', async (t) => {
  const { server, states } = await fixture(t, [], {
    executable: path.join(projectRoot, '.test-data', 'nonexistent-fixture-executable.exe'),
  });
  await assert.rejects(server.start(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /process error.*ENOENT/i);
    assert.equal((error.cause as NodeJS.ErrnoException | undefined)?.code, 'ENOENT');
    return true;
  });
  assert.equal(server.state, 'failed');
  assert.equal(server.pid, undefined);
  assert.deepEqual(states, ['starting', 'failed']);
});

test('a nonzero child exit after readiness is failed rather than falsely offline', async (t) => {
  const { server, states } = await fixture(t, ['--lifetime-ms=200', '--exit-code=7']);
  await server.start();
  await waitFor(() => server.pid === undefined);
  await waitFor(() => server.state !== 'running');
  assert.equal(server.state, 'failed');
  assert.deepEqual(states, ['starting', 'running', 'failed']);
});

test('synchronous spawn failures cannot strand the launcher in starting', async (t) => {
  const { server } = await fixture(t, [], { args: [fixturePath, 'invalid\0argument'] });
  await assert.rejects(server.start(), /null bytes|process error/i);
  assert.equal(server.state, 'failed');
  assert.equal(server.pid, undefined);
});

test('a child exiting with queued console writes does not cause an unhandled stream error', async (t) => {
  const { server } = await fixture(t, ['--exit-on-command']);
  await server.start();
  // Queue more than the OS pipe buffer before the child exits on its first command.
  for (let index = 0; index < 1024; index += 1) server.sendCommand('x'.repeat(1024));
  await waitFor(() => server.state === 'failed', 1000);
  await waitFor(() => server.pid === undefined);
  assert.throws(() => server.sendCommand('say retry'), /not running|console/i);
});

test('constructor rejects invalid timeout budgets and empty literal readiness', async () => {
  const base = { executable: process.execPath, args: [], cwd: projectRoot };
  for (const value of [0, -1, NaN, Infinity, 0.5, 2_147_483_648]) {
    assert.throws(() => new ServerProcess({ ...base, startTimeoutMs: value }), /startTimeoutMs/i);
    assert.throws(() => new ServerProcess({ ...base, stopTimeoutMs: value }), /stopTimeoutMs/i);
  }
  assert.throws(() => new ServerProcess({ ...base, readyPattern: '' }), /readyPattern/i);
});

test('constructor snapshots structured arguments and options against caller mutation', async (t) => {
  const { server, profile, lines } = await fixture(t, ['original argument']);
  profile.args[1] = 'mutated argument';
  profile.executable = path.join(projectRoot, '.test-data', 'must-not-spawn.exe');
  profile.readyPattern = 'must-not-watch-this';
  await server.start();
  const observation = JSON.parse(lines.find((line) => line.startsWith('fixture {'))!.slice(8));
  assert.deepEqual(observation.args, ['original argument']);
  await server.stop();
});

test('exit before readiness rejects with its exit code and no retained PID', async (t) => {
  const { server, states } = await fixture(t, ['--no-ready', '--lifetime-ms=100', '--exit-code=9']);
  await assert.rejects(server.start(), /before stdout readiness.*code 9/i);
  assert.equal(server.state, 'failed');
  assert.equal(server.pid, undefined);
  assert.deepEqual(states, ['starting', 'failed']);
});

test('readiness patterns are literal text rather than regular expressions', async (t) => {
  const { server, lines } = await fixture(t, [], { readyPattern: 'Done.*', startTimeoutMs: 500 });
  await assert.rejects(server.start(), /stdout readiness timed out/i);
  assert.ok(lines.includes('Done (fixture)!'));
  assert.equal(server.pid, undefined);
  assert.equal(server.state, 'failed');
});

test('a gracefully stopped launcher can restart and idle stops are harmless', async (t) => {
  const { server, lines } = await fixture(t);
  await server.stop();
  await server.forceStop();
  assert.throws(() => server.sendCommand('say offline'), /not running/i);
  for (let index = 0; index < 2; index += 1) {
    await server.start();
    server.sendCommand(`say run ${index}`);
    await waitFor(() => lines.includes(`console:say run ${index}`));
    await server.stop();
    assert.equal(server.state, 'offline');
    assert.equal(server.pid, undefined);
  }
  assert.equal(lines.filter((line) => line.startsWith('fixture {')).length, 2);
});

test('force-stop during startup rejects pending readiness rather than later reporting running', async (t) => {
  const { server, states } = await fixture(t, ['--no-ready']);
  const starting = assert.rejects(server.start(), /before stdout readiness/i);
  await server.forceStop();
  await starting;
  assert.equal(server.pid, undefined);
  assert.equal(server.state, 'failed');
  assert.ok(!states.includes('running'));
});

test('force-stop requested inside the synchronous starting listener terminates the pending launch', async (t) => {
  const { server, states } = await fixture(t, ['--no-ready']);
  let forced: Promise<void> | undefined;
  server.on('state', (state: string) => {
    if (state === 'starting') forced ??= server.forceStop();
  });
  const starting = server.start();
  const forcePromise = forced;
  assert.ok(forcePromise, 'starting must be observable only once the child can be cancelled');
  await forcePromise;
  assert.equal(server.pid, undefined, 'force-stop must await actual child closure');
  await assert.rejects(starting, /before stdout readiness/i);
  assert.equal(server.state, 'failed');
  assert.ok(!states.includes('running'));
});

test('graceful stop requested inside the synchronous starting listener reaches the child and cancels readiness', async (t) => {
  const { server, lines, states } = await fixture(t);
  let stopped: Promise<void> | undefined;
  server.on('state', (state: string) => {
    if (state === 'starting') stopped ??= server.stop();
  });
  const starting = server.start();
  const stopPromise = stopped;
  assert.ok(stopPromise, 'starting must be observable only once a stop request can be delivered');
  await stopPromise;
  await assert.rejects(starting, /before stdout readiness/i);
  await waitFor(() => lines.includes('console:stop'));
  assert.equal(server.pid, undefined);
  assert.equal(server.state, 'failed');
  assert.ok(!states.includes('running'));
});

test('graceful stop rejects a nonzero exit instead of implying saves completed', async (t) => {
  const { server } = await fixture(t, ['--exit-on-command']);
  await server.start();
  await assert.rejects(server.stop(), /abnormal.*code 7.*save/i);
  assert.equal(server.pid, undefined);
  assert.equal(server.state, 'failed');
});

test('graceful stop rejects asynchronous console failure even when an unread child exits zero', async (t) => {
  // This real child never reads stdin. Its zero exit is gated by a disposable
  // file, so the pipe cannot fail until after the backlog and stop are queued.
  const { server, cwd } = await fixture(t, [], {
    args: unreadConsoleArgs,
    stopTimeoutMs: 2000,
  });
  await server.start();
  const pid = server.pid;
  assert.ok(pid !== undefined);
  // Observe actual stream/process events, without mocking or emitting errors.
  const child = (server as unknown as { child: ChildProcessWithoutNullStreams }).child;
  const observation: { consoleError?: NodeJS.ErrnoException } = {};
  let stopRequested = false;
  let errorAfterStop = false;
  const events: string[] = [];
  child.stdin.once('error', (error: NodeJS.ErrnoException) => {
    observation.consoleError = error;
    errorAfterStop = stopRequested;
    events.push('stdin-error');
  });
  child.once('close', () => events.push('close'));
  for (let index = 0; index < 1024; index += 1) server.sendCommand('x'.repeat(1024));
  assert.ok(child.stdin.writableLength > 1024, 'unread console must have a real write backlog');
  stopRequested = true;
  const stopped = server.stop();
  // Attach a rejection handler immediately, even while the exit gate is written.
  const settled = stopped.then(() => events.push('stop-settled'), () => events.push('stop-settled'));
  assert.equal(server.state, 'stopping');
  assert.ok(!events.includes('stdin-error'), 'console error must be asynchronous and follow stop');
  assert.equal(server.pid, pid);
  await writeFile(path.join(cwd, 'exit-requested'), '');
  await settled;
  const consoleError = observation.consoleError;
  assert.ok(consoleError, 'the real stdin pipe must fail rather than merely exit');
  assert.match(consoleError.message, /write.*(?:EOF|EPIPE|ECONNRESET)/i);
  assert.equal(errorAfterStop, true);
  assert.deepEqual(events, ['stdin-error', 'close', 'stop-settled'], 'stop must await actual child close');
  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
  assert.equal(server.pid, undefined);
  assert.equal(server.state, 'failed');
  assert.ok(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed);
  assert.throws(() => process.kill(pid, 0), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
    return true;
  });
  t.diagnostic(`real stdin error=${consoleError.message}; exit=0; events=${events.join(',')}; PID ${pid} absent`);
  await assert.rejects(stopped, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /console.*save completion.*unconfirmed/i);
    assert.equal(error.cause, consoleError);
    return true;
  });
});

test('overlapping stop retains the old console cause after force-stop accepts a replacement launch', async (t) => {
  const { server, cwd } = await fixture(t, [], { args: overlappingConsoleArgs, stopTimeoutMs: 2000 });
  await server.start();
  const oldChild = (server as unknown as { child: ChildProcessWithoutNullStreams }).child;
  const oldPid = server.pid;
  assert.ok(oldPid !== undefined);
  const events: string[] = [];
  const observation: {
    consoleError?: Error;
    stopped?: Promise<void>;
    settled?: Promise<void>;
    restarted?: Promise<void>;
  } = {};
  let restartScheduled = false;
  oldChild.stdin.once('error', (error: Error) => {
    observation.consoleError = error;
    events.push('stdin-error');
  });
  oldChild.once('close', () => events.push('old-close'));
  server.on('state', (state: string) => {
    if (state !== 'failed' || restartScheduled) return;
    restartScheduled = true;
    // Register force-stop's close waiter first, then overlap graceful stop.
    const forced = server.forceStop();
    observation.restarted = forced.then(() => {
      assert.ok(events.includes('old-close'));
      const restarted = server.start();
      assert.equal(server.state, 'starting');
      events.push('restart-accepted');
      return restarted;
    });
    void observation.restarted.catch(() => undefined);
    observation.stopped = server.stop();
    observation.settled = observation.stopped.then(
      () => { events.push('old-stop-resolved'); },
      () => { events.push('old-stop-rejected'); },
    );
  });
  for (let index = 0; index < 1024; index += 1) server.sendCommand('x'.repeat(1024));
  assert.ok(oldChild.stdin.writableLength > 1024);
  await writeFile(path.join(cwd, 'exit-requested'), '');
  await waitFor(() => observation.settled !== undefined);
  await observation.settled;
  assert.ok(observation.stopped && observation.restarted);
  const consoleError = observation.consoleError;
  assert.ok(consoleError, 'must observe the actual asynchronous stdin error');
  assert.match(consoleError.message, /write.*(?:EOF|EPIPE|ECONNRESET)/i);
  assert.equal(oldChild.exitCode, 0);
  assert.equal(oldChild.signalCode, null);
  assert.ok(oldChild.stdin.destroyed && oldChild.stdout.destroyed && oldChild.stderr.destroyed);
  assert.throws(() => process.kill(oldPid, 0), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
    return true;
  });
  assert.ok(events.indexOf('old-close') < events.indexOf('restart-accepted'));
  assert.ok(events.indexOf('restart-accepted') < events.length - 1, 'restart must precede old stop settlement');
  t.diagnostic(`console cause=${consoleError.message}; old exit=0; events=${events.join(',')}; old PID ${oldPid} absent`);
  await assert.rejects(observation.stopped, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /console.*save completion.*unconfirmed/i);
    assert.equal(error.cause, consoleError, 'a new start cannot erase or replace the old console cause');
    return true;
  });
  await observation.restarted;
  assert.equal(server.state, 'running');
  const replacementPid = server.pid;
  assert.ok(replacementPid !== undefined && replacementPid !== oldPid);
  await server.stop();
  assert.equal(server.state, 'offline');
  assert.equal(server.pid, undefined);
});

test('overlapping stop rejects the killed launch without poisoning force-stop replacement readiness', async (t) => {
  const { server, states } = await fixture(t);
  await server.start();
  const oldChild = (server as unknown as { child: ChildProcessWithoutNullStreams }).child;
  const oldPid = server.pid;
  assert.ok(oldPid !== undefined);
  const events: string[] = [];
  oldChild.once('close', () => events.push('old-close'));
  const forced = server.forceStop();
  let replacementStateIndex = -1;
  const restarted = forced.then(() => {
    assert.ok(events.includes('old-close'));
    replacementStateIndex = states.length;
    const starting = server.start();
    assert.equal(server.state, 'starting');
    events.push('restart-accepted');
    return starting;
  });
  void restarted.catch(() => undefined);
  const stopped = server.stop();
  const settled = stopped.then(
    () => { events.push('old-stop-resolved'); },
    () => { events.push('old-stop-rejected'); },
  );
  await settled;
  assert.equal(oldChild.signalCode, 'SIGKILL');
  assert.ok(oldChild.stdin.destroyed && oldChild.stdout.destroyed && oldChild.stderr.destroyed);
  assert.throws(() => process.kill(oldPid, 0), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
    return true;
  });
  assert.deepEqual(events, ['old-close', 'restart-accepted', 'old-stop-rejected']);
  await assert.rejects(stopped, /abnormal.*SIGKILL.*save completion.*unconfirmed/i);
  t.diagnostic(`old signal=${oldChild.signalCode}; events=${events.join(',')}; replacement state=${server.state}; old PID ${oldPid} absent`);
  await restarted;
  assert.equal(server.state, 'running');
  assert.deepEqual(states.slice(replacementStateIndex), ['starting', 'running'], 'old stop cannot fail the new launch');
  const replacementPid = server.pid;
  assert.ok(replacementPid !== undefined && replacementPid !== oldPid);
  await server.stop();
  assert.equal(server.state, 'offline');
  assert.equal(server.pid, undefined);
});

test('a new launch clears the previous console failure before a clean zero exit', async (t) => {
  const { server, cwd } = await fixture(t, [], { args: unreadConsoleArgs, stopTimeoutMs: 2000 });
  const exitGate = path.join(cwd, 'exit-requested');
  await server.start();
  for (let index = 0; index < 1024; index += 1) server.sendCommand('x'.repeat(1024));
  const failedStop = server.stop();
  const failedSettlement = failedStop.catch(() => undefined);
  await writeFile(exitGate, '');
  await failedSettlement;
  await assert.rejects(failedStop, /console.*save completion.*unconfirmed/i);
  assert.equal(server.state, 'failed');
  assert.equal(server.pid, undefined);

  await rm(exitGate);
  await server.start();
  const child = (server as unknown as { child: ChildProcessWithoutNullStreams }).child;
  const cleanStop = server.stop();
  const cleanSettlement = cleanStop.catch(() => undefined);
  // With no backlog the small stop write completes before the child exits.
  await waitFor(() => child.stdin.writableLength === 0);
  assert.equal(server.state, 'stopping');
  await writeFile(exitGate, '');
  await cleanSettlement;
  await cleanStop;
  assert.equal(child.exitCode, 0);
  assert.equal(server.state, 'offline');
  assert.equal(server.pid, undefined);
});
