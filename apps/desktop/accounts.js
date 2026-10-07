(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  let status=null, working=false, checking=false, mode='register', prompted=false;
  let hasGroup=false, serverName='';
  // context bumps whenever the signed-in identity/context changes; opToken makes the newest async operation win.
  let context=0, opToken=0;
  let friendRequests=[], friends=[], hostingRequests=[], friendSeamAvailable=true;
  const friendSeamNotice='Friend features need the account-service update; this build does not include them yet.';
  const changed=()=>window.dispatchEvent(new Event('seedhost-account-changed'));
  const message=e=>String(e?.message||e).replace(/^Error invoking remote method '[^']+': Error: /,'');
  const validUsername=value=>typeof value==='string'&&/^[A-Za-z0-9_]{3,24}$/.test(value);
  const validText=value=>typeof value==='string'&&value.trim().length>0;
  const validPin=pin=>typeof pin==='string'&&/^[a-f0-9]{64}$/.test(pin);
  const validPort=port=>Number.isInteger(port)&&port>=1&&port<=65535;
  const validFriendRequest=r=>Boolean(r)&&validText(r.id)&&validUsername(r.from);
  const validFriend=f=>Boolean(f)&&validUsername(f.username);
  const profilePasswords = ['profile-current-password','profile-new-password','profile-confirm-password'];
  function clearProfilePasswords(){for(const id of profilePasswords)$(id).value='';}
  const element=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const friendEmpty=text=>element('li','field-help',text);
  const friendWhen=since=>typeof since==='number'&&Number.isFinite(since)?`Friends since ${new Date(since).toLocaleDateString()}`:'';
  function renderProfile(){
    const signedIn=Boolean(status?.signedIn);
    $('profile-name').textContent=signedIn?'@'+status.username:'';
    $('profile-open').disabled=working;
    $('profile-status').textContent=status?.detail||'Account directory is not configured. Local hosting still works.';
    $('account-profile-form').hidden=!signedIn;
    // Explicit recovery stays available even after an ambiguous save or while a cached session is offline.
    $('profile-signin').hidden=false;
    $('profile-signin').textContent=signedIn?'Sign in again':'Sign in or create an account';
    $('profile-signin').disabled=working||!status?.configured;
    for(const n of $('account-profile-form').querySelectorAll('input,button'))n.disabled=working||!status?.online;
    $('profile-close').disabled=working;
  }
  function render(){
    renderProfile();
    if(!status)return;
    const signedIn=Boolean(status.signedIn), online=Boolean(status.online)&&!working, interactive=online&&!working;
    $('account-heading').textContent=status.signedIn?`@${status.username}`:'Your Seed Hosting account';
    $('account-status').textContent=status.detail;
    $('account-directory-note').textContent=status.configured?'Usernames are shared with people using this same account directory. Your world files stay on your PCs.':'Local hosting works without an account. Connect this build to a shared directory to use usernames.';
    $('account-open').hidden=status.signedIn;
    $('account-open').disabled=!status.configured||working;
    $('account-signout').hidden=!status.signedIn;
    $('account-signout').disabled=working||!status.online;
    // Ordinary friends: requests and the accepted list, without any hosting controls here.
    $('friend-add-form').hidden=!signedIn||!friendSeamAvailable;
    for(const id of ['friend-add-username','friend-add-submit','friend-requests-refresh']) $(id).disabled=!interactive||!friendSeamAvailable;
    for(const b of $('friend-request-list').querySelectorAll('button'))b.disabled=!interactive;
    for(const b of $('account-friends-list').querySelectorAll('button'))b.disabled=!interactive;
    // Hosting lives only in the selected server's Multi-host page.
    $('hosting-open-account').hidden=!status.configured||signedIn;
    $('hosting-open-account').disabled=working;
    $('hosting-status').textContent=!signedIn?'Sign in to invite friends to host with you.':!status.online?'Your account is offline; hosting actions are paused.':hasGroup?'Your hosting group is ready. Invite a friend to host this server.':'No hosting group yet. Create one on this PC, or accept a hosting invitation below.';
    $('hosting-create-group').hidden=!signedIn||hasGroup;
    $('hosting-server-name').textContent=serverName||'this server';
    $('hosting-add-form').hidden=!signedIn;
    for(const id of ['hosting-start-group','hosting-add-username','hosting-add-submit','hosting-requests-refresh']) $(id).disabled=!interactive;
    for(const b of $('hosting-friend-list').querySelectorAll('button'))b.disabled=!interactive||!hasGroup;
    for(const b of $('hosting-request-list').querySelectorAll('button'))b.disabled=!interactive;
    $('account-title').textContent=mode==='register'?'Choose your username':'Welcome back';
    $('account-submit').textContent=working?'Please wait…':mode==='register'?'Create account':'Sign in';
    $('account-password').autocomplete=mode==='register'?'new-password':'current-password';
    $('account-mode').textContent=mode==='register'?'Already have an account? Sign in':'New here? Create an account';
    for(const id of ['account-username','account-password','account-submit','account-mode','account-offline'])$(id).disabled=working;
    const setupStatus=$('setup-friends-status');
    if(setupStatus) setupStatus.textContent=signedIn?`Signed in as @${status.username}. Open Friends to manage requests and hosting.`:'Open the Friends page to sign in, add friends by username and answer requests.';
  }
  function renderFriendLists(){
    const signedIn=Boolean(status?.signedIn);
    $('friend-requests-count').textContent=friendRequests.length?String(friendRequests.length):'';
    $('friends-count').textContent=friends.length?String(friends.length):'';
    $('friend-requests-refresh').hidden=!signedIn;
    if(!signedIn){
      $('friend-request-list').replaceChildren(friendEmpty('Sign in to get friend requests.'));
      $('account-friends-list').replaceChildren(friendEmpty('Sign in to see your friends.'));
      renderHostingLists();
      return;
    }
    if(!friendSeamAvailable){
      $('friend-request-list').replaceChildren(friendEmpty(friendSeamNotice));
      $('account-friends-list').replaceChildren(friendEmpty(friendSeamNotice));
      renderHostingLists();
      return;
    }
    const requestNodes=friendRequests.map(r=>{
      const li=element('li','account-request'); li.dataset.friendRequest=r.id;
      li.append(element('p','','@'+r.from+' sent you a friend request.'), element('p','field-help','Accepting makes you friends in your app. It does not share hosting or world files.'));
      const actions=element('div','account-input-row');
      const accept=element('button','button button-primary button-small','Accept'); accept.type='button'; accept.dataset.friendAccept=r.id;
      accept.addEventListener('click',()=>{ if(!accept.disabled) void acceptFriendRequest(r); });
      const decline=element('button','text-button','Decline'); decline.type='button'; decline.dataset.friendDecline=r.id;
      decline.addEventListener('click',()=>{ if(!decline.disabled) void declineFriendRequest(r); });
      actions.append(accept,decline); li.append(actions); return li;
    });
    $('friend-request-list').replaceChildren(...(requestNodes.length?requestNodes:[friendEmpty('No friend requests waiting.')]));
    const friendNodes=friends.map(f=>{
      const li=element('li','friend-item'); li.dataset.friendUsername=f.username;
      li.append(element('span','friend-name','@'+f.username));
      const when=friendWhen(f.since); if(when) li.append(element('span','subtle-label',when));
      const remove=element('button','text-button friend-remove','Remove'); remove.type='button'; remove.dataset.friendRemove=f.username;
      remove.setAttribute('aria-label','Remove @'+f.username+' from your friends');
      remove.addEventListener('click',()=>{ if(!remove.disabled) void removeFriend(f.username); });
      li.append(remove); return li;
    });
    $('account-friends-list').replaceChildren(...(friendNodes.length?friendNodes:[friendEmpty('No friends yet. Add someone by username above.')]));
    renderHostingLists();
  }
  function renderHostingLists(){
    const signedIn=Boolean(status?.signedIn);
    $('hosting-requests-refresh').hidden=!signedIn;
    // Invite buttons only appear for accepted friends and only once a hosting group exists.
    const inviteNodes=friends.map(f=>{
      const li=element('li','friend-item'); li.dataset.hostInviteUsername=f.username;
      li.append(element('span','friend-name','@'+f.username));
      const invite=element('button','button button-small','Invite to host '+(serverName||'this server'));
      invite.type='button'; invite.dataset.hostInvite=f.username; invite.disabled=!hasGroup||working;
      invite.title=hasGroup?`Invite @${f.username} to host ${serverName||'this server'}`:'Create your hosting group first';
      invite.addEventListener('click',()=>{ if(!invite.disabled) void inviteToHost(f.username); });
      li.append(invite); return li;
    });
    $('hosting-friend-list').replaceChildren(...(inviteNodes.length?inviteNodes:[friendEmpty(signedIn?'No friends yet. Add a friend by username above.':'Sign in to invite friends to host.')]));
    // Hosting invitations stay separate from ordinary friend requests and keep the endpoint/consent explanations.
    const requestNodes=hostingRequests.map(r=>{
      const li=element('li','account-request'); li.dataset.hostingRequest=r.id;
      li.append(element('p','','@'+r.from+' invited you to host a shared world with '+r.group+'.'));
      li.append(element('p','field-help','Accepting shares hosting control and world-file access with their group. Only accept people you trust.'));
      const route=element('p','field-help invitation-route');
      const endpoint=r.controlEndpoint;
      route.textContent=endpoint?`Hosting control endpoint: ${endpoint.host}:${endpoint.port}. Reachability is unverified. ${endpoint.privateRoute?'This is a private route: use the same network or a VPN that can reach this address. ':''}This is not the Minecraft player address; a Minecraft tunnel does not make hosting invitations reachable.`:'Hosting control route is unverified. A Minecraft player address is not proof that hosting invitations can connect.';
      li.append(route);
      li.append(element('p','field-help','If acceptance times out, retry only after the owner restores access to this same endpoint. If the endpoint must change, the owner must correct the advertised control route and restart Seed Hosting; decline the old request, then ask for a new invitation.'));
      const actions=element('div','account-input-row');
      const accept=element('button','button button-primary','Accept'); accept.type='button'; accept.dataset.accountAccept=r.id;
      accept.addEventListener('click',()=>{ if(!accept.disabled) void acceptHostingRequest(r); });
      const decline=element('button','text-button','Decline'); decline.type='button'; decline.dataset.accountDecline=r.id;
      decline.addEventListener('click',()=>{ if(!decline.disabled) void declineHostingRequest(r); });
      actions.append(accept,decline); li.append(actions); return li;
    });
    $('hosting-request-list').replaceChildren(...(requestNodes.length?requestNodes:[friendEmpty(signedIn&&status?.online?'No hosting invitations waiting.':'Sign in to see hosting invitations.')]));
  }
  // Every mutation runs with a context + token guard: a sign-out, newer operation, or stale reply never renders.
  async function withOp(feedbackId, work){
    if(working) return;
    working=true; render();
    const token=++opToken, generation=context;
    const current=()=>token===opToken&&generation===context;
    try{ await work(current); }
    catch(e){ if(current()) $(feedbackId).textContent=message(e); }
    finally{ if(token===opToken){working=false;render();} }
  }
  async function readLists(current){
    const settled=await Promise.allSettled([window.seedhost.call('accountFriendRequests'),window.seedhost.call('accountFriends')]);
    if(!current())return false;
    friendSeamAvailable=settled.every(r=>r.status==='fulfilled'&&Array.isArray(r.value));
    if(!friendSeamAvailable){ friendRequests=[]; friends=[]; return true; }
    friendRequests=settled[0].value.filter(validFriendRequest); friends=settled[1].value.filter(validFriend);
    return true;
  }
  async function acceptFriendRequest(r){
    await withOp('account-friends-feedback', async current=>{
      const result=await window.seedhost.call('accountFriendAccept',{id:r.id});
      if(!current())return;
      if(result?.added!==true||!validUsername(result.username)||result.username!==r.from)throw new Error('The friend request could not be confirmed. Refresh and check before retrying.');
      const friendsList=await window.seedhost.call('accountFriends');
      if(!current())return;
      if(!Array.isArray(friendsList)||!friendsList.some(f=>f?.username===result.username))throw new Error('The account directory did not confirm this friend. Refresh and check before retrying.');
      friends=friendsList.filter(validFriend); friendRequests=friendRequests.filter(q=>q.id!==r.id);
      renderFriendLists();
      $('account-friends-feedback').textContent=`You and @${result.username} are now friends. This grants no hosting or world-file access; invite them to host from a server’s Multi-host page when you want to share.`;
    });
  }
  async function declineFriendRequest(r){
    await withOp('account-friends-feedback', async current=>{
      const result=await window.seedhost.call('accountFriendDecline',{id:r.id});
      if(!current())return;
      if(result?.declined!==true||result.id!==r.id)throw new Error('The friend request could not be declined. Refresh and check before retrying.');
      const requests=await window.seedhost.call('accountFriendRequests');
      if(!current())return;
      if(!Array.isArray(requests)||requests.some(q=>q.id===r.id))throw new Error('The account directory did not confirm this decline. Refresh and check before retrying.');
      friendRequests=requests.filter(validFriendRequest);
      renderFriendLists();
      $('account-friends-feedback').textContent=`Friend request from @${r.from} declined.`;
    });
  }
  async function removeFriend(username){
    await withOp('account-friends-feedback', async current=>{
      const result=await window.seedhost.call('accountFriendRemove',{username});
      if(!current())return;
      if(result?.removed!==true||result.username!==username)throw new Error('The friend could not be removed. Refresh and check before retrying.');
      const friendsList=await window.seedhost.call('accountFriends');
      if(!current())return;
      if(!Array.isArray(friendsList)||friendsList.some(f=>f?.username===username))throw new Error('The account directory did not confirm this removal. Refresh and check before retrying.');
      friends=friendsList.filter(validFriend);
      renderFriendLists();
      $('account-friends-feedback').textContent=`@${username} was removed from your friends. They keep no hosting or world-file access from this.`;
    });
  }
  function bindFriendAdd(formId,inputId,submitId,feedbackId){
    $(formId).addEventListener('submit',event=>{
      event.preventDefault(); if($(submitId).disabled||!$(formId).reportValidity())return;
      const username=$(inputId).value.trim().toLowerCase();
      if(!validUsername(username)){$(feedbackId).textContent='Enter a username: 3–24 letters, numbers or underscores.';return;}
      if(status?.username===username){$(feedbackId).textContent='That is your own username. Sign in as a different account to add friends by username.';return;}
      void withOp(feedbackId, async current=>{
        const result=await window.seedhost.call('accountFriendSend',{username});
        if(!current())return;
        if(result?.sent!==true||result.username!==username||!validText(result.id))throw new Error('The friend request could not be confirmed. Refresh and check before retrying.');
        if(!await readLists(current))return;
        $(inputId).value=''; renderFriendLists();
        $(feedbackId).textContent=`Friend request sent to @${username}. They accept it in their app.`;
      });
    });
  }
  async function inviteToHost(username){
    await withOp('hosting-friend-feedback', async current=>{
      const result=await window.seedhost.call('accountSend',{username});
      if(!current())return;
      if(!result||typeof result.username!=='string'||result.username!==username)throw new Error('The hosting invitation was not confirmed. Refresh and check before retrying.');
      const friendsList=await window.seedhost.call('accountFriends');
      if(!current())return;
      if(!Array.isArray(friendsList)||!friendsList.some(f=>f?.username===username))throw new Error('The account directory did not confirm this friend before inviting.');
      $('hosting-friend-feedback').textContent=`Hosting invitation sent to @${username} for “${serverName||'this server'}”. They accept it in their app; accepting shares hosting and world-file access with your group.`;
    });
  }
  async function acceptHostingRequest(r){
    await withOp('hosting-request-feedback', async current=>{
      const result=await window.seedhost.call('accountAccept',{id:r.id});
      if(!current())return;
      const saved=await window.seedhost.call('getState');
      if(!current())return;
      const endpoint=r.controlEndpoint;
      // Two truthful enrollment shapes: bound to this world's group, or recorded as a joined group without a local
      // world yet (pendingGroups). Both are durable readback; neither downloads, starts or replaces any world.
      const pending=Array.isArray(saved?.pendingGroups)?saved.pendingGroups.find(p=>validText(p?.name)&&p.name===r.group&&validPin(p?.fingerprint)):null;
      const bound=validText(saved?.relay?.name)&&saved.relay.name===r.group&&saved.relay.parkOnStop===true&&validPin(saved.relay.fingerprint);
      const pin=pending?pending.fingerprint:bound?saved.relay.fingerprint:'';
      const peer=saved?.peers?.find(p=>validPin(p.fingerprint)&&p.fingerprint===pin);
      if(result?.joined!==true||!validText(r.group)||!validText(result.group)||result.group!==r.group||(!bound&&!pending)||!peer||!endpoint||!validText(endpoint.host)||!validText(peer.host)||!validPort(endpoint.port)||!validPort(peer.port)||peer.host!==endpoint.host||peer.port!==endpoint.port)throw new Error('Group enrollment could not be confirmed. This PC may already be enrolled; refresh members and check the group before retrying.');
      $('hosting-request-feedback').textContent=bound?(saved.server?`Joined ${result.group}. Your existing world stays on this PC; nothing was downloaded or started.`:`Joined ${result.group}. Your world has not been downloaded or started.`):`Joined ${result.group}. The shared world is not on this PC yet; nothing was downloaded, started or changed. Use Settings → group to attach this to a world, or take over hosting when the owner hands it over.`;
      hasGroup=true; render(); changed();
      const requests=await window.seedhost.call('accountRequests');
      if(!current())return;
      hostingRequests=Array.isArray(requests)?requests:hostingRequests.filter(q=>q.id!==r.id);
      renderHostingLists();
    });
  }
  async function declineHostingRequest(r){
    await withOp('hosting-request-feedback', async current=>{
      await window.seedhost.call('accountDecline',{id:r.id});
      if(!current())return;
      const requests=await window.seedhost.call('accountRequests');
      if(!current())return;
      if(!Array.isArray(requests))throw new Error('The account directory did not confirm this decline. Refresh and check before retrying.');
      hostingRequests=requests;
      renderHostingLists();
      $('hosting-request-feedback').textContent='Invitation declined.';
    });
  }
  async function refreshLists(){
    if(!status?.signedIn||working||checking)return;
    checking=true;
    const token=++opToken, generation=context;
    const current=()=>token===opToken&&generation===context;
    try{
      if(!await readLists(current))return;
      if(status.online){ const requests=await window.seedhost.call('accountRequests'); if(current()&&Array.isArray(requests))hostingRequests=requests; }
      if(current())renderHostingLists();
    }catch(e){ if(current())$('account-friends-feedback').textContent=message(e); }
    finally{ checking=false; }
  }
  async function update(){
    if(checking)return;checking=true;
    try{
      const next=(await window.seedhost.call('accountStatus'))??{configured:false,signedIn:false,online:false,username:null,detail:'Account directory is not configured.'};
      // Identity changes must be visible even while an operation is pending so its stale reply never renders.
      if(!status||status.signedIn!==next.signedIn||status.username!==next.username)context++;
      status=next;
      const state=await window.seedhost.call('getState');
      hasGroup=Boolean(state?.relay);
      serverName=validText(state?.server?.name)?state.server.name:'';
      if(!working){
        if(status.signedIn){
          const settled=await Promise.allSettled([window.seedhost.call('accountFriendRequests'),window.seedhost.call('accountFriends')]);
          friendSeamAvailable=settled.every(r=>r.status==='fulfilled'&&Array.isArray(r.value));
          friendRequests=friendSeamAvailable?settled[0].value.filter(validFriendRequest):[];
          friends=friendSeamAvailable?settled[1].value.filter(validFriend):[];
          if(status.online){ const hosting=await window.seedhost.call('accountRequests'); if(Array.isArray(hosting))hostingRequests=hosting; }
          else hostingRequests=[];
        }else{ friendRequests=[];friends=[];hostingRequests=[]; }
        renderFriendLists();
      }
      render();
      if(status.configured&&!status.signedIn&&!prompted&&!document.body.classList.contains('is-splashing')){prompted=true;$('account-dialog').showModal();}
    }catch(e){$('account-status').textContent=message(e);}
    finally{checking=false;render();}
  }
  $('account-profile-form').addEventListener('submit',async event=>{
    event.preventDefault();if(working||!status?.signedIn||!status.online||!$('account-profile-form').reportValidity())return;
    const username=$('profile-username').value.trim().toLowerCase(),newPassword=$('profile-new-password').value;
    if(newPassword!==$('profile-confirm-password').value){$('account-profile-feedback').textContent='The new passwords must match.';return;}
    if(username===status.username&&!newPassword){$('account-profile-feedback').textContent='No profile changes to save.';clearProfilePasswords();return;}
    const input={username,currentPassword:$('profile-current-password').value,...(newPassword?{newPassword}:{})};
    clearProfilePasswords();working=true;$('account-profile-feedback').textContent='Saving profile…';render();
    try{
      const result=await window.seedhost.call('accountUpdateProfile',input);
      const readBack=await window.seedhost.call('accountStatus');
      if(!result?.signedIn||result.username!==username||!readBack?.signedIn||!readBack.online||readBack.username!==username)throw new Error('The account directory did not confirm this change. Sign in again and check before retrying.');
      status=readBack;$('profile-username').value=status.username;
      $('account-profile-feedback').textContent='Saved profile and confirmed your username with the account directory.';changed();
    }catch(e){$('account-profile-feedback').textContent=message(e);}
    finally{input.currentPassword='';if('newPassword' in input)input.newPassword='';working=false;render();}
  });
  $('profile-open').addEventListener('click',()=>{
    if(working)return;clearProfilePasswords();$('account-profile-feedback').textContent='';
    $('profile-username').value=status?.username||'';renderProfile();$('profile-dialog').showModal();
  });
  $('profile-close').addEventListener('click',()=>{if(!working)$('profile-dialog').close();});
  $('profile-dialog').addEventListener('cancel',event=>{if(working)event.preventDefault();});
  $('profile-dialog').addEventListener('close',clearProfilePasswords);
  $('profile-signin').addEventListener('click',()=>{
    if(working||!status?.configured)return;mode='login';$('profile-dialog').close();
    $('account-error').hidden=true;render();$('account-dialog').showModal();
  });
  $('account-open').addEventListener('click',()=>{if(!working){$('account-error').hidden=true;$('account-dialog').showModal();}});
  $('hosting-open-account').addEventListener('click',()=>{if(!working&&status?.configured){$('account-error').hidden=true;$('account-dialog').showModal();}});
  $('account-offline').addEventListener('click',()=>{$('account-password').value='';$('account-dialog').close();prompted=true;});
  $('account-dialog').addEventListener('cancel',event=>{if(working)event.preventDefault();else{$('account-password').value='';prompted=true;}});
  $('account-mode').addEventListener('click',()=>{mode=mode==='register'?'login':'register';$('account-error').hidden=true;render();});
  $('account-form').addEventListener('submit',async event=>{
    event.preventDefault();if(working||!$('account-form').reportValidity())return;
    working=true;$('account-error').hidden=true;render();
    const credentials={username:$('account-username').value,password:$('account-password').value};
    $('account-password').value='';
    try{
      status=await window.seedhost.call(mode==='register'?'accountRegister':'accountLogin',credentials);
      context++;
      const state=await window.seedhost.call('getState');
      hasGroup=Boolean(state?.relay); serverName=validText(state?.server?.name)?state.server.name:'';
      $('account-dialog').close();changed();
      await refreshLists();
    }
    catch(e){$('account-error').textContent=message(e);$('account-error').hidden=false;}
    finally{credentials.password='';working=false;render();}
  });
  bindFriendAdd('friend-add-form','friend-add-username','friend-add-submit','account-friends-feedback');
  bindFriendAdd('hosting-add-form','hosting-add-username','hosting-add-submit','hosting-friend-feedback');
  $('friend-requests-refresh').addEventListener('click',()=>void refreshLists());
  $('hosting-requests-refresh').addEventListener('click',()=>void refreshLists());
  $('hosting-start-group').addEventListener('click',()=>{if($('hosting-start-group').disabled)return;void withOp('hosting-friend-feedback',async current=>{
    const result=await window.seedhost.call('accountStartGroup');
    if(!current())return;
    if(result?.created!==true)throw new Error('The hosting group could not be confirmed. Refresh and check before retrying.');
    const state=await window.seedhost.call('getState');
    if(!current())return;
    if(!state?.relay)throw new Error('The hosting group was not confirmed by this PC. Refresh and check before retrying.');
    hasGroup=true; renderHostingLists(); render(); changed();
    $('hosting-friend-feedback').textContent='Your hosting group is ready. Invite a friend to host this server.';
  });});
  $('account-signout').addEventListener('click',()=>{if(working)return;void withOp('account-friends-feedback',async current=>{
    const next=await window.seedhost.call('accountLogout');
    if(!current())return;
    status=next; context++;
    friendRequests=[];friends=[];hostingRequests=[];
    const state=await window.seedhost.call('getState');
    hasGroup=Boolean(state?.relay); serverName=validText(state?.server?.name)?state.server.name:'';
    renderFriendLists(); render();
  });});
  window.addEventListener('seedhost-account-changed',()=>void update());
  void update();setInterval(()=>void update(),15000);
  // Signup appears after the splash; do not block local use if the directory is not configured.
  const initial=setInterval(()=>{if(!document.body.classList.contains('is-splashing')){clearInterval(initial);void update();}},500);
})();
