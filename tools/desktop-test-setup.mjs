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

// Pages and settings categories are tabs. Before a check touches a control, open whichever page /
// category holds it through the real visible tab buttons, as a user would. No-op if already visible.
export async function reveal(page, selector) {
  const tabs = await page.locator(selector).first().evaluate((el) => {
    const ids = [];
    for (let n = el; n; n = n.parentElement) if (n.getAttribute?.('role') === 'tabpanel' && n.hidden) ids.unshift(n.getAttribute('aria-labelledby'));
    return ids;
  });
  for (const id of tabs) await page.locator('#' + id).click();
}
