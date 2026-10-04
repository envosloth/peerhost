// Legacy regression checks explicitly dismiss the new first-run wizard through
// its visible control. Production defaults and saved progress are not bypassed.
export async function dismissInitialSetup(page) {
  if (!await page.locator('#setup-dialog').count()) return; // Older packaged alpha.
  const progress = await page.evaluate(async () => (await window.peerhost.call('getState')).onboarding);
  if (progress?.dismissed || progress?.completed || progress?.error) return; // Returning profiles do not auto-open setup.
  await page.waitForFunction(() => document.querySelector('#setup-dialog').open, undefined, { timeout: 15000 });
  await page.locator('#setup-later').click();
  await page.waitForFunction(() => !document.querySelector('#setup-dialog').open && document.querySelector('#activity-message').textContent.startsWith('Ready'), undefined, { timeout: 15000 });
}
