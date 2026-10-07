/* Local presentation only. Busy feedback never grants authority or replaces backend readback. */
'use strict';
(() => {
  const pending = new Map();
  const globalStatus = document.getElementById('action-loading');
  function makeStatus() {
    const row = globalStatus.cloneNode(true);
    row.removeAttribute('id');
    row.dataset.loadingContext = 'dialog';
    return row;
  }
  function paint(row, entries) {
    row.hidden = entries.length === 0;
    const label = entries.at(-1)?.label || '';
    const text = entries.length > 1 ? `${label} (${entries.length} tasks in progress)` : label;
    const caption = row.querySelector('.loading-label');
    if (caption.textContent !== text) caption.textContent = text;
  }
  function render() {
    const entries = [...pending.values()];
    paint(globalStatus, entries);
    for (const dialog of document.querySelectorAll('dialog')) {
      let row = dialog.querySelector('[data-loading-context="dialog"]');
      const relevant = dialog.open ? entries.filter(entry => entry.dialog === dialog) : [];
      if (relevant.length && !row) {
        row = makeStatus();
        // Keep the setup rail/content grid intact; account dialogs use their ordinary flow.
        (dialog.querySelector('.setup-main') || dialog).prepend(row);
      }
      if (row) paint(row, relevant);
    }
  }
  function begin(label) {
    const token = Symbol('loading');
    const dialog = document.activeElement?.closest('dialog[open]') || [...document.querySelectorAll('dialog[open]')].at(-1) || null;
    pending.set(token, {label: String(label || 'Working…'), dialog});
    render();
    return () => { if (pending.delete(token)) render(); };
  }
  // A native modal makes background status inert; its own progress stays inside the top layer.
  const observer = new MutationObserver(render);
  for (const dialog of document.querySelectorAll('dialog')) observer.observe(dialog, {attributes:true, attributeFilter:['open']});
  async function run(label, work) {
    const finish = begin(label);
    try { return await work(); } finally { finish(); }
  }
  window.seedLoading = Object.freeze({begin, run});
})();
