import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

function runHarness(args = []) {
  const scratch = process.env.TMPDIR || path.join(process.env.LOCALAPPDATA, 'hermes/cache/scratch');
  return mkdir(scratch, { recursive: true }).then(() => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tools/desktop-friends-check.mjs', ...args], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, TMP: scratch, TEMP: scratch, TMPDIR: scratch, SEED_FRIENDS_HOLD_SECONDS: '0' },
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; process.stdout.write(data); });
    child.on('error', reject); child.on('close', code => resolve({ code, output }));
  }));
}

// Reject the whole selector before launching any Electron case, including inherited keys.
test('Friends regression selectors fail closed before execution', { timeout: 60000 }, async () => {
  for (const selector of ['toString', 'constructor', '__proto__', '', 'pending-send,,username-roundtrip', 'pending-send,toString']) {
    const result = await runHarness(['--case=' + selector, '--hold=0']);
    assert.equal(result.code, 1, 'invalid selector must exit 1: ' + JSON.stringify(selector) + '\n' + result.output);
    assert.match(result.output, /Unknown regression case:/);
    assert.doesNotMatch(result.output, /PASS|STEP|ACTION|SCREENSHOT/, 'invalid selector must never run or report a passing case');
  }
});

test('Username acceptance rejects mismatched saved group details without claiming success', { timeout: 120000 }, async () => {
  const result = await runHarness(['--case=readback-rejected', '--hold=0']);
  assert.equal(result.code, 0, result.output);
  for (const field of ['fingerprint', 'peerFingerprint', 'host', 'port', 'parkOnStop']) assert.match(result.output, new RegExp('PASS readback-rejected=' + field));
});

// Real headed Electron + real loopback relay + the real TLS account service. Native
// consent, delivery timing, and negative readback falsification are explicitly labelled;
// sign-in/send/accept run against actual IPC, backend and directory state.
test('Username Friends: visible isolated Electron behavioral regressions', { timeout: 360000 }, async () => {
  const result = await runHarness();
  assert.equal(result.code, 0, result.output);
});
