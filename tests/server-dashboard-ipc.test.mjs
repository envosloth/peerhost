import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateCall } from '../dist/src/core/ipc-policy.js';
const url = 'file:///seedhost/index.html';
const context = { senderId: 1, expectedSenderId: 1, isMainFrame: true };
const id = 'a'.repeat(32), scheduleId = 'b'.repeat(32), hash = 'c'.repeat(64);
const invoke = (method, payload) => validateCall(method, payload, url, url, context);
const calls = [
  ['getServerDashboard', { id }],
  ['listServerFiles', { id, path: '' }],
  ['readServerFile', { id, path: 'server.properties' }],
  ['writeServerFile', { id, path: 'server.properties', text: 'motd=Saved\n', expectedHash: hash }],
  ['saveServerSettings', { id, settings: { 'max-players': 10, pvp: true } }],
  ['saveServerSchedule', { id, schedule: { name: 'Backup', action: 'backup', intervalMinutes: 30, enabled: true } }],
  ['deleteServerSchedule', { id, scheduleId }],
  ['runServerSchedule', { id, scheduleId }],
  ['managePlayer', { id, action: 'kick', name: 'TestPlayer' }],
];
async function mainHarness(backend, confirm) {
  const source = await readFile(new URL('../dist/apps/desktop/main.js', import.meta.url), 'utf8');
  const start = source.indexOf("ipcMain.handle('seedhost:call',");
  const end = source.indexOf('tray = new Tray(', start);
  assert.ok(start >= 0 && end > start, 'real main IPC registration is present');
  const mainFrame = { url }, window = { webContents: { id: 1, mainFrame } };
  let handler;
  new Function('ipcMain', 'validateCall', 'backend', 'confirm', 'window', 'rendererUrl', source.slice(start, end))
    ({ handle(_channel, callback) { handler = callback; } }, validateCall, backend, confirm, window, url);
  return (method, payload) => handler({ sender: { id: 1 }, senderFrame: mainFrame }, method, payload);
}
test('explicit dashboard actions route exact validated payloads without a second warning popup', async () => {
  const invoked = [];
  const backend = new Proxy({ getState: async () => ({ server: { id, name: 'QA world' } }) }, { get(target, key) { return target[key] || (async (...args) => { invoked.push({ key, args }); return 'accepted'; }); } });
  const accepted = await mainHarness(backend, async () => { throw Error('Routine actions never show a warning popup'); });
  for (const [method, payload] of calls.slice(3)) await accepted(method, payload);
  assert.deepEqual(invoked, [
    {key:'writeServerFile',args:[id,'server.properties','motd=Saved\n',hash]},
    {key:'saveServerSettings',args:[id,{'max-players':'10',pvp:'true'}]},
    {key:'saveServerSchedule',args:[id,{name:'Backup',action:'backup',intervalMinutes:30,enabled:true}]},
    {key:'deleteServerSchedule',args:[id,scheduleId]},
    {key:'runServerSchedule',args:[id,scheduleId]},
    {key:'managePlayer',args:[id,'kick','TestPlayer']},
  ]);
  invoked.length=0;
  await accepted('writeServerFile', { id, path: 'note.txt', text: 'Saved text', expectedHash: hash });
  assert.deepEqual(invoked, [{ key: 'writeServerFile', args: [id, 'note.txt', 'Saved text', hash] }]);
});

test('dashboard IPC methods have a validated trusted path through the preload', async () => {
  const source = await readFile(new URL('../apps/desktop/preload.cts', import.meta.url), 'utf8');
  for (const [method, payload] of calls) {
    const result = invoke(method, payload);
    assert.equal(result.id, id, method);
    assert.ok(source.includes("'" + method + "'"), method + ' is missing in sandbox bridge');
    assert.throws(() => validateCall(method, payload, url, url, { ...context, isMainFrame: false }), /untrusted/i);
    assert.throws(() => invoke(method, { ...payload, id: '../wrong' }), /invalid|server/i);
    assert.throws(() => invoke(method, { ...payload, unexpected: true }), /invalid/i);
  }
});
test('dashboard IPC rejects unsafe paths, binary text, privilege escalation and multiline commands', () => {
  for (const filename of ['../state.json', 'C:/outside.txt', 'logs/../../identity.json', 'logs\\latest.log', '/absolute', 'a:alternate-stream', 'CON']) {
    assert.throws(() => invoke('readServerFile', { id, path: filename }), /unsafe|invalid|reserved/i);
    assert.throws(() => invoke('listServerFiles', { id, path: filename }), /unsafe|invalid|reserved/i);
  }
  assert.throws(() => invoke('writeServerFile', { id, path: 'server.jar', text: 'evil', expectedHash: hash }), /read-only/i);
  assert.throws(() => invoke('writeServerFile', { id, path: 'note.txt', text: '\0', expectedHash: hash }), /text/i);
  assert.throws(() => invoke('saveServerSettings', { id, settings: { 'online-mode': false } }), /invalid|supported/i);
  assert.throws(() => invoke('saveServerSchedule', { id, schedule: { name: 'Start', action: 'start', intervalMinutes: 1, enabled: true } }), /invalid/i);
  assert.throws(() => invoke('saveServerSchedule', { id, schedule: { name: 'Command', action: 'command', command: 'say hi\nstop', intervalMinutes: 1, enabled: true } }), /invalid/i);
  assert.throws(() => invoke('managePlayer', { id, action: 'op', name: 'TestPlayer' }), /invalid/i);
  assert.throws(() => invoke('managePlayer', { id, action: 'kick', name: 'Player\nstop' }), /invalid/i);
});
