(() => {
  const $ = id => document.getElementById(id);
  let busy = false, connected = false, address = '';
  function display(result) {
    connected = result?.connected === true;
    address = typeof result?.address === 'string' ? result.address : '';
    $('playit-address').textContent = address;
    $('playit-status').textContent = result?.detail || 'Not checked.';
    controls();
  }
  function controls() {
    for (const id of ['playit-connect','playit-check','playit-create','playit-disconnect','playit-setup']) $(id).disabled = busy;
    $('playit-create').disabled = busy || !connected;
    $('playit-disconnect').disabled = busy || !connected;
    $('playit-copy').disabled = busy || !address;
  }
  async function action(method) {
    if (busy) return;
    busy = true; controls();
    if (method !== 'playitSetup') { address = ''; $('playit-address').textContent = ''; $('playit-status').textContent = 'Checking…'; }
    try {
      const r = await window.seedhost.call(method);
      if (r) display(r);
      else if (method !== 'playitSetup') display(await window.seedhost.call('playitStatus'));
    } catch { display({connected,detail:'Could not complete playit setup. Check the agent and try again.'}); }
    finally { busy = false; controls(); }
  }
  for (const [id,method] of [['playit-connect','playitImport'],['playit-check','playitCheck'],['playit-create','playitCreate'],['playit-disconnect','playitDisconnect'],['playit-setup','playitSetup']]) $(id).addEventListener('click',()=>action(method));
  $('playit-copy').addEventListener('click',async()=>{
    if(!address || busy)return;
    try { await navigator.clipboard.writeText(address); $('playit-status').textContent = 'Address copied. Share it with your Minecraft Java friends.'; }
    catch { $('playit-status').textContent = 'Select the address above and copy it manually.'; }
  });
  void action('playitStatus');
  // Clear stale reachability on each check; do not connect externally until opted in.
  setInterval(()=>{if(connected&&!busy)void action('playitCheck');},60000);
})();
