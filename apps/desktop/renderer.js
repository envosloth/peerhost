/* PeerHost's local renderer. All privileged operations go through the preload bridge. */
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

  const busyLabels = {
    importServer: 'Selecting / importing a server…', createSnapshot: 'Creating snapshot…',
    saveProfile: 'Saving launch profile…', startServer: 'Starting server…', stopServer: 'Stopping server…',
    sendCommand: 'Sending command…', saveSettings: 'Saving preferences…', startPeerListener: 'Starting peer listener…',
    addPeer: 'Saving trusted peer…', sendSnapshot: 'Sending snapshot…', handoff: 'Transferring hosting ownership…',
  };
  const isBusy = () => Boolean(pendingMethod || state?.busy);
  const isStopped = () => !state?.server || ['offline', 'failed'].includes(state.server.state);
  const isHosting = () => state?.server?.ownership?.state === 'hosting';
  const ownsServer = () => {
    const ownership = state?.server?.ownership;
    return Boolean(ownership && typeof ownership === 'object' && ownership.state === 'owned' && ownership.owner === state.deviceId);
  };
  const canSnapshot = () => bridgeReady && !isBusy() && Boolean(state?.server) && isStopped() && ownsServer();
  const formatEndpoint = (host, port) => `${String(host).includes(':') ? `[${host}]` : host}:${port}`;
  const errorMessage = (error) => typeof error?.message === 'string' ? error.message : String(error);
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function showError(message, kind = 'action') {
    errorKind = kind;
    $('error-text').textContent = message;
    $('error-banner').hidden = false;
  }

  function render() {
    const server = state?.server;
    const blocked = !bridgeReady || isBusy();
    const active = !isStopped() || isHosting();
    const profileEditable = !blocked && Boolean(server) && !active;
    const nextServerKey = server ? `${server.serverDir}\n${server.storeDir}` : null;
    if (nextServerKey !== serverKey) {
      serverKey = nextServerKey;
      profileDirty = false;
      for (const id of ['java-executable', 'java-args']) $(id).removeAttribute('aria-invalid');
    }
    $('app-version').textContent = state ? `v${state.version} · alpha` : 'App unavailable';
    $('server-name').textContent = server?.name || 'No server imported';
    $('server-empty').hidden = Boolean(server);
    $('server-info').hidden = !server;
    $('server-directory').textContent = server?.serverDir || '—';
    $('store-directory').textContent = server?.storeDir || '—';
    $('snapshot-id').textContent = server?.snapshotId || 'No snapshot yet';
    const ownership = server?.ownership;
    $('ownership-state').textContent = !server ? '—' : !ownership ? 'Unknown · hosting blocked' :
      typeof ownership === 'object' ? `${ownership.state || 'Unknown'} · ${ownership.owner === state.deviceId ? 'this device' : 'another / unknown device'}` : String(ownership);
    const processLabels = { offline: 'Stopped', failed: 'Failed', running: 'Hosting', starting: 'Starting', stopping: 'Stopping' };
    $('server-status').textContent = server ? processLabels[server.state] || `Unknown state: ${server.state}` : 'Not configured';
    $('server-status').className = 'badge';
    $('server-status').classList.toggle('is-running', server?.state === 'running');
    $('server-status').classList.toggle('is-working', ['starting', 'stopping'].includes(server?.state));
    $('server-status').classList.toggle('is-failed', server?.state === 'failed');
    $('import-server').disabled = blocked || active;
    $('start-server').disabled = blocked || !server || active || !ownsServer() || profileDirty || !server.profile?.executable || !Array.isArray(server.profile?.args);
    $('stop-server').disabled = blocked || !server || !['running', 'starting'].includes(server.state);
    $('create-snapshot').disabled = !canSnapshot();
    const recoverable = ownership?.owner === state?.deviceId && ownership?.state === 'uncertain' && !ownership?.offer && isStopped();
    $('recover-ownership').hidden = !recoverable;
    $('recover-ownership').disabled = blocked || !recoverable;
    $('java-executable').disabled = !profileEditable;
    $('java-args').disabled = !profileEditable;
    $('save-profile').disabled = !profileEditable || !profileDirty;
    if (!profileDirty) {
      $('java-executable').value = server?.profile?.executable || '';
      $('java-args').value = server ? JSON.stringify(server.profile?.args || [], null, 2) : '';
    }
    $('profile-feedback').textContent = !server ? 'Import a server to configure its launch profile.' : profileDirty ? 'Unsaved changes · save before hosting.' : active ? 'Stop hosting to edit this profile.' : 'Loaded from this server’s saved profile.';
    $('server-action-hint').textContent = !server ? 'Import a server to enable hosting and snapshots.' : !bridgeReady ? 'App state is unavailable; actions are blocked.' : isBusy() ? 'An operation is in progress. Wait for the app to finish.' : active ? 'Stop hosting before editing, creating a snapshot, or sending it to a peer. Unknown process states are blocked.' : !ownsServer() ? 'Hosting and snapshots are blocked: ownership is not safely held by this device.' : profileDirty ? 'Save your launch profile before starting. Only run executables and mods you trust.' : 'This PC hosts directly. Snapshot creation and sending require a stopped server.';
    $('server-command').disabled = blocked || server?.state !== 'running';
    $('send-command').disabled = $('server-command').disabled || !$('server-command').value.trim();
    const logText = (state?.logs || []).join('\n');
    if (logText !== lastLogs) {
      $('console-lines').textContent = logText;
      lastLogs = logText;
      if ($('follow-logs').checked) $('console-output').scrollTop = $('console-output').scrollHeight;
    }
    $('console-empty').hidden = Boolean(state?.logs?.length);
    $('device-fingerprint').value = state?.deviceId || '';
    $('copy-fingerprint').disabled = !bridgeReady || !state?.deviceId;
    $('start-listener').disabled = blocked || Boolean(state?.peerEndpoint);
    $('start-listener').textContent = state?.peerEndpoint ? 'Listener active' : 'Start listener';
    $('copy-peer-details').disabled = !bridgeReady || !state?.peerEndpoint || !state?.deviceId;
    $('listener-status').textContent = state?.peerEndpoint ? 'LISTENING' : 'NOT LISTENING';
    $('listener-endpoint').textContent = state?.peerEndpoint ? formatEndpoint(state.peerEndpoint.host, state.peerEndpoint.port) : 'No listener endpoint';
    const localOnly = ['127.0.0.1', '::1', 'localhost'].includes(state?.peerEndpoint?.host);
    $('listener-help').textContent = state?.peerEndpoint ? localOnly ? 'Loopback only: other computers cannot reach this endpoint. No router or firewall configuration is changed.' : 'This is the actual listener endpoint, not proof of public reachability. No automatic NAT traversal.' : 'Start the listener to see the actual endpoint. An endpoint is not proof of public reachability.';
    renderPeerList();
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
    $('gateway-status').textContent = 'Unconnected';
    $('settings-feedback').textContent = settingsDirty ? 'Unsaved preferences.' : 'Preferences loaded from this PC.';
    const busy = pendingMethod || state?.busy;
    $('activity-message').textContent = !bridgeReady ? 'App connection unavailable · actions blocked.' : busy ? busyLabels[busy] || `Working: ${busy}` : 'Ready · actions run on this PC.';
    $('activity-message').classList.toggle('is-busy', Boolean(busy));
    const sendStillCurrent = selectedSend && server?.snapshotId === selectedSend.snapshotId && state?.peers.some((peer) => peer.fingerprint === selectedSend.fingerprint);
    $('confirm-send').disabled = !canSnapshot() || !sendStillCurrent;
    if (selectedSend) $('send-dialog-snapshot').textContent = `Snapshot: ${selectedSend.snapshotId}${sendStillCurrent ? '' : ' · State changed. Cancel and review again.'}`;
  }

  function renderPeerList() {
    const peers = state?.peers || [];
    const signature = JSON.stringify(peers);
    $('peers-empty').hidden = peers.length > 0;
    $('peer-count').textContent = peers.length ? `${peers.length} SAVED` : 'NONE ADDED';
    if (signature !== renderedPeers) {
      renderedPeers = signature;
      const nodes = peers.map((peer) => {
        const item = element('li', 'peer-item');
        const heading = element('div', 'peer-item-heading');
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
        heading.append(element('span', 'peer-name', peer.name), button, handoff);
        const pin = element('details', 'peer-pin');
        pin.append(element('summary', '', 'Verified fingerprint'), element('code', 'peer-fingerprint', peer.fingerprint));
        item.append(heading, element('code', 'peer-endpoint', formatEndpoint(peer.host, peer.port)), pin);
        return item;
      });
      $('peer-list').replaceChildren(...nodes);
    }
    for (const button of $('peer-list').querySelectorAll('button')) button.disabled = !canSnapshot() || !state.server?.snapshotId;
  }

  async function runAction(method, payload, onVerified) {
    if (!bridgeReady || isBusy()) return false;
    pendingMethod = method;
    $('error-banner').hidden = true;
    render();
    try {
      await window.peerhost.call(method, payload);
      // A polling read begun before the mutation must finish before the read-back.
      if (refreshInFlight) await refreshInFlight;
      const verified = await refresh();
      if (!verified) return false;
      if (onVerified) onVerified();
      return true;
    } catch (error) {
      const message = `${method} failed: ${errorMessage(error)}`;
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
  for (const id of ['java-executable', 'java-args']) {
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
    return runAction('saveProfile', { executable, args }, () => {
      if (state.server?.profile?.executable !== executable || JSON.stringify(state.server.profile.args) !== JSON.stringify(args)) throw new Error('The saved launch profile could not be confirmed. Your edits have been kept.');
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

  function selectPanel(panel, focus = true) {
    for (const name of ['peers', 'settings']) {
      const selected = name === panel;
      $(`${name}-panel`).hidden = !selected;
      $(`${name}-tab`).setAttribute('aria-selected', String(selected));
      $(`${name}-tab`).tabIndex = selected ? 0 : -1;
    }
    if (focus) $(`${panel}-tab`).focus();
  }
  for (const name of ['peers', 'settings']) {
    $(`${name}-tab`).addEventListener('click', () => selectPanel(name));
    $(`nav-${name}`).addEventListener('click', () => selectPanel(name));
    $(`${name}-tab`).addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      selectPanel(event.key === 'Home' ? 'peers' : event.key === 'End' ? 'settings' : name === 'peers' ? 'settings' : 'peers');
    });
  }
  $('start-listener').addEventListener('click', () => {
    if ($('start-listener').disabled) return;
    return runAction('startPeerListener');
  });
  async function copyText(id, text) {
    if ($(id).disabled) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable. Select and copy the fingerprint manually.');
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
    if (!button || button.disabled || !canSnapshot() || !state.server?.snapshotId) return;
    const peer = state.peers.find((entry) => entry.fingerprint === button.dataset.fingerprint);
    if (!peer) return;
    const method = button.dataset.method === 'handoff' ? 'handoff' : 'sendSnapshot';
    selectedSend = { fingerprint: peer.fingerprint, snapshotId: state.server.snapshotId, method };
    $('send-dialog-title').textContent = method === 'handoff' ? 'Hand off hosting?' : 'Send this snapshot?';
    $('confirm-send').textContent = method === 'handoff' ? 'Hand off ownership' : 'Send snapshot';
    $('send-dialog-warning').textContent = method === 'handoff' ? 'This shares server files, including configuration/player data, then transfers hosting authority. This PC is fenced before transfer and stays blocked after a failure or declined offer. Both devices must approve. No automatic server start.' : 'This shares server files, which may contain private configuration or player data. Verify the recipient’s fingerprint. Sending is not a hosting handoff.';
    $('send-dialog-recipient').textContent = `To ${peer.name} · ${formatEndpoint(peer.host, peer.port)}`;
    $('send-dialog-fingerprint').textContent = peer.fingerprint;
    render();
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
    return runAction('saveSettings', { persistentAddress, gatewayAddress, startAtLogin }, () => {
      if (state.settings.persistentAddress !== persistentAddress || state.settings.gatewayAddress !== gatewayAddress || state.settings.startAtLogin !== startAtLogin) throw new Error('The saved preferences could not be confirmed. Your edits have been kept.');
      settingsDirty = false;
    });
  });

  function refresh() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = Promise.resolve().then(async () => {
      try {
        if (typeof window.peerhost?.call !== 'function') throw new Error('The PeerHost desktop bridge is unavailable. Open this window from the desktop app.');
        const next = await window.peerhost.call('getState');
        if (!next || typeof next !== 'object' || !next.settings || !Array.isArray(next.peers) || !Array.isArray(next.logs)) throw new Error('The app returned an invalid state.');
        state = next;
        bridgeReady = true;
        if (errorKind === 'state') { $('error-banner').hidden = true; errorKind = null; }
        render();
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

  document.addEventListener('visibilitychange', () => {
    clearTimeout(pollTimer);
    if (!document.hidden) void refresh().then(schedulePoll);
  });
  void refresh().then(schedulePoll);
})();
