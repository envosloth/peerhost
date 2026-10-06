// Legacy regression checks explicitly dismiss the new first-run wizard through
// its visible control. Production defaults and saved progress are not bypassed.
export async function dismissInitialSetup(page) {
  if (!await page.locator('#setup-dialog').count()) return; // Older packaged alpha.
  const progress = await page.evaluate(async () => (await window.seedhost.call('getState')).onboarding);
  if (progress?.dismissed || progress?.completed || progress?.error) return; // Returning profiles do not auto-open setup.
  await page.waitForFunction(() => document.querySelector('#setup-dialog').open, undefined, { timeout: 15000 });
  await page.locator('#setup-later').click();
  await page.waitForFunction(() => !document.querySelector('#setup-dialog').open && document.querySelector('#activity-message').textContent.startsWith('Ready'), undefined, { timeout: 15000 });
}

// Home never exposes server tabs, even with a remembered backend selection.
// Enter the workspace only through the selected library card's visible Open action.
export async function openSelectedServer(page) {
  await page.bringToFront();
  if (await page.locator('#operate-tab').isVisible()) return;
  await page.locator('#home-tab').click();
  await page.locator('#server-list .is-current button[data-action="open"]').click();
  await page.waitForFunction(() => !document.querySelector('#operate-panel').hidden && !document.querySelector('#operate-tab').hidden);
}

// Pages and settings categories are tabs. Before a check touches a control, open whichever page /
// category holds it through the real visible tab buttons, as a user would. No-op if already visible.
export async function reveal(page, selector) {
  await page.bringToFront();
  const inWorkspaceHeader = await page.locator(selector).first().evaluate(el => Boolean(el.closest('#server-workspace-header[hidden]')));
  if (inWorkspaceHeader) await openSelectedServer(page);
  const tabs = await page.locator(selector).first().evaluate((el) => {
    const ids = [];
    for (let n = el; n; n = n.parentElement) if (n.getAttribute?.('role') === 'tabpanel' && n.hidden) ids.unshift(n.getAttribute('aria-labelledby'));
    return ids;
  });
  for (const id of tabs) {
    await page.bringToFront();
    if (await page.locator('#' + id).isHidden()) {
      if (['home-tab', 'friends-tab', 'settings-tab'].includes(id)) await page.locator('#home-tab').click();
      else await openSelectedServer(page);
    }
    await page.locator('#' + id).click();
  }
}
