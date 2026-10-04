import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
const cli = path.resolve('dist/src/relay/cli.js');

test('CLI opts into a separate loopback player listener and stops both cleanly', async t => {
  const root = await mkdtemp(path.join(process.env.TMPDIR ?? '.test-data', 'relay-gateway-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [cli, 'serve', '--root', root, '--port', '0', '--game-port', '0']);
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stderr.on('data', b => { stderr += b; });
  const match = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no GAME_LISTENING: ' + stdout + stderr)), 5000);
    child.stdout.on('data', b => { stdout += b; const m = /GAME_LISTENING=([^:]+):(\d+)/.exec(stdout); if (m) { clearTimeout(timer); resolve(m); } });
    child.once('close', code => { clearTimeout(timer); reject(new Error(`relay exited ${code}: ${stderr}`)); });
  });
  assert.equal(match[1], '127.0.0.1'); assert.ok(Number(match[2]) > 0);
  const exited = once(child, 'close'); child.kill('SIGTERM'); assert.equal((await exited)[0], 0);
});
