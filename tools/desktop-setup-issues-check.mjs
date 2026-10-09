// Headed real Electron, preload, IPC policy and backend; isolated scratch, loopback HTTP only.
// TEST-ONLY native consent answers and upstream -> loopback transport redirect. No backend/IPC stubs.
// All fixture artifacts/executables are explicitly NOT Java or Minecraft.
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';
import { javaProbeFixture } from '../tests/java-probe-fixture.mjs';
import { reveal } from './desktop-test-setup.mjs';
import { AccountService } from '../dist/src/core/accounts.js';
import { createIdentity } from '../dist/src/core/peer-transport.js';
const options = process.argv.slice(2);
assert.ok(options.length <= 1 && options.every(arg => /^--hold=\d+$/.test(arg)), 'Only --hold=<0..600 seconds> is supported');
const holdSeconds = options.length ? Number(options[0].slice('--hold='.length)) : 90;
assert.ok(Number.isSafeInteger(holdSeconds) && holdSeconds >= 0 && holdSeconds <= 600, 'Hold must be 0..600 seconds');
const project = fileURLToPath(new URL('../', import.meta.url));
assert.ok(process.env.TMPDIR?.includes('hermes'), 'Use isolated Hermes scratch, not live profiles or OS Temp');
const root = await mkdtemp(path.join(process.env.TMPDIR, 'seedhost-setup-issues-ui-'));
const profile = path.join(root, 'profile');
await mkdir(profile);
const progress = { version: 1, step: 'server', dismissed: true, completed: false, skipped: [], draft: { name: 'Fixture world', loader: 'vanilla', gameVersion: '', memoryMiB: 2048 } };
await writeFile(path.join(profile, 'onboarding.json'), JSON.stringify(progress));
const java = await javaProbeFixture(root);
const requests = [], steps = [], errors = [];
let stepLog = [];
const modFixtures = Array.from({ length: 25 }, (_, i) => ({ project_id: 'fixture' + i, slug: 'fixture' + i, title: 'Mod ' + (25 - i), description: 'Loopback fixture, NOT actual Modrinth data', author: 'Fixture', downloads: 1000 - i, follows: i * 10, client_side: 'unsupported', server_side: 'required', icon_url: null }));
const hash = bytes => createHash('sha1').update(bytes).digest('hex');
const jar = Buffer.from('fixture JAR bytes - NOT Minecraft');
const metadata = JSON.stringify({ id: '1.21.1', javaVersion: { majorVersion: 21, component: 'java-runtime-delta' }, downloads: { server: { url: 'https://piston-data.mojang.com/server.jar', size: jar.length, sha1: hash(jar) } } });
const http = createServer((req, res) => {
  requests.push(req.url);
  res.setHeader('content-type', 'application/json');
  if (req.url === '/mc/game/version_manifest_v2.json') return res.end(JSON.stringify({ latest: { release: '1.21.1' }, versions: [{ id: '1.21.1', type: 'release', url: 'https://piston-meta.mojang.com/version.json', sha1: hash(metadata) }] }));
  if (req.url === '/version.json') return res.end(metadata);
  if (req.url === '/server.jar') return res.end(jar);
  if (req.url.startsWith('/v2/search')) {
    const params = new URL(req.url, 'http://127.0.0.1').searchParams;
    const hits = modFixtures.filter(h => h.title.toLowerCase().includes((params.get('query') || '').toLowerCase()));
    if (params.get('index') === 'follows') hits.reverse();
    const offset = Number(params.get('offset')), limit = Number(params.get('limit'));
    return res.end(JSON.stringify({ hits: hits.slice(offset, offset + limit), total_hits: hits.length }));
  }
  res.statusCode = 404; res.end('{}');
});
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + http.address().port;
const env = { ...process.env, SEEDHOST_TEST_LOOPBACK: '1', JAVA_HOME: path.dirname(path.dirname(java)) }; delete env.ELECTRON_RUN_AS_NODE; delete env.SEEDHOST_ACCOUNT_SERVICE;
let app, page, accountService, membershipEvidence;
const apps = new Set();
async function launch(profileRoot = profile) {
  app = await _electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.join(project, 'dist/apps/desktop/main.js'), '--profile-root=' + profileRoot], env });
  apps.add(app);
  page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.bringToFront(); await settled();
  await page.context().route('https://**/*', route => route.abort());
  await app.evaluate(({ dialog }, origin) => {
    dialog.showMessageBox = async () => ({ response: 1 });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
      if (!['piston-meta.mojang.com', 'piston-data.mojang.com', 'api.modrinth.com'].includes(url.hostname)) throw Error('TEST-ONLY external fetch blocked: ' + url.hostname);
      return realFetch(origin + url.pathname + url.search, init);
    };
  }, origin);
}
const state = () => page.evaluate(() => window.seedhost.call('getState'));
async function settled() { await page.waitForFunction(() => document.querySelector('#activity-message').textContent.startsWith('Ready')); }
async function click(selector) { await page.bringToFront(); await page.locator(selector).click(); await settled(); }
async function fill(selector, value) { await page.bringToFront(); await page.locator(selector).fill(value); }
async function select(selector, value) { await page.bringToFront(); await page.locator(selector).selectOption(value); }
async function check(selector) { await page.bringToFront(); await page.locator(selector).check(); }
async function key(value) { await page.bringToFront(); await page.keyboard.press(value); }
async function closeCurrent() { await app.close(); apps.delete(app); app = null; }
async function stage(step) { await click(`[data-setup-step="${step}"]`); await page.waitForFunction(s => !document.getElementById('setup-' + s).hidden, step); }
async function finishAnimations() { await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))); }); }
async function screenshot(label) { await page.bringToFront(); await finishAnimations(); const target = path.join(root, label + '.png'); await page.screenshot({ path: target }); console.log('SCREENSHOT=' + target); }
async function assertAccountOnTop() {
  await finishAnimations();
  const view = await page.evaluate(() => {
    const dialog = document.getElementById('account-dialog'), rect = dialog.getBoundingClientRect();
    return { guide: document.getElementById('setup-dialog').open, account: dialog.open,
      onTop: Boolean(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('#account-dialog')),
      focused: Boolean(document.activeElement?.closest('#account-dialog')) };
  });
  assert.deepEqual(view, { guide: true, account: true, onTop: true, focused: true }, 'sign-in is usable above the guide, not inert behind it');
}
async function prepareAccountProfile(name) {
  const target = path.join(root, name); await mkdir(target);
  await writeFile(path.join(target, 'account-service.json'), JSON.stringify({ ...accountService.endpoint, fingerprint: accountService.identity.fingerprint }));
  // Suppress auto-guide metadata until the loopback transport is attached; open the genuinely fresh guide via its visible navigation.
  await writeFile(path.join(target, 'onboarding.json'), JSON.stringify({ ...progress, draft: { ...progress.draft, name: 'My Minecraft server' } }));
  return target;
}
async function signup(username) {
  await page.waitForFunction(() => document.getElementById('account-dialog').open);
  await fill('#account-username', username);
  // Generated, disposable loopback-only credentials; never a user's account, vault or published test secret.
  await fill('#account-password', randomBytes(24).toString('hex'));
  await click('#account-submit');
  await page.waitForFunction(() => !document.getElementById('account-dialog').open && document.getElementById('account-heading').textContent.startsWith('@'));
  assert.equal((await page.evaluate(() => window.seedhost.call('accountStatus'))).username, username);
}

// A disposable stopped workspace directory (NOT Minecraft) so Multi-host is reachable; native folder answer only.
async function importDisposable(label) {
  if ((await state()).server) return;
  const source = path.join(root, 'workspace-' + label);
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'eula.txt'), 'eula=true\n');
  await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, source);
  await page.bringToFront(); await page.locator('#home-tab').click();
  await click('#import-server');
  await page.waitForFunction(() => document.querySelector('#server-list .is-current[data-action="open"]'));
  await click('#server-list .is-current[data-action="open"]');
  await page.waitForFunction(() => !document.getElementById('peers-tab').hidden);
}
async function inspectionHold() {
  if (!holdSeconds || !page || page.isClosed()) return;
  await page.bringToFront();
  for (let left = holdSeconds; left > 0; left -= Math.min(15, left)) {
    console.log('HOLD: headed Electron remains visible for ' + left + ' more seconds');
    await page.waitForTimeout(Math.min(15, left) * 1000);
  }
}
function step(message) { steps.push(message); stepLog.push(`[${new Date().toISOString()}] ${message}`); console.log('STEP ' + steps.length + ': ' + message); }
try {
  await launch(); await click('#nav-setup');
  if (await page.locator('#setup-choose-create').isVisible()) await click('#setup-choose-create');
  await page.waitForFunction(() => document.querySelector('#setup-version').value === '1.21.1');
  step('Create has no duplicate memory input; creation keeps the 2 GB default');
  await screenshot('create');
  assert.equal(await page.locator('#setup-create-form #setup-memory, #setup-create-form input[type="range"]').count(), 0, 'RAM choice belongs only to Memory, not Create');
  step('Fabric setup sorting exposes upstream choices plus visibly page-scoped A–Z/Z–A, with working pagination/reset');
  assert.equal(await page.locator('#setup-mod-sort').count(), 1, 'Setup Modrinth has a sort selector');
  await check('input[name="setup-loader-choice"][value="fabric"]');
  await page.waitForFunction(() => document.querySelectorAll('#setup-mod-list li').length === 20);
  await select('#setup-mod-sort', 'title-asc');
  await page.waitForFunction(() => document.querySelector('#setup-mod-list strong').textContent === 'Mod 6');
  assert.match(await page.locator('#setup-mod-status').textContent(), /this (loaded )?page.*not.*(?:full|global)/i);
  await click('#setup-mod-next'); assert.match(await page.locator('#setup-mod-page').textContent(), /21–25 of 25/);
  assert.equal(await page.locator('#setup-mod-next').isDisabled(), true);
  await select('#setup-mod-sort', 'title-desc');
  await page.waitForFunction(() => document.querySelector('#setup-mod-list strong').textContent === 'Mod 25');
  assert.match(await page.locator('#setup-mod-page').textContent(), /1–20 of 25/);
  for (const [sort, index] of Object.entries({ popularity: 'follows', downloads: 'downloads', relevance: 'relevance', newest: 'newest', updated: 'updated' })) {
    await select('#setup-mod-sort', sort);
    await page.waitForFunction(() => !document.querySelector('#setup-mod-next').disabled);
    assert.equal(new URL(requests.filter(r => r.startsWith('/v2/search')).at(-1), origin).searchParams.get('index'), index);
  }
  await screenshot('setup-mod-sorting');
  await check('input[name="setup-loader-choice"][value="vanilla"]');
  await click('#setup-create');
  await page.waitForFunction(() => !document.querySelector('#setup-runtime').hidden);
  assert.deepEqual((await state()).server.profile.args, ['-Xms512M', '-Xmx2048M', '-jar', 'server.jar', 'nogui']);
  step('One accessible Memory slider reads saved RAM; keyboard adjustment saves through actual IPC');
  const slider = page.locator('#setup-runtime-memory');
  assert.equal(await slider.getAttribute('type'), 'range');
  await page.bringToFront(); await slider.focus(); await key('ArrowRight');
  assert.equal(await slider.inputValue(), '2560');
  assert.match(await page.locator('#setup-memory-value').textContent(), /2.5 GB/);
  await click('#setup-profile-save');
  assert.ok((await state()).server.profile.args.includes('-Xmx2560M'));
  await screenshot('memory');
  await click('#setup-save-close'); await closeCurrent(); await launch(); await click('#nav-setup'); await stage('runtime');
  assert.equal(await page.locator('#setup-runtime-memory').inputValue(), '2560', 'saved RAM survives real restart');
  await screenshot('memory-reopened');
  step('Advanced custom JVM JSON arguments round-trip through renderer, preload and main, without starting');
  assert.equal(await page.locator('#setup-custom-java-args').count(), 1, 'Memory has a custom Java arguments editor');
  await click('#setup-java-advanced > summary');
  await fill('#setup-custom-java-args', JSON.stringify(['-XX:+UseG1GC', '-Dfixture.greeting=two words & literal']));
  await click('#setup-profile-save');
  assert.deepEqual((await state()).server.profile.args, ['-Xms512M', '-Xmx2560M', '-XX:+UseG1GC', '-Dfixture.greeting=two words & literal', '-jar', 'server.jar', 'nogui']);
  await screenshot('custom-java');
  await click('#setup-save-close'); await closeCurrent(); await launch(); await click('#nav-setup'); await stage('runtime');
  assert.deepEqual(JSON.parse(await page.locator('#setup-custom-java-args').inputValue()), ['-XX:+UseG1GC', '-Dfixture.greeting=two words & literal']);
  await click('#setup-java-advanced > summary');
  await fill('#setup-custom-java-args', '["-Xmx8G"]'); await click('#setup-profile-save');
  assert.match(await page.locator('#setup-error').textContent(), /Custom Java arguments/);
  assert.ok((await state()).server.profile.args.includes('-Xmx2560M'), 'rejected heap override changes nothing');
  await fill('#setup-custom-java-args', '["unterminated]'); await click('#setup-profile-save');
  assert.match(await page.locator('#setup-error').textContent(), /JSON/);
  await fill('#setup-custom-java-args', '[]'); await click('#setup-profile-save'); await click('#setup-save-close');
  step('Imported JVM flags, unsupported launch options and program arguments stay exact until a real Memory/custom-argv save');
  await page.bringToFront(); await click('#server-list [data-action="open"]');
  await reveal(page, '#profile-details'); await click('#profile-details > summary');
  const importedArgs = ['-Xmx4G', '-Dimported=kept', '--add-opens=java.base/java.lang=ALL-UNNAMED', '-jar', 'server.jar', '-XmxProgramArgument', 'nogui'];
  await fill('#java-args', JSON.stringify(importedArgs)); await fill('#start-timeout', '123'); await fill('#stop-timeout', '45');
  await click('#save-profile');
  const importedProfile = (await state()).server.profile;
  assert.deepEqual(importedProfile.args, importedArgs);
  await click('#nav-setup'); await stage('runtime');
  assert.deepEqual((await state()).server.profile, importedProfile, 'opening Memory never rewrites an imported profile');
  assert.deepEqual(JSON.parse(await page.locator('#setup-custom-java-args').inputValue()), ['-Dimported=kept']);
  await fill('#setup-runtime-memory', '3072'); await click('#setup-profile-save');
  let savedProfile = (await state()).server.profile;
  assert.deepEqual(savedProfile.args, ['-Xms512M', '-Xmx3072M', ...importedArgs.slice(1)]);
  assert.equal(savedProfile.startTimeoutSeconds, 123); assert.equal(savedProfile.stopTimeoutSeconds, 45);
  if (!await page.locator('#setup-java-advanced').evaluate(node => node.open)) await click('#setup-java-advanced > summary');
  await fill('#setup-custom-java-args', '["-Dreplacement=new"]'); await click('#setup-profile-save');
  const preservedArgs = ['-Xms512M', '-Xmx3072M', '-Dreplacement=new', ...importedArgs.slice(2)];
  assert.deepEqual((await state()).server.profile.args, preservedArgs);
  await screenshot('imported-java-preserved');
  await click('#setup-save-close'); await closeCurrent(); await launch(); await click('#nav-setup'); await stage('runtime');
  savedProfile = (await state()).server.profile;
  assert.deepEqual(savedProfile.args, preservedArgs, 'imported unsupported flags and program arguments survive real restart');
  assert.equal(savedProfile.startTimeoutSeconds, 123); assert.equal(savedProfile.stopTimeoutSeconds, 45);
  await click('#setup-save-close');
  step('Existing-server Modrinth sort and pagination use the same real main/backend path');
  await page.evaluate(() => window.seedhost.call('saveModTarget', { loader: 'fabric', gameVersion: '1.21.1' }));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.bringToFront(); await click('#server-list [data-action="open"]');
  await reveal(page, '#mods-details'); await click('#mods-tab');
  await page.waitForFunction(() => document.querySelectorAll('#mod-results li').length === 20);
  assert.equal(await page.locator('#mod-sort').count(), 1);
  await select('#mod-sort', 'title-asc');
  await page.waitForFunction(() => document.querySelector('#mod-results h3')?.textContent === 'Mod 6');
  assert.match(await page.locator('#mod-search-status').textContent(), /this (loaded )?page.*not.*(?:full|global)/i);
  await click('#mod-next'); assert.match(await page.locator('#mod-page').textContent(), /21–25 of 25/);
  await select('#mod-sort', 'updated');
  await page.waitForFunction(() => document.querySelector('#mod-page').textContent.startsWith('1–20'));
  await screenshot('server-mod-sorting');
  step('Guide visits remain pending; explicit skips get their own durable status rather than false completion');
  await click('#nav-setup'); await stage('friends');
  assert.equal(await page.locator('[data-setup-step="friends"]').getAttribute('data-status'), 'pending');
  await click('#setup-next');
  assert.equal(await page.locator('[data-setup-step="gateway"]').getAttribute('data-status'), 'pending');
  await click('#setup-skip');
  assert.equal(await page.locator('[data-setup-step="gateway"]').getAttribute('data-status'), 'skipped');
  assert.equal(await page.locator('#setup-ready-title').textContent(), 'Almost there', 'Friends still unresolved');
  await click('#setup-next'); assert.equal((await state()).onboarding.completed, false);
  await click('#nav-setup'); await stage('friends'); await click('#setup-skip'); await stage('ready');
  await screenshot('guide-skipped');
  await click('#setup-next'); assert.equal((await state()).onboarding.completed, true);
  await closeCurrent(); await launch(); await click('#nav-setup');
  for (const s of ['server', 'runtime', 'ready']) assert.equal(await page.locator(`[data-setup-step="${s}"]`).getAttribute('data-status'), 'complete');
  for (const s of ['friends', 'gateway']) assert.equal(await page.locator(`[data-setup-step="${s}"]`).getAttribute('data-status'), 'skipped');
  step('Undoing a skip and unreadable gateway settings show unavailable, not visited/done; required config removal invalidates Done');
  await stage('gateway'); await click('#setup-unskip');
  await writeFile(path.join(profile, 'game-gateway.json'), '{');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => document.querySelector('[data-setup-step="gateway"]').dataset.status === 'unavailable');
  assert.equal((await state()).onboarding.completed, false);
  assert.equal(await readFile(path.join(profile, 'game-gateway.json'), 'utf8'), '{', 'corrupt optional metadata retained');
  await screenshot('guide-unavailable');
  await click('#setup-skip'); await click('#setup-next'); assert.equal((await state()).onboarding.completed, true, 'explicit optional skip permits completion');
  await page.evaluate(executable => window.seedhost.call('saveProfile', { executable, args: [] }), java);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await click('#nav-setup'); await stage('ready');
  assert.equal(await page.locator('[data-setup-step="runtime"]').getAttribute('data-status'), 'pending');
  assert.equal(await page.locator('[data-setup-step="ready"]').getAttribute('data-status'), 'pending');
  assert.equal((await state()).onboarding.completed, false);
  await screenshot('guide-config-removed');
  await closeCurrent();
  step('The guide Friends step is static: no account card or duplicated controls; Open Friends lands on the Friends page');
  accountService = new AccountService(path.join(root, 'username-directory'), await createIdentity());
  await accountService.listen({ host: '127.0.0.1', port: 0 });
  const ownerProfile = await prepareAccountProfile('guide-owner'), joinerProfile = await prepareAccountProfile('guide-joiner');
  await launch(ownerProfile); await signup('guide_alex');
  await click('#nav-setup'); await stage('friends');
  assert.equal(await page.locator('#setup-friends #account-card, #setup-friends #friends-controls, #setup-friends #friend-code').count(), 0, 'the guide holds no account card, member controls or invitation codes');
  assert.match(await page.locator('#setup-friends').textContent(), /Friends page/);
  await click('#setup-open-friends');
  await page.waitForFunction(() => !document.getElementById('setup-dialog').open && !document.getElementById('friends-panel').hidden);
  await page.waitForFunction(() => document.activeElement.id === 'friend-add-username');
  await screenshot('username-guide-friends-open');
  step('Hosting groups are created only in a server\u2019s Multi-host page; owner membership is real and canManage');
  await importDisposable('guide-owner');
  await click('#peers-tab');
  await page.locator('#hosting-create-group').waitFor({ state: 'visible' });
  await click('#hosting-start-group');
  await page.waitForFunction(() => document.getElementById('hosting-friend-feedback').textContent.includes('Your hosting group is ready'));
  const ownerState = await state(), ownerGroup = ownerState.relay;
  assert.ok(ownerGroup); assert.equal(ownerState.onboarding.checks.friends, 'complete');
  assert.equal((await page.evaluate(() => window.seedhost.call('listFriends'))).canManage, true);
  assert.equal((await page.evaluate(() => window.seedhost.call('alwaysOnStatus'))).running, true);
  const owner = { app, page };
  step('A signed-in Join choice closes the guide and focuses the add-by-username form; a genuinely fresh signed-out Join surfaces sign-in that Escape returns from');
  await click('#nav-setup'); await stage('server');
  assert.equal(await page.locator('#setup-choose-join').isVisible(), true, 'signed-in fresh guide still exposes Join');
  await click('#setup-choose-join');
  await page.waitForFunction(() => !document.getElementById('setup-dialog').open && document.activeElement.id === 'friend-add-username', null, { timeout: 12000 });
  assert.equal(await page.locator('#account-dialog').evaluate(dialog => dialog.open), false, 'signed-in Join goes to the real username form without another sign-in dialog');
  await screenshot('username-guide-owner');
  await launch(joinerProfile);
  await page.waitForFunction(() => document.getElementById('account-dialog').open);
  await click('#account-offline'); await click('#nav-setup');
  assert.equal((await state()).server, null);
  assert.equal(await page.locator('#setup-choose-join').isVisible(), true);
  await click('#setup-choose-join');
  await page.waitForFunction(() => document.getElementById('account-dialog').open);
  assert.equal(await page.locator('#setup-dialog').evaluate(d => d.open), false, 'Join closes the guide before routing to Friends');
  assert.equal(await page.locator('#friends-panel').isVisible(), true, 'Join lands on the Friends page');
  await assertAccountOnTop(); await key('Tab'); await key('Tab'); await assertAccountOnTop();
  await screenshot('username-signin-above-friends');
  await key('Escape');
  await page.waitForFunction(() => !document.getElementById('account-dialog').open);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'account-open', 'Escape returns to the Friends sign-in action');
  await click('#account-open'); await signup('guide_sam');
  assert.equal(await page.locator('#friend-add-form').isVisible(), true, 'signed-in Friends shows the add-by-username form');
  assert.equal(await page.locator('#friends-panel #hosting-card').count(), 0, 'ordinary Friends holds no hosting controls');
  const joiner = { app, page };
  step('A friend request is delivered through actual IPC and the real loopback TLS account directory');
  ({ app, page } = owner);
  await click('#friends-tab');
  await fill('#friend-add-username', 'guide_sam');
  await click('#friend-add-submit');
  await page.waitForFunction(() => document.getElementById('account-friends-feedback').textContent.includes('Friend request sent to @guide_sam'));
  assert.equal(await page.locator('#friend-add-username').inputValue(), '');
  await screenshot('username-friend-request-sent');
  ({ app, page } = joiner);
  await click('#friend-requests-refresh');
  await page.locator('#friend-request-list [data-friend-accept]').waitFor({ state: 'visible' });
  assert.match(await page.locator('#friend-request-list').textContent(), /@guide_alex sent you a friend request/);
  await screenshot('username-friend-inbox');
  step('Accepting establishes a real friendship with no hosting authority; hosting is a separate explicit Multi-host invitation');
  await click('#friend-request-list [data-friend-accept]');
  await page.waitForFunction(() => document.getElementById('account-friends-feedback').textContent.includes('are now friends'));
  assert.equal((await state()).relay, null, 'friendship alone grants no hosting');
  assert.match(await page.locator('#account-friends-list').textContent(), /@guide_alex/);
  await importDisposable('guide-joiner');
  await click('#peers-tab');
  const joinerBeforeHosting = await state();
  ({ app, page } = owner);
  await click('#peers-tab');
  await page.locator('#hosting-friend-list [data-host-invite="guide_sam"]').waitFor({ state: 'visible' });
  await click('#hosting-friend-list [data-host-invite="guide_sam"]');
  await page.waitForFunction(() => document.getElementById('hosting-friend-feedback').textContent.includes('Hosting invitation sent to @guide_sam'));
  ({ app, page } = joiner);
    await click('#home-tab'); await click('#friends-tab');
    assert.equal(await page.locator('#friends-panel #hosting-request-list').count(), 1);
    await click('#hosting-requests-refresh');
  await page.locator('#hosting-request-list [data-account-accept]').waitFor({ state: 'visible' });
  await click('#hosting-request-list [data-account-accept]');
  await page.waitForFunction(() => document.getElementById('hosting-request-feedback').textContent.includes('Joined'));
  const joinedState = await state(), joinedFriends = await page.evaluate(() => window.seedhost.call('listFriends'));
  const ownerFriends = await owner.page.evaluate(() => window.seedhost.call('listFriends'));
  const recorded = joinedState.relay?.fingerprint === ownerGroup.fingerprint || (joinedState.pendingGroups || []).some(entry => entry.fingerprint === ownerGroup.fingerprint);
  assert.equal(recorded, true, 'the exact group is recorded locally');
  assert.deepEqual(joinedState.servers, joinerBeforeHosting.servers, 'acceptance never adds, downloads or replaces a world');
  assert.equal(joinedState.server.state, 'offline', 'acceptance never starts their server');
  assert.equal(joinedFriends.members.length, 2); assert.equal(ownerFriends.members.length, 2);
  assert.ok(joinedFriends.members.some(member => member.you && member.fingerprint === joinedState.deviceId));
  assert.ok(ownerFriends.members.some(member => member.fingerprint === joinedState.deviceId));
  assert.deepEqual(await page.evaluate(() => window.seedhost.call('accountRequests')), []);
  membershipEvidence = { relayFingerprint: ownerGroup.fingerprint, ownerDevice: ownerState.deviceId, joinerDevice: joinedState.deviceId,
    ownerMemberCount: ownerFriends.members.length, joinerMemberCount: joinedFriends.members.length, friendsCheck: joinedState.onboarding.checks.friends, pending: !joinedState.relay };
  await screenshot('username-guide-accepted');
  step('Session, friendship and enrollment survive restart, and guide progress is derived from saved configuration');
  await closeCurrent(); await launch(joinerProfile);
  assert.equal((await page.evaluate(() => window.seedhost.call('accountStatus'))).username, 'guide_sam');
  assert.equal(await page.locator('#account-dialog').evaluate(dialog => dialog.open), false);
  await click('#friends-tab');
  await page.waitForFunction(() => document.getElementById('account-friends-list').textContent.includes('@guide_alex'));
  const restored = await state();
  assert.ok(restored.relay || restored.pendingGroups.length, 'enrollment survived restart');
  assert.equal(restored.onboarding.checks.friends, 'complete');
  await screenshot('username-guide-reopened');
  assert.deepEqual(errors, []);
  console.log('PASS: ' + steps.length + ' headed setup/guide stages; actual IPC/profile restart and username friendship + hosting flows verified. Fixtures NOT Java/Minecraft.');
} catch (error) {
  process.exitCode = 1; console.error('FAIL:', error);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
} finally {
  await inspectionHold().catch(error => { process.exitCode = 1; errors.push('Inspection hold: ' + error.message); });
  for (const instance of [...apps].reverse()) await instance.close().catch(error => { process.exitCode = 1; errors.push('Electron cleanup: ' + error.message); });
  await accountService?.close();
  http.closeAllConnections(); await new Promise(resolve => http.close(resolve));
  await writeFile(path.join(root, 'result.json'), JSON.stringify({ steps: stepLog, stepCount: steps.length, errors, requests, exitCode: process.exitCode ?? 0,
    profile, java, holdSeconds, membershipEvidence, note: 'TEST-ONLY upstream transport + native consent; real backend/IPC, real TLS account service and relay. Disposable scratch accounts only. NOT Java/Minecraft.' }, null, 2));
  console.log('ARTIFACT_DIR=' + root);
}
