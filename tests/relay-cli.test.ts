import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createIdentity } from '../src/core/peer-transport.js';
import { SeedHostApplication } from '../src/core/application.js';

const cli = path.resolve('dist/src/relay/cli.js');
function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
function lineMatching(child: ChildProcessWithoutNullStreams, pattern: RegExp): Promise<RegExpExecArray> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => reject(new Error('relay did not report ' + pattern)), 10000);
    lines.on('line', (line) => { const match = pattern.exec(line); if (match) { clearTimeout(timer); lines.close(); resolve(match); } });
  });
}

test('the headless relay CLI initializes, trusts a host, serves a park, reports status and stops cleanly', { timeout: 60000 }, async (t) => {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(path.resolve('.test-data/relay-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const relayRoot = path.join(root, 'relay');
  const init = await run(['init', '--root', relayRoot]);
  assert.equal(init.code, 0, init.stderr);
  const fingerprint = /FINGERPRINT=([a-f0-9]{64})/.exec(init.stdout)?.[1];
  assert.ok(fingerprint, init.stdout);
  if (process.platform !== 'win32') assert.equal((await stat(path.join(relayRoot, 'identity.json'))).mode & 0o077, 0, 'private key is owner-only');
  assert.equal((await run(['init', '--root', relayRoot])).stdout.match(/FINGERPRINT=([a-f0-9]{64})/)?.[1], fingerprint, 'init is idempotent');
  const identity = await createIdentity();
  assert.equal((await run(['trust', '--root', relayRoot, '--name', 'Desktop', '--fingerprint', 'not-a-fingerprint'])).code, 2);
  assert.equal((await run(['trust', '--root', relayRoot, '--name', 'Desktop', '--fingerprint', identity.fingerprint])).code, 0);

  const serve = spawn(process.execPath, [cli, 'serve', '--root', relayRoot, '--port', '0']);
  t.after(() => { if (serve.exitCode === null) serve.kill('SIGKILL'); });
  const [, host, port] = await lineMatching(serve, /^LISTENING=([0-9.]+):(\d+)$/);
  assert.equal(host, '127.0.0.1', 'loopback unless --host is given');

  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'world.bin'), 'parked by the CLI test');
  const app = new SeedHostApplication(path.join(root, 'host'), identity);
  t.after(() => app.close().catch(() => {}));
  await app.open();
  await app.importExisting(source, true);
  await app.addPeer({ name: 'Mini PC', fingerprint: fingerprint!, host: host!, port: Number(port) });
  await app.saveRelay({ fingerprint: fingerprint!, parkOnStop: false });
  await app.parkAtRelay();
  assert.equal((await app.checkRelay())!.state, 'owned');

  serve.kill('SIGTERM');
  const code = await new Promise<number | null>((resolve) => serve.once('close', resolve));
  assert.equal(code, 0, 'SIGTERM is a clean shutdown');
  const status = await run(['status', '--root', relayRoot]);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /CUSTODY=owned generation=1 snapshot=[a-f0-9]{64}/);
  assert.match(status.stdout, new RegExp(`TRUSTED=Desktop ${identity.fingerprint}`));
});
