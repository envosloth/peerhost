import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Renderer/real Chromium DOM tests with a TEST-ONLY bridge. Not backend or Minecraft verification.
let browser;
before(async () => { browser = await chromium.launch({ executablePath: existsSync(chromium.executablePath()) ? chromium.executablePath() : '/usr/bin/chromium', headless: false }); });
after(async () => { await browser?.close(); });
const progress = () => ({ version: 1, step: 'server', dismissed: false, completed: false, skipped: [], draft: { name: 'My server', loader: 'vanilla', gameVersion: '', memoryMiB: 2048 }, error: null });
function appState(server = null) { return { version: 'test', deviceId: 'a'.repeat(64), server, servers:server ? [{id:server.id,name:server.name,active:true,state:server.state,configured:true}] : [], peers: [], logs: [], settings: {}, relay: null, onboarding: progress(), gateway: { enabled: false, localPort: 25565, state: 'off', detail: '' } }; }
function server() { return { id:'a'.repeat(32), name: 'Existing world', state: 'offline', serverDir: '/fixture/server', storeDir: '/fixture/store', snapshotId: 's1', ownership: { state: 'owned', owner: 'a'.repeat(64) }, profile: { executable: '/fixture/java', args: ['@args.txt', 'nogui'] }, mods: { server: [], client: [] } }; }
async function renderer(t, state = appState()) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  t.after(() => page.close());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, [], 'no renderer exceptions'));
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(({ state }) => {
    window.fixture = { state, calls: [], failure: null, snapshots: [{ id: 's1', parentId: null, fileCount: 2, bytes: 32, current: true }, { id: 's0', parentId: null, fileCount: 1, bytes: 16, current: false }] };
    window.seedhost = { call: async (method, payload) => {
      const f = window.fixture; f.calls.push({ method, payload });
      if (f.failure === method) throw Error('Fixture refusal: ' + method);
      if (method === 'getState') return f.state;
      if (method === 'saveOnboarding') {
        const {serverId, ...input}=payload;const saved={...input,version:1,error:null};
        if(serverId===null) {f.state.newServerOnboarding=saved;if(!f.state.server)f.state.onboarding=saved;}
        else f.state.onboarding=saved;
      }
      if (method === 'createServer') return null; // Native Cancel is null, never a successful void result.
      if (method === 'listServerVersions') return { latest: '1.21.1', versions: [{ id: '1.21.1' }, { id: '1.20.1' }] };
      if (method === 'discoverJava') return [{ executable: '/fixture/java', major: 21, version: '21.0.1' }];
      if (method === 'pickJava') return f.pickedJava ?? null;
      if (method === 'listSnapshots') return f.snapshots;
      if (method === 'accountStatus') return f.state.account?.status;
      if (method === 'accountRequests') return f.state.account?.requests ?? [];
      // TEST-ONLY friendship seam: the merged IPC returns arrays; tests may seed state.account.friends.
      if (method === 'accountFriendRequests') return f.state.account?.friendRequests ?? [];
      if (method === 'accountFriends') return f.state.account?.friends ?? [];
      return undefined; // Successful void seam; explicit native cancellations above retain their null contract.
    } };
  }, { state });
  await page.goto('file://' + fileURLToPath(new URL('../apps/desktop/index.html', import.meta.url)));
  await page.waitForFunction(() => document.querySelector('#activity-message').textContent.startsWith('Ready'));
  return page;
}
export { renderer, appState, server, settled };
async function settled(page) { await page.waitForFunction(() => document.querySelector('#activity-message').textContent.startsWith('Ready')); }