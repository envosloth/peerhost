/* Seed Hosting's local renderer. All privileged operations go through the preload bridge. */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  let state = null;
  let bridgeReady = false;
  let refreshInFlight = null;
  let pollTimer = null;
  let pendingMethod = null;
  let profileDirty = false;
  let settingsDirty = false;
  let serverKey = null;
  let renderedPeers = null;
  let lastLogs = null;
  let selectedSend = null;
  let errorKind = null;
  let relayDirty = false;
  let settingsCategory = 'appearance';

  const busyLabels = {
    importServer: 'Choosing / copying your server…', createSnapshot: 'Saving a backup…',
    saveProfile: 'Saving launch settings…', startServer: 'Starting server…', stopServer: 'Stopping server and saving the world…',
    createServer: 'Setting up your world — downloading and checking the official files (and Java, if needed)… this can take a few minutes.', saveOnboarding: 'Saving…',
    configureSimpleProfile: 'Saving Java and memory…', pickJava: 'Checking the Java you chose…', restoreSnapshot: 'Restoring backup…',
    saveGameGateway: 'Saving…', checkGameGateway: 'Testing the player address…', selectServer: 'Switching server…', deleteServer: 'Deleting the server and its backups…',
    sendCommand: 'Sending command…', saveSettings: 'Saving preferences…', startPeerListener: 'Starting peer listener…',
    addPeer: 'Saving trusted peer…', sendSnapshot: 'Sending snapshot…', handoff: 'Transferring hosting ownership…',
    cleanUp: 'Freeing up space…', saveRelay: 'Saving…',
    addMods: 'Adding mods…', removeMod: 'Removing mod…', exportClientPack: 'Exporting the client pack…',
    parkAtRelay: 'Handing the world to your always-on PC…', claimFromRelay: 'Taking over hosting…', checkRelay: 'Checking the always-on PC…',
    saveModTarget: 'Saving mod compatibility…', installMod: 'Reviewing / installing mod and dependencies…',
    createInvite: 'Creating an invitation code…', joinWithInvite: 'Joining the group…',
    alwaysOnEnable: 'Setting up this PC as the always-on PC…', alwaysOnDisable: 'Turning off the always-on PC…', alwaysOnNewCode: 'Making a new code…',
    pairAlwaysOn: 'Finding your always-on PC and connecting…', publicAddressEnable: 'Setting up your public address…', publicAddressDisable: 'Turning off the public address…', setupFabricMods: 'Installing your mods and anything they need…',
  };
  let relayStatus = null;
  let relayStatusError = null;
  let relayContext = null;
  let relayRequest = 0;
  function currentRelayContext() {
    const relay = state?.relay;
    const peer = state?.peers?.find(p => p.fingerprint === relay?.fingerprint);
    return relay ? JSON.stringify([state.deviceId, state.server?.id ?? null, relay, peer ?? null]) : null;
  }
  function syncRelayContext() {
    const context = currentRelayContext();
    if (context !== relayContext) {
      relayContext = context; relayRequest++;
      relayStatus = null; relayStatusError = null;
    }
    return context;
  }
  const TIMEOUT_MIN = 5, TIMEOUT_MAX = 3600;
  const isBusy = () => Boolean(pendingMethod || state?.busy);
  const isStopped = () => !state?.server || ['offline', 'failed'].includes(state.server.state);
  const isHosting = () => state?.server?.ownership?.state === 'hosting';
  const ownsServer = () => {
    const ownership = state?.server?.ownership;
    return Boolean(ownership && typeof ownership === 'object' && ownership.state === 'owned' && ownership.owner === state.deviceId);
  };
  const canSnapshot = () => bridgeReady && !isBusy() && Boolean(state?.server) && !state.server.modInstallError && isStopped() && ownsServer();
  const pendingOffer = () => {
    const ownership = state?.server?.ownership;
    return ownership?.state === 'offered' && ownership.owner === state.deviceId ? ownership.offer : null;
  };
  const formatEndpoint = (host, port) => `${String(host).includes(':') ? `[${host}]` : host}:${port}`;
  // Electron wraps main-process errors as "Error invoking remote method 'seedhost:call': Error: <reason>"; show the reason.
  const errorMessage = (error) => (typeof error?.message === 'string' ? error.message : String(error)).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
  const ACTION_FAILURES = {
    createServer: 'Couldn’t create the server', importServer: 'Couldn’t import the server', startServer: 'Couldn’t start the server',
    stopServer: 'Couldn’t stop the server', createSnapshot: 'Couldn’t save a backup', restoreSnapshot: 'Couldn’t restore the backup',
    saveProfile: 'Couldn’t save the launch settings', configureSimpleProfile: 'Couldn’t save Java and memory', pickJava: 'Couldn’t use that Java',
    saveSettings: 'Couldn’t save your settings', saveRelay: 'Couldn’t save the relay', addPeer: 'Couldn’t save the trusted peer',
    sendSnapshot: 'Couldn’t send the snapshot', handoff: 'Couldn’t hand off hosting', sendCommand: 'Couldn’t send the command',
    startPeerListener: 'Couldn’t start the listener', cleanUp: 'Couldn’t free up space', addMods: 'Couldn’t add the mods',
    removeMod: 'Couldn’t remove the mod', exportClientPack: 'Couldn’t export the client pack', installMod: 'Couldn’t install the mod',
    saveModTarget: 'Couldn’t save mod compatibility', createInvite: 'Couldn’t create an invitation', joinWithInvite: 'Couldn’t join the group',
    parkAtRelay: 'Couldn’t hand off to the always-on PC', claimFromRelay: 'Couldn’t take over hosting', saveOnboarding: 'Couldn’t save your setup progress',
    saveGameGateway: 'Couldn’t save the player address', checkGameGateway: 'Couldn’t test the player address', recoverStopped: 'Couldn’t recover ownership',
    selectServer: 'Couldn’t switch servers', deleteServer: 'Couldn’t delete the server', managePlayer: 'Couldn’t manage the player',
    saveServerSchedule: 'Couldn’t save the schedule', deleteServerSchedule: 'Couldn’t delete the schedule', runServerSchedule: 'Couldn’t run the schedule',
    alwaysOnEnable: 'Couldn’t make this the always-on PC', alwaysOnDisable: 'Couldn’t turn off the always-on PC', alwaysOnNewCode: 'Couldn’t make a new code',
    pairAlwaysOn: 'Couldn’t connect to the always-on PC', publicAddressEnable: 'Couldn’t set up the public address', publicAddressDisable: 'Couldn’t turn off the public address', setupFabricMods: 'Couldn’t install the mods',
  };
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const setLed = (id, kind) => { $(id).className = kind ? `led led-${kind}` : 'led'; };
  const PROCESS_LABELS = { offline: 'Stopped', failed: 'Failed', running: 'Running', starting: 'Starting', stopping: 'Stopping' };
  // Opens every page / settings category that contains a control, so focus and errors land on something visible.
  let selectPage = () => {};
  let selectCategory = () => {};
  function revealElement(node) {
    const tabs = [];
    for (let n = node; n; n = n.parentElement) if (n.getAttribute?.('role') === 'tabpanel' && n.hidden) tabs.unshift(n.getAttribute('aria-labelledby'));
    for (const id of tabs) {
      if (id.startsWith('settings-cat-')) selectCategory(id.slice('settings-cat-'.length));
      else selectPage(id.replace(/-tab$/, ''));
    }
    for (let n = node.parentElement; n; n = n.parentElement) if (n.tagName === 'DETAILS' && !n.open) n.open = true;
  }

  function showError(message, kind = 'action') {
    errorKind = kind;
    $('error-text').textContent = message;
    $('error-banner').hidden = false;
    if ($('setup-dialog').open) { $('setup-error').textContent = message; $('setup-error').hidden = false; }
  }

  const setupSteps = ['server', 'runtime', 'friends', 'gateway', 'ready'];
  const DEFAULT_SERVER_NAME = 'My Minecraft server';
  const RECENT_RELEASES = 10;

  let setupDraft = null;
  let setupAutoChecked = false;
  let setupReturnFocus = null;
  let setupMetadataLoading = false;
  let setupMetadataLoaded = false;
  let setupJava = [];
  let setupReleases = [];
  let setupLatest = '';
  let setupMode = 'choose';
  let setupGatewayDirty = false;
  let setupGatewayCheck = null;
  let setupGatewayContext = null;
  let setupCustomJavaDirty = false;
  // Display only the supported single-token prefix. The core validator is authoritative on save.
  const customJvmNames = new Set(['UseG1GC', 'UseZGC', 'UseShenandoahGC', 'UseParallelGC', 'UseSerialGC', 'MaxGCPauseMillis', 'DisableExplicitGC', 'AlwaysPreTouch', 'UseStringDeduplication', 'ParallelRefProcEnabled', 'UnlockExperimentalVMOptions', 'UnlockDiagnosticVMOptions', 'G1NewSizePercent', 'G1MaxNewSizePercent', 'G1HeapRegionSize', 'G1ReservePercent', 'G1HeapWastePercent', 'G1MixedGCCountTarget', 'InitiatingHeapOccupancyPercent', 'G1MixedGCLiveThresholdPercent', 'G1RSetUpdatingPauseTimePercent', 'SurvivorRatio', 'PerfDisableSharedMem', 'MaxTenuringThreshold', 'ParallelGCThreads', 'ConcGCThreads', 'UseNUMA', 'UseNUMAInterleaving']);
  function profileCustomJavaArgs() {
    const args = state?.server?.profile?.args || [];
    const end = args.findIndex(arg => !arg.startsWith('-') || ['-jar', '-cp', '-classpath', '--class-path', '-p', '--module-path', '-m', '--module', '--'].includes(arg) || /^(?:--class-path|--module-path|--module)=/.test(arg));
    return args.slice(0, end < 0 ? args.length : end).filter(arg => {
      const property = /^-D([A-Za-z0-9_.-]{1,128})=(.*)$/.exec(arg);
      if (property) return property[1] === 'java.awt.headless' || !/^(?:java|javax|jdk|sun)\./i.test(property[1]);
      const flag = /^-XX:(?:[+-]([A-Za-z][A-Za-z0-9]{0,63})|([A-Za-z][A-Za-z0-9]{0,63})=([A-Za-z0-9.+-]{1,64}))$/.exec(arg);
      return Boolean(flag && customJvmNames.has(flag[1] || flag[2])) || /^(?:-ea|-da|-server|-Xss\d+[kKmMgG])$/.test(arg);
    });
  }
  $('setup-custom-java-args').addEventListener('input', () => { setupCustomJavaDirty = true; $('setup-custom-java-args').removeAttribute('aria-invalid'); });
  const defaultSetup = () => ({ step: 'server', dismissed: false, completed: false, skipped: [], draft: { name: DEFAULT_SERVER_NAME, loader: 'vanilla', gameVersion: '', memoryMiB: 2048 } });
  const setupPrepared = () => Boolean(state?.server?.profile?.executable && state.server.profile.args?.length && !state.server.modInstallError);
  const formatMemory = (mib) => mib % 1024 === 0 ? `${mib / 1024} GB` : `${(mib / 1024).toFixed(1)} GB`;
  const formatBytes = (bytes) => bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  function profileMemoryMiB() {
    const flag = state?.server?.profile?.args?.find(arg => /^-Xmx\d+[mMgG]$/.test(arg));
    const match = flag && /^-Xmx(\d+)([mMgG])$/.exec(flag);
    return match ? Number(match[1]) * (match[2].toLowerCase() === 'g' ? 1024 : 1) : null;
  }
  // Keep unusual imported values exact. Opening the guide never rewrites the launch profile.
  function fillMemory(id, selected) {
    $(id).step = Number.isSafeInteger(selected) && selected % 512 !== 0 ? '1' : '512';
    $(id).value = String(Number.isSafeInteger(selected) ? selected : 2048);
    renderMemoryValue();
  }
  function renderMemoryValue() {
    const memory = Number($('setup-runtime-memory').value);
    const label = `${formatMemory(memory)} (${memory.toLocaleString()} MiB)`;
    $('setup-memory-value').textContent = label;
    $('setup-runtime-memory').setAttribute('aria-valuetext', label);
  }
  $('setup-runtime-memory').addEventListener('input', renderMemoryValue);
  // Tiles and chips are the visible controls. Each hidden <select> stays the single form value the guide
  // reads and validates; picks flow into it and programmatic changes flow back onto the tiles.
  function syncBridges() {
    for (const group of document.querySelectorAll('[data-bridge]')) {
      const select = $(group.dataset.bridge);
      if (group.classList.contains('chip-options')) {
        const options = [...select.options];
        const signature = JSON.stringify(options.map((option) => [option.value, option.textContent]));
        if (group.dataset.signature !== signature) {
          group.dataset.signature = signature;
          group.replaceChildren(...options.map((option) => {
            const [size, note] = option.textContent.split(' · ');
            const chip = element('label', 'chip-option');
            const input = element('input');
            input.type = 'radio'; input.name = `${select.id}-choice`; input.value = option.value;
            chip.append(input, element('span', 'chip-value', size));
            if (note) chip.append(element('span', 'chip-note', note));
            return chip;
          }));
        }
      }
      for (const input of group.querySelectorAll('input[type="radio"]')) {
        input.checked = input.value === select.value;
        input.disabled = select.disabled;
      }
    }
  }
  // Live preview of the world being created: it follows every choice and says plainly what is still needed.
  function renderWorldPreview() {
    const name = $('setup-name').value.trim();
    $('world-preview-name').textContent = name || 'Untitled world';
    $('world-preview-meta').textContent = [$('setup-loader').value === 'fabric' ? 'Fabric · mods ready' : 'Vanilla', $('setup-version').value || 'pick a version', 'memory adjustable next'].join(' · ');
    const missing = [!name && 'a name', !$('setup-version').value && 'a version'].filter(Boolean);
    $('world-preview-ready').textContent = missing.length ? 'Still needed: ' + missing.join(', ') : 'Ready to create ✓';
    $('world-preview-ready').classList.toggle('is-ready', !missing.length);
  }
  for (const id of ['setup-name', 'setup-loader', 'setup-version']) {
    for (const type of ['input', 'change']) $(id).addEventListener(type, renderWorldPreview);
  }
  const NAME_START = ['Mossy', 'Sunny', 'Willow', 'Amber', 'Clover', 'Maple', 'Misty', 'Pebble', 'Fern', 'Honey', 'Cedar', 'Bramble', 'Starlit', 'Copper', 'Juniper', 'Sprout'];
  const NAME_END = ['Hollow', 'Meadow', 'Grove', 'Shores', 'Valley', 'Ridge', 'Haven', 'Glade', 'Peaks', 'Springs', 'Orchard', 'Cove', 'Fields', 'Hills', 'Isle', 'Garden'];
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  $('setup-random-name').addEventListener('click', () => {
    if ($('setup-random-name').disabled) return;
    let next;
    do next = pick(NAME_START) + ' ' + pick(NAME_END); while (next === $('setup-name').value);
    $('setup-name').value = next;
    $('setup-name').removeAttribute('aria-invalid');
    $('setup-name').dispatchEvent(new Event('input', { bubbles: true }));
    $('setup-random-name').classList.remove('is-rolling');
    void $('setup-random-name').offsetWidth; // Restart the roll animation.
    $('setup-random-name').classList.add('is-rolling');
  });
  // Sunflower seed-head pattern (golden-angle phyllotaxis) for the decorative art.
  for (const svg of document.querySelectorAll('svg.phyllo')) {
    const count = Number(svg.dataset.seeds) || 120;
    const step = 92 / Math.sqrt(count);
    for (let n = 1; n <= count; n++) {
      const angle = n * 2.399963229728653, radius = step * Math.sqrt(n);
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', (radius * Math.cos(angle)).toFixed(2));
      dot.setAttribute('cy', (radius * Math.sin(angle)).toFixed(2));
      dot.setAttribute('r', (1.1 + 2.7 * n / count).toFixed(2));
      svg.append(dot);
    }
  }
  for (const group of document.querySelectorAll('[data-bridge]')) {
    const select = $(group.dataset.bridge);
    group.addEventListener('change', (event) => {
      if (event.target.type !== 'radio' || select.disabled) return;
      select.value = event.target.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    select.addEventListener('change', syncBridges);
  }
  function setupPayload() {
    return { step: setupDraft.step, dismissed: setupDraft.dismissed, completed: setupDraft.completed, skipped: [...setupDraft.skipped], draft: { name: $('setup-name').value, loader: $('setup-loader').value, gameVersion: $('setup-version').value, memoryMiB: Number($('setup-runtime-memory').value) } };
  }
  function renderVersions() {
    const selected = $('setup-version').value || setupDraft?.draft.gameVersion || '';
    const showAll = $('setup-all-versions').checked;
    const ids = setupReleases.map(v => v.id);
    const shown = showAll ? ids : ids.slice(0, RECENT_RELEASES);
    if (selected && !shown.includes(selected)) shown.push(selected);
    const placeholder = element('option', '', setupMetadataLoading && !ids.length ? 'Loading versions…' : 'Choose a version'); placeholder.value = '';
    $('setup-version').replaceChildren(placeholder, ...shown.map(id => { const option = element('option', '', id === setupLatest ? `${id} · latest` : id); option.value = id; return option; }));
    $('setup-version').value = selected || (shown.includes(setupLatest) ? setupLatest : '');
  }
  function stepDone(step) {
    const checks = setupChecks();
    return checks[step] === 'complete' || checks[step] === 'skipped';
  }
  // Configuration alone, without the saved completed flag: the payload asks to complete, so it cannot read its own prior state.
  function setupResolved() {
    const checks = setupChecks();
    return checks.server === 'complete' && checks.runtime === 'complete' && [checks.friends, checks.gateway].every(check => check === 'complete' || check === 'skipped');
  }
  // Configured setup, not visited stages. The main process reports the same derivation after persistence.
  function setupChecks() {
    const server = state?.server;
    const runtime = server?.modInstallError ? 'unavailable' : setupPrepared() ? 'complete' : 'pending';
    const gatewayConfigured = Boolean(alwaysOnStatus?.running && !alwaysOnStatus.error || state?.gateway?.enabled === true && state?.relay && !state?.gateway?.error);
    const gateway = gatewayConfigured ? 'complete' : setupDraft?.skipped.includes('gateway') ? 'skipped' : state?.gateway?.error || alwaysOnStatus?.error ? 'unavailable' : 'pending';
    return {
      server: server ? 'complete' : 'pending',
      runtime,
      friends: state?.relay ? 'complete' : setupDraft?.skipped.includes('friends') ? 'skipped' : 'pending',
      gateway,
      ready: state?.onboarding?.completed && !server?.modInstallError && Boolean(server?.profile?.executable && server.profile.args?.length) && runtime === 'complete' && ['complete', 'skipped'].includes(state?.relay ? 'complete' : setupDraft?.skipped.includes('friends') ? 'skipped' : 'pending') && ['complete', 'skipped'].includes(gateway) ? 'complete' : 'pending',
    };
  }
  function renderReadySummary() {
    const server = state?.server;
    const java = server?.profile?.executable ? setupJava.find(j => j.executable === server.profile.executable) : null;
    const memory = profileMemoryMiB();
    const checks = setupChecks();
    const optional = [checks.friends, checks.gateway];
    const rows = [
      [Boolean(server), server ? `Server: ${server.name}` : 'Server: not created yet — go back to “Your server”.'],
      [setupPrepared(), setupPrepared() ? `Runs with ${java ? `Java ${java.major}` : 'your chosen Java'}${memory ? ` and ${formatMemory(memory)} of memory` : ''}.` : server?.modInstallError ? `Java & memory: unavailable until this is repaired — ${server.modInstallError}` : 'Java & memory: not set yet.'],
      [checks.friends === 'complete', state?.relay ? `Friends: in group “${state.relay.name}”.` : checks.friends === 'skipped' ? 'Friends: skipped — add them any time from the Friends tab.' : 'Friends: not set up yet — finish the step or explicitly skip it.'],
      [checks.gateway === 'complete', checks.gateway === 'unavailable' ? `Always-on PC: unavailable until this is repaired — ${state?.gateway?.error || alwaysOnStatus?.error}` : checks.gateway === 'complete' ? 'Always-on PC: ready to give players one address.' : checks.gateway === 'skipped' ? 'Always-on PC: skipped — you can add one later.' : 'Always-on PC: not set up yet — finish the step or explicitly skip it.'],
    ];
    const signature = JSON.stringify(rows);
    if ($('setup-ready-list').dataset.signature === signature) return;
    $('setup-ready-list').dataset.signature = signature;
    $('setup-ready-list').replaceChildren(...rows.map(([done, text]) => { const item = element('li', done ? 'is-done' : '', text); return item; }));
    $('setup-ready-copy').textContent = state?.onboarding?.completed && optional.every(check => check === 'complete' || check === 'skipped') ? 'Setup is complete. You can reopen this guide any time from the sidebar.' : 'Finish your server and memory, then either set up Friends and the always-on PC or skip those optional steps. Nothing is falsely marked done.';
  }
  function renderSetup() {
    const blocked = !bridgeReady || isBusy();
    $('nav-setup').disabled = !bridgeReady;
    for (const id of ['create-server-empty', 'import-server-empty', 'setup-open-friends']) $(id).disabled = blocked;
    if (!setupAutoChecked && bridgeReady) {
      setupAutoChecked = true;
      if (!state.server && state.onboarding && !state.onboarding.dismissed && !state.onboarding.completed) queueMicrotask(() => openSetup());
    }
    if (!$('setup-dialog').open || !setupDraft) return;
    const step = setupDraft.step, server = state.server;
    // The guide never moves the account card: Friends and hosting stay in their own workspaces.
    for (const panel of document.querySelectorAll('[data-setup-panel]')) panel.hidden = panel.dataset.setupPanel !== step;
    for (const button of document.querySelectorAll('[data-setup-step]')) {
      button.setAttribute('aria-current', button.dataset.setupStep === step ? 'step' : 'false');
      button.dataset.done = String(stepDone(button.dataset.setupStep));
      button.dataset.status = setupChecks()[button.dataset.setupStep];
      button.title = { complete: 'Configured', skipped: 'Skipped — you can set this up any time', pending: 'Not set up yet', unavailable: 'Unavailable until the problem is repaired' }[button.dataset.status];
      button.disabled = blocked;
    }
    $('setup-title').textContent = server ? 'Setup guide' : 'Welcome to Seed Hosting';
    for (const id of ['setup-back', 'setup-later', 'setup-save-close', 'setup-skip', 'setup-unskip', 'setup-next']) $(id).disabled = blocked;
    $('setup-back').hidden = step === 'server' && (setupMode !== 'create' || Boolean(server));
    $('setup-skip').hidden = !['friends', 'gateway'].includes(step) || setupChecks()[step] === 'complete';
    $('setup-unskip').hidden = !['friends', 'gateway'].includes(step) || !setupDraft.skipped.includes(step);
    $('setup-next').hidden = step === 'server' && !server;
    $('setup-next').textContent = step === 'ready' ? 'Go to my server' : step === 'server' ? 'Continue' : 'Next';
    $('setup-later').hidden = step === 'ready';
    // Server stage: a plain choice first; the creation form appears only once the user picks it.
    $('setup-intro').hidden = Boolean(server) || setupMode === 'create';
    $('setup-choices').hidden = Boolean(server) || setupMode === 'create';
    $('setup-create-form').hidden = Boolean(server) || setupMode !== 'create';
    $('setup-name').disabled = blocked || Boolean(server);
    for (const id of ['setup-loader', 'setup-version', 'setup-all-versions', 'setup-create']) $(id).disabled = blocked || Boolean(server);
    $('setup-existing').hidden = !server;
    $('setup-existing').textContent = server ? `✓ “${server.name}” is ready on this PC. Continue to check its Java and memory.` : '';
    $('setup-import').disabled = blocked || Boolean(server);
    $('setup-choose-create').disabled = blocked || Boolean(server);
    $('setup-choose-join').disabled = blocked;
    // Runtime stage.
    for (const id of ['setup-runtime-java', 'setup-runtime-memory', 'setup-custom-java-args', 'setup-runtime-pick', 'setup-profile-save']) $(id).disabled = blocked || !server || !isStopped() || !ownsServer() || Boolean(server.modInstallError);
    $('setup-runtime-feedback').textContent = !server ? 'Create or import a server first.' : !isStopped() ? 'Stop the server before changing Java or memory.' : !ownsServer() ? 'Ownership is not confirmed on this PC. Recover local ownership or check the group before changing settings.' : server.modInstallError ? server.modInstallError : $('setup-runtime-feedback').textContent || '';
    // Always-on PC stage.
    renderAlwaysOn(blocked);
    renderSetupMods(blocked, server);
    for (const id of ['setup-gateway-enabled', 'setup-gateway-port', 'setup-gateway-save', 'setup-gateway-check']) $(id).disabled = blocked;
    $('setup-storage-check').disabled = blocked || !state.relay;
    if (!state.relay && !$('setup-storage-status').dataset.checked) $('setup-storage-status').textContent = 'Join the always-on PC’s group first (Friends step).';
    if (!setupGatewayDirty) { $('setup-gateway-enabled').checked = state.gateway?.enabled === true; $('setup-gateway-port').value = state.gateway?.localPort ?? 25565; }
    const gatewayContext = JSON.stringify([state.relay?.fingerprint, state.gateway, state.server?.state, state.server?.ownership]);
    if (gatewayContext !== setupGatewayContext) { setupGatewayContext = gatewayContext; setupGatewayCheck = null; }
    $('setup-gateway-status').textContent = setupGatewayCheck || `Not checked yet · player address is ${state.gateway?.enabled ? 'on' : 'off'}${state.gateway?.detail ? ` (${state.gateway.detail})` : ''}.`;
    $('setup-status').textContent = blocked ? busyLabels[pendingMethod || state?.busy] || 'Saving…' : 'Progress is saved automatically.';
    // Ready stage.
    $('setup-ready-title').textContent = state?.onboarding?.completed && setupChecks().ready === 'complete' ? 'You’re all set' : 'Almost there';
    renderReadySummary();
    syncBridges();
    $('setup-random-name').disabled = $('setup-name').disabled;
    renderWorldPreview();
  }
  function openSetup(step) {
    if (!bridgeReady || isBusy()) return;
    if (!$('setup-dialog').open) {
      const saved = state.onboarding;
      setupDraft = saved && setupSteps.includes(saved.step) && saved.draft ? { step: saved.step, dismissed: saved.dismissed, completed: saved.completed, skipped: [...(saved.skipped || [])], draft: { ...saved.draft } } : defaultSetup();
      setupMode = setupDraft.draft.gameVersion || setupDraft.draft.name !== DEFAULT_SERVER_NAME ? 'create' : 'choose';
      $('setup-name').value = setupDraft.draft.name;
      $('setup-loader').value = setupDraft.draft.loader;
      fillMemory('setup-runtime-memory', profileMemoryMiB() ?? setupDraft.draft.memoryMiB);
      setupCustomJavaDirty = false;
      $('setup-custom-java-args').value = JSON.stringify(profileCustomJavaArgs(), null, 2);
      $('setup-runtime-feedback').textContent = '';
      delete $('setup-storage-status').dataset.checked;
      setupGatewayDirty = false;
      // Preserve a saved release even when offline; metadata never overwrites an explicit draft.
      $('setup-version').replaceChildren();
      renderVersions();
      setupReturnFocus = document.activeElement;
      $('setup-error').hidden = true;
      $('setup-close-unsaved').hidden = true;
      if (state.onboarding?.error) { $('setup-error').textContent = state.onboarding.error; $('setup-error').hidden = false; }
      $('setup-dialog').showModal();
      if (!setupMetadataLoaded) void loadSetupMetadata();
      void refreshAlwaysOn();
    }
    if (step) setupDraft.step = step;
    renderSetup(); $('setup-save-close').focus();
  }
  function closeSetup() {
    if (isBusy()) return false;
    $('setup-dialog').close(); setupReturnFocus?.focus();
    return true;
  }
  async function saveSetup(step, close = false, skipped = false) {
    if (!setupDraft || isBusy()) return;
    const payload = setupPayload();
    if (skipped && !payload.skipped.includes(payload.step)) payload.skipped.push(payload.step);
    payload.step = step; payload.dismissed = close;
    payload.completed = step === 'ready' && close && setupResolved();
    $('setup-error').hidden = true;
    const saved = await runAction('saveOnboarding', payload, () => {
      const actual = state.onboarding;
      if (!actual || Object.keys(payload).some(key => JSON.stringify(actual[key]) !== JSON.stringify(payload[key]))) throw new Error('Saved setup could not be confirmed. Your draft remains open.');
      setupDraft = payload;
    });
    if (!saved) { $('setup-close-unsaved').hidden = false; return; }
    if (close) closeSetup();
    else { renderSetup(); $('setup-dialog').querySelector('.setup-body').scrollTop = 0; $('setup-save-close').focus(); }
  }
  $('nav-setup').addEventListener('click', () => openSetup());
  $('open-gateway-setup').addEventListener('click', () => openSetup('gateway'));
  $('create-server-empty').addEventListener('click', () => { openSetup('server'); if (!state?.server) { setupMode = 'create'; renderSetup(); $('setup-name').focus(); } });
  $('add-server').addEventListener('click', () => { if ($('add-server').disabled) return; openSetup('server'); setupMode = 'create'; renderSetup(); $('setup-name').focus(); });
  $('server-list').addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
    if (!button || button.disabled) return;
    const id = button.dataset.id;
    if (button.dataset.action === 'select') return runAction('selectServer', { id }, () => { $('server-list').dataset.signature = ''; });
    if (button.dataset.action === 'delete') return runAction('deleteServer', { id }, () => { $('server-list').dataset.signature = ''; });
  });
  $('import-server-empty').addEventListener('click', () => { openSetup('server'); $('setup-import').focus(); });
  $('setup-choose-create').addEventListener('click', () => { if ($('setup-choose-create').disabled) return; setupMode = 'create'; renderSetup(); $('setup-name').focus(); });
  $('setup-choose-join').addEventListener('click', async () => {
    if ($('setup-choose-join').disabled) return;
    await saveSetup('friends');
    if (!$('setup-dialog').open || setupDraft?.step !== 'friends') return;
    await routeGuideToAccountJoin();
  });
  $('setup-all-versions').addEventListener('change', renderVersions);
  for (const button of document.querySelectorAll('[data-setup-step]')) button.addEventListener('click', () => saveSetup(button.dataset.setupStep));
  for (const id of ['setup-save-close', 'setup-later']) $(id).addEventListener('click', () => saveSetup(setupDraft.step, true));
  $('setup-dialog').addEventListener('cancel', event => { event.preventDefault(); void saveSetup(setupDraft.step, true); });
  $('setup-close-unsaved').addEventListener('click', () => closeSetup());
  $('setup-dialog').addEventListener('close', () => {
    renderFriends();
  });
  $('setup-back').addEventListener('click', () => {
    if (setupDraft.step === 'server' && setupMode === 'create') { setupMode = 'choose'; return renderSetup(); }
    return saveSetup(setupSteps[Math.max(0, setupSteps.indexOf(setupDraft.step) - 1)]);
  });
  // “Join a friend’s world” lands on the Friends page: the guide closes first, then sign-in or the add-by-username form is focused.
  let joinRouteToken = 0;
  async function routeGuideToAccountJoin() {
    const token = ++joinRouteToken;
    if ($('setup-dialog').open && !closeSetup()) return;
    window.seedDashboard.selectPage('friends');
    let account = null;
    try { account = await window.seedhost.call('accountStatus'); } catch { account = null; }
    // A slow status reply never focuses stale controls after another navigation, guide open, or sign-out.
    if (token !== joinRouteToken || $('friends-tab').getAttribute('aria-selected') !== 'true' || $('setup-dialog').open) return;
    if (account && account.signedIn && !$('friend-add-form').hidden) return $('friend-add-username').focus();
    // Signed out (or status unavailable): surface the sign-in prompt. Focus the opener before its click so dismissal returns there.
    $('account-open').focus();
    if (!$('account-open').disabled) $('account-open').click();
  }
  $('setup-open-friends').addEventListener('click', () => { if (!$('setup-open-friends').disabled) void routeGuideToAccountJoin(); });
  // A page change closes the guide, so it can never float over a different workspace.
  window.addEventListener('seedhost-page-changed', () => { if ($('setup-dialog').open && !isBusy()) closeSetup(); });
  $('setup-next').addEventListener('click', () => saveSetup(setupSteps[Math.min(4, setupSteps.indexOf(setupDraft.step) + 1)], setupDraft.step === 'ready'));
  $('setup-skip').addEventListener('click', () => saveSetup(setupSteps[setupSteps.indexOf(setupDraft.step) + 1], false, true));
  $('setup-unskip').addEventListener('click', () => {
    if (!setupDraft || isBusy() || !setupDraft.skipped.includes(setupDraft.step)) return;
    setupDraft.skipped = setupDraft.skipped.filter(name => name !== setupDraft.step);
    return saveSetup(setupDraft.step);
  });
  $('setup-import').addEventListener('click', async () => { if (!$('setup-import').disabled) { await runAction('importServer'); if (state.server) await saveSetup('runtime'); } });

  async function loadSetupMetadata() {
    if (setupMetadataLoading) return;
    setupMetadataLoading = true; renderSetup();
    const results = await Promise.allSettled([window.seedhost.call('listServerVersions'), window.seedhost.call('discoverJava')]);
    try {
      if (results[0].status === 'fulfilled') {
        const { latest, versions } = results[0].value;
        if (!Array.isArray(versions) || versions.some(v => typeof v.id !== 'string')) throw new Error('Invalid release list.');
        setupReleases = versions; setupLatest = latest;
      }
      if (results[1].status === 'fulfilled') {
        if (!Array.isArray(results[1].value)) throw new Error('Invalid Java discovery result.');
        setupJava = [...results[1].value].sort((x, y) => y.major - x.major);
      }
      setupMetadataLoaded = results.every(r => r.status === 'fulfilled');
      const failures = results.filter(r => r.status === 'rejected');
      if (failures.length) showError(`Couldn’t load ${results[0].status === 'rejected' ? 'Minecraft versions (check your internet connection)' : 'the Java list'}: ${failures.map(r => errorMessage(r.reason)).join('; ')}.`);
    } catch (error) { showError(errorMessage(error)); }
    finally { setupMetadataLoading = false; renderVersions(); renderSetupJava(); renderSetup(); }
  }
  // Java is automatic when creating a world (found on this PC or installed from Mojang's official runtimes).
  // Only the Java & memory step lists runtimes, for imported servers or a deliberate change.
  function renderSetupJava() {
    const runtimeSelected = $('setup-runtime-java').value || state?.server?.profile?.executable || '';
    const candidates = [...setupJava];
    if (runtimeSelected && !candidates.some(item => item.executable === runtimeSelected)) candidates.push({ executable: runtimeSelected, major: '' });
    const runtimePlaceholder = element('option', '', 'Select Java'); runtimePlaceholder.value = '';
    $('setup-runtime-java').replaceChildren(runtimePlaceholder, ...candidates.map(java => { const option = element('option', '', java.major ? `Java ${java.major} · ${java.executable}` : `Current · ${java.executable}`); option.value = java.executable; return option; }));
    $('setup-runtime-java').value = runtimeSelected;
  }
  $('setup-runtime-pick').addEventListener('click', () => runAction('pickJava', undefined, java => {
    if (!java) return;
    setupJava = [...setupJava.filter(item => item.executable !== java.executable), java];
    renderSetupJava(); $('setup-runtime-java').value = java.executable;
  }));
  $('setup-runtime-form').addEventListener('submit', event => {
    event.preventDefault(); if (!$('setup-dialog').open || setupDraft?.step !== 'runtime' || $('setup-profile-save').disabled) return;
    const javaExecutable = $('setup-runtime-java').value, memoryMiB = Number($('setup-runtime-memory').value);
    if (!javaExecutable) return invalid('setup-runtime-java', 'Choose which Java to use.');
    if (!Number.isSafeInteger(memoryMiB) || memoryMiB < 512 || memoryMiB > 65536) return invalid('setup-runtime-memory', 'Choose an amount of memory.');
    let customJavaArgs;
    if (setupCustomJavaDirty) {
      try { customJavaArgs = JSON.parse($('setup-custom-java-args').value); }
      catch { return invalid('setup-custom-java-args', 'Enter valid JSON: an array of JVM argument strings.'); }
      if (!Array.isArray(customJavaArgs) || customJavaArgs.length > 32 || customJavaArgs.some(arg => typeof arg !== 'string' || arg.length > 1024 || /[\x00-\x1f\x7f]/.test(arg)) || customJavaArgs.join('').length > 8192) return invalid('setup-custom-java-args', 'Custom Java arguments must be a bounded JSON string array without control characters.');
    }
    return runAction('configureSimpleProfile', { javaExecutable, memoryMiB, ...(customJavaArgs ? { customJavaArgs } : {}) }, () => {
      if (state.server?.profile?.executable !== javaExecutable || profileMemoryMiB() !== memoryMiB) throw new Error('Saved Java and RAM profile could not be confirmed.');
      if (customJavaArgs && JSON.stringify(profileCustomJavaArgs()) !== JSON.stringify(customJavaArgs)) throw new Error('Saved custom Java arguments could not be confirmed.');
      setupCustomJavaDirty = false;
      $('setup-custom-java-args').value = JSON.stringify(profileCustomJavaArgs(), null, 2);
      $('setup-runtime-feedback').textContent = `Saved · ${formatMemory(memoryMiB)} of memory.`;
    });
  });
  $('setup-advanced').addEventListener('click', async () => { await saveSetup(setupDraft.step, true); if (!$('setup-dialog').open) { revealElement($('java-executable')); $('java-executable').focus(); } });
  for (const id of ['setup-gateway-enabled', 'setup-gateway-port']) $(id).addEventListener('input', () => { setupGatewayDirty = true; setupGatewayCheck = null; });
  $('setup-gateway-form').addEventListener('submit', event => {
    event.preventDefault(); if ($('setup-gateway-save').disabled) return;
    const enabled = $('setup-gateway-enabled').checked, localPort = Number($('setup-gateway-port').value);
    if (!Number.isSafeInteger(localPort) || localPort < 1 || localPort > 65535) return invalid('setup-gateway-port', 'Enter a local Minecraft port from 1 to 65535.');
    return runAction('saveGameGateway', { enabled, localPort }, () => {
      if (state.gateway?.enabled !== enabled || state.gateway?.localPort !== localPort) throw new Error('Saved gateway opt-in could not be confirmed.');
      setupGatewayDirty = false; setupGatewayCheck = null;
    });
  });
  $('setup-gateway-check').addEventListener('click', async () => {
    setupGatewayCheck = null;
    const checked = await runAction('checkGameGateway', undefined, result => {
      if (!result || typeof result.ready !== 'boolean' || typeof result.enabled !== 'boolean') throw new Error('Gateway returned an invalid check result.');
      setupGatewayCheck = result.ready ? `Verified · players can use ${formatEndpoint(result.host, result.port)} (${result.detail}). Try joining from a friend’s network to be sure it’s reachable from the internet.` : `Not ready · ${result.detail || 'this PC isn’t hosting through the always-on PC yet'}. It turns on automatically while you host.`;
    });
    if (!checked) setupGatewayCheck = `Unreachable · ${$('setup-error').textContent}`;
    renderSetup();
  });
  $('setup-storage-check').addEventListener('click', async () => {
    $('setup-storage-status').dataset.checked = 'true';
    $('setup-storage-status').textContent = 'Checking the always-on PC…';
    const checked = await runAction('checkRelay', undefined, result => {
      $('setup-storage-status').textContent = result ? '✓ Connected · the always-on PC has a copy of your world.' : '✓ Connected · no world stored there yet. Stop your server and choose “Hand off to always-on PC”.';
    });
    if (!checked) $('setup-storage-status').textContent = `Couldn’t reach the always-on PC · ${$('setup-error').textContent}`;
  });
  for (const button of document.querySelectorAll('[data-setup-link]')) button.addEventListener('click', () => runAction('openSetupLink', { page: button.dataset.setupLink }));
  $('setup-create-form').addEventListener('submit', async event => {
    event.preventDefault(); if ($('setup-create').disabled) return;
    const draft = setupPayload().draft;
    if (!draft.name.trim() || /[\0\r\n]/.test(draft.name)) return invalid('setup-name', 'Give your server a name.');
    if (!draft.gameVersion) return invalid('setup-version', 'Choose a Minecraft version.');
    if (!Number.isSafeInteger(draft.memoryMiB) || draft.memoryMiB < 512 || draft.memoryMiB > 65536) return invalid('setup-runtime-memory', 'Choose an amount of memory on the Memory step.');
    $('setup-error').hidden = true;
    // Empty Java = automatic. Pressing Create is the EULA agreement shown beside the button.
    await runAction('createServer', { ...draft, javaExecutable: '', eulaAccepted: true });
    if (state.server && draft.loader === 'fabric' && setupPickedMods.size) {
      const picked = [...setupPickedMods.keys()];
      await runAction('setupFabricMods', { projectIds: picked }, result => {
        const failed = result?.failed ?? [];
        setupPickedMods.clear();
        if (failed.length) showError(`Some mods couldn’t be added: ${failed.map(f => `${setupModTitles.get(f.projectId) ?? f.projectId} (${f.reason})`).join('; ')}. You can try others later under My server → Mods.`);
      });
    }
    if (state.server) { fillMemory('setup-runtime-memory', profileMemoryMiB() ?? draft.memoryMiB); $('setup-runtime-feedback').textContent = 'Ready — Java and memory are already set up.'; await loadSetupMetadata(); await saveSetup('runtime'); }
  });

  // ---------- Setup guide: pick Fabric mods before the world exists ----------
  const setupPickedMods = new Map(); // projectId → title, in pick order
  const setupModTitles = new Map();
  let setupModHits = [], setupModLoading = false, setupModQuery = null, setupModContext = null, setupModRequest = 0, setupModNotice = '';
  let setupModOffset = 0, setupModTotal = 0, setupModSort = 'downloads';
  const sortScopeNote = sort => sort.startsWith('title-') ? ' Alphabetical order applies only to this loaded page, not the full Modrinth catalogue; pages are selected by downloads.' : '';
  const sortLabel = id => $(id).selectedOptions[0]?.textContent || 'Downloads';
  async function searchSetupMods(offset = 0, query = $('setup-mod-query').value.trim(), sort = $('setup-mod-sort').value) {
    const gameVersion = $('setup-version').value;
    if (!gameVersion || $('setup-loader').value !== 'fabric') return;
    const token = ++setupModRequest;
    const context = setupModContext;
    setupModLoading = true; setupModNotice = ''; setupModQuery = query; setupModSort = sort; setupModHits = []; renderSetup();
    try {
      const result = await window.seedhost.call('searchSetupMods', { query, gameVersion, offset, sort });
      if (token !== setupModRequest || context !== setupModContext) return;
      if (!Array.isArray(result?.hits) || !Number.isSafeInteger(result.total) || result.total < 0) throw new Error('Modrinth returned an invalid search result.');
      setupModHits = result.hits; setupModOffset = offset; setupModTotal = result.total;
      if (!setupModHits.length) setupModNotice = query ? `No Fabric mods for ${gameVersion} match “${query}”.` : `No Fabric mods found for ${gameVersion}.`;
    } catch (error) {
      if (token !== setupModRequest || context !== setupModContext) return;
      setupModHits = []; setupModOffset = 0; setupModTotal = 0; setupModNotice = `Couldn’t reach Modrinth: ${errorMessage(error)} You can add mods later too.`;
    } finally { if (token === setupModRequest) { setupModLoading = false; renderSetup(); } }
  }
  function renderSetupMods(blocked, server) {
    const fabric = $('setup-loader').value === 'fabric';
    const version = $('setup-version').value;
    const context = JSON.stringify([fabric, version]);
    if (setupModContext !== context) {
      setupModContext = context; setupModRequest++; setupModLoading = false;
      setupModHits = []; setupModQuery = null; setupModOffset = 0; setupModTotal = 0; setupModNotice = '';
      setupPickedMods.clear();
    }
    $('setup-mods').hidden = !fabric || Boolean(server);
    if ($('setup-mods').hidden) return;
    if (version && !setupModLoading && setupModQuery === null && !setupModNotice) queueMicrotask(() => void searchSetupMods());
    for (const id of ['setup-mod-query', 'setup-mod-sort']) $(id).disabled = blocked || !version;
    $('setup-mod-search').disabled = blocked || !version || setupModLoading;
    $('setup-mod-status').textContent = (!version ? 'Choose a Minecraft version to see compatible mods.' : setupModLoading ? 'Searching Modrinth…' : setupModNotice || `${setupModQuery ? `Results for “${setupModQuery}”` : `Fabric mods for ${version}`} · ${sortLabel('setup-mod-sort')}.`) + sortScopeNote(setupModSort);
    $('setup-mod-list').setAttribute('aria-busy', String(setupModLoading));
    $('setup-mod-previous').disabled = blocked || setupModLoading || setupModOffset === 0;
    $('setup-mod-next').disabled = blocked || setupModLoading || !setupModHits.length || setupModOffset + MOD_PAGE_SIZE >= setupModTotal || setupModOffset + MOD_PAGE_SIZE > 10000;
    $('setup-mod-page').textContent = setupModHits.length ? `${setupModOffset + 1}–${setupModOffset + setupModHits.length} of ${setupModTotal.toLocaleString()}` : 'No results loaded';
    const signature = JSON.stringify([setupModHits.map(h => h.projectId), [...setupPickedMods.keys()], blocked]);
    if ($('setup-mod-list').dataset.signature !== signature) {
      $('setup-mod-list').dataset.signature = signature;
      $('setup-mod-list').replaceChildren(...setupModHits.map(hit => {
        setupModTitles.set(hit.projectId, hit.title);
        const picked = setupPickedMods.has(hit.projectId);
        const row = element('li', 'setup-mod' + (picked ? ' is-picked' : ''));
        let icon;
        if (hit.iconUrl) { icon = element('img'); icon.src = hit.iconUrl; icon.alt = ''; icon.loading = 'lazy'; icon.referrerPolicy = 'no-referrer'; }
        else icon = element('span', 'setup-mod-icon');
        const copy = element('div');
        copy.append(element('strong', '', hit.title), element('span', '', hit.description || `by ${hit.author}`));
        const button = element('button', 'button button-small' + (picked ? '' : ' button-primary'), picked ? 'Added ✓' : 'Add');
        button.type = 'button'; button.dataset.setupMod = hit.projectId; button.disabled = blocked;
        button.setAttribute('aria-pressed', String(picked)); button.setAttribute('aria-label', `${picked ? 'Remove' : 'Add'} ${hit.title}`);
        row.append(icon, copy, button);
        return row;
      }));
    }
    $('setup-mod-picked').hidden = !setupPickedMods.size;
    $('setup-mod-picked').textContent = setupPickedMods.size ? `${setupPickedMods.size} mod${setupPickedMods.size === 1 ? '' : 's'} will be installed: ${[...setupPickedMods.values()].join(', ')}` : '';
  }
  $('setup-mod-search').addEventListener('click', () => void searchSetupMods());
  $('setup-mod-sort').addEventListener('change', () => void searchSetupMods(0));
  $('setup-mod-next').addEventListener('click', () => { if (!$('setup-mod-next').disabled) void searchSetupMods(setupModOffset + MOD_PAGE_SIZE, setupModQuery, setupModSort); });
  $('setup-mod-previous').addEventListener('click', () => { if (!$('setup-mod-previous').disabled) void searchSetupMods(Math.max(0, setupModOffset - MOD_PAGE_SIZE), setupModQuery, setupModSort); });
  for (const id of ['setup-loader', 'setup-version']) $(id).addEventListener('change', () => renderSetup());
  $('setup-mod-query').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void searchSetupMods(); } });
  $('setup-mod-list').addEventListener('click', event => {
    const button = event.target.closest('button[data-setup-mod]');
    if (!button || button.disabled) return;
    const id = button.dataset.setupMod;
    if (setupPickedMods.has(id)) setupPickedMods.delete(id);
    else if (setupPickedMods.size < 50) setupPickedMods.set(id, setupModTitles.get(id) ?? id);
    renderSetup();
  });

  // ---------- Setup guide: one-click always-on PC ----------
  let alwaysOnStatus = null, alwaysOnMode = null, alwaysOnPaired = '', alwaysOnTimer = null;
  // ---------- Public address: one button on My server ----------
  // Each address belongs to the captured local server. Shared hosting has its own gateway controls.
  let publicStatus = null, publicTimer = null;
  let publicSelection = '', publicPort = null, publicGeneration = 0, publicRequest = 0, publicBusy = false;
  const PUBLIC_WORKING = ['downloading', 'approve', 'starting', 'creating', 'pending'];
  function syncPublicContext() {
    const id = state?.server?.id ?? '';
    const port = state?.server?.playerPort ?? null;
    if (id !== publicSelection || port !== publicPort) {
      publicSelection = id; publicPort = port; ++publicGeneration; ++publicRequest; publicStatus = null; publicBusy = false;
      $('public-value').textContent = ''; $('public-live').hidden = true;
    }
    return id;
  }
  async function refreshPublicAddress() {
    const id = syncPublicContext();
    if (!id || publicBusy) return;
    const generation = publicGeneration, request = ++publicRequest;
    try {
      const result = await window.seedhost.call('publicAddressStatus', { id });
      if (syncPublicContext() !== id || generation !== publicGeneration || request !== publicRequest) return;
      publicStatus = result;
    } catch (error) {
      if (syncPublicContext() !== id || generation !== publicGeneration || request !== publicRequest) return;
      publicStatus = { state: 'error', address: null, detail: String(error?.message ?? error), approveUrl: null };
    }
    renderPublicCard();
  }
  function renderPublicCard() {
    syncPublicContext();
    const stopped = publicStatus?.state === 'reachable' && state?.server?.state !== 'running';
    const st = stopped ? 'reserved' : publicStatus?.state ?? 'off', working = PUBLIC_WORKING.includes(st), card = $('public-card');
    const address = ['reachable', 'reserved'].includes(st) ? publicStatus.address : null;
    card.dataset.state = st;
    card.hidden = st === 'unsupported';
    $('public-title').textContent = address ? (st === 'reachable' ? 'Your world is open to friends 🎉' : 'Your address is ready') : working ? 'Setting up your address…' : st === 'error' ? 'That didn’t work' : 'Let friends join from anywhere';
    $('public-detail').textContent = address
      ? (st === 'reachable' ? 'Verified on this PC. Friends put this in Minecraft → Multiplayer → Add Server. This local address does not follow multi-host handoffs.' : stopped ? 'Address reserved. No running Minecraft process is tracked for this server on this PC.' : publicStatus.detail)
      : st === 'approve' ? 'playit.gg opened in your browser. Make a free account or log in, then click the big Approve button. Come back here after — the rest is automatic.'
      : working ? 'This takes about a minute. You don’t need to do anything.'
      : st === 'error' ? `${publicStatus.detail} Press the button to try again.`
      : publicStatus?.detail || 'Get an address for this server on this PC. No hosting group or helper is required. Each server needs a distinct Minecraft port.';
    $('public-steps').hidden = !working;
    const order = ['download', 'approve', 'address'], now = st === 'approve' ? 'approve' : ['downloading', 'starting'].includes(st) && !publicStatus?.approveUrl ? 'download' : 'address';
    for (const li of $('public-steps').querySelectorAll('li')) {
      li.classList.toggle('is-now', li.dataset.step === now);
      li.classList.toggle('is-done', order.indexOf(li.dataset.step) < order.indexOf(now));
    }
    $('public-live').hidden = !address;
    $('public-value').textContent = address ?? '';
    $('public-go').hidden = working || Boolean(address);
    $('public-go').textContent = st === 'error' ? 'Try again' : 'Get my address';
    $('public-approve').hidden = st !== 'approve';
    $('public-port-settings').hidden = st !== 'error' || !/port/i.test(publicStatus?.detail ?? '');
    $('public-off').hidden = !address && st !== 'error';
    $('public-off').textContent = 'Disconnect locally';
    const blocked = !bridgeReady || isBusy() || publicBusy || !publicSelection;
    for (const id of ['public-go', 'public-approve', 'public-off', 'public-copy', 'public-port-settings']) $(id).disabled = blocked;
    // Poll quickly while something is happening, slowly otherwise.
    const wanted = working ? 2000 : 30000;
    if (publicTimer?.ms !== wanted) { clearInterval(publicTimer?.id); publicTimer = { ms: wanted, id: setInterval(() => void refreshPublicAddress(), wanted) }; }
  }
  async function publicAction(method) {
    const id = syncPublicContext();
    if (!id || publicBusy || isBusy()) return;
    const generation = publicGeneration, request = ++publicRequest;
    publicBusy = true; renderPublicCard();
    try {
      const result = await window.seedhost.call(method, { id });
      if (syncPublicContext() !== id || generation !== publicGeneration || request !== publicRequest) return;
      publicStatus = result;
    } catch (error) {
      if (syncPublicContext() !== id || generation !== publicGeneration || request !== publicRequest) return;
      publicStatus = { state: 'error', address: null, detail: String(error?.message ?? error), approveUrl: null };
    } finally {
      if (syncPublicContext() === id && generation === publicGeneration) { publicBusy = false; renderPublicCard(); }
    }
  }
  $('public-port-settings').addEventListener('click', () => {
    if (!syncPublicContext() || !bridgeReady || publicBusy || isBusy()) return;
    selectPage('server-settings');
    $('property-server-port')?.focus();
  });
  $('public-go').addEventListener('click', () => publicAction('publicAddressEnable'));
  $('public-off').addEventListener('click', () => publicAction('publicAddressDisable'));
  $('public-approve').addEventListener('click', () => publicAction('publicAddressOpenApproval'));
  $('public-copy').addEventListener('click', async () => {
    const value = $('public-value').textContent; if (!value) return;
    try { await navigator.clipboard.writeText(value); $('public-copy').textContent = 'Copied ✓'; setTimeout(() => { $('public-copy').textContent = 'Copy'; }, 2000); } catch { /* text is selectable */ }
  });

  async function refreshAlwaysOn() {
    try { alwaysOnStatus = await window.seedhost.call('alwaysOnStatus'); } catch { alwaysOnStatus = null; }
    renderSetup();
  }
  function renderAlwaysOn(blocked) {
    const running = alwaysOnStatus?.running === true;
    const paired = Boolean(state.relay);
    const mode = running ? 'host' : alwaysOnMode;
    $('always-on-choices').hidden = Boolean(mode) || paired;
    $('always-on-host').hidden = mode !== 'host';
    $('always-on-pair-form').hidden = mode !== 'pair' || paired;
    $('always-on-paired').hidden = !paired || running;
    $('always-on-paired').textContent = paired ? (alwaysOnPaired || `Connected to ${state.relay.name}. Your world is kept there when you stop playing.`) + (state.gateway?.enabled ? ' Friends join through it.' : '') : '';
    $('always-on-back').hidden = !alwaysOnMode || running || paired;
    for (const id of ['always-on-be', 'always-on-pair', 'always-on-new-code', 'always-on-off', 'always-on-connect', 'always-on-code-input', 'always-on-back']) $(id).disabled = blocked;
    if (mode === 'host') {
      const ok = running && !alwaysOnStatus.error;
      $('always-on-led').className = 'led ' + (ok ? 'led-ok' : 'led-bad');
      $('always-on-title').textContent = running ? `${alwaysOnStatus.name} is your always-on PC` : 'Always-on PC is off';
      $('always-on-detail').textContent = alwaysOnStatus?.error ? alwaysOnStatus.error : 'Running. Keep this PC on with Seed Hosting open — it can sit in the tray.';
      const code = alwaysOnStatus?.code;
      if ($('always-on-code').textContent !== (code || '— — —')) { $('always-on-code').textContent = code || '— — —'; $('always-on-code').classList.remove('is-new'); void $('always-on-code').offsetWidth; if (code) $('always-on-code').classList.add('is-new'); }
      $('always-on-new-code').textContent = code ? 'New code' : 'Show a code';
      const address = alwaysOnStatus?.addresses?.[0];
      $('always-on-address').textContent = address && alwaysOnStatus.gamePort ? `${address}${alwaysOnStatus.gamePort === 25565 ? '' : ':' + alwaysOnStatus.gamePort}` : '—';
      const members = alwaysOnStatus?.members ?? [];
      $('always-on-members').textContent = members.length ? members.map(m => m.name).join(', ') : 'None yet';
    }
    // Keep the code and the paired list fresh while the host panel is visible.
    const live = $('setup-dialog').open && setupDraft?.step === 'gateway' && running;
    if (live && !alwaysOnTimer) alwaysOnTimer = setInterval(() => void refreshAlwaysOn(), 4000);
    if (!live && alwaysOnTimer) { clearInterval(alwaysOnTimer); alwaysOnTimer = null; }
  }
  $('always-on-be').addEventListener('click', async () => {
    alwaysOnMode = 'host';
    const ok = await runAction('alwaysOnEnable', { name: state.deviceName || 'Always-on PC' }, result => { alwaysOnStatus = result; });
    if (!ok || !alwaysOnStatus?.running) { alwaysOnMode = null; return renderSetup(); }
    await runAction('alwaysOnNewCode', undefined, result => { alwaysOnStatus = result; });
  });
  $('always-on-new-code').addEventListener('click', () => runAction('alwaysOnNewCode', undefined, result => { alwaysOnStatus = result; }));
  $('always-on-off').addEventListener('click', async () => {
    await runAction('alwaysOnDisable', undefined, result => { alwaysOnStatus = result; if (!result?.running) alwaysOnMode = null; });
  });
  $('always-on-pair').addEventListener('click', () => { alwaysOnMode = 'pair'; renderSetup(); $('always-on-code-input').focus(); });
  $('always-on-back').addEventListener('click', () => { alwaysOnMode = null; $('always-on-pair-status').textContent = ''; renderSetup(); });
  $('always-on-code-input').addEventListener('input', () => {
    const raw = $('always-on-code-input').value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 12);
    const formatted = raw.match(/.{1,4}/g)?.join('-') ?? '';
    if ($('always-on-code-input').value !== formatted) $('always-on-code-input').value = formatted;
    $('always-on-code-input').removeAttribute('aria-invalid'); $('always-on-pair-status').textContent = '';
  });
  $('always-on-pair-form').addEventListener('submit', async event => {
    event.preventDefault(); if ($('always-on-connect').disabled) return;
    const code = $('always-on-code-input').value;
    if (code.replace(/-/g, '').length !== 12) { $('always-on-pair-status').textContent = 'Type all 12 characters shown on the always-on PC.'; return invalid('always-on-code-input', 'Type all 12 characters shown on the always-on PC.'); }
    $('always-on-pair-status').textContent = 'Looking for your always-on PC on this network…';
    const ok = await runAction('pairAlwaysOn', { code, name: state.deviceName || 'Gaming PC' }, result => {
      if (!result) { $('always-on-pair-status').textContent = ''; return; }
      $('always-on-code-input').value = '';
      alwaysOnPaired = `Connected to ${result.relayName}. Your world is kept there when you stop playing.`;
    });
    if (!ok) $('always-on-pair-status').textContent = 'Not connected. Check the code, and that both PCs are on the same network with Seed Hosting open on the always-on PC.';
  });

  let snapshotContext = null;
  let snapshotRequest = 0;
  let snapshotLoading = false;
  let snapshots = null;
  let snapshotNotice = '';
  function renderHistory() {
    const context = JSON.stringify([state?.server?.serverDir, state?.server?.storeDir, state?.server?.snapshotId]);
    if (context !== snapshotContext) { snapshotContext = context; snapshotRequest++; snapshotLoading = false; snapshots = null; snapshotNotice = ''; $('snapshot-list').replaceChildren(); }
    $('snapshot-history').hidden = !state?.server;
    $('refresh-snapshots').disabled = !bridgeReady || isBusy() || !state?.server || snapshotLoading;
    $('snapshot-history-status').textContent = snapshotLoading ? 'Loading backups…' : snapshotNotice || (!state?.server ? '' : !isStopped() ? 'Stop the server to restore a backup.' : !ownsServer() ? 'Only the PC currently hosting this world can restore it.' : state.server.modInstallError ? 'Restore is unavailable until the unfinished mod install is repaired.' : snapshots?.length ? `${snapshots.length} backup${snapshots.length === 1 ? '' : 's'}. A backup is saved automatically each time you stop the server.` : 'No backups yet. One is saved each time you stop the server.');
    for (const button of $('snapshot-list').querySelectorAll('button')) button.disabled = !canSnapshot() || snapshotLoading || button.dataset.current === 'true';
    if (bridgeReady && state?.server && isStopped() && ownsServer() && snapshots === null && !snapshotLoading && !snapshotNotice) queueMicrotask(() => void loadSnapshots());
  }
  async function loadSnapshots() {
    if (!bridgeReady || !state?.server || snapshotLoading) return;
    const token = ++snapshotRequest, context = snapshotContext;
    snapshotLoading = true; snapshotNotice = ''; renderHistory();
    try {
      const result = await window.seedhost.call('listSnapshots');
      if (token !== snapshotRequest || context !== snapshotContext) return;
      if (!Array.isArray(result) || result.some(item => typeof item.id !== 'string' || typeof item.current !== 'boolean' || !Number.isSafeInteger(item.fileCount) || !Number.isSafeInteger(item.bytes))) throw new Error('Invalid snapshot history.');
      snapshots = result;
      $('snapshot-list').replaceChildren(...result.map(snapshot => {
        const item = element('li', 'snapshot-item');
        const content = element('div');
        const title = element('strong', 'snapshot-title', snapshot.current ? 'Latest backup' : `Backup ${result.length - result.indexOf(snapshot)}`);
        const code = element('code', 'snapshot-identifier', snapshot.id.slice(0, 12)); code.title = snapshot.id;
        const meta = element('p', 'field-help', `${formatBytes(snapshot.bytes)} · ${snapshot.fileCount} files · `); meta.append(code);
        content.append(title, meta);
        const button = element('button', 'button button-small', snapshot.current ? 'Current' : 'Restore…');
        button.type = 'button'; button.dataset.snapshot = snapshot.id; button.dataset.current = String(snapshot.current); button.setAttribute('aria-label', snapshot.current ? 'Current backup' : `Restore backup ${snapshot.id}`);
        item.append(content, button); return item;
      }));
    } catch (error) { if (token === snapshotRequest) { snapshots = null; snapshotNotice = `Couldn’t load backups: ${errorMessage(error)}. Press Refresh to try again.`; } }
    finally { if (token === snapshotRequest) { snapshotLoading = false; renderHistory(); } }
  }
  $('refresh-snapshots').addEventListener('click', () => { if (!$('refresh-snapshots').disabled) void loadSnapshots(); });
  $('snapshot-list').addEventListener('click', async event => {
    const button = event.target.closest('button[data-snapshot]');
    if (!button || button.disabled || !canSnapshot()) return;
    await runAction('restoreSnapshot', { snapshotId: button.dataset.snapshot });
    await loadSnapshots();
  });

  function gatewayStatusText(label) {
    const detail = state?.gateway?.detail || '';
    if (/Park and Claim once/.test(detail)) return 'One-time step: Stop server (it hands the world to your always-on PC), then press Take over hosting and Start server again. After that, the always-on PC address works every time you host.';
    if (state?.gateway?.state === 'ready') return `Ready · ${detail || 'tunnel connected'}. Friends can join through your always-on PC while this server runs.`;
    return `${label}${detail ? ` · ${detail}` : ''}.`;
  }
  // One row per server on this PC. Only the server in use can run; deleting is guarded in the backend.
  function renderServers(blocked) { window.seedDashboard.renderServers(state, blocked); }
  function renderGettingStarted() {
    const checks = { server: Boolean(state?.server), start: state?.server?.state === 'running', friends: Boolean(state?.relay), relay: state?.gateway?.enabled === true };
    for (const item of $('getting-started').querySelectorAll('li')) item.classList.toggle('is-done', checks[item.dataset.check] === true);
  }
  function render() {
    const server = state?.server;
    const blocked = !bridgeReady || isBusy();
    if (publicStatus) renderPublicCard();
    const active = !isStopped() || isHosting();
    const profileEditable = !blocked && Boolean(server) && !active;
    const nextServerKey = server ? `${server.serverDir}\n${server.storeDir}` : null;
    if (nextServerKey !== serverKey) {
      serverKey = nextServerKey;
      $('setup-runtime-java').value = '';
      renderSetupJava();
      profileDirty = false;
      for (const id of ['java-executable', 'java-args', 'start-timeout', 'stop-timeout']) $(id).removeAttribute('aria-invalid');
    }
    $('app-version').textContent = state ? `v${state.version} · alpha` : 'App unavailable';
    $('server-name').textContent = server?.name || 'No server yet';
    $('server-empty').hidden = Boolean(server);
    renderServers(blocked);
    $('server-info').hidden = !server;
    $('server-directory').textContent = server?.serverDir || '—';
    $('store-directory').textContent = server?.storeDir || '—';
    $('snapshot-id').textContent = server?.snapshotId || 'No backup yet';
    const ownership = server?.ownership;
    $('server-details').hidden = !server;
    $('ownership-state').textContent = !server ? '—' : !ownership ? 'Unknown · hosting blocked' :
      typeof ownership === 'object' ? `${ownership.state || 'Unknown'} · ${ownership.owner === state.deviceId ? 'this device' : 'another / unknown device'}` : String(ownership);
    const processLabels = { offline: 'Stopped', failed: 'Failed', running: 'Hosting', starting: 'Starting', stopping: 'Stopping' };
    $('server-status').textContent = server ? processLabels[server.state] || `Unknown state: ${server.state}` : 'Not configured';
    $('server-status').className = 'badge';
    $('server-status').classList.toggle('is-running', server?.state === 'running');
    $('server-status').classList.toggle('is-working', ['starting', 'stopping'].includes(server?.state));
    $('server-status').classList.toggle('is-failed', server?.state === 'failed');
    $('import-server').disabled = blocked || active;
    $('start-server').disabled = blocked || !server || Boolean(server.modInstallError) || active || !ownsServer() || profileDirty || !server.profile?.executable || !Array.isArray(server.profile?.args);
    $('stop-server').disabled = blocked || !server || !['running', 'starting'].includes(server.state);
    $('create-snapshot').disabled = !canSnapshot();
    const cleanable = Boolean(server) && isStopped() && ['owned', 'offered', 'transferred'].includes(ownership?.state);
    $('clean-up').disabled = blocked || !cleanable;
    const recoverable = ownership?.owner === state?.deviceId && ownership?.state === 'uncertain' && !ownership?.offer && isStopped();
    $('recover-ownership').hidden = !recoverable;
    $('server-recovery-reminder').hidden = !recoverable;
    $('recover-ownership').disabled = blocked || !recoverable || Boolean(server?.modInstallError);
    $('java-executable').disabled = !profileEditable;
    $('java-args').disabled = !profileEditable;
    $('start-timeout').disabled = !profileEditable;
    $('stop-timeout').disabled = !profileEditable;
    $('save-profile').disabled = !profileEditable || !profileDirty;
    if (!profileDirty) {
      $('java-executable').value = server?.profile?.executable || '';
      $('java-args').value = server ? JSON.stringify(server.profile?.args || [], null, 2) : '';
      $('start-timeout').value = server?.profile?.startTimeoutSeconds ?? '';
      $('stop-timeout').value = server?.profile?.stopTimeoutSeconds ?? '';
    }
    $('profile-feedback').textContent = !server ? 'Create or import a server first.' : profileDirty ? 'Unsaved changes · save before starting.' : active ? 'Stop the server to edit these settings.' : 'Saved.';
    const hint = !server ? '' : !bridgeReady ? 'Seed Hosting can’t reach its background service; buttons are paused.' : isBusy() ? '' : active ? '' : server.modInstallError ? `${server.modInstallError}. Repair the mod files before starting.` : pendingOffer() ? 'Your world is being handed to another PC. Use Retry on that PC if it didn’t finish; if they decline, it comes back here.' : !ownsServer() ? ownership?.state === 'uncertain' && ownership.owner === state.deviceId ? 'No server process is tracked here. Confirm previous processes are stopped & recover local ownership before starting.' : 'Hosting authority is not confirmed on this PC. Check the group and hand-over status before starting.' : profileDirty ? 'Save your launch settings before starting.' : '';
    const needsJava = Boolean(server) && !hint && !active && (!server.profile?.executable || !server.profile?.args?.length);
    $('server-action-hint').textContent = needsJava ? 'Choose Java before starting: open the Setup guide → Memory → Advanced: change Java.' : hint; $('server-action-hint').hidden = !needsJava && !hint;
    $('server-toolbar').hidden = !server;
    for (const id of ['mods-details', 'profile-details', 'console-section', 'server-status']) $(id).hidden = !server;
    $('console-tab').hidden = !server;
    if (!server && $('console-tab').getAttribute('aria-selected') === 'true') selectPage('operate');
    const logs = window.seedDashboard.logsFor(state);
    $('console-peek').hidden = !server || !logs.length;
    $('console-peek-line').textContent = logs.length ? logs[logs.length - 1] : 'No process output yet.';
    $('console-state').textContent = server?.state === 'running' ? 'Running' : server ? PROCESS_LABELS[server.state] || 'Unknown' : 'Not running';
    $('console-state').className = server?.state === 'running' ? 'badge is-running' : ['starting', 'stopping'].includes(server?.state) ? 'badge is-working' : 'badge';
    $('server-command').disabled = blocked || server?.state !== 'running';
    $('send-command').disabled = $('server-command').disabled || !$('server-command').value.trim();
    const logText = logs.join('\n');
    if (logText !== lastLogs) {
      $('console-lines').textContent = logText;
      lastLogs = logText;
      if ($('follow-logs').checked) $('console-output').scrollTop = $('console-output').scrollHeight;
    }
    $('console-empty').hidden = Boolean(logs.length);
    $('device-fingerprint').value = state?.deviceId || '';
    $('copy-fingerprint').disabled = !bridgeReady || !state?.deviceId;
    $('start-listener').disabled = blocked || Boolean(state?.peerEndpoint);
    $('start-listener').textContent = state?.peerEndpoint ? 'Listener active' : 'Start listener';
    $('copy-peer-details').disabled = !bridgeReady || !state?.peerEndpoint || !state?.deviceId;
    $('listener-status').textContent = state?.peerEndpoint ? 'LISTENING' : 'NOT LISTENING';
    $('listener-endpoint').textContent = state?.peerEndpoint ? formatEndpoint(state.peerEndpoint.host, state.peerEndpoint.port) : 'No listener endpoint';
    const localOnly = ['127.0.0.1', '::1', 'localhost'].includes(state?.peerEndpoint?.host);
    $('listener-help').textContent = state?.peerEndpoint ? localOnly ? 'Loopback only: other computers cannot reach this endpoint. No router or firewall configuration is changed.' : 'This is the actual listener endpoint, not proof of public reachability. No automatic NAT traversal.' : 'Start the listener to see the actual endpoint. An endpoint is not proof of public reachability.';
    // Status LEDs mirror authoritative state only: they never imply reachability beyond what is known.
    $('nav-server-led').className = server?.state === 'running' ? 'led led-ok' : ['starting', 'stopping'].includes(server?.state) ? 'led led-work' : server?.state === 'failed' ? 'led led-bad' : 'led';
    $('device-led').className = bridgeReady ? 'led led-ok' : 'led led-bad';
    $('listener-led').className = state?.peerEndpoint ? 'led led-info' : 'led';
    renderPeerList();
    renderRelay();
    renderMods();
    renderModBrowser();
    renderFriends();
    renderSetup();
    renderHistory();
    for (const id of ['peer-name', 'peer-fingerprint', 'peer-host', 'peer-port', 'add-peer']) $(id).disabled = blocked;
    if (!settingsDirty) {
      $('persistent-address').checked = state?.settings?.persistentAddress === true;
      $('gateway-address').value = state?.settings?.gatewayAddress || '';
      $('start-at-login').checked = state?.settings?.startAtLogin === true;
    }
    $('persistent-address').disabled = blocked;
    $('gateway-address').disabled = blocked || !$('persistent-address').checked;
    $('start-at-login').disabled = blocked;
    $('save-settings').disabled = blocked || !settingsDirty;
    const gatewayLabels = { off: 'Off', connecting: 'Connecting', ready: 'Ready tunnel', error: 'Error' };
    const gatewayLabel = state?.gateway ? gatewayLabels[state.gateway.state] || 'Unknown' : 'Unavailable in this build';
    $('gateway-status').textContent = state?.gateway?.enabled ? gatewayLabel : 'Unconnected';
    $('player-gateway').hidden = !(state?.gateway?.enabled || state?.relay || state?.settings?.persistentAddress);
    $('player-gateway-status').textContent = gatewayStatusText(gatewayLabel);
    $('player-address').textContent = state?.settings?.persistentAddress && state.settings.gatewayAddress ? `Displayed player address: ${state.settings.gatewayAddress}` : '';
    renderGettingStarted();
    $('open-gateway-setup').disabled = blocked;
    $('settings-feedback').textContent = settingsDirty ? 'Unsaved preferences.' : 'Preferences loaded from this PC.';
    const busy = pendingMethod || state?.busy;
    $('activity-message').textContent = !bridgeReady ? 'App connection unavailable · actions blocked.' : busy ? busyLabels[busy] || `Working: ${busy}` : 'Ready';
    $('activity-message').classList.toggle('is-busy', Boolean(busy));
    $('activity-message').classList.toggle('is-offline', !bridgeReady);
    const sendStillCurrent = selectedSend && server?.snapshotId === selectedSend.snapshotId && state?.peers.some((peer) => peer.fingerprint === selectedSend.fingerprint) &&
      (!selectedSend.retry || pendingOffer()?.target === selectedSend.fingerprint);
    const allowed = selectedSend?.retry ? bridgeReady && !isBusy() && isStopped() : canSnapshot();
    $('confirm-send').disabled = !allowed || !sendStillCurrent;
    if (selectedSend) $('send-dialog-snapshot').textContent = `Snapshot: ${selectedSend.snapshotId}${sendStillCurrent ? '' : ' · State changed. Cancel and review again.'}`;
    $('settings-savebar').hidden = settingsCategory === 'appearance' && !settingsDirty;
    window.seedDashboard.update(state, blocked);
  }

  let renderedMods = null;
  function renderMods() {
    const server = state?.server;
    const mods = server?.mods || { server: [], client: [] };
    const editable = modsEditable();
    $('mods-summary').textContent = server?.modsError ? 'Mods unavailable' : server ? `${mods.server.length} server · ${mods.client.length} client` : 'Server & client';
    $('add-server-mods').disabled = !editable;
    $('add-client-mods').disabled = !editable;
    $('export-client-pack').disabled = !bridgeReady || isBusy() || Boolean(server?.modsError) || !mods.client.length;
    const signature = JSON.stringify(mods);
    if (signature !== renderedMods) {
      renderedMods = signature;
      for (const kind of ['server', 'client']) {
        $(`${kind}-mods`).replaceChildren(...mods[kind].map((mod) => {
          const item = element('li', 'mod-item');
          const remove = element('button', 'text-button', 'Remove');
          remove.type = 'button';
          remove.dataset.kind = kind;
          remove.dataset.name = mod.name;
          remove.setAttribute('aria-label', `Remove ${mod.name}`);
          const name = element('span', 'mod-name', mod.name);
          name.title = mod.name;
          item.append(name, element('span', 'mod-size', mod.size >= 1048576 ? `${(mod.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(mod.size / 1024))} KB`), remove);
          return item;
        }));
      }
    }
    for (const button of document.querySelectorAll('.mod-list button')) button.disabled = !editable;
  }

  // Catalogue reads do not claim the mutation lock or call getState. A request token
  // prevents a slow response for an old server/target/query replacing newer results.
  const MOD_PAGE_SIZE = 20;
  let modTargetDirty = false;
  let modContext = null;
  let modRequest = 0;
  let modLoading = false;
  let modLoaded = false;
  let modHits = [];
  let modOffset = 0;
  let modTotal = 0;
  let modQuery = '';
  let modSort = 'downloads';
  let modNotice = '';
  let renderedCatalogue = null;
  const targetReady = () => !state?.server?.modsError && Boolean(state?.server?.modTarget?.loader && state?.server?.modTarget?.gameVersion);
  const modsEditable = () => bridgeReady && !isBusy() && Boolean(state?.server) && !state.server.modsError && isStopped() && ownsServer();
  const projectInstalled = (hit) => ['server', 'client'].some((side) => (state?.server?.mods?.[side] || []).some((mod) => mod.source?.projectId === hit.projectId));

  function renderModBrowser() {
    const target = state?.server?.modTarget;
    const context = JSON.stringify([serverKey, target?.loader, target?.gameVersion, state?.server?.modsError]);
    if (context !== modContext) {
      modContext = context;
      modTargetDirty = false;
      modRequest++;
      modLoading = false;
      modLoaded = false;
      modHits = [];
      modTotal = 0;
      modOffset = 0;
      modNotice = '';
      renderedCatalogue = null;
      $('mod-loader').removeAttribute('aria-invalid');
      $('mod-game-version').removeAttribute('aria-invalid');
      if (targetReady() && $('mods-details').open && bridgeReady) queueMicrotask(() => void searchMods(0));
    }
    if (!modTargetDirty) {
      $('mod-loader').value = target?.loader || '';
      $('mod-game-version').value = target?.gameVersion || '';
    }
    for (const id of ['mod-loader', 'mod-game-version']) $(id).disabled = !modsEditable();
    $('save-mod-target').disabled = !modsEditable() || !modTargetDirty;
    $('mod-target-feedback').textContent = state?.server?.modsError ? `Mods unavailable: ${state.server.modsError} Mod actions are blocked until metadata can be read safely.` : !state?.server ? 'Import a modded server to browse compatible mods.' : modTargetDirty ? 'Unsaved compatibility · save to update results. This does not install or change the loader.' : targetReady() ? `Showing mods for ${target.loader} ${target.gameVersion}${target.detected ? ' · detected from server' : ' · saved target'}.` : 'Loader or version could not be detected. Set both above; this does not install the loader.';
    const searchable = bridgeReady && targetReady() && !modTargetDirty;
    $('mod-query').disabled = !searchable;
    $('mod-sort').disabled = !searchable;
    $('search-mods').disabled = !searchable || modLoading;
    $('search-mods').textContent = modLoading ? 'Searching…' : 'Search';
    $('mod-results').setAttribute('aria-busy', String(modLoading));
    $('mod-search-status').textContent = (state?.server?.modsError ? 'Mod browsing is blocked while mod metadata is unavailable.' : !targetReady() ? 'Save compatibility to browse mods.' : modTargetDirty ? 'Save compatibility before searching or installing.' : modLoading ? 'Loading compatible mods from Modrinth…' : modNotice || (modLoaded ? modHits.length ? `${modQuery ? `Results for “${modQuery}”` : 'Mods on Modrinth'} · ${sortLabel('mod-sort')} · ${modTotal.toLocaleString()} compatible projects. Placement follows each project’s server/client requirements.` : 'No compatible mods found. Try a different search or compatibility target.' : 'Open Mods to browse compatible mods.')) + sortScopeNote(modSort);
    const signature = JSON.stringify([modHits, state?.server?.mods]);
    if (signature !== renderedCatalogue) {
      renderedCatalogue = signature;
      $('mod-results').replaceChildren(...modHits.map((hit) => {
        const item = element('li', 'mod-project');
        item.dataset.projectId = hit.projectId;
        const icon = element('div', 'mod-icon', hit.title?.slice(0, 1) || 'M');
        try {
          const url = new URL(hit.iconUrl);
          if (url.protocol === 'https:' && url.host === 'cdn.modrinth.com' && !url.username && !url.password) {
            const image = element('img');
            image.src = url.href; image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
            image.addEventListener('error', () => image.remove(), { once: true });
            icon.append(image);
          }
        } catch { /* A missing or untrusted icon leaves a local text fallback. */ }
        const content = element('div', 'mod-project-content');
        content.append(element('h3', 'mod-project-title', hit.title), element('p', 'mod-project-author', `by ${hit.author || 'Unknown author'} · ${Number(hit.downloads || 0).toLocaleString()} downloads`), element('p', 'mod-project-description', hit.description));
        const placement = (hit.placement || []).map((side) => side === 'server' ? 'Server' : side === 'client' ? 'Client pack' : '').filter(Boolean).join(' + ');
        const actions = element('div', 'mod-project-actions');
        const page = element('button', 'text-button', 'View on Modrinth ↗');
        page.type = 'button'; page.dataset.slug = hit.slug;
        page.setAttribute('aria-label', `View ${hit.title} on Modrinth`);
        // Provenance on either side is not proof that every side/dependency is
        // present. Reuse the installer to review and safely repair partial installs.
        const installLabel = projectInstalled(hit) ? 'Repair / check' : 'Install';
        const install = element('button', 'button button-small', installLabel);
        install.type = 'button'; install.dataset.install = hit.projectId;
        install.setAttribute('aria-label', `${installLabel} ${hit.title}`);
        actions.append(element('span', 'mod-placement', placement || 'Review placement at install'), page, install);
        content.append(actions); item.append(icon, content); return item;
      }));
    }
    for (const button of $('mod-results').querySelectorAll('button[data-install]')) {
      button.disabled = !modsEditable() || modTargetDirty || modLoading;
    }
    for (const button of $('mod-results').querySelectorAll('button[data-slug]')) button.disabled = !bridgeReady || Boolean(state?.server?.modsError);
    $('mod-previous').disabled = !searchable || modLoading || !modLoaded || modOffset === 0;
    $('mod-next').disabled = !searchable || modLoading || !modLoaded || !modHits.length || modOffset + MOD_PAGE_SIZE >= modTotal || modOffset + MOD_PAGE_SIZE > 10000;
    $('mod-page').textContent = modLoaded && modHits.length ? `${modOffset + 1}–${modOffset + modHits.length} of ${modTotal.toLocaleString()}` : 'No results loaded';
  }

  async function searchMods(offset = 0, query = $('mod-query').value.trim(), sort = $('mod-sort').value) {
    if (!bridgeReady || !targetReady() || modTargetDirty) return;
    const token = ++modRequest;
    const context = modContext;
    modLoading = true;
    modHits = []; modSort = sort;
    modNotice = '';
    renderModBrowser();
    try {
      const result = await window.seedhost.call('searchMods', { query, offset, sort });
      if (token !== modRequest || context !== modContext) return;
      if (!Array.isArray(result?.hits) || !Number.isSafeInteger(result.total) || result.total < 0) throw new Error('Modrinth returned an invalid search result.');
      modHits = result.hits;
      modTotal = result.total;
      modOffset = offset;
      modQuery = query;
      modLoaded = true;
    } catch (error) {
      if (token !== modRequest || context !== modContext) return;
      modHits = []; modLoaded = false; modTotal = 0;
      modNotice = `Could not load Modrinth: ${errorMessage(error)} Use Search to try again.`;
    } finally {
      if (token === modRequest) { modLoading = false; renderModBrowser(); }
    }
  }

  $('mods-details').addEventListener('toggle', () => {
    if ($('mods-details').open && !modLoaded && !modLoading) void searchMods(0);
  });
  for (const [id, event] of [['mod-loader', 'change'], ['mod-game-version', 'input']]) {
    $(id).addEventListener(event, () => {
      modTargetDirty = true; modRequest++; modLoading = false;
      $(id).removeAttribute('aria-invalid'); renderModBrowser();
    });
  }
  $('mod-target-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if ($('save-mod-target').disabled) return;
    const loader = $('mod-loader').value;
    const gameVersion = $('mod-game-version').value;
    if (!['fabric', 'quilt', 'forge', 'neoforge'].includes(loader)) return invalid('mod-loader', 'Choose Fabric, Quilt, Forge, or NeoForge.');
    if (!/^\d+(?:\.\d+){1,2}(?:-[0-9A-Za-z.]+)?$/.test(gameVersion) || gameVersion.length > 32) return invalid('mod-game-version', 'Enter the exact Minecraft version, for example 1.21.1, without spaces.');
    return runAction('saveModTarget', { loader, gameVersion }, () => {
      if (state.server?.modTarget?.loader !== loader || state.server?.modTarget?.gameVersion !== gameVersion) throw new Error('Saved compatibility could not be confirmed.');
      modTargetDirty = false; renderModBrowser();
      if (!modLoading) void searchMods(0);
    });
  });
  $('mod-search-form').addEventListener('submit', (event) => { event.preventDefault(); if (!$('search-mods').disabled) void searchMods(0); });
  $('mod-sort').addEventListener('change', () => void searchMods(0));
  $('mod-next').addEventListener('click', () => { if (!$('mod-next').disabled) void searchMods(modOffset + MOD_PAGE_SIZE, modQuery, modSort); });
  $('mod-previous').addEventListener('click', () => { if (!$('mod-previous').disabled) void searchMods(Math.max(0, modOffset - MOD_PAGE_SIZE), modQuery, modSort); });
  $('mod-results').addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.slug) {
      try { await window.seedhost.call('openModPage', { slug: button.dataset.slug }); }
      catch (error) { showError(`Could not open Modrinth: ${errorMessage(error)}`); }
    } else if (button.dataset.install) {
      const projectId = button.dataset.install;
      await runAction('installMod', { projectId });
      // Installation is confirmed only by the read-back's provenance, never by a
      // successful invoke (the user may have cancelled the native confirmation).
      renderModBrowser();
    }
  });


  let friendContext = null;
  let friends = null;
  let friendRequest = 0;
  let friendsLoading = false;
  let friendError = '';
  let friendCheckedAt = 0;

  let renderedFriends = null;
  function renderFriends() {
    const context = state?.relay?.fingerprint || null;
    if (context !== friendContext) {
      friendContext = context;
      friendRequest++; friends = null; friendsLoading = false; friendError = '';
      renderedFriends = null; friendCheckedAt = 0;
      $('friend-feedback').textContent = context ? `You’re in the group on ${state.relay.name}.` : 'Not in a group yet.';
    }

    $('refresh-friends').disabled = !bridgeReady || !context || friendsLoading;
    $('refresh-friends').textContent = friendsLoading ? 'Refreshing…' : 'Refresh members';
    $('friend-list').setAttribute('aria-busy', String(friendsLoading));
    $('group-status').textContent = !context ? 'No group' : !bridgeReady ? 'Not checked · app unavailable' : friendsLoading ? 'Checking members…' : friendError ? 'Unreachable · retry' : friends ? 'Members confirmed' : 'Not checked';
    $('friend-last-checked').textContent = friendCheckedAt ? `Last checked ${new Date(friendCheckedAt).toLocaleTimeString()}${friendError ? ' · unsuccessful' : ''}. Membership is not online presence.` : '';
    const custodyLabels = {
      unknown: 'Hosting: unknown · the always-on PC hasn’t stored this world yet.',
      parked: 'Hosting: nobody · the world is waiting on the always-on PC.',
      pending: 'Hosting: a hand-over is in progress.',
      held: `World held by ${friends?.holder} · hosting not observed`,
    };
    $('friend-holder').textContent = !context ? 'Join a group to see its members.' : friendError ? `Members unavailable: ${friendError} Refresh to try again.` : friendsLoading ? 'Checking members…' : friends ? custodyLabels[friends.custody] || custodyLabels.unknown : 'Not checked yet';
    $('nav-friend-count').hidden = !friends?.members?.length;
    $('nav-friend-count').textContent = String(friends?.members?.length || 0);
    const signature = JSON.stringify(friends);
    if (signature !== renderedFriends) {
      renderedFriends = signature;
      $('friend-list').replaceChildren(...(friends?.members || []).map((member) => {
        const item = element('li', 'friend-item');
        item.append(element('span', 'friend-name', member.name), element('span', 'subtle-label', member.fingerprint === friends.owner ? (member.you ? 'You · group owner' : 'Group owner') : member.you ? 'You' : 'Can host'));
        if (friends.canManage && !member.you && member.fingerprint !== friends.owner) {
          const remove = element('button', 'text-button friend-remove', 'Remove');
          remove.type = 'button'; remove.dataset.removeFriend = member.fingerprint;
          remove.setAttribute('aria-label', `Remove ${member.name} from group`);
          remove.disabled = !bridgeReady || isBusy();
          remove.addEventListener('click', () => runAction('removeFriend', { fingerprint: member.fingerprint }, async result => {
            if (result?.removed) { await refreshFriends(); $('friend-feedback').textContent = `${member.name} was removed from your group.`; }
          }));
          item.append(remove);
        }

        return item;
      }));
    }
    for (const button of $('friend-list').querySelectorAll('[data-remove-friend]')) button.disabled = !bridgeReady || isBusy();
  }
  window.addEventListener('seedhost-account-changed', () => { void refresh(); void refreshFriends(); });
  async function refreshFriends() {
    if (!bridgeReady || !friendContext || friendsLoading) return;
    const token = ++friendRequest;
    const context = friendContext;
    friendsLoading = true; friendError = ''; renderFriends();
    try {
      const result = await window.seedhost.call('listFriends');
      if (token !== friendRequest || context !== friendContext) return;
      if (!Array.isArray(result?.members) || !['unknown', 'parked', 'pending', 'held'].includes(result.custody) ||
          (result.custody === 'held' ? typeof result.holder !== 'string' || !result.holder.trim() : result.holder !== null)) throw new Error('Relay returned invalid members.');
      friends = result;
    } catch (error) {
      if (token !== friendRequest || context !== friendContext) return;
      friends = null;
      friendError = /invalid members|invalid relay friends|invalid group (owner|permissions)/i.test(String(error?.message ?? error))
        ? 'Group information could not be verified.'
        : 'Check your connection and that the always-on PC is running.';
    } finally {
      if (token === friendRequest) { friendsLoading = false; friendCheckedAt = Date.now(); renderFriends(); }
    }
  }
  $('refresh-friends').addEventListener('click', () => { if (!$('refresh-friends').disabled) void refreshFriends(); });

  function renderRelay() {
    syncRelayContext();
    const relay = state?.relay;
    const server = state?.server;
    const ownership = server?.ownership;
    const blocked = !bridgeReady || isBusy();
    $('relay-card').hidden = !relay;
    if (relay) {
      $('relay-name').textContent = relay.name;
      const atRelay = ownership?.owner === relay.fingerprint;
      const here = ownership?.owner === state.deviceId;
      $('relay-holder').textContent = relayStatusError ? 'UNREACHABLE' : relayStatus === undefined ? 'EMPTY'
        : relayStatus ? (relayStatus.state === 'transferred' ? `WITH ${String(relayStatus.ownerName || 'ANOTHER PC').toUpperCase()}` : relayStatus.state === 'offered' ? 'HAND-OVER IN PROGRESS' : 'WAITING ON ALWAYS-ON PC')
        : 'NOT CHECKED';
      const pendingPark = ownership?.state === 'offered' && ownership.offer?.target === relay.fingerprint;
      $('park-relay').textContent = pendingPark ? 'Retry hand-off' : 'Hand off to always-on PC';
      $('park-relay').disabled = blocked || !server || !isStopped() || !(ownsServer() || pendingPark);
      $('claim-relay').disabled = blocked || !isStopped() || here || isHosting();
      $('check-relay').disabled = blocked;
      $('relay-help').textContent = relayStatusError ? `Couldn’t reach the always-on PC: ${relayStatusError}`
        : !server ? 'No world on this PC yet. Use Take over hosting to get it from the always-on PC.'
        : atRelay ? 'The world is waiting on the always-on PC. Anyone in the group can take over hosting, including you.'
        : here && ownership?.state === 'uncertain' ? 'No server process is tracked here. Confirm previous processes are stopped & recover local ownership on Performance before starting.'
        : ownership?.state === 'offered' ? 'A hand-over is pending. Hosting has not been confirmed; check its status before retrying.'
        : here && ['owned', 'hosting'].includes(ownership?.state) ? server.state === 'running' ? 'This PC is running the server. Stop it before handing the world off.' : 'This PC owns the stopped world. Start it here, or hand it off to the always-on PC.'
        : 'Hosting is not observed here. Check the group’s world status before requesting a hand-over.';
    }
    const select = $('relay-peer');
    const options = [['', 'None: hand off directly between PCs'], ...(state?.peers || []).map((peer) => [peer.fingerprint, `${peer.name} · ${formatEndpoint(peer.host, peer.port)}`])];
    if (select.dataset.signature !== JSON.stringify(options)) {
      select.dataset.signature = JSON.stringify(options);
      select.replaceChildren(...options.map(([value, label]) => { const option = element('option', '', label); option.value = value; return option; }));
    }
    if (!relayDirty) {
      select.value = relay?.fingerprint || '';
      $('park-on-stop').checked = relay?.parkOnStop === true;
    }
    select.disabled = blocked;
    $('park-on-stop').disabled = blocked || !select.value;
  }

  function renderPeerList() {
    const peers = state?.peers || [];
    const signature = JSON.stringify([peers, state?.relay?.fingerprint ?? null]);
    $('peers-empty').hidden = peers.length > 0;
    $('peer-count').textContent = peers.length ? `${peers.length} SAVED` : 'NONE ADDED';
    if (signature !== renderedPeers) {
      renderedPeers = signature;
      const nodes = peers.map((peer) => {
        const item = element('li', 'peer-item well');
        const heading = element('div', 'peer-item-main');
        const avatar = element('span', 'peer-avatar', (Array.from(peer.name.trim())[0] || '?').toUpperCase());
        avatar.setAttribute('aria-hidden', 'true');
        const text = element('div', 'peer-text');
        text.append(element('span', 'peer-name', peer.name), element('code', 'peer-endpoint', formatEndpoint(peer.host, peer.port)));
        heading.append(avatar, text);
        const actions = element('div', 'peer-actions');
        const button = element('button', 'button button-small', 'Send snapshot');
        button.type = 'button';
        button.dataset.fingerprint = peer.fingerprint;
        button.dataset.method = 'sendSnapshot';
        button.setAttribute('aria-label', `Send snapshot to ${peer.name}`);
        const handoff = element('button', 'button button-small', 'Hand off');
        handoff.type = 'button';
        handoff.dataset.fingerprint = peer.fingerprint;
        handoff.dataset.method = 'handoff';
        handoff.setAttribute('aria-label', `Hand off hosting to ${peer.name}`);
        if (peer.fingerprint === state?.relay?.fingerprint) actions.append(element('span', 'subtle-label', 'RELAY · USE HAND OFF / TAKE OVER ON MY SERVER'));
        else actions.append(button, handoff);
        const pin = element('details', 'peer-pin');
        pin.append(element('summary', '', 'Verified fingerprint'), element('code', 'peer-fingerprint', peer.fingerprint));
        item.append(heading, actions, pin);
        return item;
      });
      $('peer-list').replaceChildren(...nodes);
    }
    const offer = pendingOffer();
    const idleStopped = bridgeReady && !isBusy() && isStopped();
    for (const button of $('peer-list').querySelectorAll('button')) {
      const retry = Boolean(offer) && button.dataset.method === 'handoff' && button.dataset.fingerprint === offer.target;
      if (button.dataset.method === 'handoff') button.textContent = retry ? 'Retry handoff' : 'Hand off';
      button.disabled = retry ? !idleStopped : !canSnapshot() || !state.server?.snapshotId;
    }
  }

  async function runAction(method, payload, onVerified) {
    if (!bridgeReady || isBusy()) return false;
    pendingMethod = method;
    $('error-banner').hidden = true;
    render();
    try {
      const result = await window.seedhost.call(method, payload);
      // A polling read begun before the mutation must finish before the read-back.
      if (refreshInFlight) await refreshInFlight;
      const verified = await refresh();
      // Native dialog cancellation is null, not a successful mutation.
      if (!verified || result === null) return false;
      if (onVerified) await onVerified(result);
      if (state?.relay) void refreshFriends();
      return true;
    } catch (error) {
      const reason = errorMessage(error);
      const message = `${ACTION_FAILURES[method] || `${method} failed`}: ${reason}`;
      if (refreshInFlight) await refreshInFlight;
      await refresh(); // Failed operations can still alter process / ownership state.
      showError(message);
      return false;
    } finally {
      pendingMethod = null;
      render();
    }
  }

  function invalid(id, message) {
    $(id).setAttribute('aria-invalid', 'true');
    showError(message);
    revealElement($(id));
    $(id).focus();
  }

  $('dismiss-error').addEventListener('click', () => { $('error-banner').hidden = true; });
  for (const [id, method] of [['import-server', 'importServer'], ['create-snapshot', 'createSnapshot'], ['start-server', 'startServer'], ['stop-server', 'stopServer']]) {
    $(id).addEventListener('click', () => {
      if ($(id).disabled) return;
      return runAction(method);
    });
  }
  $('recover-ownership').addEventListener('click', () => {
    if ($('recover-ownership').disabled) return;
    return runAction('recoverStopped', { confirmed: true });
  });
  async function checkRelay() {
    if (!state?.relay || !bridgeReady) return;
    const context = syncRelayContext();
    const token = ++relayRequest;
    // Generation rejects A → B → A and older requests to the same endpoint.
    const current = () => context === syncRelayContext() && token === relayRequest;
    try {
      const status = await window.seedhost.call('checkRelay');
      if (!current()) return;
      relayStatus = status === null ? undefined : status;
      relayStatusError = null;
    } catch (error) {
      if (!current()) return;
      relayStatus = null;
      relayStatusError = errorMessage(error).replace(/^Error invoking remote method 'seedhost:call': (Error: )?/, '');
    } finally {
      if (current()) render();
    }
  }
  $('check-relay').addEventListener('click', () => { if (!$('check-relay').disabled) void checkRelay(); });
  for (const [id, method] of [['park-relay', 'parkAtRelay'], ['claim-relay', 'claimFromRelay']]) {
    $(id).addEventListener('click', async () => {
      if ($(id).disabled) return;
      await runAction(method);
      await checkRelay();
    });
  }
  for (const id of ['relay-peer', 'park-on-stop']) {
    $(id).addEventListener('change', () => { relayDirty = true; settingsDirty = true; render(); });
  }
  for (const kind of ['server', 'client']) {
    $(`add-${kind}-mods`).addEventListener('click', () => {
      if ($(`add-${kind}-mods`).disabled) return;
      return runAction('addMods', { kind });
    });
    $(`${kind}-mods`).addEventListener('click', (event) => {
      const button = event.target.closest('button[data-name]');
      if (!button || button.disabled) return;
      return runAction('removeMod', { kind: button.dataset.kind, name: button.dataset.name });
    });
  }
  $('export-client-pack').addEventListener('click', () => {
    if ($('export-client-pack').disabled) return;
    return runAction('exportClientPack');
  });
  $('clean-up').addEventListener('click', () => {
    if ($('clean-up').disabled) return;
    return runAction('cleanUp');
  });
  for (const id of ['java-executable', 'java-args', 'start-timeout', 'stop-timeout']) {
    $(id).addEventListener('input', () => {
      profileDirty = true;
      $(id).removeAttribute('aria-invalid');
      render();
    });
  }
  $('profile-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if ($('save-profile').disabled) return;
    const executable = $('java-executable').value;
    if (!executable.trim() || /[\0\r\n]/.test(executable)) return invalid('java-executable', 'Enter a Java executable path, without a shell command or line breaks.');
    let args;
    try { args = JSON.parse($('java-args').value); } catch { return invalid('java-args', 'Arguments must be a valid JSON array of strings, for example ["-jar", "server.jar", "nogui"].'); }
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || /[\0\r\n]/.test(arg))) return invalid('java-args', 'Arguments must be a JSON array of strings without NUL characters or line breaks.');
    const timeouts = {};
    for (const [id, key] of [['start-timeout', 'startTimeoutSeconds'], ['stop-timeout', 'stopTimeoutSeconds']]) {
      const text = $(id).value.trim();
      if (!text) continue;
      const value = Number(text);
      if (!/^\d+$/.test(text) || value < TIMEOUT_MIN || value > TIMEOUT_MAX) return invalid(id, `Timeouts must be whole seconds from ${TIMEOUT_MIN} to ${TIMEOUT_MAX}.`);
      timeouts[key] = value;
    }
    return runAction('saveProfile', { executable, args, ...timeouts }, () => {
      const saved = state.server?.profile;
      if (saved?.executable !== executable || JSON.stringify(saved.args) !== JSON.stringify(args) ||
          Object.entries(timeouts).some(([key, value]) => saved[key] !== value)) throw new Error('The saved launch profile could not be confirmed. Your edits have been kept.');
      profileDirty = false;
    });
  });
  $('server-command').addEventListener('input', () => {
    $('server-command').removeAttribute('aria-invalid');
    render();
  });
  $('command-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if ($('send-command').disabled) return;
    const command = $('server-command').value;
    if (!command.trim() || /[\0\r\n]/.test(command) || command.length > 4096) return invalid('server-command', 'Enter one command line (up to 4096 characters), without NUL characters or line breaks.');
    return runAction('sendCommand', { command }, () => { $('server-command').value = ''; });
  });
  $('follow-logs').addEventListener('change', () => {
    if ($('follow-logs').checked) $('console-output').scrollTop = $('console-output').scrollHeight;
  });

  // Sidebar tabs own whole pages; Settings has its own category tabs. The selected tab alone is marked,
  // and focus stays on whichever tab the user clicked (arrow keys move it, as in any tab list).
  function tabGroup(names, tabId, panelId, onSelect) {
    const select = (name, focus = false) => {
      for (const other of names) {
        const selected = other === name;
        $(panelId(other)).hidden = !selected;
        $(tabId(other)).setAttribute('aria-selected', String(selected));
        $(tabId(other)).tabIndex = selected ? 0 : -1;
        $(tabId(other)).classList.toggle('is-active', selected);
      }
      onSelect?.(name);
      if (focus) $(tabId(name)).focus();
    };
    for (const name of names) {
      $(tabId(name)).addEventListener('click', () => select(name));
      $(tabId(name)).addEventListener('keydown', (event) => {
        const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
        if (!step && !['Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const available = names.filter((n) => !$(tabId(n)).hidden);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : (available.indexOf(name) + step + available.length) % available.length;
        select(available[index], true);
      });
    }
    return select;
  }
  selectPage = window.seedDashboard.bind({ runAction, refresh, showError });
  selectCategory = tabGroup(['appearance', 'network', 'app'], (n) => `settings-cat-${n}`, (n) => `settings-${n}`, (name) => {
    settingsCategory = name;
    $('settings-savebar').hidden = name === 'appearance' && !settingsDirty;
  });
  $('open-console').addEventListener('click', () => selectPage('console'));
  $('start-listener').addEventListener('click', () => {
    if ($('start-listener').disabled) return;
    return runAction('startPeerListener');
  });
  async function copyText(id, text) {
    if ($(id).disabled) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable. Select and copy the text manually.');
      await navigator.clipboard.writeText(text);
      const original = $(id).textContent;
      $(id).textContent = 'Copied';
      setTimeout(() => { $(id).textContent = original; }, 1800);
    } catch (error) {
      showError(`Copy failed: ${errorMessage(error)}`);
    }
  }
  $('copy-fingerprint').addEventListener('click', () => copyText('copy-fingerprint', state?.deviceId || ''));
  $('copy-peer-details').addEventListener('click', () => {
    if (!state?.peerEndpoint) return;
    return copyText('copy-peer-details', `Fingerprint: ${state.deviceId}\nListener: ${formatEndpoint(state.peerEndpoint.host, state.peerEndpoint.port)}`);
  });
  for (const id of ['peer-name', 'peer-fingerprint', 'peer-host', 'peer-port']) {
    $(id).addEventListener('input', () => { $(id).removeAttribute('aria-invalid'); });
  }
  $('peer-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if ($('add-peer').disabled) return;
    const name = $('peer-name').value;
    const fingerprint = $('peer-fingerprint').value;
    const host = $('peer-host').value;
    const portText = $('peer-port').value;
    if (!name.trim() || name.length > 80) return invalid('peer-name', 'Enter a recognizable peer name (up to 80 characters).');
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) return invalid('peer-fingerprint', 'The verified fingerprint must be exactly 64 lowercase hexadecimal characters. Do not add spaces or silently change its case.');
    if (fingerprint === state.deviceId) return invalid('peer-fingerprint', 'This is your own fingerprint. Enter the other device’s verified fingerprint.');
    if (!host || host.length > 253 || !/^(?:[A-Za-z0-9.-]+|[0-9A-Fa-f:]+)$/.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return invalid('peer-host', 'Enter a listener hostname or IP address, without a protocol, port, spaces, or path.');
    const port = Number(portText);
    if (!/^\d{1,5}$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) return invalid('peer-port', 'Enter a listener port from 1 to 65535.');
    return runAction('addPeer', { name, fingerprint, host, port }, () => {
      if (!state.peers.some((peer) => peer.name === name && peer.fingerprint === fingerprint && peer.host === host && peer.port === port)) throw new Error('The saved trusted peer could not be confirmed. Your entries have been kept.');
      for (const id of ['peer-name', 'peer-fingerprint', 'peer-host', 'peer-port']) $(id).value = '';
      $('add-peer-details').open = false;
    });
  });
  $('peer-list').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-fingerprint]');
    if (!button || button.disabled || !state.server?.snapshotId) return;
    const peer = state.peers.find((entry) => entry.fingerprint === button.dataset.fingerprint);
    if (!peer) return;
    const method = button.dataset.method === 'handoff' ? 'handoff' : 'sendSnapshot';
    const retry = method === 'handoff' && pendingOffer()?.target === peer.fingerprint;
    if (!retry && !canSnapshot()) return;
    selectedSend = { fingerprint: peer.fingerprint, snapshotId: state.server.snapshotId, method, retry };
    $('send-dialog-title').textContent = method === 'handoff' ? 'Hand off hosting?' : 'Send this snapshot?';
    $('confirm-send').textContent = method === 'handoff' ? 'Hand off ownership' : 'Send snapshot';
    $('send-dialog-warning').textContent = retry ? 'This resends the pending handoff offer. If the peer already accepted it, it simply confirms; it is never applied twice. This PC stays fenced until the peer accepts or declines.' : method === 'handoff' ? 'This shares server files, including configuration/player data, then transfers hosting authority. This PC is fenced before transfer. If the attempt fails it stays fenced and you can retry; if the peer declines, ownership returns here. Both devices must approve. No automatic server start.' : 'This shares server files, which may contain private configuration or player data. Verify the recipient’s fingerprint. Sending is not a hosting handoff.';
    $('send-dialog-recipient').textContent = `To ${peer.name} · ${formatEndpoint(peer.host, peer.port)}`;
    $('send-dialog-fingerprint').textContent = peer.fingerprint;
    render();
    if (peer.fingerprint === state.relay?.fingerprint) return showError('This peer is your relay. Use Park on relay instead; it stores the server for any PC to claim.');
    $('send-dialog').showModal();
    $('cancel-send').focus();
  });
  $('cancel-send').addEventListener('click', () => { selectedSend = null; $('send-dialog').close(); render(); });
  $('close-send').addEventListener('click', () => { selectedSend = null; $('send-dialog').close(); render(); });
  $('send-dialog').addEventListener('close', () => { selectedSend = null; render(); });
  $('confirm-send').addEventListener('click', () => {
    if ($('confirm-send').disabled || !selectedSend) return;
    const {fingerprint,method} = selectedSend;
    selectedSend = null;
    $('send-dialog').close();
    return runAction(method, { fingerprint });
  });
  for (const [id, eventName] of [['persistent-address', 'change'], ['gateway-address', 'input'], ['start-at-login', 'change']]) {
    $(id).addEventListener(eventName, () => {
      settingsDirty = true;
      $(id).removeAttribute('aria-invalid');
      render();
    });
  }
  $('settings-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if ($('save-settings').disabled) return;
    const persistentAddress = $('persistent-address').checked;
    const gatewayAddress = $('gateway-address').value;
    const startAtLogin = $('start-at-login').checked;
    if (gatewayAddress.length > 253) return invalid('gateway-address', 'Gateway address must be at most 253 characters.');
    if (persistentAddress) {
      const match = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(gatewayAddress);
      const port = match ? Number(match[2]) : 0;
      if (!match || port < 1 || port > 65535 || match[1].startsWith('.') || match[1].endsWith('.') || match[1].includes('..')) return invalid('gateway-address', 'Enter the mini-PC gateway as hostname:port, with a port from 1 to 65535. No protocol or path.');
    }
    const relayFingerprint = $('relay-peer').value;
    const relay = relayFingerprint ? { fingerprint: relayFingerprint, parkOnStop: $('park-on-stop').checked } : null;
    const relayChanged = JSON.stringify(relay) !== JSON.stringify(state.relay ? { fingerprint: state.relay.fingerprint, parkOnStop: state.relay.parkOnStop } : null);
    return runAction('saveSettings', { persistentAddress, gatewayAddress, startAtLogin }, () => {
      if (state.settings.persistentAddress !== persistentAddress || state.settings.gatewayAddress !== gatewayAddress || state.settings.startAtLogin !== startAtLogin) throw new Error('The saved preferences could not be confirmed. Your edits have been kept.');
    }).then(async (saved) => {
      if (!saved) return;
      if (relayChanged && !await runAction('saveRelay', relay)) return;
      relayDirty = false;
      settingsDirty = false;
      relayStatus = null;
      relayStatusError = null;
      render();
      if (relay) void checkRelay();
    });
  });

  function refresh() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = Promise.resolve().then(async () => {
      try {
        if (typeof window.seedhost?.call !== 'function') throw new Error('The Seed Hosting desktop bridge is unavailable. Open this window from the desktop app.');
        const next = await window.seedhost.call('getState');
        if (!next || typeof next !== 'object' || !next.settings || !Array.isArray(next.peers) || !Array.isArray(next.logs)) throw new Error('The app returned an invalid state.');
        state = next;
        syncPublicContext();
        bridgeReady = true;
        if (!publicStatus) void refreshPublicAddress();
        if (errorKind === 'state') { $('error-banner').hidden = true; errorKind = null; }
        render();
        if (state.relay && Date.now() - friendCheckedAt > 10000 && !isBusy()) void refreshFriends();
        return true;
      } catch (error) {
        bridgeReady = false;
        showError(`Could not read app state: ${errorMessage(error)}`, 'state');
        render();
        return false;
      } finally {
        refreshInFlight = null;
      }
    });
    return refreshInFlight;
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (document.hidden) return;
    pollTimer = setTimeout(async () => {
      await refresh();
      schedulePoll();
    }, 1000);
  }

  // Appearance is a renderer-only preference remembered on this PC. Storage can be unavailable; defaults then apply.
  const APPEARANCE_KEY = 'seedhost.appearance';
  const appearanceChoices = {
    theme: ['dark', 'light', 'system'], accent: ['sprout', 'teal', 'ocean', 'violet', 'amber', 'rose'], depth: ['soft', 'tactile'],
    density: ['comfortable', 'compact'], motion: ['full', 'reduced'], close: ['tray', 'quit'],
  };
  const appearanceDefaults = { theme: 'dark', accent: 'sprout', depth: 'soft', density: 'comfortable', motion: 'full', close: 'tray' };
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  const appearance = { ...appearanceDefaults };
  try {
    const saved = JSON.parse(localStorage.getItem(APPEARANCE_KEY) || '{}');
    for (const key of Object.keys(appearanceChoices)) if (appearanceChoices[key].includes(saved?.[key])) appearance[key] = saved[key];
  } catch { /* Unreadable preference: keep defaults. */ }
  function applyAppearance() {
    const root = document.documentElement;
    root.dataset.theme = appearance.theme === 'system' ? (systemDark.matches ? 'dark' : 'light') : appearance.theme;
    root.dataset.accent = appearance.accent;
    root.dataset.depth = appearance.depth;
    root.dataset.density = appearance.density;
    root.dataset.motion = appearance.motion;
    for (const key of Object.keys(appearanceChoices)) {
      const input = $(`appearance-${key}`).querySelector(`input[value="${appearance[key]}"]`);
      if (input) input.checked = true;
    }
    const closeLabel = appearance.close === 'quit' ? 'Quit Seed Hosting safely' : 'Close to tray';
    $('window-close').setAttribute('aria-label', closeLabel);
    $('window-close').title = closeLabel;
  }
  function saveAppearance() {
    try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance)); } catch { /* Applies for this session only. */ }
  }
  for (const key of Object.keys(appearanceChoices)) {
    $(`appearance-${key}`).addEventListener('change', (event) => {
      const value = event.target.value;
      if (event.target.name !== key || !appearanceChoices[key].includes(value)) return;
      appearance[key] = value;
      applyAppearance();
      saveAppearance();
    });
  }
  $('reset-appearance').addEventListener('click', () => {
    Object.assign(appearance, appearanceDefaults);
    applyAppearance();
    saveAppearance();
  });
  systemDark.addEventListener('change', () => { if (appearance.theme === 'system') applyAppearance(); });
  applyAppearance();

  // Window chrome. Borderless offers only fullscreen; fullscreen offers only borderless.
  const hasBridge = () => typeof window.seedhost?.call === 'function';
  let fullScreen = false;
  function renderWindowState(windowState) {
    if (!windowState || typeof windowState.fullScreen !== 'boolean') return;
    fullScreen = windowState.fullScreen;
    const label = fullScreen ? 'Switch to borderless window' : 'Enter fullscreen';
    $('window-mode').dataset.mode = fullScreen ? 'fullscreen' : 'borderless';
    $('window-mode').setAttribute('aria-label', label);
    $('window-mode').title = `${label} (F11)`;
  }
  async function windowCall(method) {
    if (!hasBridge()) return showError('Window controls need the Seed Hosting desktop app.');
    try {
      renderWindowState(await window.seedhost.call(method));
    } catch (error) {
      showError(`Window control failed: ${errorMessage(error)}`);
    }
  }
  $('window-minimize').addEventListener('click', () => windowCall('windowMinimize'));
  $('window-mode').addEventListener('click', () => windowCall('windowToggleFullscreen'));
  $('window-close').addEventListener('click', () => windowCall(appearance.close === 'quit' ? 'quitApp' : 'windowClose'));
  $('quit-app').addEventListener('click', () => windowCall('quitApp'));
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (hasBridge()) void windowCall('getWindowState'); }, 60);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'F11') {
      event.preventDefault();
      void windowCall('windowToggleFullscreen');
    } else if (event.key === 'Escape' && fullScreen && !event.defaultPrevented && !document.querySelector('dialog[open]') && !event.target.closest?.('input, textarea, select')) {
      void windowCall('windowToggleFullscreen');
    }
  });

  // Splash covers the first authoritative read (and lets the mark finish drawing); never longer than 6 s.
  const splashStarted = performance.now();
  let splashDismissed = false;
  function dismissSplash() {
    if (splashDismissed) return;
    splashDismissed = true;
    const reduced = document.documentElement.dataset.motion === 'reduced';
    setTimeout(() => {
      $('splash').classList.add('is-leaving');
      document.body.classList.remove('is-splashing');
      setTimeout(() => { $('splash').hidden = true; }, reduced ? 0 : 420);
    }, reduced ? 0 : Math.max(0, 1900 - (performance.now() - splashStarted)));
  }
  setTimeout(dismissSplash, 6000);

  document.addEventListener('visibilitychange', () => {
    clearTimeout(pollTimer);
    if (!document.hidden) {
      void refresh().then(schedulePoll);
      if (hasBridge()) void windowCall('getWindowState');
    }
  });
  void refresh().then((ok) => {
    if (!ok) $('splash-status').textContent = 'Could not reach the app. Opening anyway…';
    dismissSplash();
    schedulePoll();
    void checkRelay();
  });
  if (hasBridge()) void windowCall('getWindowState');
})();
