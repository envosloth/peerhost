import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { dismissInitialSetup } from '../tools/desktop-test-setup.mjs';

// Real Electron app with an isolated profile. Exercises window chrome, splash, page tabs and appearance only;
// no server process is started.
const electronPath = createRequire(import.meta.url)('electron');
async function launch(name) {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(path.resolve('.test-data/window-' + name + '-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const args = [...(process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : []), path.resolve('dist/apps/desktop/main.js'), '--profile-root=' + path.join(root, 'profile')];
  const app = await electron.launch({ executablePath: electronPath, args, env });
  return { app, page: await app.firstWindow() };
}
const win = (app) => app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return { fullScreen: w.isFullScreen(), minimized: w.isMinimized(), visible: w.isVisible(), count: BrowserWindow.getAllWindows().length }; });

// Visible controls / headings that overlap each other, clip their own text, or leave the viewport.
async function layoutProblems(page) {
  return page.evaluate(() => {
    const problems = [];
    const describe = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).join('.') : '');
    const visible = (e) => {
      const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false;
      for (let n = e; n; n = n.parentElement) { const s = getComputedStyle(n); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false; }
      for (let d = e.closest('details:not([open])'); d; d = d.parentElement?.closest('details:not([open])') ?? null) { if (!d.querySelector(':scope > summary')?.contains(e)) return false; }
      return !e.closest('[hidden],#splash,dialog:not([open])');
    };
    const scrolledAway = (e) => { const r = e.getBoundingClientRect(); for (let n = e.parentElement; n; n = n.parentElement) { const s = getComputedStyle(n); if (/(auto|scroll|hidden)/.test(s.overflow + s.overflowX + s.overflowY)) { const p = n.getBoundingClientRect(); if (r.bottom <= p.top || r.top >= p.bottom || r.right <= p.left || r.left >= p.right) return true; } } return false; };
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1) problems.push('page scrolls horizontally: ' + doc.scrollWidth + '>' + doc.clientWidth);
    for (const scroller of document.querySelectorAll('.page:not([hidden]), .sidebar')) if (scroller.scrollWidth > scroller.clientWidth + 1) problems.push('horizontal overflow in ' + describe(scroller));
    const nodes = [...document.querySelectorAll('button,input,textarea,select,.badge,h1,h2,h3,summary,label,.chip,.led,.kbd,code.listener-endpoint')].filter((e) => visible(e) && !scrolledAway(e));
    for (const e of nodes) {
      const r = e.getBoundingClientRect();
      if (r.right > innerWidth + 1 || r.left < -1) problems.push('outside viewport: ' + describe(e));
      if ((e.tagName === 'BUTTON' || e.classList.contains('badge')) && e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflow !== 'visible') problems.push('text clipped: ' + describe(e));
    }
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (a.contains(b) || b.contains(a)) continue;
      if ((a.tagName === 'LABEL' && a.control === b) || (b.tagName === 'LABEL' && b.control === a)) continue;
      const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
      const w = Math.min(x.right, y.right) - Math.max(x.left, y.left), h = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top);
      if (w > 1.5 && h > 1.5) problems.push('overlap: ' + describe(a) + ' × ' + describe(b));
    }
    return problems;
  });
}

test('splash, borderless/fullscreen toggle, page tabs, appearance, minimize, close-to-tray and layout integrity', { timeout: 180000 }, async () => {
  const { app, page } = await launch('chrome');
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  try {
    assert.equal((await win(app)).count, 1, 'the splash lives inside the single app window, not a second BrowserWindow');
    await page.waitForFunction(() => document.querySelector('#app-version')?.textContent?.includes('v0.2'));
    await page.waitForFunction(() => document.querySelector('#splash')?.hasAttribute('hidden'), undefined, { timeout: 10000 });
    await dismissInitialSetup(page);

    // No separate title strip: the sidebar reaches the top edge and the window buttons sit on the page itself.
    const chrome = await page.evaluate(() => {
      const bar = document.querySelector('.window-controls').parentElement;
      const style = getComputedStyle(bar);
      return { sidebarTop: document.querySelector('.sidebar').getBoundingClientRect().top, inMain: Boolean(bar.closest('main')), background: style.backgroundColor, border: style.borderBottomWidth };
    });
    assert.deepEqual(chrome, { sidebarTop: 0, inMain: true, background: 'rgba(0, 0, 0, 0)', border: '0px' });
    const mode = page.locator('#window-mode');
    assert.equal(await mode.getAttribute('data-mode'), 'borderless');
    assert.match(await mode.getAttribute('aria-label'), /fullscreen/i, 'borderless offers only fullscreen');
    await mode.click();
    await page.waitForFunction(() => document.querySelector('#window-mode')?.getAttribute('data-mode') === 'fullscreen');
    assert.equal((await win(app)).fullScreen, true);
    assert.match(await mode.getAttribute('aria-label'), /borderless/i, 'fullscreen offers only borderless');
    assert.deepEqual(await layoutProblems(page), [], 'fullscreen layout');
    await mode.click();
    await page.waitForFunction(() => document.querySelector('#window-mode')?.getAttribute('data-mode') === 'borderless');
    assert.equal((await win(app)).fullScreen, false);
    await page.keyboard.press('F11');
    await page.waitForFunction(() => document.querySelector('#window-mode')?.getAttribute('data-mode') === 'fullscreen');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#window-mode')?.getAttribute('data-mode') === 'borderless');

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
    await page.waitForFunction(() => innerWidth <= 1000);

    // Each sidebar tab owns one page; only that page shows, only that tab is marked, focus stays on it.
    const pages = ['operate', 'peers', 'settings'];
    const pageState = () => page.evaluate((names) => names.map((n) => ({ n, selected: document.getElementById(n + '-tab').getAttribute('aria-selected'), shown: !document.getElementById(n + '-panel').hidden })), pages);
    assert.deepEqual((await pageState()).filter((p) => p.shown).map((p) => p.n), ['operate'], 'starts on My server');
    assert.equal(await page.locator('#console-tab').isHidden(), true, 'console page appears once a server exists');
    for (const name of pages) {
      await page.locator('#' + name + '-tab').click();
      for (const p of await pageState()) assert.deepEqual([p.selected, p.shown], p.n === name ? ['true', true] : ['false', false], 'after clicking ' + name + ': ' + p.n);
      assert.equal(await page.evaluate(() => document.activeElement?.id), name + '-tab', 'focus stays on the clicked tab');
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.nav-tab.is-active')].map((e) => e.id)), [name + '-tab'], 'the active outline follows the click');
    }
    // Status lights follow real state: a loopback-only peer listener lights the listener LED.
    await page.locator('#peers-tab').click(); await page.locator('#advanced-peers').evaluate((el) => { el.open = true; });
    assert.equal(await page.locator('#listener-led').getAttribute('class'), 'led');
    await page.locator('#start-listener').click();
    await page.waitForFunction(() => document.querySelector('#listener-status').textContent === 'LISTENING');
    await page.waitForFunction(() => document.querySelector('#listener-led').classList.contains('led-info'), undefined, { timeout: 5000 });
    await page.locator('#settings-tab').focus(); await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'peers-tab', 'arrow keys skip the hidden console tab');
    assert.equal(await page.locator('#peers-panel').isHidden(), false);

    const categories = ['appearance', 'network', 'app'];
    for (const theme of ['dark', 'light']) {
      await page.locator('#settings-tab').click();
      await page.locator('#settings-cat-appearance').click();
      await page.locator(`#appearance-theme [value="${theme}"]`).check();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
      for (const cat of categories) {
        await page.locator('#settings-cat-' + cat).click();
        assert.deepEqual(await page.evaluate((names) => names.filter((n) => !document.getElementById('settings-' + n).hidden), categories), [cat], 'one settings category at a time');
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'settings-cat-' + cat);
        assert.equal(await page.locator('#settings-savebar').isHidden(), cat === 'appearance', 'Save settings only where saved preferences live');
        assert.deepEqual(await layoutProblems(page), [], theme + ' settings/' + cat + ' at minimum size');
      }
      await page.locator('#peers-tab').click();
      await page.locator('#advanced-peers').evaluate((el) => { el.open = true; });
      await page.locator('#add-peer-details').evaluate((el) => { el.open = true; });
      assert.deepEqual(await layoutProblems(page), [], theme + ' friends page at minimum size');
      await page.locator('#operate-tab').click();
      assert.deepEqual(await layoutProblems(page), [], theme + ' server page at minimum size');
    }
    await page.locator('#settings-tab').click(); await page.locator('#settings-cat-appearance').click();
    await page.locator('#appearance-density [value="compact"]').check();
    await page.locator('#appearance-accent [value="violet"]').check();
    assert.deepEqual(await layoutProblems(page), [], 'compact density');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#splash')?.hasAttribute('hidden'), undefined, { timeout: 10000 });
    assert.deepEqual(await page.evaluate(() => ({ ...document.documentElement.dataset })), { theme: 'light', accent: 'violet', density: 'compact', depth: 'soft', motion: 'full' }, 'appearance survives reload');

    await page.locator('#window-minimize').click();
    await app.evaluate(async ({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; for (let i = 0; i < 100 && !w.isMinimized(); i++) await new Promise((r) => setTimeout(r, 20)); });
    assert.equal((await win(app)).minimized, true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
    await page.locator('#window-close').click();
    await app.evaluate(async ({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; for (let i = 0; i < 100 && w.isVisible(); i++) await new Promise((r) => setTimeout(r, 20)); });
    const closed = await win(app);
    assert.equal(closed.visible, false, 'X hides to tray by default'); assert.equal(closed.count, 1, 'app keeps running');
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
});
