import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runHarness(args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tools/desktop-friends-check.mjs', ...args], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, SEED_FRIENDS_HOLD_SECONDS: '0' },
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; process.stdout.write(data); });
    child.on('error', reject); child.on('close', code => resolve({ code, output }));
  });
}

// Reject the whole selector before launching any Electron case, including inherited keys.
test('Friends regression selectors fail closed before execution', { timeout: 60000 }, async () => {
  for (const selector of ['toString', 'constructor', '__proto__', '', 'preview,,join', 'preview,toString']) {
    const result = await runHarness(['--case=' + selector, '--hold=0']);
    assert.equal(result.code, 1, 'invalid selector must exit 1: ' + JSON.stringify(selector) + '\n' + result.output);
    assert.match(result.output, /Unknown regression case:/);
    assert.doesNotMatch(result.output, /PASS|STEP|ACTION|SCREENSHOT/, 'invalid selector must never run or report a passing case');
  }
});

// Real headed Electron + real loopback relay. Dialog answers only are substituted,
// except explicitly labelled TEST-ONLY bridge concurrency cases in the harness.
test('Friends guided invitations: visible isolated Electron behavioral regressions', { timeout: 360000 }, async () => {
  const result = await runHarness();
  assert.equal(result.code, 0, result.output);
});
