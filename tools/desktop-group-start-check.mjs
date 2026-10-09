// REAL headed Electron / renderer / sandbox preload / main / backend / pinned TLS.
// Only native dialog answers are substituted. No IPC handlers, launch resolvers,
// getState results, process lifecycle or authority are replaced. Synthetic Java
// fixture save bytes are orchestration evidence, NOT Minecraft gameplay/save proof.
// Prerequisites: parent canonical gate complete; current emitted dist (or matching
// --packaged executable); installed project Playwright/Electron; local JDK 17+;
// SEEDHOST_SMOKE_JAVA=<absolute java.exe>, SEEDHOST_GROUP_QA_APPROVE_JAVA=true.
// No build, download, installation or automatic test registration occurs here.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron } from 'playwright';
import { desktopArtifactLaunch } from './desktop-artifact-launch.mjs';
import { dismissInitialSetup, reveal, openSelectedServer } from './desktop-test-setup.mjs';

const exec = promisify(execFile);
const option = name => process.argv.find(v => v.startsWith('--' + name + '='))?.slice(name.length + 3);
const project = fileURLToPath(new URL('../', import.meta.url));
const packaged = option('packaged') ?? option('executable-path');
const hold = Number(option('hold') ?? 90);
assert.ok(Number.isInteger(hold) && hold >= 0 && hold <= 300, '--hold must be 0..300 seconds');
const scratch = process.env.TMPDIR;
assert.ok(scratch && path.isAbsolute(scratch) && scratch.replaceAll('\\', '/').toLowerCase().includes('/hermes/cache/scratch'), 'TMPDIR must be absolute Hermes cache/scratch');
const java = process.env.SEEDHOST_SMOKE_JAVA;
assert.ok(java && path.isAbsolute(java) && /^java(?:\.exe)?$/i.test(path.basename(java)), 'Set SEEDHOST_SMOKE_JAVA to an absolute LOCAL java executable');
assert.equal(process.env.SEEDHOST_GROUP_QA_APPROVE_JAVA, 'true', 'Explicit local synthetic Java/JAR approval required: SEEDHOST_GROUP_QA_APPROVE_JAVA=true');
const javaReal = await realpath(java);
assert.ok((await stat(javaReal)).isFile());
const jdkBin = path.dirname(javaReal);
const javac = path.join(jdkBin, process.platform === 'win32' ? 'javac.exe' : 'javac');
const jarTool = path.join(jdkBin, process.platform === 'win32' ? 'jar.exe' : 'jar');
for (const tool of [javac, jarTool]) assert.ok((await stat(tool).catch(() => null))?.isFile(), 'BLOCKER: approved Java needs local JDK javac and jar siblings: ' + tool);
const root = await mkdtemp(path.join(scratch, 'seedhost-real-group-start-'));
console.log('ARTIFACT_DIR=' + root);
// Keep Windows safety helpers reachable while selecting only the approved Java.
const fixturePath = process.platform === 'win32'
  ? [jdkBin, path.join(process.env.SystemRoot, 'System32'), path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(path.delimiter)
  : jdkBin;
const env = { ...process.env, TMP: root, TEMP: root, TMPDIR: root, SEEDHOST_TEST_LOOPBACK: '1', SEEDHOST_GROUP_QA_ROOT: root, JAVA_HOME: path.dirname(jdkBin), PATH: fixturePath };
for (const key of ['ELECTRON_RUN_AS_NODE', 'SEEDHOST_ACCOUNT_SERVICE', 'SEEDHOST_UPDATE_ORIGIN', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH']) delete env[key];
const apps = [], errors = [], evidence = [];
let service, passed = false;
const pause = ms => new Promise(r => setTimeout(r, ms));
const call = (page, method, payload) => page.evaluate(({ method, payload }) => window.seedhost.call(method, payload), { method, payload });
const state = instance => call(instance.page, 'getState');
async function until(check, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() >= end) throw Error(label); await pause(150); }
}
async function idle(instance) {
  await until(async () => !(await state(instance)).busy, instance.name + ' backend busy timeout');
  await instance.page.waitForFunction(() => document.querySelector('#activity-message')?.textContent.startsWith('Ready'), undefined, { timeout: 60000 });
}
async function click(instance, selector) {
  await instance.page.bringToFront();
  await instance.page.locator(selector).click();
}
async function shot(instance, name) {
  await instance.page.bringToFront();
  await instance.page.screenshot({ path: path.join(root, name + '.png'), animations: 'disabled' });
}
async function step(text) { evidence.push(text); console.log('STEP ' + evidence.length + ' ' + text); }
async function workspace(instance) { await idle(instance); await openSelectedServer(instance.page); }
async function friends(instance) { await click(instance, '#home-tab'); await click(instance, '#friends-tab'); }
async function startBound(instance) {
  await workspace(instance); await reveal(instance.page, '#start-server');
  await instance.page.locator('#start-server').waitFor({ state: 'visible' });
  await until(() => instance.page.locator('#start-server').isEnabled(), 'Bound group Start must be enabled');
  await click(instance, '#start-server');
}
async function running(instance) {
  await until(async () => (await state(instance)).server?.state === 'running', instance.name + ' did not run'); await idle(instance);
  assert.ok((await state(instance)).logs.some(line => line.includes('Done (group Java fixture)')), 'Readiness must come from actual Java stdout');
}
async function stop(instance) {
  // Use the real exposed settings API to exercise the legacy false setting on
  // EVERY host; modern pending enrollment defaults parkOnStop to true.
  const pin = (await state(instance)).relay.fingerprint;
  await call(instance.page, 'saveRelay', { fingerprint: pin, parkOnStop: false });
  await idle(instance);
  assert.equal((await state(instance)).relay.parkOnStop, false);
  await workspace(instance); await reveal(instance.page, '#stop-server'); await click(instance, '#stop-server');
  await until(async () => { const s = await state(instance); return !s.busy && s.server?.state === 'offline' && s.server.ownership?.state === 'transferred'; }, instance.name + ' Stop failed to publish final snapshot');
  await idle(instance);
  assert.equal((await state(instance)).relay.parkOnStop, false, 'Legacy optional-publication setting remains false; group Stop overrides it');
  const custody = await call(instance.page, 'checkRelay');
  assert.equal(custody.state, 'owned', 'Stop must return safely stopped custody to group');
  assert.equal(custody.owner, (await state(instance)).relay.fingerprint, 'Published snapshot must be owned by the pinned group authority');
  assert.equal(custody.snapshotId, (await state(instance)).server.snapshotId, 'Group must hold the exact final published snapshot');
}
async function spawnLines() {
  return (await readFile(path.join(root, 'spawn-ledger.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).trim().split('\n').filter(Boolean);
}
async function launch(name) {
  const profile = path.join(root, name); await mkdir(profile);
  await writeFile(path.join(profile, 'account-service.json'), JSON.stringify({ ...service.endpoint, fingerprint: service.identity.fingerprint }));
  const app = await _electron.launch({ ...desktopArtifactLaunch(project, profile, packaged), env, timeout: 30000 });
  const instance = { app, profile, name, page: null }; apps.push(instance); // retain handles even if firstWindow fails
  const page = instance.page = await app.firstWindow(); page.setDefaultTimeout(25000);
  page.on('pageerror', error => errors.push({ name, message: error.message })); await page.bringToFront();
  await page.waitForFunction(() => document.querySelector('#splash')?.hidden);
  await app.evaluate(({ dialog }) => {
    globalThis.__groupQaPick = null; globalThis.__groupQaDialogs = [];
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1); globalThis.__groupQaDialogs.push({ type: 'open', title: options.title });
      if (!/stopped Minecraft Java server/.test(options.title)) throw Error('Unexpected native picker: ' + options.title);
      return { canceled: !globalThis.__groupQaPick, filePaths: globalThis.__groupQaPick ? [globalThis.__groupQaPick] : [] };
    };
    dialog.showMessageBox = async (...args) => { globalThis.__groupQaDialogs.push({ type: 'message', message: args.at(-1).message }); throw Error('Unexpected native confirmation in group Start/Stop'); };
  });
  await page.waitForFunction(() => document.querySelector('#account-dialog')?.open);
  await click(instance, '#account-offline'); await dismissInitialSetup(page); await idle(instance);
  // Disposable credentials go directly to the REAL local directory via sandbox IPC.
  await call(page, 'accountRegister', { username: name, password: randomBytes(24).toString('hex') });
  await page.evaluate(() => window.dispatchEvent(new Event('seedhost-account-changed')));
  await friends(instance); await page.waitForFunction(() => document.querySelector('#account-heading').textContent.startsWith('@'));
  const runtimes = await call(page, 'discoverJava');
  assert.equal(runtimes.length, 1, 'Serverless Start requires precisely one approved LOCAL Java runtime; fixture PATH/JAVA_HOME deliberately select one');
  assert.equal((await realpath(runtimes[0].executable)).toLowerCase(), javaReal.toLowerCase());
  if (packaged) {
    const expected = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')).version;
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), expected, 'Artifact must match current source version; parent must additionally verify build freshness');
    assert.equal((await state(instance)).version, expected);
  }
  return instance;
}
async function pendingButton(instance, pin) {
  await friends(instance);
  const selector = `[data-hosting-group="${pin}"] .button`;
  await instance.page.locator(selector).waitFor({ state: 'visible' });
  assert.equal(await instance.page.locator(selector).innerText(), 'Start server');
  await until(() => instance.page.locator(selector).isEnabled(), 'Pending group Start disabled');
  return selector;
}
async function joinPending(owner, member, pin) {
  const invite = await call(owner.page, 'createInvite');
  await call(member.page, 'joinWithInvite', { code: invite.code, name: member.name });
  await idle(member);
  await member.page.evaluate(() => window.dispatchEvent(new Event('seedhost-account-changed')));
  const joined = await state(member);
  assert.equal(joined.server, null); assert.equal(joined.servers.length, 0);
  assert.ok(joined.pendingGroups.some(g => g.fingerprint === pin));
  await pendingButton(member, pin);
}
const paths = ['server.jar', 'eula.txt', 'server.properties', 'world/level.dat', 'world/region/r.0.0.mca', 'mods/example.jar', 'config/example.toml', 'world/final-save.bin'];
async function bytes(instance) {
  const dir = (await state(instance)).server.serverDir;
  return Object.fromEntries(await Promise.all(paths.map(async name => [name, (await readFile(path.join(dir, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; }))?.toString('hex') ?? null])));
}
async function absent(instance, name) { await assert.rejects(readFile(path.join((await state(instance)).server.serverDir, name)), { code: 'ENOENT' }); }
async function edit(instance, revision) {
  const dir = (await state(instance)).server.serverDir;
  for (const [name, value] of [['world/level.dat', `level-${revision}\u0000bytes`], ['world/region/r.0.0.mca', `region-${revision}\u0001bytes`], ['mods/example.jar', `synthetic-mod-${revision}`], ['config/example.toml', `setting="${revision}"\n`], ['server.properties', `motd=fixture-${revision}\nserver-port=25565\n`]]) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true }); await writeFile(path.join(dir, name), value);
  }
}
async function refuse(instance, selector, holder, pin) {
  const before = await state(holder), count = (await spawnLines()).length;
  await click(instance, selector);
  await until(async () => {
    const text = await instance.page.locator('#error-text').innerText();
    return /hosting|checked out|unknown|Stop the server/i.test(text) && !(await state(instance)).busy;
  }, 'Start must refuse a live holder visibly');
  const after = await state(holder);
  assert.equal(after.server.state, 'running'); assert.equal(after.server.snapshotId, before.server.snapshotId);
  assert.deepEqual(after.server.ownership, before.server.ownership);
  assert.equal((await spawnLines()).length, count, 'Refused Start must not spawn');
  await shot(instance, instance.name + '-refused-' + count);
  assert.ok((await call(instance.page, 'listHostingGroups')).some(group => group.fingerprint === pin));
}
async function bounded(operation, timeout, label) {
  let timer;
  try { return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), timeout); })]); }
  finally { clearTimeout(timer); }
}
try {
  await step('Validate approved local JDK and compile a narrow real Java server.jar fixture (no network, shell launch or production bypass)');
  const version = await exec(javaReal, ['-version'], { env, timeout: 5000, windowsHide: true });
  assert.match(version.stderr + version.stdout, /(?:openjdk|java)(?: version)? ["']?(?:17|18|19|2\d|[3-9]\d)(?:[. "'+-])/);
  const build = path.join(root, 'fixture-build'); await mkdir(build);
  const javaSource = `import java.nio.file.*; import java.nio.charset.StandardCharsets; import java.io.*;
public class GroupFixture {
  public static void main(String[] args) throws Exception {
    Path root=Path.of(System.getenv("SEEDHOST_GROUP_QA_ROOT")).toRealPath();
    Path cwd=Path.of("").toRealPath();
    if(!cwd.startsWith(root) || cwd.equals(root)) throw new SecurityException("Scratch-only fixture");
    long pid=ProcessHandle.current().pid();
    Files.writeString(root.resolve("spawn-ledger.txt"),pid+"|"+cwd+"\\n",StandardCharsets.UTF_8,StandardOpenOption.CREATE,StandardOpenOption.APPEND);
    // This is deliberately not a Minecraft port listener or mod loader.
    System.out.println("Done (group Java fixture)! Synthetic readiness; not Minecraft."); System.out.flush();
    BufferedReader input=new BufferedReader(new InputStreamReader(System.in,StandardCharsets.UTF_8));
    String line; while((line=input.readLine())!=null) { if(line.equals("stop")) {
      Path out=cwd.resolve("world/final-save.bin"); Files.createDirectories(out.getParent());
      Files.writeString(out,"SAVED:"+Files.readString(cwd.resolve("config/example.toml")),StandardCharsets.UTF_8);
      System.out.println("Fixture final save completed"); System.out.flush(); return;
    }}
    throw new IOException("Unclean stdin close; no final-save proof");
  }
}\n`;
  await writeFile(path.join(build, 'GroupFixture.java'), javaSource);
  await exec(javac, ['--release', '17', '-d', build, path.join(build, 'GroupFixture.java')], { env, timeout: 30000, windowsHide: true });
  const source = path.join(root, 'source-stopped-synthetic-not-minecraft'); await mkdir(source);
  await exec(jarTool, ['--create', '--file', path.join(source, 'server.jar'), '--main-class', 'GroupFixture', '-C', build, 'GroupFixture.class'], { env, timeout: 30000, windowsHide: true });
  assert.equal((await readdir(source)).join(','), 'server.jar');
  await writeFile(path.join(source, 'eula.txt'), 'eula=true\n');
  await writeFile(path.join(source, 'deleted-before-bootstrap.bin'), 'old import-only byte');
  await mkdir(path.join(source, 'world')); await writeFile(path.join(source, 'world/level.dat'), 'original source');
  const sourceJar = await readFile(path.join(source, 'server.jar'));
  console.log('FIXTURE_JAR_SHA256=' + createHash('sha256').update(sourceJar).digest('hex'));
  const { AccountService } = await import(pathToFileURL(path.join(project, 'dist/src/core/accounts.js')));
  const { createIdentity } = await import(pathToFileURL(path.join(project, 'dist/src/core/peer-transport.js')));
  service = new AccountService(path.join(root, 'directory'), await createIdentity());
  await service.listen({ host: '127.0.0.1', port: 0 }); assert.equal(service.endpoint.host, '127.0.0.1');
  await step('Launch visible isolated owner A and serverless member B; pinned loopback account directory');
  const a = await launch('groupqa_owner'), b = await launch('groupqa_member');
  await a.app.evaluate((_electron, pick) => { globalThis.__groupQaPick = pick; }, source);
  await click(a, '#home-tab'); await click(a, '#import-server');
  await until(async () => Boolean((await state(a)).server), 'Owner import failed'); await idle(a); await workspace(a);
  await reveal(a.page, '#java-executable');
  if (!await a.page.locator('#profile-details').evaluate(e => e.open)) await click(a, '#profile-details > summary');
  await a.page.locator('#java-executable').fill(javaReal);
  await a.page.locator('#java-args').fill(JSON.stringify(['-Xms32M', '-Xmx128M', '-jar', 'server.jar', 'nogui']));
  await click(a, '#save-profile'); await idle(a);
  assert.equal((await state(a)).server.profile.executable, javaReal);
  await click(a, '#peers-tab'); await click(a, '#hosting-start-group');
  await until(async () => Boolean((await state(a)).relay), 'Real owner group creation failed'); await idle(a);
  const pin = (await state(a)).relay.fingerprint;
  assert.equal((await state(a)).relay.parkOnStop, false);
  const role = await call(a.page, 'alwaysOnStatus'); assert.equal(role.enabled, false); assert.equal(role.gamePort, null);
  const route = await call(a.page, 'getHostingControlRoute', { fingerprint: pin }); assert.equal(route.listener.host, '127.0.0.1');
  await joinPending(a, b, pin);
  assert.equal((await state(a)).server.ownership.state, 'owned', 'Enrollment must not publish/transfer owner bytes');
  await shot(b, '01-serverless-pending-visible-start');
  await step('Edit stopped A AFTER enrollment; visible B Start bootstraps latest world/mod/config and deletion, using local Java');
  await edit(a, 'A-latest-after-enrollment');
  const aDir = (await state(a)).server.serverDir;
  await rm(path.join(aDir, 'deleted-before-bootstrap.bin'));
  await writeFile(path.join(aDir, 'deleted-by-B.bin'), 'old A retain only in conflict copy');
  const initial = await bytes(a);
  await click(b, await pendingButton(b, pin)); await running(b);
  assert.equal((await state(b)).pendingGroups.length, 0); assert.equal((await state(b)).servers.length, 1);
  assert.deepEqual(await bytes(b), initial); await absent(b, 'deleted-before-bootstrap.bin');
  assert.equal((await state(a)).server.ownership.state, 'transferred');
  assert.equal((await spawnLines()).length, 1); await shot(b, '02-b-running-latest-complete');
  await step('Active B refuses second-host A Start, with no snapshot/stop/spawn side effect');
  await workspace(a); await reveal(a.page, '#start-server'); await refuse(a, '#start-server', b, pin);
  await step('Edit B while synthetic host runs; mandatory visible Stop saves final byte BEFORE publication despite parkOnStop=false');
  await edit(b, 'B-latest-before-stop'); await rm(path.join((await state(b)).server.serverDir, 'deleted-by-B.bin'));
  await stop(b);
  const expectedB = await bytes(b);
  assert.equal(Buffer.from(expectedB['world/final-save.bin'], 'hex').toString(), 'SAVED:setting="B-latest-before-stop"\n');
  await shot(b, '03-b-stopped-final-published');
  await step('Visible A Start reacquires exact B bytes/deletion; active OWNER A refuses stale member B Start');
  await startBound(a); await running(a); assert.deepEqual(await bytes(a), expectedB); await absent(a, 'deleted-by-B.bin');
  assert.equal(await readFile(path.join(aDir, 'deleted-by-B.bin'), 'utf8'), 'old A retain only in conflict copy');
  await workspace(b); await reveal(b.page, '#start-server'); await refuse(b, '#start-server', a, pin);
  await shot(a, '04-a-running-exact-b-final-save'); await stop(a);
  await step('Concurrent real B/C Starts through visible controls: exactly one live winner and zero loser spawn (no timing monkeypatch)');
  const c = await launch('groupqa_contender'); await joinPending(a, c, pin);
  const cSelector = await pendingButton(c, pin); await workspace(b); await reveal(b.page, '#start-server');
  const baseline = (await spawnLines()).length;
  // Real clicks may serialize at OS focus delivery; no assertion of deterministic
  // reservation-window overlap. This still exercises competing asynchronous Starts.
  await Promise.all([click(b, '#start-server'), click(c, cSelector)]);
  await until(async () => {
    const states = await Promise.all([state(b), state(c)]);
    return states.every(s => !s.busy) && states.filter(s => s.server?.state === 'running').length === 1;
  }, 'Competing Starts did not produce exactly one running host');
  const competitors = await Promise.all([state(b), state(c)]);
  const winner = competitors[0].server?.state === 'running' ? b : c;
  const loser = winner === b ? c : b;
  assert.equal((await spawnLines()).length, baseline + 1, 'Exactly one Java spawn admitted in competing Start');
  assert.notEqual((await state(loser)).server?.state, 'running');
  if (loser === c) { assert.equal((await state(c)).server, null); assert.equal((await state(c)).servers.length, 0); }
  await running(winner); assert.deepEqual(await bytes(winner), expectedB);
  await shot(winner, '05-competing-start-winner'); await shot(loser, '06-competing-start-loser'); await stop(winner);
  await step('Final A acquisition confirms latest complete bytes, then mandatory Stop and visible final inspection');
  await startBound(a); await running(a); assert.deepEqual(await bytes(a), expectedB); await absent(a, 'deleted-by-B.bin'); await stop(a);
  assert.deepEqual(await bytes(a), expectedB);
  assert.equal(await readFile(path.join(source, 'world/level.dat'), 'utf8'), 'original source');
  assert.deepEqual(await readFile(path.join(source, 'server.jar')), sourceJar);
  assert.equal(await readFile(path.join(source, 'deleted-before-bootstrap.bin'), 'utf8'), 'old import-only byte');
  for (const instance of apps) assert.ok((await instance.app.evaluate(() => globalThis.__groupQaDialogs)).every(d => d.type === 'open'), 'Only import-native picker should appear');
  assert.deepEqual(errors, []); await shot(a, '07-final-a-stopped-published');
  for (let remaining = hold; remaining > 0; remaining -= Math.min(15, remaining)) { console.log('VISIBLE HOLD ' + remaining + 's'); await pause(Math.min(15, remaining) * 1000); }
  assert.equal((await state(a)).server.state, 'offline');
  passed = true;
  await writeFile(path.join(root, 'result.json'), JSON.stringify({ passed, packaged: packaged ?? null, root, hold, java: javaReal, jarSha256: createHash('sha256').update(sourceJar).digest('hex'), evidence, spawnLedger: await spawnLines(), raceWinner: winner.name, errors, boundary: 'Synthetic real Java process and file bytes, real Electron and pinned loopback TLS; NOT Minecraft save/gameplay, WAN or provider proof; no deterministic reservation-window timing gate' }, null, 2));
  console.log('PASS REAL ELECTRON one-click group Start/Stop; A -> B -> A exact latest fixture bytes/deletions, final-stop-save publication, active owner/member refusals and single-spawn competition. NOT Minecraft save proof.');
} catch (error) {
  console.error('FAIL', error); process.exitCode = 1;
  for (const instance of apps) if (instance.page && !instance.page.isClosed()) {
    console.error(instance.name + ' STATE', await state(instance).then(s => ({ busy: s.busy, serverState: s.server?.state, ownership: s.server?.ownership?.state, pending: s.pendingGroups.length })).catch(() => null));
    console.error(instance.name + ' BANNER', await instance.page.locator('#error-text').innerText().catch(() => null));
    await shot(instance, instance.name + '-failure').catch(() => {});
  }
  await writeFile(path.join(root, 'failure.json'), JSON.stringify({ passed: false, error: String(error.stack ?? error), evidence, errors }, null, 2)).catch(() => {});
} finally {
  // Never enumerate/kill unrelated Seed Hosting or Java processes. Close only
  // handles retained from our launches; app.exit is bounded and is NOT safe-save proof.
  for (const instance of [...apps].reverse()) {
    console.log('CLEANUP ' + instance.name + ' pid=' + instance.app.process()?.pid);
    if (instance.page && !instance.page.isClosed()) {
      const s = await bounded(() => state(instance), 3000, 'Cleanup state timeout').catch(() => null);
      if (!s?.busy && ['running', 'starting'].includes(s?.server?.state)) await bounded(() => call(instance.page, 'stopServer'), 35000, 'Cleanup Stop timeout').catch(error => console.error('CLEANUP Stop:', error.message));
    }
    await bounded(() => instance.app.close(), 15000, 'App close timeout').catch(async error => {
      console.error('CLEANUP bounded fallback:', error.message);
      await bounded(() => instance.app.evaluate(({ app }) => app.exit(1)), 3000, 'App exit timeout').catch(() => {});
      const child = instance.app.process(); if (child && child.exitCode === null) child.kill();
    });
  }
  if (service) await bounded(() => service.close(), 5000, 'Directory close timeout').catch(error => { console.error(error.message); process.exitCode = 1; });
  console.log('CLEANUP complete; disposable profiles/evidence retained for inspection');
  console.log('ARTIFACT_DIR=' + root); console.log('RESULT=' + passed);
}
