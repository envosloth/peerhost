(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  let status=null, working=false, checking=false, mode='register', prompted=false, hasGroup=false;
  const changed=()=>window.dispatchEvent(new Event('seedhost-account-changed'));
  const message=e=>String(e?.message||e).replace(/^Error invoking remote method '[^']+': Error: /,'');
  function render(){
    if(!status)return;
    $('account-heading').textContent=status.signedIn?`@${status.username}`:'Your Seed Hosting account';
    $('account-status').textContent=status.detail;
    $('account-directory-note').textContent=status.configured?'Usernames are shared with people using this same account directory. Your world files stay on your PCs.':'Local hosting works without an account. Connect this build to a shared directory to use usernames.';
    $('account-open').hidden=status.signedIn;
    $('account-open').disabled=!status.configured||working;
    $('account-signout').hidden=!status.signedIn;
    $('account-signout').disabled=working||!status.online;
    $('username-friend-form').hidden=!status.signedIn || !hasGroup;
    $('account-create-group').hidden=!status.signedIn || hasGroup;
    $('account-start-group').disabled=working||!status.online;
    $('account-refresh').hidden=!status.signedIn;
    for(const id of ['account-refresh','username-invite','friend-username']) $(id).disabled=working||!status.online;
    // Codes are a compatibility fallback, not the ordinary account-based flow.
    const manual=document.querySelector('.friends-configure');if(manual)manual.hidden=Boolean(status.signedIn);
    $('account-title').textContent=mode==='register'?'Choose your username':'Welcome back';
    $('account-submit').textContent=working?'Please wait…':mode==='register'?'Create account':'Sign in';
    $('account-password').autocomplete=mode==='register'?'new-password':'current-password';
    $('account-mode').textContent=mode==='register'?'Already have an account? Sign in':'New here? Create an account';
    for(const id of ['account-username','account-password','account-submit','account-mode','account-offline'])$(id).disabled=working;
    for(const b of $('account-inbox').querySelectorAll('button'))b.disabled=working||!status.online;
  }
  async function update(){
    if(checking||working)return;checking=true;
    try{
      status=await window.seedhost.call('accountStatus');render();
      if(status.signedIn) {
        const state=await window.seedhost.call('getState');
        hasGroup=Boolean(state.relay);render();
      } else $('account-create-group').hidden=true;
      if(status.configured&&!status.signedIn&&!prompted&&!document.body.classList.contains('is-splashing')){prompted=true;$('account-dialog').showModal();}
      if(status.signedIn&&status.online)await inbox();
    }catch(e){$('account-status').textContent=message(e);}finally{checking=false;}
  }
  async function inbox(){
    const requests=await window.seedhost.call('accountRequests');
    const nodes=requests.map(r=>{
      const li=document.createElement('li');li.className='account-request';
      const text=document.createElement('p');text.textContent=`@${r.from} invited you to ${r.group}.`;
      const hint=document.createElement('span');hint.className='field-help';hint.textContent='Accept to share hosting and world-file access. Only accept people you trust.';
      const actions=document.createElement('div');actions.className='account-input-row';
      const accept=document.createElement('button');accept.type='button';accept.className='button button-primary';accept.textContent='Accept';accept.dataset.accountAccept=r.id;
      accept.addEventListener('click',()=>act(async()=>{
        const result=await window.seedhost.call('accountAccept',{id:r.id});
        $('account-friend-feedback').textContent=`Joined ${result.group}. Your world has not been downloaded or started.`;hasGroup=true;render();changed();await inbox();
      }));
      const decline=document.createElement('button');decline.type='button';decline.className='text-button';decline.textContent='Decline';decline.dataset.accountDecline=r.id;
      decline.addEventListener('click',()=>act(async()=>{await window.seedhost.call('accountDecline',{id:r.id});await inbox();$('account-friend-feedback').textContent='Invitation declined.';}));
      actions.append(accept,decline);li.append(text,hint,actions);return li;
    });
    if(!nodes.length){const empty=document.createElement('li');empty.className='field-help';empty.textContent='No invitations waiting.';nodes.push(empty);}
    $('account-inbox').replaceChildren(...nodes);render();
  }
  async function act(work){if(working)return;working=true;render();try{await work();}catch(e){$('account-friend-feedback').textContent=message(e);}finally{working=false;render();}}
  $('account-open').addEventListener('click',()=>{if(!working){$('account-error').hidden=true;$('account-dialog').showModal();}});
  $('account-offline').addEventListener('click',()=>{$('account-password').value='';$('account-dialog').close();prompted=true;});
  $('account-dialog').addEventListener('cancel',event=>{if(working)event.preventDefault();else{$('account-password').value='';prompted=true;}});
  $('account-mode').addEventListener('click',()=>{mode=mode==='register'?'login':'register';$('account-error').hidden=true;render();});
  $('account-form').addEventListener('submit',async event=>{
    event.preventDefault();if(working||!$('account-form').reportValidity())return;
    working=true;$('account-error').hidden=true;render();
    const credentials={username:$('account-username').value,password:$('account-password').value};
    $('account-password').value='';
    try{status=await window.seedhost.call(mode==='register'?'accountRegister':'accountLogin',credentials);$('account-dialog').close();hasGroup=Boolean((await window.seedhost.call('getState')).relay);changed();await inbox();}
    catch(e){$('account-error').textContent=message(e);$('account-error').hidden=false;}
    finally{credentials.password='';working=false;render();}
  });
  $('username-friend-form').addEventListener('submit',event=>{event.preventDefault();if(!$('username-friend-form').reportValidity())return;void act(async()=>{const r=await window.seedhost.call('accountSend',{username:$('friend-username').value});$('account-friend-feedback').textContent=`Invitation sent to @${r.username}. They accept it in their app.`;$('friend-username').value='';});});
  $('account-refresh').addEventListener('click',()=>act(inbox));
  $('account-start-group').addEventListener('click',()=>act(async()=>{await window.seedhost.call('accountStartGroup');hasGroup=true;render();changed();$('account-friend-feedback').textContent='Your group is ready. Add your friend by username.';}));
  $('account-signout').addEventListener('click',()=>act(async()=>{status=await window.seedhost.call('accountLogout');$('account-inbox').replaceChildren();render();}));
  window.addEventListener('seedhost-account-changed',()=>void update());
  void update();setInterval(()=>void update(),15000);
  // Signup appears after the splash; do not block local use if the directory is not configured.
  const initial=setInterval(()=>{if(!document.body.classList.contains('is-splashing')){clearInterval(initial);void update();}},500);
})();
