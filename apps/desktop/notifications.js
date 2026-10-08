(() => {
  'use strict';
  const $=id=>document.getElementById(id), MAX=100, SEEN_MAX=500;
  let scope=null, history=[], seen=[], serverStates=new Map(), accountGeneration=0;
  const text=v=>typeof v==='string'&&v.length>0&&v.length<=160;
  const username=v=>typeof v==='string'&&/^[a-z0-9_]{3,24}$/.test(v);
  const key=()=>`seedhost.notifications.v1:${scope}`;
  function save(){if(!scope)return;try{localStorage.setItem(key(),JSON.stringify({history,seen}));}catch{$('notifications-feedback').textContent='History could not be saved on this PC.';}}
  function setAccount(status){
    const next=status?.signedIn&&username(status.username)?JSON.stringify([status.directoryFingerprint||status.directory||'configured-directory',status.username]):null;
    if(next===scope)return;
    accountGeneration++;scope=next;history=[];seen=[];serverStates=new Map();$('notifications-feedback').textContent='';
    if(scope)try{const value=JSON.parse(localStorage.getItem(key())||'{}');history=Array.isArray(value.history)?value.history.filter(n=>n&&text(n.id)&&text(n.title)&&typeof n.read==='boolean'&&Number.isFinite(n.at)&&['friends','hosting','server'].includes(n.destination)&&(!n.serverId||text(n.serverId))).slice(0,MAX).map(n=>({id:n.id,title:n.title,read:n.read,at:n.at,destination:n.destination,...(n.serverId?{serverId:n.serverId}:{})})):[];seen=Array.isArray(value.seen)?value.seen.filter(text).slice(-SEEN_MAX):history.map(n=>n.id);}catch{}
    render();
  }
  function add(id,title,destination,serverId){
    if(!scope||!text(id)||!text(title)||seen.includes(id))return;
    if(id.startsWith('friend:')||id.startsWith('hosting:'))seen=[...seen,id].slice(-SEEN_MAX);
    history=[{id,title,destination,read:false,at:Date.now(),...(text(serverId)?{serverId}:{})},...history].slice(0,MAX);save();render();
  }
  function requests(friendRequests,hostingRequests){
    for(const r of friendRequests||[])if(text(r.id)&&username(r.from))add('friend:'+r.id,`@${r.from} sent a friend request`,'friends');
    for(const r of hostingRequests||[])if(text(r.id)&&username(r.from)){
      const loopback=/^(localhost|127(?:\.[0-9]{1,3}){3}|\[?::1\]?)$/i.test(r.controlEndpoint?.host||'');
      add('hosting:'+r.id,loopback?`@${r.from} sent a hosting invitation with a same-PC-only route. Another PC cannot reach it.`:`@${r.from} sent a hosting invitation`,'hosting');
    }
  }
  function servers(state){
    if(!scope)return;
    for(const s of state?.servers||[]){
      if(!text(s.id))continue;
      const old=serverStates.get(s.id), current=s.state;
      serverStates.set(s.id,current);
      // Custody, ownerName and restored ledger states never establish a running process.
      if(old!==undefined&&old!==current&&['running','offline','failed','crashed'].includes(current)){
        const title=current==='running'?'Server started':current==='offline'?'Server stopped':'Server process failed';
        add(`server:${s.id}:${Date.now()}:${current}`,title,'server',s.id);
      }
    }
  }
  function failure(method,serverId){if(!['startServer','stopServer'].includes(method))return;add(`failure:${method}:${Date.now()}`,method==='startServer'?'Server could not start. Open it to check the error.':'Server could not stop. Open it to check the error.','server',serverId);}
  function render(){
    const unread=history.filter(n=>!n.read).length;
    $('notifications-count').textContent=String(unread);
    $('notifications-open').setAttribute('aria-label',`Notifications, ${unread} unread`);
    $('notifications-mark-read').disabled=!unread;
    $('notifications-clear').disabled=!history.length;
    const nodes=history.map(n=>{
      const li=document.createElement('li');li.className='account-request'+(n.read?'':' notification-unread');li.dataset.notification=n.id;
      const button=document.createElement('button');button.type='button';button.className='text-button';button.textContent=n.title;
      button.addEventListener('click',()=>{n.read=true;save();render();$('notifications-dialog').close();window.dispatchEvent(new CustomEvent('seedhost-notification-open',{detail:{destination:n.destination,serverId:n.serverId}}));});
      const when=document.createElement('p');when.className='field-help';when.textContent=`${n.read?'Read':'Unread'} · ${new Date(n.at).toLocaleString()}`;li.append(button,when);return li;
    });
    if(!nodes.length){const li=document.createElement('li');li.className='field-help';li.textContent=scope?'No notifications yet.':'Sign in to see your notification history.';nodes.push(li);}
    $('notifications-list').replaceChildren(...nodes);
  }
  $('notifications-open').addEventListener('click',()=>{$('notifications-dialog').showModal();});
  $('notifications-close').addEventListener('click',()=>{$('notifications-dialog').close();});
  $('notifications-mark-read').addEventListener('click',()=>{for(const n of history)n.read=true;save();render();});
  // Retain the bounded event IDs: clearing history must not rediscover the same waiting requests next poll.
  $('notifications-clear').addEventListener('click',()=>{history=[];save();render();});
  function captureFailure(){const generation=accountGeneration;return (method,serverId)=>{if(accountGeneration===generation)failure(method,serverId);};}
  window.seedNotifications=Object.freeze({setAccount,requests,servers,failure,captureFailure});render();
})();
