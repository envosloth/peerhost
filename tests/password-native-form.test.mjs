import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { _electron } from 'playwright';

// Actual native Chromium constraints in a headed Electron renderer. TEST-ONLY bridge;
// these disposable input values are not credentials and no account is submitted.
test('native password field applies four-character and Unicode/control bounds', { timeout: 60000 }, async () => {
  assert.ok(process.env.TMPDIR, 'Isolated scratch required');
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'seed-password-native-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.resolve('tools/dashboard-fixture-main.cjs'), '--profile-root=' + root], env });
  try {
    const page = await app.firstWindow(); await page.bringToFront();
    await page.waitForFunction(() => document.querySelector('#splash').hidden);
    // Move the actual production input into a QA-only visible form, without altering its attributes.
    await page.evaluate(() => {
      for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
      const form = document.createElement('form'); form.id = 'native-password-fixture';
      form.style.cssText = 'position:fixed;inset:100px 100px auto;z-index:99999;padding:24px;background:var(--card);';
      const heading = document.createElement('h2'); heading.textContent = 'Native password validation — isolated test';
      const label = document.createElement('label'); label.htmlFor = 'account-password'; label.textContent = 'Disposable fixture text (not a submitted account)';
      form.append(heading, label, document.getElementById('account-password'), document.getElementById('account-password-help'));
      document.body.append(form);
      form.addEventListener('submit', event => event.preventDefault());
    });
    const input = page.locator('#account-password');
    for (const [text, valid] of [['abc', false], ['abcd', true], ['café', true], [' café ', true], ['x'.repeat(128), true], ['a\tbc', false], ['a\u007fbc', false], ['a\u0085bc', false]]) {
      await page.bringToFront(); await input.fill(text);
      const observed = await input.evaluate(node => ({ valid: node.checkValidity(), value: node.value, patternMismatch: node.validity.patternMismatch, tooShort: node.validity.tooShort }));
      assert.equal(observed.valid, valid, JSON.stringify({ length: text.length, ...observed }));
      assert.equal(observed.value, text, 'native field must not trim or normalize accepted text');
      console.log('NATIVE PASSWORD CASE length=' + text.length + ' valid=' + observed.valid);
    }
    // Maxlength prevents user entry of a 129th character; the IPC/service separately reject it.
    await page.bringToFront(); await input.fill('x'.repeat(128)); await input.press('End'); await input.pressSequentially('x');
    assert.equal((await input.inputValue()).length, 128);
    assert.match(await page.locator('#account-password-help').textContent(), /weak/i);
    const screenshot = path.join(root, 'native-password-validation.png');
    await page.screenshot({ path: screenshot }); console.log('SCREENSHOT=' + screenshot);
  } finally { app.process().kill(); await app.close().catch(() => {}); }
});
