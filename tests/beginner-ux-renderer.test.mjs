import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { openSelectedServer } from '../tools/desktop-test-setup.mjs';

// Beginner-UX renderer contract with a TEST-ONLY bridge. Not backend or Minecraft verification.
let browser;
before(async () => { browser = await chromium.launch({ executablePath: existsSync(chromium.executablePath()) ? chromium.executablePath() : '/usr/bin/chromium', headless: false }); });
after(async () => { await browser?.close(); });
const progress = (step = 'server') => ({ version: 1, step, dismissed: false, completed: false, skipped: [], draft: { name: 'My Minecraft server', loader: 'vanilla', gameVersion: '', memoryMiB: 2048 }, error: null });
const versions = Array.from({ length: 15 }, (_, i) => ({ id: `1.21.${15 - i}` }));
function appState(server = null, extra = {}) { return { version: 'test', deviceId: 'a'.repeat(64), server, servers: server ? [{ id: server.id, name: server.name, active: true, state: server.state, configured: true }] : [], peers: [], logs: [], settings: {}, relay: null, onboarding: progress(), gateway: { enabled: false, localPort: 25565, state: 'off', detail: '' }, lanAddresses: ['192.168.1.20'], ...extra }; }
function server() { return { id: 'beginner-fixture', name: 'Weekend world', state: 'offline', serverDir: '/fixture/server', storeDir: '/fixture/store', snapshotId: 's1', ownership: { state: 'owned', owner: 'a'.repeat(64) }, profile: { executable: '/fixture/java21', args: ['-Xmx2048M', '-jar', 'server.jar', 'nogui'] }, mods: { server: [], client: [] } }; }
async function renderer(t, state = appState()) {
  const page = await browser.newPage({ viewport: { width: 1240, height: 860 } });
  await page.bringToFront();
  console.log('VISIBLE renderer contract (TEST-ONLY bridge): ' + t.name);
  t.after(async () => {
    if (!page.isClosed() && process.env.TMPDIR) await page.screenshot({ path: process.env.TMPDIR + '/seedhost-beginner-' + t.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 90) + '.png' });
    await page.close();
  });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, [], 'no renderer exceptions'));
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(({ state, versions }) => {
    window.fixture = { state, calls: [] };
    window.seedhost = { call: async (method, payload) => {
      const f = window.fixture; f.calls.push({ method, payload });
      if (method === 'getState') return f.state;
      if (method === 'saveOnboarding') f.state.onboarding = { ...payload, version: 1, error: null };
      if (method === 'listServerVersions') return { latest: versions[0].id, versions };
      if (method === 'discoverJava') return [{ executable: '/fixture/java17', major: 17, version: '17.0.2' }, { executable: '/fixture/java21', major: 21, version: '21.0.4' }];
      if (method === 'checkGameGateway') return f.gatewayCheck ?? { enabled: false, host: null, port: null, ready: false, detail: 'off' };
      if (method === 'listSnapshots') return [{ id: 's1'.padEnd(64, '0'), parentId: null, fileCount: 12, bytes: 5 * 1048576, current: true }];
      return undefined;
    } };
  }, { state, versions });
  await page.goto('file://' + fileURLToPath(new URL('../apps/desktop/index.html', import.meta.url)));
  await page.waitForFunction(() => document.querySelector('#activity-message').textContent.startsWith('Ready'));
  return page;
}
const settled = page => page.waitForFunction(() => document.querySelector('#activity-message').textContent.startsWith('Ready'));

test('Home hides all server sections, including a remembered selection, until its library card is opened', async t => {
  const page = await renderer(t, appState(server(), { onboarding: { ...progress('ready'), dismissed: true } }));
  const names = ['operate', 'console', 'players', 'backups', 'scheduler', 'peers', 'mods', 'tunnels', 'server-settings', 'server-files'];
  for (const reload of [false, true]) {
    if (reload) { await page.reload(); await settled(page); }
    assert.equal(await page.locator('#home-panel').isVisible(), true);
    for (const name of names) assert.equal(await page.locator('#' + name + '-tab').isHidden(), true, name + ' hidden on Home');
    await openSelectedServer(page);
    for (const name of names) assert.equal(await page.locator('#' + name + '-tab').isVisible(), true, name + ' exposed only after Open');
    await page.locator('#home-tab').click();
    for (const name of names) assert.equal(await page.locator('#' + name + '-tab').isHidden(), true, name + ' hidden again on Home');
  }
});

test('first run starts with a plain choice, not a form', async t => {
  const page = await renderer(t);
  await page.waitForFunction(() => document.querySelector('#setup-dialog').open);
  assert.match(await page.locator('#setup-intro').textContent(), /friends/i, 'explains what the app is for');
  assert.equal(await page.locator('#setup-choose-create').isVisible(), true);
  assert.equal(await page.locator('#setup-import').isVisible(), true);
  assert.equal(await page.locator('#setup-create-form').isVisible(), false, 'no form until a path is chosen');
  assert.equal(await page.locator('#setup-next').isVisible(), false, 'nothing to advance to before a server exists');
  assert.match(await page.locator('[data-setup-step="friends"]').textContent(), /optional/i);
  assert.match(await page.locator('[data-setup-step="gateway"]').textContent(), /optional/i);
});

test('new world form picks sensible defaults: latest release, automatic Java, one memory choice only on the Memory step', async t => {
  const page = await renderer(t);
  await page.locator('#setup-choose-create').click();
  assert.equal(await page.locator('#setup-create-form').isVisible(), true);
  await page.waitForFunction(() => document.querySelector('#setup-version').value === '1.21.15');
  assert.equal(await page.locator('#setup-java').count(), 0, 'Java is automatic, not a choice');
  assert.equal(await page.locator('#setup-memory, #setup-memory-chips').count(), 0, 'Create no longer duplicates the memory choice');
  assert.match(await page.locator('#setup-create-form').textContent(), /Starts with 2 GB of memory.*Memory step/s);
  assert.ok(await page.locator('#setup-version option').count() <= 11, 'only recent releases by default');
  await page.locator('#setup-all-versions').check();
  assert.equal(await page.locator('#setup-version option').count(), 16, 'every release on request');
  assert.equal(await page.locator('#setup-version').inputValue(), '1.21.15', 'toggling keeps the selection');
});

test('stepper shows completed stages and Ready summarises what was set up', async t => {
  const page = await renderer(t, appState(server(), { onboarding: progress('ready') }));
  await page.locator('#nav-setup').click();
  assert.equal(await page.locator('[data-setup-step="server"]').getAttribute('data-done'), 'true');
  assert.equal(await page.locator('[data-setup-step="friends"]').getAttribute('data-done'), 'false');
  const summary = await page.locator('#setup-ready-list').textContent();
  assert.match(summary, /Weekend world/);
  assert.match(summary, /2 GB/);
  assert.match(await page.locator('#setup-ready').textContent(), /localhost/);
  assert.equal(await page.locator('#setup-next').textContent(), 'Go to my server');
});

test('always-on PC stage is two big choices, with no terminal or commands anywhere', async t => {
  const page = await renderer(t);
  await page.locator('[data-setup-step="gateway"]').click(); await settled(page);
  assert.equal(await page.locator('#always-on-be').isVisible(), true);
  assert.equal(await page.locator('#always-on-pair').isVisible(), true);
  assert.equal(await page.locator('#setup-gateway-advanced').evaluate(d => d.open), false, 'fine controls are folded away');
  assert.doesNotMatch(await page.locator('#setup-gateway').textContent(), /terminal|Node\.js|seedhost-relay|--host/i);
  assert.match(await page.locator('#setup-skip').textContent(), /skip/i);
});

test('Operate without a server shows a getting-started checklist', async t => {
  const page = await renderer(t);
  await page.locator('#setup-later').click(); await settled(page);
  assert.equal(await page.locator('#getting-started').isVisible(), true);
  assert.equal(await page.locator('#getting-started li').count(), 4);
  assert.equal(await page.locator('#create-server-empty').textContent(), 'create a server');
  assert.equal(await page.locator('#player-gateway').isVisible(), false, 'gateway jargon hidden until used');
  assert.equal(await page.locator('#advanced-peers').evaluate(d => d.open), false, 'fingerprints are advanced');
  assert.equal(await page.locator('#device-fingerprint').isVisible(), false);
  for (const id of ['mods-details', 'profile-details', 'console-section']) assert.equal(await page.locator('#' + id).isVisible(), false, id + ' hidden until a server exists');
});

test('Operate with a server uses plain words and explains how to join', async t => {
  const page = await renderer(t, appState(server(), { onboarding: { ...progress('ready'), dismissed: true } }));
  await openSelectedServer(page);
  assert.equal(await page.getByRole('button', { name: 'Start server', exact: true }).count(), 1);
  await page.locator('#backups-tab').click();
  assert.equal(await page.getByRole('button', { name: 'Save backup', exact: true }).count(), 1);
  assert.equal(await page.locator('#snapshot-history-title').textContent(), 'Backups');
  assert.equal(await page.locator('#server-details').evaluate(d => d.open), false, 'paths and IDs are folded away');
  assert.equal(await page.locator('#server-directory').isVisible(), false);
  const join = await page.locator('#join-help').textContent();
  assert.match(join, /localhost/);
  assert.match(join, /192\.168\.1\.20:25565/);
  await page.waitForFunction(() => document.querySelectorAll('#snapshot-list li').length === 1);
  assert.match(await page.locator('#snapshot-list').textContent(), /5\.0 MB/);
});

test('join help shows the always-on PC player address once the tunnel is ready', async t => {
  const running = server(); running.state = 'running'; running.ownership.state = 'hosting';
  const state = appState(running, { relay: { fingerprint: 'c'.repeat(64), name: 'Home relay', parkOnStop: true }, gateway: { enabled: true, localPort: 25565, state: 'ready', detail: 'Pinned host tunnel is ready' }, onboarding: { ...progress('ready'), dismissed: true } });
  const page = await renderer(t, state);
  await page.evaluate(() => { window.fixture.gatewayCheck = { enabled: true, host: '100.97.20.84', port: 25565, ready: true, detail: 'Confirmed host route' }; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => document.querySelector('#join-help').textContent.includes('100.97.20.84:25565'), undefined, { timeout: 8000 });
  assert.match(await page.locator('#join-help').textContent(), /always-on PC/i);
});

test('first gateway start explains the one-time hand-off in plain words', async t => {
  const running = server(); running.state = 'running'; running.ownership.state = 'hosting';
  const state = appState(running, { relay: { fingerprint: 'c'.repeat(64), name: 'Home relay', parkOnStop: true }, gateway: { enabled: true, localPort: 25565, state: 'error', detail: 'Park and Claim once to establish confirmed relay custody before forwarding' }, onboarding: { ...progress('ready'), dismissed: true } });
  const page = await renderer(t, state);
  const text = await page.locator('#player-gateway').textContent();
  assert.doesNotMatch(text, /Park and Claim|custody/);
  assert.match(text, /Stop server/);
  assert.match(text, /Take over hosting/);
});

for (const scenario of ['other group result','round trip result','same pin new endpoint','old error','newer request wins','cached status cleared'])
  test('relay check rejects stale context: ' + scenario, async t => {
    const relay={fingerprint:'c'.repeat(64),name:'Group A',parkOnStop:true};
    const peer={...relay,host:'127.0.0.1',port:8443};
    const page=await renderer(t,appState(server(),{relay,peers:[peer],onboarding:{...progress('ready'),dismissed:true}}));
    await openSelectedServer(page);await page.locator('#peers-tab').click();
    await page.evaluate(()=>{
      const call=window.seedhost.call;window.fixture.relayRequests=[];
      window.seedhost.call=async(method,payload)=>{
        if(method==='checkRelay')return new Promise((resolve,reject)=>window.fixture.relayRequests.push({resolve,reject}));
        return call(method,payload);
      };
    });
    const finish=async(index,error=false)=>{
      await page.evaluate(({index,error})=>{
        const request=window.fixture.relayRequests[index];
        if(error)request.reject(new Error('OLD GROUP ERROR'));
        else request.resolve({state:'transferred',ownerName:index===0?'OLD GROUP HOLDER':'CURRENT HOLDER'});
      },{index,error});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    };
    const change=async(kind)=>{
      await page.evaluate(kind=>{
        if(kind==='B')window.fixture.state.relay={fingerprint:'d'.repeat(64),name:'Group B',parkOnStop:true};
        if(kind==='A')window.fixture.state.relay={fingerprint:'c'.repeat(64),name:'Group A',parkOnStop:true};
        if(kind==='endpoint')window.fixture.state.peers[0].port=9443;
        document.dispatchEvent(new Event('visibilitychange'));
      },kind);
      await settled(page);
      if(kind!=='endpoint')await page.waitForFunction(name=>document.querySelector('#relay-name').textContent===name,kind==='B'?'Group B':'Group A');
    };
    await page.locator('#check-relay').click();
    await page.waitForFunction(()=>window.fixture.relayRequests.length===1);
    if(scenario==='cached status cleared'){
      await finish(0);assert.match(await page.locator('#relay-holder').textContent(),/OLD GROUP HOLDER/);
      await change('B');assert.equal(await page.locator('#relay-holder').textContent(),'NOT CHECKED');return;
    }
    if(scenario==='newer request wins'){
      await page.locator('#check-relay').click();await page.waitForFunction(()=>window.fixture.relayRequests.length===2);
      await finish(1);
    }else{
      await change(scenario==='same pin new endpoint'?'endpoint':'B');
      if(scenario==='round trip result')await change('A');
    }
    await finish(0,scenario==='old error');
    assert.equal(await page.locator('#relay-holder').textContent(),scenario==='newer request wins'?'WITH CURRENT HOLDER':'NOT CHECKED');
    assert.doesNotMatch(await page.locator('#relay-help').textContent(),/OLD GROUP ERROR/);
  });

test('Friends held custody never claims a stopped foreign holder is hosting', async t => {
  const world=server();world.ownership={state:'transferred',owner:'d'.repeat(64)};
  const page=await renderer(t,appState(world,{relay:{fingerprint:'c'.repeat(64),name:'Group',parkOnStop:true},onboarding:{...progress('ready'),dismissed:true}}));
  await page.evaluate(()=>{
    const call=window.seedhost.call;
    window.seedhost.call=async(method,payload)=>method==='listFriends'?{members:[],custody:'held',holder:'Stopped friend',owner:'d'.repeat(64)}:call(method,payload);
  });
  await page.locator('#friends-tab').click();await page.locator('#refresh-friends').click();
  await page.waitForFunction(()=>document.querySelector('#group-status').textContent==='Members confirmed');
  assert.equal(await page.locator('#friend-holder').textContent(),'World held by Stopped friend · hosting not observed');
});

test('username acceptance rejects a truthy but non-boolean enrollment result', async t => {
  const page=await renderer(t,appState(null,{onboarding:{...progress('ready'),dismissed:true}}));
  await page.evaluate(()=>{
    const call=window.seedhost.call;
    window.seedhost.call=async(method,payload)=>{
      if(method==='accountStatus')return {configured:true,signedIn:true,online:true,username:'local_user',detail:'Signed in'};
      if(method==='accountRequests')return [{id:'request',from:'friend',group:'Group',controlEndpoint:{host:'127.0.0.1',port:8443}}];
      if(method==='accountAccept'){
        window.fixture.state.relay={fingerprint:'c'.repeat(64),name:'Group',parkOnStop:true};
        window.fixture.state.peers=[{fingerprint:'c'.repeat(64),host:'127.0.0.1',port:8443}];
        return {joined:'true',group:'Group'};
      }
      return call(method,payload);
    };window.dispatchEvent(new Event('seedhost-account-changed'));
  });
  await page.locator('#friends-tab').click();
  await page.locator('#account-inbox [data-account-accept]').click();
  await page.waitForFunction(()=>!document.querySelector('#account-refresh').disabled);
  assert.match(await page.locator('#account-friend-feedback').textContent(),/could not be confirmed/i);
  assert.doesNotMatch(await page.locator('#account-friend-feedback').textContent(),/^Joined/);
});

for (const [label, pin, port] of [
  ['missing pins', null, 8443], ['short agreeing pins', 'c', 8443],
  ['uppercase agreeing pins', 'C'.repeat(64), 8443], ['nonhex agreeing pins', 'g'.repeat(64), 8443],
  ['matching string ports', 'c'.repeat(64), '8443'], ['zero ports', 'c'.repeat(64), 0],
  ['overflow ports', 'c'.repeat(64), 65536], ['fractional ports', 'c'.repeat(64), 8443.5],
]) test('username acceptance rejects ' + label + ' in enrollment readback', async t => {
  const page = await renderer(t, appState(null, {onboarding:{...progress('ready'),dismissed:true}}));
  await page.evaluate(({pin,port}) => {
    const call = window.seedhost.call;
    window.seedhost.call = async (method,payload) => {
      if(method==='accountStatus')return {configured:true,signedIn:true,online:true,username:'local_user',detail:'Signed in'};
      if(method==='accountRequests')return [{id:'request',from:'friend',group:'Group',controlEndpoint:{host:'127.0.0.1',port}}];
      if(method==='accountAccept'){
        const fingerprint = pin === null ? {} : {fingerprint:pin};
        window.fixture.state.relay = {...fingerprint,name:'Group',parkOnStop:true};
        window.fixture.state.peers = [{...fingerprint,host:'127.0.0.1',port}];
        return {joined:true,group:'Group'};
      }
      return call(method,payload);
    };window.dispatchEvent(new Event('seedhost-account-changed'));
  },{pin,port});
  await page.locator('#friends-tab').click();
  await page.locator('#account-inbox [data-account-accept]').click();
  await page.waitForFunction(()=>!document.querySelector('#account-refresh').disabled);
  assert.match(await page.locator('#account-friend-feedback').textContent(),/could not be confirmed/i);
  assert.doesNotMatch(await page.locator('#account-friend-feedback').textContent(),/^Joined/);
});

for (const [label,host,group] of [
  ['missing hosts',null,'Group'], ['empty hosts','','Group'], ['numeric hosts',42,'Group'],
  ['missing group', '127.0.0.1',null], ['empty group','127.0.0.1',''], ['numeric group','127.0.0.1',42],
]) test('username acceptance rejects ' + label + ' even when readback agrees', async t => {
  const page=await renderer(t,appState(null,{onboarding:{...progress('ready'),dismissed:true}}));
  await page.evaluate(({host,group})=>{
    const call=window.seedhost.call;
    const route=host===null?{port:8443}:{host,port:8443};
    const name=group===null?{}:{group};
    window.seedhost.call=async(method,payload)=>{
      if(method==='accountStatus')return {configured:true,signedIn:true,online:true,username:'local_user',detail:'Signed in'};
      if(method==='accountRequests')return [{id:'request',from:'friend',...name,controlEndpoint:route}];
      if(method==='accountAccept'){
        window.fixture.state.relay={fingerprint:'c'.repeat(64),...(group===null?{}:{name:group}),parkOnStop:true};
        window.fixture.state.peers=[{fingerprint:'c'.repeat(64),...route}];
        return {joined:true,...name};
      }
      return call(method,payload);
    };window.dispatchEvent(new Event('seedhost-account-changed'));
  },{host,group});
  await page.locator('#friends-tab').click();
  await page.locator('#account-inbox [data-account-accept]').click();
  await page.waitForFunction(()=>!document.querySelector('#account-refresh').disabled);
  assert.match(await page.locator('#account-friend-feedback').textContent(),/could not be confirmed/i);
});

test('username acceptance keeps an existing local world and never suggests receiving it', async t => {
  const world=server();
  const page=await renderer(t,appState(world,{onboarding:{...progress('ready'),dismissed:true}}));
  const relay={fingerprint:'c'.repeat(64),name:'Home relay',host:'100.97.20.84',port:47625};
  await page.evaluate(relay=>{
    const call=window.seedhost.call;let requests=[{id:'fixture-request',from:'friend',group:relay.name,controlEndpoint:{host:relay.host,port:relay.port,privateRoute:true,reachability:'unverified'}}];
    window.seedhost.call=async(method,payload)=>{
      if(method==='accountStatus')return {configured:true,signedIn:true,online:true,username:'local_user',detail:'Signed in'};
      if(method==='accountRequests')return requests;
      if(method==='accountAccept'){
        window.fixture.state.relay={fingerprint:relay.fingerprint,name:relay.name,parkOnStop:true};
        window.fixture.state.peers=[{...relay}];requests=[];return {joined:true,group:relay.name};
      }
      if(method==='listFriends')return {members:[],custody:'unknown',holder:null};
      if(method==='checkRelay')return null;
      return call(method,payload);
    };window.dispatchEvent(new Event('seedhost-account-changed'));
  },relay);
  await page.locator('#friends-tab').click();
  await page.locator('#account-inbox [data-account-accept]').waitFor({state:'visible'});
  assert.match(await page.locator('#account-inbox').textContent(),/@friend/);
  await page.locator('#account-inbox [data-account-accept]').click();
  await page.waitForFunction(()=>document.querySelector('#account-friend-feedback').textContent.startsWith('Joined'));
  const message=await page.locator('#account-friend-feedback').textContent();
  assert.doesNotMatch(message,/receive the world|take over/i);
  assert.match(message,/existing world stays on this PC.*nothing was downloaded or started/i);
  assert.deepEqual(await page.evaluate(()=>window.fixture.state.server),world);
  assert.equal(await page.locator('#friend-code,#invite-code').count(),0);
});
