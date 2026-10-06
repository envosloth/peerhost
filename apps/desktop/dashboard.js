/* Per-server workspace. Existing controls are relocated, never cloned; the preload remains the only privilege boundary. */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const processLabels = { offline: 'Stopped', failed: 'Failed', running: 'Running', starting: 'Starting', stopping: 'Stopping' };
  const pages = ['home', 'operate', 'console', 'peers', 'settings'];
  let state = null, blocked = true, currentPage = 'home', hooks = null, selectionGeneration = 0;
  const button = (text, cls = 'button button-small') => { const n = el('button', cls, text); n.type = 'button'; return n; };
  const homeTab = button('Home', 'nav-tab'); homeTab.id = 'home-tab'; homeTab.setAttribute('role', 'tab'); homeTab.setAttribute('aria-controls', 'home-panel');
  const navIcon = el('span', 'nav-icon'); navIcon.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-server"/></svg>';
  const navCopy = el('span', 'nav-copy'); navCopy.append(el('span', 'nav-text', 'Home'), el('span', 'nav-sub', 'Your server library')); homeTab.replaceChildren(navIcon, navCopy);
  document.querySelector('.nav-tabs').prepend(homeTab);
  const home = el('section', 'page'); home.id = 'home-panel'; home.setAttribute('role', 'tabpanel'); home.setAttribute('aria-labelledby', 'home-tab');
  const inner = el('div', 'page-inner'); home.append(inner); $('operate-panel').before(home);
  inner.append(document.querySelector('.marquee'));
  $('workspace-title').textContent = 'Home';
  document.querySelector('.mode-label').textContent = 'Your worlds, on your PCs. Choose a server to manage it.';
  const library = $('server-library'); inner.append(library); library.classList.add('card', 'home-library');
  const actions = el('div', 'home-actions'); actions.append($('add-server'), $('import-server')); library.querySelector('.server-library-head').append(actions);
  const limit = library.querySelector('.field-help'); limit.id = 'home-concurrency'; limit.textContent = 'One server can run at a time on this PC. Stop the server before switching; each world keeps its own settings and backups.';
  library.append($('server-empty'));
  // Join instructions live with the library so they are readable even before a server exists.
  inner.append($('join-help'));
  const selectionHint = el('p', 'field-help'); selectionHint.id = 'home-selection-hint'; selectionHint.setAttribute('role', 'status'); library.append(selectionHint);
  const stopFirst = button('Stop server', 'button button-stop button-small'); stopFirst.id = 'home-stop-first'; stopFirst.hidden = true; library.append(stopFirst);
  stopFirst.addEventListener('click', () => {
    if (stopFirst.disabled || !hooks || !['running', 'starting'].includes(state?.server?.state)) return;
    void hooks.runAction('stopServer');
  });

  function addPage(name, title, subtitle, icon) {
    const tab = button('', 'nav-tab'); tab.id = name + '-tab'; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', name + '-panel');
    const art = el('span', 'nav-icon'); art.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${icon}"/></svg>`;
    const copy = el('span', 'nav-copy'); copy.append(el('span', 'nav-text', title), el('span', 'nav-sub', subtitle)); tab.append(art, copy); $('peers-tab').before(tab);
    const panel = el('section', 'page'); panel.id = name + '-panel'; panel.hidden = true; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id);
    const body = el('div', 'page-inner'); const heading = el('header', 'page-header'); heading.append(el('h1', '', title)); body.append(heading); panel.append(body); $('settings-panel').before(panel); pages.splice(pages.length - 1, 0, name); return body;
  }
  const playersBody = addPage('players', 'Players', 'Online & whitelist', 'i-friends');
  playersBody.innerHTML += '<section class="card dashboard-card"><h2 id="players-count">Unavailable</h2><p id="players-help" class="field-help"></p><ul id="players-list" class="dashboard-list" aria-label="Sampled online players"></ul><form id="player-form" class="dashboard-inline-form"><div><label for="player-name">Minecraft name</label><input type="text" id="player-name" maxlength="16" autocomplete="off" spellcheck="false" required pattern="[A-Za-z0-9_]{1,16}"></div><div><label for="player-action">Action</label><select id="player-action"><option value="whitelist-add">Add to whitelist</option><option value="whitelist-remove">Remove from whitelist</option></select></div><button id="player-submit" type="submit" class="button">Send action</button></form><p id="player-feedback" class="field-help" role="status"></p></section>';
  const locallyOwned = () => state?.server?.ownership?.owner === state?.deviceId && ['owned', 'hosting'].includes(state?.server?.ownership?.state);
  const canManagePlayers = () => !blocked && locallyOwned() && state?.server?.state === 'running';
  function renderPlayers() {
    const p = dashboard?.players;
    $('players-count').textContent = `${sampled(p?.online) ? p.online : 'Unavailable'} / ${sampled(p?.max) ? p.max : 'Unavailable'} online`;
    $('players-help').textContent = p?.error || 'Names are the server’s reported sample; the sample may not include every online player. Actions require this PC to own the running server.';
    const signature = JSON.stringify([p?.sample, canManagePlayers()]);
    if ($('players-list').dataset.signature !== signature) {
      $('players-list').dataset.signature = signature;
      const list = Array.isArray(p?.sample) ? p.sample : [];
      $('players-list').replaceChildren(...(list.length ? list.map(player => {
        const item = el('li', 'dashboard-list-row'); item.append(el('strong', '', player.name)); const kick = button('Kick'); kick.dataset.player = player.name; kick.disabled = !canManagePlayers(); item.append(kick); return item;
      }) : [el('li', 'field-help', p?.online === 0 ? 'No players online.' : 'No player names reported.')]));
    }
    for (const id of ['player-name', 'player-action', 'player-submit']) $(id).disabled = !canManagePlayers();
  }
  async function playerAction(action, name) {
    if (!canManagePlayers() || !/^[A-Za-z0-9_]{1,16}$/.test(name)) return;
    const id = selectedId(), generation = selectionGeneration; $('player-feedback').textContent = 'Sending action…';
    const current = () => selectedId() === id && generation === selectionGeneration;
    const ok = await hooks.runAction('managePlayer', { id, action, name });
    if (!current()) return;
    if (ok) {
      const refreshed = await refreshDashboard(true);
      if (!current()) return;
      $('player-feedback').textContent = refreshed ? 'Command sent to the running server. Check Console for the result.' : 'Action sent, but server data could not be refreshed. Check Console for the result.';
    } else $('player-feedback').textContent = 'Action was not confirmed. Check the error above and try again.';
  }
  $('player-form').addEventListener('submit', event => { event.preventDefault(); void playerAction($('player-action').value, $('player-name').value); });
  $('players-list').addEventListener('click', event => { const b = event.target.closest('button[data-player]'); if (b && !b.disabled) void playerAction('kick', b.dataset.player); });

  const tunnelsBody = addPage('tunnels', 'Tunnels', 'Player addresses & routing', 'i-globe');
  const tunnelsScope = el('p', 'field-help', 'The public address and playit connection are app-wide. Player routing follows the world this PC is hosting through its always-on PC; it is not an independent tunnel for every library card. An address is not proof of public reachability.'); tunnelsScope.id = 'tunnels-scope';
  tunnelsBody.append(tunnelsScope, $('public-card'), $('player-gateway'), $('playit-panel'));

  const settingsBody = addPage('server-settings', 'Server settings', 'Properties & launch', 'i-settings');
  const PROPERTY_FIELDS = [['motd', 'Message of the day', 'text', 200], ['server-port', 'Server port', 'number', null], ['max-players', 'Max players', 'number', null], ['difficulty', 'Difficulty', 'select', ['peaceful', 'easy', 'normal', 'hard']], ['gamemode', 'Game mode', 'select', ['survival', 'creative', 'adventure', 'spectator']], ['pvp', 'Player versus player', 'boolean', null], ['white-list', 'Whitelist', 'boolean', null], ['view-distance', 'View distance (chunks)', 'number', null], ['simulation-distance', 'Simulation distance (chunks)', 'number', null]];
  settingsBody.insertAdjacentHTML('beforeend', '<section class="card dashboard-card"><h2>Server properties</h2><p id="properties-help" class="field-help"></p><form id="properties-form" class="dashboard-form"></form><p id="properties-feedback" class="field-help" role="status"></p></section>');
  const propertyInput = field => $('property-' + field);
  const propertiesDirty = new Set();
  const propertyRevisions = new Map();
  function propertyValue(field, values) {
    const value = values?.[field], kind = PROPERTY_FIELDS.find(([key]) => key === field)?.[2];
    if (kind === 'boolean') return value === true || value === 'true' ? true : value === false || value === 'false' ? false : undefined;
    if (kind === 'number') return value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : undefined;
    return value;
  }
  for (const [field, label, kind, extra] of PROPERTY_FIELDS) {
    // The field name is both the server.properties key and the guard-tested hook; label text stays human.
    const group = el('div', kind === 'boolean' ? 'setting-row switch-row' : 'setting-block'); const input = el(kind === 'select' ? 'select' : 'input');
    input.id = 'property-' + field; input.name = field; input.dataset.field = field;
    if (kind === 'select') input.append(...extra.map(v => { const o = el('option', '', v); o.value = v; return o; }));
    else { input.type = kind === 'boolean' ? 'checkbox' : kind; if (extra != null) input.maxLength = extra; if (kind === 'number') input.min = field === 'server-port' ? 1 : 0; if (field === 'server-port') input.max = 65535; }
    const text = el('label', 'setting-label', label + ' '); text.htmlFor = input.id; text.append(el('small', '', field));
    group.append(text, input); $('properties-form').append(group);
  }
  const propertiesSave = button('Save properties', 'button button-primary'); propertiesSave.id = 'properties-save'; propertiesSave.type = 'submit';
  const propertiesActions = el('div', 'page-actions'); propertiesActions.append(propertiesSave); $('properties-form').append(propertiesActions);
  function readProperties() {
    const values = {}; for (const [field, , kind] of PROPERTY_FIELDS) { const input = propertyInput(field); if (!propertiesDirty.has(field)) continue; if (kind === 'boolean') values[field] = input.checked; else values[field] = kind === 'number' ? Number(input.value) : input.value; }
    return values;
  }
  function renderProperties() {
    const current = dashboard?.settings;
    const stopped = stoppedOwned();
    for (const [field, , kind] of PROPERTY_FIELDS) {
      const input = propertyInput(field); input.disabled = blocked || !locallyOwned() || !stopped || !dashboard || Boolean(dashboard.settingsError);
      const value = propertyValue(field, current);
      if (!propertiesDirty.has(field)) {
        if (kind === 'boolean') { input.checked = value === true; input.indeterminate = value === undefined; }
        else input.value = value == null ? '' : String(value);
      }
    }
    const unknown = Array.isArray(dashboard?.settings?.unknownKeys) ? ` ${dashboard.settings.unknownKeys.length} unsupported key(s) are left untouched.` : '';
    $('properties-help').textContent = !dashboard ? 'Refresh data to read this server’s properties.' : dashboard.settingsError ? `Properties unavailable: ${dashboard.settingsError}. Saving is blocked; refresh after repairing the file.` : `${stopped ? 'Only edited properties are saved and verified against server.properties. Indeterminate boxes mean the file does not set that value.' : 'Stop this owned server before changing properties. The launch profile below is read-only while it runs.'}${unknown}`;
    $('properties-save').disabled = blocked || !locallyOwned() || !stopped || !dashboard || Boolean(dashboard.settingsError);
  }
  $('properties-form').addEventListener('input', event => { const field = event.target.dataset.field; if (field) { propertiesDirty.add(field); propertyRevisions.set(field, (propertyRevisions.get(field) || 0) + 1); } renderProperties(); });
  $('properties-form').addEventListener('submit', async event => {
    event.preventDefault(); if ($('properties-save').disabled) return;
    const changed = {}; for (const [field, value] of Object.entries(readProperties())) { const before = propertyValue(field, dashboard?.settings); if (value !== undefined && value !== before) changed[field] = value; }
    if (!Object.keys(changed).length) { $('properties-feedback').textContent = 'No property changes to save.'; return; }
    const revisions = new Map(propertyRevisions);
    const ok = await panelAction('saveServerSettings', { settings: changed }, 'properties-feedback', d => !d.settingsError && Object.entries(changed).every(([k, v]) => propertyValue(k, d.settings) === v), 'Verified saved properties against the server read-back.');
    if (ok) { for (const field of Object.keys(changed)) if (propertyRevisions.get(field) === revisions.get(field)) propertiesDirty.delete(field); renderProperties(); }
  });
  settingsBody.append($('profile-details'));
  settingsBody.append(el('p', 'warning-copy', 'The launch profile (Java path and arguments) is unchanged and remains the only way to change how the server starts. Memory and Java are also reachable from the setup guide.'));

  const filesBody = addPage('server-files', 'Server files', 'Browse & edit text', 'i-folder');
  filesBody.insertAdjacentHTML('beforeend', '<section class="card dashboard-card"><div class="compact-heading"><h2 id="file-path">Server root</h2><div class="page-actions"><button id="file-up" type="button" class="button button-small">Up one folder</button><button id="file-refresh" type="button" class="button button-small">Refresh</button></div></div><p class="field-help">Directories and text files, listed from the managed copy of this server. Writes are refused while it runs or when another PC owns it, and a changed file is never overwritten silently: the guard hash from the last read is sent with every save.</p><ul id="file-list" class="dashboard-list" aria-label="Server files"></ul><section id="file-edit" hidden><div class="compact-heading"><h2 id="file-name">No file open</h2><span id="file-hash" class="subtle-label mono"></span></div><label class="sr-only" for="file-editor">File contents</label><textarea id="file-editor" class="mono" rows="14" spellcheck="false"></textarea><div class="page-actions"><button id="file-save" type="button" class="button button-primary">Save file</button><button id="file-reload" type="button" class="button">Reload from disk</button><button id="file-close" type="button" class="text-button">Close</button></div><p id="file-feedback" class="field-help" role="status"></p></section></section>');
  // Folder/open failures must remain visible even while the editor is closed.
  $('file-edit').after($('file-feedback'));
  let filePath = '', fileList = null, fileOpen = null, filesToken = 0, filesBusy = false, filesAttempt = 0;
  const filesWritable = () => !blocked && locallyOwned() && ['owned'].includes(state?.server?.ownership?.state) && ['offline', 'failed'].includes(state?.server?.state);
  function resetFiles(clearFeedback = true) { filePath = ''; fileList = null; fileOpen = null; filesToken++; filesBusy = false; filesAttempt = 0; $('file-edit').hidden = true; $('file-list').replaceChildren(); $('file-path').textContent = 'Server root'; if (clearFeedback) $('file-feedback').textContent = ''; }
  function renderFiles() {
    $('file-refresh').disabled = blocked || !selectedId() || !dashboard || filesBusy;
    $('file-up').hidden = !filePath;
    $('file-up').disabled = blocked || filesBusy;
    const save = $('file-save'); save.disabled = blocked || !fileOpen?.hash || fileOpen.editable === false || filesBusy || !filesWritable();
    save.title = fileOpen?.editable === false ? 'This file is read-only here' : filesWritable() ? 'Save with the last-read guard hash' : 'Saving requires this PC to own the stopped server';
    $('file-editor').disabled = blocked || !fileOpen?.hash || fileOpen.editable === false || !filesWritable();
  }
  async function listFiles(path = filePath) {
    const id = selectedId(); if (!id || blocked) return false;
    const token = ++filesToken; filesBusy = true; renderFiles(); $('file-feedback').textContent = 'Loading folder…';
    try {
      const listing = await window.seedhost.call('listServerFiles', { id, path });
      if (token !== filesToken || selectedId() !== id) return false;
      if (!listing || listing.serverId !== id || listing.path !== path || !Array.isArray(listing.entries)) throw new Error('The folder listing did not match this server. Refresh to try again.');
      filePath = listing.path; fileList = listing.entries; $('file-path').textContent = listing.path ? `Server root / ${listing.path}` : 'Server root';
      $('file-list').replaceChildren(...(listing.entries.length ? listing.entries.map(entry => {
        const item = el('li', 'dashboard-list-row file-entry'); item.dataset.path = entry.path; item.dataset.kind = entry.kind; item.tabIndex = 0;
        item.setAttribute('role', 'button'); item.setAttribute('aria-label', `${entry.kind === 'directory' ? 'Folder' : 'File'} ${entry.name}`);
        const copy = el('div', 'dashboard-row-copy'); copy.append(el('strong', '', entry.name));
        copy.append(el('p', 'field-help', `${entry.kind === 'directory' ? 'Folder' : 'File'}${Number.isSafeInteger(entry.bytes) ? ` · ${entry.bytes} bytes` : ''}${entry.kind === 'file' && entry.editable !== true ? ' · Read-only here' : ''}`));
        item.append(copy); return item;
      }) : [el('li', 'field-help', 'This folder is empty.')]));
      $('file-feedback').textContent = ''; return true;
    } catch (error) {
      if (token === filesToken) $('file-feedback').textContent = `Couldn’t list this folder: ${reason(error)}. Refresh to try again.`;
      return false;
    } finally { if (token === filesToken) { filesBusy = false; filesAttempt = Date.now(); renderFiles(); } }
  }
  async function openFile(path) {
    const id = selectedId(); if (!id || blocked) return false;
    const editable = fileList?.find(entry => entry.path === path)?.editable ?? (fileOpen?.path === path ? fileOpen.editable : true);
    const token = ++filesToken; filesBusy = true; renderFiles(); $('file-feedback').textContent = 'Opening file…';
    try {
      const file = await window.seedhost.call('readServerFile', { id, path });
      if (token !== filesToken || selectedId() !== id) return false;
      if (!file || file.serverId !== id || file.path !== path || typeof file.text !== 'string' || typeof file.hash !== 'string') throw new Error('The file read did not match this server. Refresh to try again.');
      fileOpen = { path, hash: file.hash, bytes: file.bytes, editable }; $('file-edit').hidden = false; $('file-name').textContent = path; $('file-hash').textContent = `guard ${file.hash.slice(0, 12)}`; $('file-editor').value = file.text;
      $('file-feedback').textContent = editable === false ? 'Read-only file: this path cannot be saved here.' : filesWritable() ? 'Loaded from disk. Saving sends this guard hash.' : 'Read-only right now: saving requires this PC to own the stopped server.';
      renderFiles(); return true;
    } catch (error) {
      if (token === filesToken) $('file-feedback').textContent = `Couldn’t open this file: ${reason(error)}.`;
      return false;
    } finally { if (token === filesToken) { filesBusy = false; renderFiles(); } }
  }
  async function saveFile() {
    if (!fileOpen || $('file-save').disabled) return;
    const id = selectedId(), open = { ...fileOpen }, text = $('file-editor').value;
    const token = ++filesToken, generation = selectionGeneration;
    const current = () => token === filesToken && generation === selectionGeneration && selectedId() === id;
    filesBusy = true; renderFiles(); $('file-feedback').textContent = 'Saving…';
    try {
      const result = await window.seedhost.call('writeServerFile', { id, path: open.path, text, expectedHash: open.hash });
      if (!current()) return;
      if (result === null) { $('file-feedback').textContent = 'Save cancelled. Your text is kept.'; return; }
      const verify = await window.seedhost.call('readServerFile', { id, path: open.path });
      if (!current()) return;
      if (!verify || verify.serverId !== id || verify.path !== open.path || verify.text !== text || typeof verify.hash !== 'string') throw new Error('The saved file could not be confirmed on disk. Reload before editing again.');
      fileOpen = { ...open, hash: verify.hash, bytes: verify.bytes }; $('file-hash').textContent = `guard ${verify.hash.slice(0, 12)}`;
      $('file-feedback').textContent = 'Verified saved file against the disk read-back.';
    } catch (error) {
      if (current()) {
        fileOpen.hash = null; $('file-hash').textContent = 'Unconfirmed guard — reload required';
        $('file-feedback').textContent = `Couldn’t save this file: ${reason(error)}. Reload from disk and review before retrying.`;
      }
    } finally { if (current()) { filesBusy = false; renderFiles(); } }
  }
  $('file-list').addEventListener('click', event => { const item = event.target.closest('[data-path]'); if (!item || filesBusy) return; if (item.dataset.kind === 'directory') void listFiles(item.dataset.path); else void openFile(item.dataset.path); });
  $('file-list').addEventListener('keydown', event => { if (event.key === 'Enter' && event.target.closest?.('[data-path]')) event.target.click(); });
  $('file-up').addEventListener('click', () => void listFiles(filePath.split('/').slice(0, -1).join('/')));
  $('file-refresh').addEventListener('click', () => void listFiles());
  $('file-save').addEventListener('click', () => void saveFile());
  $('file-reload').addEventListener('click', () => { if (fileOpen) void openFile(fileOpen.path); });
  $('file-close').addEventListener('click', () => { filesToken++; filesBusy = false; fileOpen = null; $('file-edit').hidden = true; $('file-feedback').textContent = ''; renderFiles(); });

  const modsBody = addPage('mods', 'Mods', 'Modrinth & client pack', 'i-puzzle'); modsBody.append($('mods-details'));

  const multiBody = $('peers-panel').querySelector('.page-inner');
  $('peers-tab').querySelector('.nav-text').textContent = 'Multi-host'; $('peers-tab').querySelector('.nav-sub').textContent = 'Group & world handoff';
  multiBody.querySelector('h1').textContent = 'Multi-host';
  const multiScope = el('p', 'field-help multi-host-scope', 'App-wide hosting group: membership and invitations apply across this app, not a separate group per server. World handoff controls below act on the selected server.'); multiScope.id = 'multi-host-scope';
  multiBody.querySelector('.page-header').after(multiScope, $('relay-card'));

  const schedulerBody = addPage('scheduler', 'Scheduler', 'Jobs while app is open', 'i-settings');
  schedulerBody.innerHTML += '<section class="card dashboard-card"><p id="scheduler-help" class="field-help">Intervals run only while this app is open. These are not Windows scheduled tasks. No start jobs: backups require a stopped, owned world; stop and command jobs require a running, owned server.</p><ul id="schedule-list" class="dashboard-list" aria-label="Server schedules"></ul><h2 id="schedule-form-title">New schedule</h2><form id="schedule-form" class="dashboard-form"><div><label for="schedule-name">Name</label><input type="text" id="schedule-name" maxlength="80" required autocomplete="off"></div><div><label for="schedule-action">Action</label><select id="schedule-action"><option value="backup">Save backup</option><option value="stop">Stop server</option><option value="command">Console command</option></select></div><div id="schedule-command-field" hidden><label for="schedule-command">One console command</label><input type="text" id="schedule-command" maxlength="4096" autocomplete="off" spellcheck="false"></div><div><label for="schedule-interval">Interval (minutes)</label><input id="schedule-interval" type="number" min="1" step="1" value="60" required></div><label class="inline-check"><input id="schedule-enabled" type="checkbox" checked> Enabled</label><div class="page-actions"><button id="schedule-save" type="submit" class="button button-primary">Save schedule</button><button id="schedule-cancel" type="button" class="button" hidden>Cancel edit</button></div></form><p id="schedule-feedback" class="field-help" role="status"></p></section>';
  let editingSchedule = null;
  const stoppedOwned = () => !blocked && locallyOwned() && state?.server?.ownership?.state === 'owned' && ['offline', 'failed'].includes(state?.server?.state) && !state?.server?.modInstallError;
  const dateLabel = value => value ? new Date(value).toLocaleString() : 'Not scheduled';
  function resetSchedule() { editingSchedule = null; $('schedule-form').reset(); $('schedule-form-title').textContent = 'New schedule'; $('schedule-cancel').hidden = true; $('schedule-command-field').hidden = true; }
  function renderSchedules() {
    const jobs = Array.isArray(dashboard?.schedules) ? dashboard.schedules : [];
    const unavailable = !dashboard || Boolean(dashboard.scheduleError);
    $('scheduler-help').textContent = dashboard?.scheduleError ? `Scheduling unavailable: ${dashboard.scheduleError}. Repair the schedule metadata and refresh before trying again.` : 'Intervals run only while this app is open. These are not Windows scheduled tasks. No start jobs: backups require a stopped, owned world; stop and command jobs require a running, owned server.';
    const signature = JSON.stringify([jobs, blocked, locallyOwned(), state?.server?.state, unavailable]);
    if ($('schedule-list').dataset.signature !== signature) {
      $('schedule-list').dataset.signature = signature;
      $('schedule-list').replaceChildren(...(jobs.length ? jobs.map(job => {
        const item = el('li', 'dashboard-list-row'); const copy = el('div', 'dashboard-row-copy'); copy.append(el('strong', '', job.name));
        copy.append(el('p', 'field-help', `${job.action} · every ${job.intervalMinutes} minutes · ${job.enabled ? 'Enabled' : 'Paused'}`));
        copy.append(el('p', 'field-help', `Next: ${dateLabel(job.nextRunAt)} · Last: ${job.lastRunAt ? dateLabel(job.lastRunAt) : 'Never'} · ${job.lastOutcome == null ? 'No outcome yet' : typeof job.lastOutcome === 'string' ? job.lastOutcome : JSON.stringify(job.lastOutcome)}`));
        const actions = el('div', 'page-actions');
        for (const [action, text] of [['edit', 'Edit'], ['run', 'Run now'], ['delete', 'Delete']]) { const b = button(text); b.dataset.jobAction = action; b.dataset.jobId = job.id; b.disabled = blocked || unavailable || !locallyOwned() || (action === 'run' && !(job.action === 'backup' ? stoppedOwned() : canManagePlayers())); if (action === 'run' && b.disabled) b.title = job.action === 'backup' ? 'Stop this owned server before saving a backup' : 'Start this owned server before running this job'; actions.append(b); }
        item.append(copy, actions); return item;
      }) : [el('li', 'field-help', dashboard ? 'No schedules for this server yet.' : 'Refresh data to load schedules.')]));
    }
    for (const n of $('schedule-form').querySelectorAll('input,select,button')) n.disabled = blocked || !locallyOwned() || unavailable;
  }
  async function panelAction(method, payload, feedback, verify, success) {
    const id = selectedId(), generation = selectionGeneration; $(feedback).textContent = 'Saving / checking server data…';
    const current = () => selectedId() === id && generation === selectionGeneration;
    const ok = await hooks.runAction(method, { id, ...payload });
    if (!current()) return false;
    if (!ok) { $(feedback).textContent = 'Not confirmed. Check the error above; your entries are kept.'; return false; }
    const refreshed = await refreshDashboard(true);
    if (!current()) return false;
    if (!refreshed || !dashboard || !verify(dashboard)) { $(feedback).textContent = 'The server read-back did not confirm this change. Refresh and check before retrying.'; return false; }
    $(feedback).textContent = success; return true;
  }
  $('schedule-action').addEventListener('change', () => { $('schedule-command-field').hidden = $('schedule-action').value !== 'command'; });
  $('schedule-cancel').addEventListener('click', resetSchedule);
  $('schedule-form').addEventListener('submit', async event => {
    event.preventDefault(); if ($('schedule-save').disabled) return;
    const action = $('schedule-action').value, interval = Number($('schedule-interval').value), command = $('schedule-command').value;
    if (!Number.isSafeInteger(interval) || interval < 1 || !/^[0-9]+$/.test($('schedule-interval').value)) { $('schedule-feedback').textContent = 'Use a positive whole number of minutes.'; return; }
    if (action === 'command' && (!command.trim() || /[\0\r\n]/.test(command))) { $('schedule-feedback').textContent = 'Enter exactly one console command.'; return; }
    const schedule = { ...(editingSchedule ? { id: editingSchedule } : {}), name: $('schedule-name').value.trim(), action, ...(action === 'command' ? { command } : {}), intervalMinutes: interval, enabled: $('schedule-enabled').checked };
    if (await panelAction('saveServerSchedule', { schedule }, 'schedule-feedback', d => d.schedules?.some(j => Object.entries(schedule).every(([k, v]) => j[k] === v)), 'Verified saved schedule.')) resetSchedule();
  });
  $('schedule-list').addEventListener('click', async event => {
    const b = event.target.closest('button[data-job-action]'); if (!b || b.disabled) return;
    const job = dashboard.schedules.find(j => j.id === b.dataset.jobId); if (!job) return;
    if (b.dataset.jobAction === 'edit') {
      editingSchedule = job.id; $('schedule-name').value = job.name; $('schedule-action').value = job.action; $('schedule-interval').value = job.intervalMinutes; $('schedule-enabled').checked = job.enabled; $('schedule-command').value = job.command || ''; $('schedule-command-field').hidden = job.action !== 'command'; $('schedule-form-title').textContent = 'Edit schedule'; $('schedule-cancel').hidden = false; $('schedule-name').focus(); return;
    }
    if (b.dataset.jobAction === 'delete') { if (await panelAction('deleteServerSchedule', { scheduleId: job.id }, 'schedule-feedback', d => !d.schedules?.some(j => j.id === job.id), 'Verified removal.')) resetSchedule(); }
    else await panelAction('runServerSchedule', { scheduleId: job.id }, 'schedule-feedback', d => d.schedules?.some(j => j.id === job.id && j.lastOutcome != null), 'Runner outcome loaded below; check whether it succeeded.');
  });

  // One header is shared by every server section; Home and App settings are renderer-only destinations.
  const serverHeader = el('section', 'server-workspace-header'); serverHeader.id = 'server-workspace-header';
  home.before(serverHeader); serverHeader.append(document.querySelector('.server-identity'), $('server-toolbar'), $('server-action-hint'));
  const dashboardBar = el('div', 'dashboard-bar');
  const dashboardStatus = el('p', 'field-help'); dashboardStatus.id = 'dashboard-status'; dashboardStatus.setAttribute('role', 'status');
  const dashboardRefresh = button('Refresh data'); dashboardRefresh.id = 'dashboard-refresh'; dashboardBar.append(dashboardStatus, dashboardRefresh); serverHeader.append(dashboardBar);
 const backupsBody = addPage('backups', 'Backups', 'Local world revisions', 'i-backup');
 const backupActions = el('div', 'page-actions'); backupActions.append($('create-snapshot'), $('clean-up')); backupsBody.append(backupActions, $('snapshot-history'));
 $('operate-tab').querySelector('.nav-text').textContent = 'Performance'; $('operate-tab').querySelector('.nav-sub').textContent = 'Process & usage';
  const performance = el('section', 'card performance-card'); performance.setAttribute('aria-labelledby', 'performance-title');
  const performanceTitle = el('h1', '', 'Performance'); performanceTitle.id = 'performance-title'; performance.append(performanceTitle, el('p', 'field-help', 'Live process samples from this PC. Unavailable means no measurement, not zero usage.'));
  const metrics = el('dl', 'performance-grid');
  for (const [id, label] of [['cpu', 'CPU'], ['memory', 'Memory'], ['uptime', 'Uptime'], ['pid', 'Process ID']]) {
    const group = el('div', 'metric well'); const value = el('dd', '', 'Unavailable'); value.id = 'performance-' + id; group.append(el('dt', '', label), value); metrics.append(group);
  }
  const performanceNotice = el('p', 'field-help'); performanceNotice.id = 'performance-notice'; performance.append(metrics, performanceNotice);
  $('operate-panel').querySelector('.page-inner').prepend(performance);

  let dashboard = null, dashboardId = null, dashboardRequest = 0, dashboardInFlight = false, requestedAt = 0, dashboardStateLogs = null;
  const selectedId = () => state?.servers?.find(s => s.active)?.id ?? state?.server?.id ?? null;
  const reason = error => (error?.message || String(error)).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
  const sampled = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  function logsFor(next) { const id = next?.servers?.find(s => s.active)?.id ?? next?.server?.id ?? null; return dashboard && dashboard.serverId === id && Array.isArray(dashboard.logs) && JSON.stringify(next?.logs || []) === dashboardStateLogs ? dashboard.logs : next?.logs || []; }
  function renderConsole() {
    const logs = logsFor(state); $('console-lines').textContent = logs.join('\n'); $('console-empty').hidden = logs.length > 0;
    $('console-peek-line').textContent = logs.at(-1) || 'No process output yet.';
    if ($('follow-logs').checked) $('console-output').scrollTop = $('console-output').scrollHeight;
  }
  function renderDashboard() {
    renderConsole(); renderPlayers(); renderSchedules(); renderProperties();
    const p = dashboard?.performance;
    $('performance-cpu').textContent = sampled(p?.cpuPercent) ? `${p.cpuPercent}%` : 'Unavailable';
    $('performance-memory').textContent = sampled(p?.memoryMiB) ? `${p.memoryMiB} MiB` : 'Unavailable';
    $('performance-uptime').textContent = sampled(p?.uptimeSeconds) ? `${Math.floor(p.uptimeSeconds)} s` : 'Unavailable';
    $('performance-pid').textContent = sampled(p?.pid) ? String(p.pid) : 'Unavailable';
    performanceNotice.textContent = p?.error || (p?.sampledAt ? `Sampled ${new Date(p.sampledAt).toLocaleString()}` : 'No process sample is available.');
  }
  async function refreshDashboard(force = false) {
    const id = selectedId(); if (!id || !hooks || blocked || (dashboardInFlight && !force)) return false;
    const token = ++dashboardRequest; dashboardInFlight = true; requestedAt = Date.now(); dashboardStatus.textContent = 'Loading server data…';
    const stateLogs = JSON.stringify(state?.logs || []);
    try {
      const next = await window.seedhost.call('getServerDashboard', { id });
      if (token !== dashboardRequest || selectedId() !== id) return false;
      if (!next || next.serverId !== id) throw new Error('The response belongs to a different server. Refresh to try again.');
      dashboard = next; dashboardId = id; dashboardStateLogs = stateLogs; renderDashboard(); dashboardStatus.textContent = 'Updated from this server'; return true;
    } catch (error) {
      if (token === dashboardRequest && selectedId() === id) { dashboard = null; renderDashboard(); dashboardStatus.textContent = `Couldn’t load server data: ${reason(error)}. Use Refresh data to retry.`; }
      return false;
    } finally { if (token === dashboardRequest) dashboardInFlight = false; }
  }
  dashboardRefresh.addEventListener('click', () => void refreshDashboard(true));
  function syncRoute() {
    const serverPage = !['home', 'settings'].includes(currentPage);
    // Remembered backend selection is not an opened workspace. Home stays a library;
    // its stop-first control remains available if a server is running.
    const workspaceOpen = serverPage && Boolean(state?.server);
    for (const name of ['operate', 'console', 'players', 'backups', 'scheduler', 'peers', 'mods', 'tunnels', 'server-settings', 'server-files']) $(name + '-tab').hidden = !workspaceOpen;
    serverHeader.hidden = !workspaceOpen;
    dashboardRefresh.disabled = blocked || !selectedId();
    renderPlayers(); renderSchedules(); renderProperties(); renderFiles();
    if (currentPage === 'server-files' && !fileList && !filesBusy && selectedId() && !blocked && Date.now() - filesAttempt > 2000) { filesAttempt = Date.now(); void listFiles(); }
    if (serverPage && !dashboard && !dashboardInFlight) void refreshDashboard();
  }

  function selectPage(name, focus = false) {
    if (!pages.includes(name)) return;
    if (!['home', 'settings', 'peers'].includes(name) && !state?.server) return;
    currentPage = name;
    for (const p of pages) {
      $(p + '-panel').hidden = p !== name;
      const tab = $(p + '-tab'); tab.setAttribute('aria-selected', String(p === name)); tab.tabIndex = p === name ? 0 : -1; tab.classList.toggle('is-active', p === name);
    }
    if (name === 'console' && $('follow-logs').checked) $('console-output').scrollTop = $('console-output').scrollHeight;
    syncRoute();
    if (focus) $(name + '-tab').focus();
  }
  // One fixed information architecture: the library first, then the selected server's sections.
  const TAB_ORDER = ['home', 'operate', 'console', 'players', 'backups', 'scheduler', 'peers', 'mods', 'tunnels', 'server-settings', 'server-files', 'settings'];
  document.querySelector('.nav-tabs').append(...TAB_ORDER.map(name => $(name + '-tab')));
  document.querySelector('main').append(...TAB_ORDER.map(name => $(name + '-panel')));

  function bind(callbacks) {
    hooks = callbacks;
    for (const p of pages) {
      $(p + '-tab').addEventListener('click', () => selectPage(p));
      $(p + '-tab').addEventListener('keydown', event => {
        const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
        if (!step && !['Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const names = pages.filter(n => !$(n + '-tab').hidden && !$(n + '-tab').disabled);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? names.length - 1 : (names.indexOf(p) + step + names.length) % names.length;
        selectPage(names[index], true);
      });
    }
    $('server-list').addEventListener('click', async event => {
      const b = event.target.closest('button[data-action="open"]'); if (!b || b.disabled || !hooks) return;
      if (!state.servers.some(s => s.id === b.dataset.id && s.active)) {
        if (!await hooks.runAction('selectServer', { id: b.dataset.id })) return;
      }
      selectPage('operate');
    });
    selectPage('home'); return selectPage;
  }
  function renderServers(next, busy) {
    state = next; blocked = busy;
    // Prefer the authoritative library; fall back to describing the single selected server so older state shapes still render cards.
    const servers = Array.isArray(state?.servers) ? state.servers : state?.server ? [{ id: 'current', name: state.server.name, active: true, state: state.server.state, ownerName: state.server.ownerName ?? null, configured: Boolean(state.server.profile?.executable && state.server.profile?.args?.length) }] : [];
    const active = Boolean(state?.server && (!['offline', 'failed'].includes(state.server.state) || state.server.ownership?.state === 'hosting'));
    library.hidden = false; $('add-server').disabled = busy || active;
    selectionHint.textContent = active ? `Stop ${state.server.name} before switching to another server. Home stays available while it runs.` : '';
    stopFirst.hidden = !active; stopFirst.disabled = busy || !['running', 'starting'].includes(state?.server?.state);
    // Sections that render one selected server are disabled until this PC actually has one.
    for (const name of ['operate', 'console', 'players', 'backups', 'scheduler', 'mods', 'tunnels', 'server-settings', 'server-files']) { const tab = $(name + '-tab'); if (tab) tab.disabled = !state?.server; }
    const signature = JSON.stringify([servers, busy, active]); if ($('server-list').dataset.signature === signature) return;
    $('server-list').dataset.signature = signature;
    $('server-list').replaceChildren(...servers.map(entry => {
      const row = el('li', entry.active ? 'server-row is-current' : 'server-row'); row.dataset.serverId = entry.id;
      const art = el('span', 'server-card-art'); art.setAttribute('aria-hidden', 'true'); art.innerHTML = '<svg class="icon"><use href="#i-cube"/></svg>';
      const copy = el('div', 'server-card-copy'); copy.append(el('strong', 'server-row-name', entry.name || 'Untitled server'));
      copy.append(el('span', 'server-card-meta', `${processLabels[entry.state] || 'Unknown state'} · Owner: ${entry.ownerName || 'Unknown'}`));
      copy.append(el('span', 'field-help', entry.configured === true ? 'Launch profile configured' : entry.configured === false ? 'Launch profile needs setup' : 'Launch configuration unknown'));
      const a = el('div', 'server-row-actions'); const open = button(entry.active ? 'Open server' : 'Select server', 'button button-primary button-small'); open.dataset.action = 'open'; open.dataset.id = entry.id; open.disabled = busy || (active && !entry.active); open.title = active && !entry.active ? `Stop ${state.server.name} before switching` : `Open ${entry.name}`;
      const remove = button('Delete…', 'button button-small button-danger'); remove.dataset.action = 'delete'; remove.dataset.id = entry.id; remove.disabled = busy || active;
      a.append(open, remove); row.append(art, copy, a); return row;
    }));
  }
  function update(next, busy) {
    state = next; blocked = busy;
    if (selectedId() !== dashboardId) {
      selectionGeneration++;
      dashboardRequest++; dashboardInFlight = false; dashboard = null; dashboardId = selectedId(); requestedAt = 0; propertiesDirty.clear(); resetFiles(); resetSchedule(); $('schedule-feedback').textContent = ''; $('player-feedback').textContent = ''; renderDashboard();
    }
    syncRoute();
    if (!['home', 'settings'].includes(currentPage) && !blocked && !dashboardInFlight && Date.now() - requestedAt >= 1000) void refreshDashboard();
    renderConsole();
  }
  window.seedDashboard = Object.freeze({ bind, update, renderServers, selectPage, logsFor });
})();
