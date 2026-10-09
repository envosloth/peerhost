'use strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL('.', import.meta.url));
// Regression fixture: actual dashboard and runAction source with an in-memory DOM/IPC seam.
// Not graphical Electron or live-backend verification; headed tests remain separate.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const { stripTypeScriptTypes } = require('node:module');
const { createHash } = require('node:crypto');
const repo = path.resolve(__dirname, '..');
const dashboardSource = fs.readFileSync(path.join(repo, 'apps/desktop/dashboard.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(repo, 'apps/desktop/renderer.js'), 'utf8');
const runActionSource = rendererSource.slice(rendererSource.indexOf('  async function runAction('), rendererSource.indexOf('  function invalid(', rendererSource.indexOf('  async function runAction(')));
const hash = value => createHash('sha256').update(value).digest('hex');
const A = 'a'.repeat(32), B = 'b'.repeat(32), DEV = 'd'.repeat(64);
function defer() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };

function dom() {
  const ids = new Map(), selectors = new Map();
  class Node {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.dataset = {}; this.children = []; this.listeners = new Map(); this.attributes = new Map();
      this._text = ''; this._html = ''; this.value = ''; this.disabled = false; this.hidden = false; this.checked = false; this.indeterminate = false;
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    set id(value) { this._id = value; ids.set(value, this); } get id() { return this._id || ''; }
    set textContent(value) { this._text = String(value ?? ''); this.children = []; } get textContent() { return this._text + this.children.map(n => n.textContent || '').join(''); }
    append(...nodes) { for (const node of nodes) { if (!node) throw new Error('null DOM append'); if (node.parentElement) node.parentElement.children = node.parentElement.children.filter(x => x !== node); this.children.push(node); node.parentElement = this; } }
    prepend(...nodes) { this.append(...nodes); this.children = [...nodes, ...this.children.filter(x => !nodes.includes(x))]; }
    replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
    before(...nodes) { (this.parentElement || document.root).append(...nodes); }
    after(...nodes) { (this.parentElement || document.root).append(...nodes); }
    setAttribute(key, value) { this.attributes.set(key, String(value)); } getAttribute(key) { return this.attributes.get(key) ?? null; }
    addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(callback); }
    async fire(name, target = this) { const event = { target, preventDefault() {}, key: null }; for (const cb of this.listeners.get(name) || []) await cb(event); await flush(); }
    querySelector(selector) { if (selector.startsWith('#')) return document.getElementById(selector.slice(1)); const key = this.id + ':' + selector; if (!selectors.has(key)) selectors.set(key, new Node(selector === 'h1' ? 'h1' : 'div')); return selectors.get(key); }
    querySelectorAll(selector) { if (this.id === 'schedule-form' && selector === 'input,select,button') return [...ids].filter(([id]) => ['schedule-name','schedule-action','schedule-command','schedule-interval','schedule-enabled','schedule-save','schedule-cancel'].includes(id)).map(([, node]) => node); return []; }
    focus() {} reset() { if (this.id === 'schedule-form') { document.getElementById('schedule-name').value = ''; document.getElementById('schedule-action').value = 'backup'; document.getElementById('schedule-command').value = ''; document.getElementById('schedule-interval').value = '60'; document.getElementById('schedule-enabled').checked = true; } }
    closest(selector) { if (selector === '[data-path]' && this.dataset.path) return this; if (selector === 'button[data-job-action]' && this.dataset.jobAction) return this; if (selector === 'button[data-player]' && this.dataset.player) return this; if (selector === 'button[data-action="open"]' && this.dataset.action === 'open') return this; return null; }
    set innerHTML(html) { this._html = html; for (const match of html.matchAll(/<([a-zA-Z][\w:-]*)\b([^>]*)>/g)) { const attrs = match[2], id = /\bid="([^"]*)"/.exec(attrs)?.[1]; if (!id) continue; const n = new Node(match[1]); n.id = id; n.hidden = /(?:^|\s)hidden(?:\s|$)/.test(attrs); n.checked = /(?:^|\s)checked(?:\s|$)/.test(attrs); n.value = /\bvalue="([^"]*)"/.exec(attrs)?.[1] || ''; if (id === 'schedule-action') n.value = 'backup'; if (id === 'player-action') n.value = 'whitelist-add'; this.append(n); }
      // The only nesting relevant to these probes: file feedback is inside a hidden editor.
      if (html.includes('id="file-edit"') && html.includes('id="file-feedback"')) ids.get('file-edit').append(ids.get('file-feedback'));
    }
    get innerHTML() { return this._html; } insertAdjacentHTML(_where, html) { this.innerHTML = this._html + html; }
  }
  const document = { root: new Node('main'), createElement: tag => new Node(tag), getElementById(id) { if (!ids.has(id)) { const n = new Node(id.endsWith('-form') ? 'form' : id.endsWith('-tab') ? 'button' : 'div'); n.id = id; } return ids.get(id); }, querySelector(selector) { if (!selectors.has(selector)) selectors.set(selector, selector === 'main' ? this.root : new Node()); return selectors.get(selector); } };
  return { document, ids, Node };
}
function state(id = A, running = false, logs = []) {
  return { deviceId: DEV, server: { id, name: id === A ? 'World A' : 'World B', state: running ? 'running' : 'offline', ownership: { owner: DEV, state: running ? 'hosting' : 'owned' }, modInstallError: null }, servers: [{ id: A, active: id === A }, { id: B, active: id === B }], logs, relay: null };
}
function data(id = A) { return { serverId: id, performance: { cpuPercent: null, memoryMiB: null, pid: null, uptimeSeconds: null, sampledAt: null, error: 'Server is not running' }, players: { online: null, max: null, sample: [], error: 'Server is not running' }, settings: { motd: 'World', pvp: 'true', 'max-players': '20' }, settingsError: null, schedules: [], scheduleError: null, logs: [] }; }
async function harness(options = {}) {
  const d = dom(), dashboards = { [A]: data(A), [B]: data(B) }, calls = [];
  // Browser-faithful minimum for page-change notifications: the dashboard dispatches Event('seedhost-page-changed').
  const windowListeners = new Map();
  const ctx = { document: d.document, console, Buffer, Date, Number, JSON, Object, Array, String, Math, Error, RegExp, Set,
    Event: class Event { constructor(type) { this.type = String(type); } },
    window: { addEventListener: (type, fn) => { const list = windowListeners.get(type) || []; list.push(fn); windowListeners.set(type, list); },
      dispatchEvent: event => { for (const fn of windowListeners.get(event.type) || []) fn(event); return true; } } };
  ctx.state = state(options.id || A, Boolean(options.running), []); ctx.bridgeReady = true; ctx.pendingMethod = null; ctx.refreshInFlight = null;
  ctx.$ = id => d.document.getElementById(id); ctx.isBusy = () => Boolean(ctx.pendingMethod || ctx.state.busy);
  ctx.showError = message => { ctx.$('error-text').textContent = message; }; ctx.ACTION_FAILURES = {}; ctx.errorMessage = e => e.message || String(e); ctx.invitationProblem = ctx.errorMessage; ctx.refreshFriends = async () => {};
  ctx.window.seedhost = { call: async (method, payload) => {
    calls.push({ method, payload: structuredClone(payload) });
    if (options.call) { const override = await options.call(method, payload, { ctx, dashboards, calls }); if (override && override.handled) return override.result; }
    if (method === 'getServerDashboard') return structuredClone(dashboards[payload.id]);
    if (method === 'listServerFiles') return { serverId: payload.id, path: payload.path, entries: [] };
    return null;
  } };
  vm.createContext(ctx); vm.runInContext(dashboardSource, ctx, { filename: 'apps/desktop/dashboard.js' });
  ctx.render = () => { const blocked = !ctx.bridgeReady || ctx.isBusy(); ctx.window.seedDashboard.renderServers(ctx.state, blocked); ctx.window.seedDashboard.update(ctx.state, blocked); };
  ctx.refresh = async () => { ctx.render(); return true; };
  vm.runInContext(runActionSource + '\nthis.actualRunAction = runAction;', ctx, { filename: 'apps/desktop/renderer.js:runAction' });
  ctx.window.seedDashboard.bind({ runAction: ctx.actualRunAction, refresh: ctx.refresh, showError: ctx.showError });
  ctx.render(); ctx.window.seedDashboard.selectPage('operate'); await flush();
  const change = async (id, running = false, logs = []) => { ctx.state = state(id, running, logs); ctx.render(); await flush(); };
  const open = async pathValue => { const item = new d.Node('li'); item.dataset.path = pathValue; item.dataset.kind = 'file'; await ctx.$('file-list').fire('click', item); };
  return { ctx, $, ...d, calls, dashboards, change, open, select: page => ctx.window.seedDashboard.selectPage(page) };
  function $(id) { return ctx.$(id); }
}

// Regressions exercise real renderer functions behind an isolated fixture.
test('native managed-folder refusal remains inline without an in-app editor', async () => {
  const h = await harness({ call: async method => { if (method === 'openServerFolder') throw new Error('Unreadable managed folder'); } });
  h.select('server-files'); await h.$('file-open-folder').fire('click');
  assert.match(h.$('file-feedback').textContent, /Unreadable managed folder/);
  assert.equal(h.calls.some(c => c.method === 'listServerFiles'), false);
  assert.equal(h.ids.has('file-editor'), false);
});

test('native null consent must not become a successful runAction result', async () => {
  const h = await harness(); const ok = await h.ctx.actualRunAction('managePlayer', { id: A, action: 'kick', name: 'Alex' });
  console.log('OBSERVED runAction null-cancel return:', ok);
  assert.equal(ok, false, 'main.ts returns null for native Cancel; mutation success must be false');
});

test('cancelled player action must not claim a command was sent', async () => {
  const h = await harness({ running: true }); h.$('player-name').value = 'Alex'; await h.$('player-form').fire('submit');
  console.log('OBSERVED cancelled player feedback:', h.$('player-feedback').textContent);
  assert.doesNotMatch(h.$('player-feedback').textContent, /Command sent/);
});





test('scheduler read-back must accept actual backend trimmed names without an unconfirmed-save error', async () => {
  const ts = fs.readFileSync(path.join(repo, 'src/core/server-scheduler.ts'), 'utf8');
  const snippet = ts.slice(ts.indexOf('export interface ServerSchedule'), ts.indexOf('export function createSchedule'));
  const c = { Buffer, isServerId: id => /^[a-f0-9]{32}$/.test(id) }; vm.createContext(c); vm.runInContext(stripTypeScriptTypes(snippet).replace(/\bexport\s+/g, '') + '\nthis.validateScheduleInput = validateScheduleInput;', c);
  const h = await harness({ call: async (method, payload, { dashboards }) => {
    if (method === 'saveServerSchedule') { const canonical = c.validateScheduleInput(payload.schedule); const job = { ...canonical, id: 'c'.repeat(32), serverId: payload.id, nextRunAt: Date.now() + canonical.intervalMinutes * 60000, lastRunAt: null, lastOutcome: null }; dashboards[payload.id].schedules.push(job); return { handled: true, result: structuredClone(dashboards[payload.id].schedules) }; }
    return null;
  } });
  h.$('schedule-name').value = '  Backup  '; h.$('schedule-interval').value = '30'; h.$('schedule-enabled').checked = true; await h.$('schedule-form').fire('submit');
  console.log('OBSERVED actual canonical saved name / feedback:', JSON.stringify({ saved: h.dashboards[A].schedules[0]?.name, feedback: h.$('schedule-feedback').textContent }));
  assert.match(h.$('schedule-feedback').textContent, /Verified saved schedule/);
});

test('disabled scheduler state must be displayed and prevent unavailable mutation controls', async () => {
  const h = await harness(); h.dashboards[A].scheduleError = 'Scheduler disabled: Invalid schedule metadata'; await h.$('dashboard-refresh').fire('click');
  console.log('OBSERVED scheduleError / disabled / displayed help:', JSON.stringify({ error: h.dashboards[A].scheduleError, disabled: h.$('schedule-save').disabled, help: h.$('scheduler-help').textContent, list: h.$('schedule-list').textContent }));
  assert.equal(h.$('schedule-save').disabled, true, 'backend explicitly disabled scheduling; save must not remain enabled');
});







test('fresher selected-server getState logs must not be masked forever by dashboard cache on Home', async () => {
  const h = await harness(); h.dashboards[A].logs = ['older dashboard line']; await h.$('dashboard-refresh').fire('click'); h.select('home'); await h.change(A, false, ['older dashboard line', 'new output']);
  const logs = h.ctx.window.seedDashboard.logsFor(h.ctx.state);
  console.log('OBSERVED fresher state logs / exposed console logs:', JSON.stringify({ stateLogs: h.ctx.state.logs, exposedLogs: logs }));
  assert.equal(logs.at(-1), 'new output');
});

test('new property edits during the read-back phase must not be discarded by the older save', async () => {
  const readBack = defer(); let holding = false;
  const h = await harness({ call: async (method, payload, { dashboards }) => {
    if (method === 'saveServerSettings') { for (const [key, value] of Object.entries(payload.settings)) dashboards[payload.id].settings[key] = String(value); holding = true; return { handled: true, result: { serverId: payload.id, path: 'server.properties', hash: hash('saved settings'), bytes: 10, backupFile: 'scratch-only' } }; }
    if (method === 'getServerDashboard' && holding) return { handled: true, result: await readBack.promise };
    return null;
  } });
  h.$('property-motd').value = 'Saved MOTD'; await h.$('properties-form').fire('input', h.$('property-motd'));
  const saving = h.$('properties-form').fire('submit'); await flush();
  assert.equal(h.$('property-max-players').disabled, false, 'real runAction has released its busy flag before verification completes');
  h.$('property-max-players').value = '12'; await h.$('properties-form').fire('input', h.$('property-max-players'));
  readBack.resolve(structuredClone(h.dashboards[A])); await saving;
  console.log('OBSERVED property added during read-back / final input:', h.$('property-max-players').value);
  assert.equal(h.$('property-max-players').value, '12', 'only the saved edits may be cleared; a later unsaved edit must survive');
});


for (const phase of ['mutation', 'read-back']) {
  test(`late player ${phase} completion cannot change feedback after A-B-A selection`, async () => {
    const gate = defer(); let verification = false, held = false;
    const h = await harness({ running: true, call: async (method, payload) => {
      if (method === 'managePlayer') { verification = true; return { handled: true, result: phase === 'mutation' ? await gate.promise : {} }; }
      if (method === 'getServerDashboard' && verification && phase === 'read-back' && !held) { held = true; return { handled: true, result: await gate.promise }; }
      return null;
    } });
    h.$('player-name').value = 'Alex'; await h.$('player-form').fire('submit'); await flush();
    if (phase === 'read-back') assert.equal(held, true);
    await h.change(B, true); await h.change(A, true);
    const feedback = h.$('player-feedback').textContent;
    gate.resolve(phase === 'mutation' ? {} : data(A)); await flush();
    assert.equal(h.$('player-feedback').textContent, feedback, 'obsolete action must not post status in the newer selection');
  });

  test(`late schedule ${phase} completion cannot change feedback or form after A-B-A selection`, async () => {
    const gate = defer(); let verification = false, held = false;
    const h = await harness({ call: async (method, payload, { dashboards }) => {
      if (method === 'saveServerSchedule') {
        dashboards[A].schedules = [{ ...payload.schedule, id: 'c'.repeat(32), serverId: A }]; verification = true;
        return { handled: true, result: phase === 'mutation' ? await gate.promise : dashboards[A].schedules };
      }
      if (method === 'getServerDashboard' && verification && phase === 'read-back' && !held) { held = true; return { handled: true, result: await gate.promise }; }
      return null;
    } });
    h.$('schedule-name').value = 'Saved job'; h.$('schedule-interval').value = '30';
    const saving = h.$('schedule-form').fire('submit'); await flush();
    if (phase === 'read-back') assert.equal(held, true);
    await h.change(B); await h.change(A); h.$('schedule-name').value = 'New unsaved job';
    const feedback = h.$('schedule-feedback').textContent;
    gate.resolve(phase === 'mutation' ? h.dashboards[A].schedules : structuredClone(h.dashboards[A])); await saving; await flush();
    assert.equal(h.$('schedule-feedback').textContent, feedback, 'obsolete verification must not post status in the newer selection');
    assert.equal(h.$('schedule-name').value, 'New unsaved job', 'obsolete success must not reset the newer form');
  });
}
