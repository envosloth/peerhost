import test from 'node:test';
import assert from 'node:assert/strict';
import {renderer,appState,server,settled} from '../tools/ui-renderer-fixture.mjs';
const signedIn={configured:true,signedIn:true,online:true,username:'alex',detail:'Fixture directory'};
test('UX library whole card opens via click Enter Space without Open button; nested delete stays Home',async t=>{
 const page=await renderer(t,appState(server()));
 const row=page.locator('.server-row');
 assert.equal(await row.locator('button[data-action="open"]').count(),0);
 assert.equal(await row.getAttribute('role'),'button');
 for(const key of ['Enter','Space']){
   await row.focus();await row.press(key);await page.waitForFunction(()=>!document.querySelector('#operate-panel').hidden);
   await page.locator('#home-tab').click();
 }
 await row.locator('button[data-action="delete"]').click();await settled(page);
 assert.equal(await page.locator('#home-panel').isVisible(),true);
 await row.locator('.server-row-name').click();assert.equal(await page.locator('#operate-panel').isVisible(),true);
});
test('UX folder navigation opens selected managed folder and reports failure inline',async t=>{
 const page=await renderer(t,appState(server()));await page.locator('.server-row-name').click();
 await page.locator('#server-files-tab').click();
 await page.waitForFunction(()=>window.fixture.calls.some(c=>c.method==='openServerFolder'),{},{timeout:4000});
 assert.deepEqual(await page.evaluate(()=>window.fixture.calls.find(c=>c.method==='openServerFolder').payload),{id:server().id});
 assert.equal(await page.locator('#file-editor').count(),0);
 await page.evaluate(()=>{window.fixture.failure='openServerFolder';});await page.locator('#server-files-tab').click();
 await page.waitForFunction(()=>document.querySelector('#file-feedback').textContent.includes('Fixture refusal'));
 assert.equal(await page.locator('#file-feedback').isVisible(),true);
 assert.equal(await page.evaluate(()=>window.fixture.calls.some(c=>c.method==='listServerFiles')),false);
});
test('UX Mods expanded discovery has visible compatibility sort placement chips and installed lists',async t=>{
 const s={...server(),modTarget:{loader:'fabric',gameVersion:'1.21.1'}};
 const page=await renderer(t,appState(s));await page.locator('.server-row-name').click();await page.locator('#mods-tab').click();
 assert.equal(await page.locator('#mods-details').evaluate(n=>n.tagName),'SECTION');
 assert.equal(await page.locator('#mod-query').isVisible(),true);
 assert.equal(await page.locator('#mods-details select:visible').count(),0);
 assert.equal(await page.locator('#server-mods').isVisible(),true);assert.equal(await page.locator('#client-mods').isVisible(),true);
 await page.locator('[data-bridge="mod-sort"] input[value="newest"]').check();
 await page.waitForFunction(()=>window.fixture.calls.some(c=>c.method==='searchMods'&&c.payload.sort==='newest'));
 await page.locator('[data-bridge="mod-loader"] input[value="quilt"]').check();assert.equal(await page.locator('#mod-loader').inputValue(),'quilt');
 assert.equal(await page.locator('#save-mod-target').isEnabled(),true);
 assert.equal(await page.locator('#mod-placement-controls input[value="auto"]').isChecked(),true);
});
test('UX groups label bound local server and remote pending label without invented local binding',async t=>{
 const page=await renderer(t,{...appState(server()),account:{status:signedIn}});
 await page.evaluate(()=>{const original=window.seedhost.call;window.seedhost.call=async(m,p)=>m==='listHostingGroups'?[
 {fingerprint:'c'.repeat(64),name:'Shared group',serverId:'a'.repeat(32),serverName:'Existing world',pending:false,localAuthority:true},
 {fingerprint:'d'.repeat(64),name:'Remote world',serverId:null,serverName:null,pending:true,localAuthority:false}]:original(m,p);window.dispatchEvent(new Event('seedhost-account-changed'));});
 await page.locator('#friends-tab').click();await page.locator('[data-hosting-group]').first().waitFor();
 assert.match(await page.locator('[data-hosting-group="'+ 'c'.repeat(64)+'"]').textContent(),/Server: Existing world/);
 const pending=await page.locator('[data-hosting-group="'+ 'd'.repeat(64)+'"]').textContent();
 assert.match(pending,/Remote group: Remote world/);assert.match(pending,/No local server bound/);assert.doesNotMatch(pending,/Existing world/);
});
test('UX inline Home notices require explicit incoming handoff response and explain download working copy',async t=>{
 const state={...appState(server()),appNotice:'Quit refused while an operation is busy',incomingHandoff:{id:'offer-1',source:'Sam PC',snapshotId:'revision-1'}};
 const page=await renderer(t,state);
 assert.equal(await page.locator('#home-panel').isVisible(),true);
 assert.equal(await page.locator('#app-notice').isVisible(),true);assert.match(await page.locator('#app-notice').textContent(),/Quit refused/);
 assert.match(await page.locator('#incoming-handoff').textContent(),/Sam PC/);
 assert.equal(await page.evaluate(()=>window.fixture.calls.some(c=>c.method==='respondIncomingHandoff')),false);
 await page.locator('#incoming-handoff-decline').click();await settled(page);
 assert.deepEqual(await page.evaluate(()=>window.fixture.calls.find(c=>c.method==='respondIncomingHandoff').payload),{id:'offer-1',accepted:false});
 await page.locator('#nav-setup').click();assert.match(await page.locator('#setup-download-note').textContent(),/chosen.*folder.*subfolder|chosen.*directory.*subfolder/);assert.match(await page.locator('#setup-download-note').textContent(),/separate managed working copy/);
});
test('incoming inline consent remains actionable while the receive operation holds the mutation lock',async t=>{
 const id='12345678-1234-4234-8234-123456789abc';
 const page=await renderer(t,appState(server()));
 await page.evaluate(id=>{window.fixture.state.busy='receiveSnapshot';window.fixture.state.incomingHandoff={id,source:'Trusted fixture PC',snapshotId:'b'.repeat(64)};},id);
 await page.waitForFunction(()=>document.querySelector('#activity-message').textContent==='Working: receiveSnapshot');
 assert.equal(await page.locator('#incoming-handoff-accept').isEnabled(),true,'the pending receive cannot disable the response that releases it');
 assert.equal(await page.locator('#create-snapshot').isDisabled(),true,'ordinary mutations remain locked');
 await page.evaluate(()=>{const old=window.seedhost.call;window.seedhost.call=async(m,p)=>{if(m==='respondIncomingHandoff'){window.fixture.calls.push({method:m,payload:p});return new Promise(resolve=>{window.finishResponse=()=>{window.fixture.state.incomingHandoff=null;window.fixture.state.busy=null;resolve({responded:true});};});}return old(m,p);};});
 await page.locator('#incoming-handoff-accept').click();await page.waitForFunction(()=>!!window.finishResponse);
 assert.equal(await page.locator('#incoming-handoff-decline').isDisabled(),true,'a second response cannot race the first');
 await page.evaluate(()=>window.finishResponse());await settled(page);
 assert.deepEqual(await page.evaluate(()=>window.fixture.calls.filter(c=>c.method==='respondIncomingHandoff').map(c=>c.payload)),[{id,accepted:true}]);
});
test('explicit peer handoff runs without a warning popup and keeps transfer consequences inline',async t=>{
 const peer={name:'Trusted fixture',host:'127.0.0.1',port:47642,fingerprint:'b'.repeat(64)};
 const page=await renderer(t,{...appState(server()),peers:[peer]});
 await page.locator('#settings-tab').click();await page.locator('#advanced-peers > summary').click();
 assert.equal(await page.locator('#send-dialog').count(),0,'the outgoing warning dialog must be removed, not merely hidden');
 assert.match(await page.locator('#peer-transfer-warning').textContent(),/files.*configuration.*player data|configuration.*player data/i);
 assert.match(await page.locator('#peer-transfer-warning').textContent(),/fenced|retry/i);
 await page.locator('[data-method="handoff"]').click();await settled(page);
 assert.deepEqual(await page.evaluate(()=>window.fixture.calls.filter(c=>c.method==='handoff').map(c=>c.payload)),[{fingerprint:peer.fingerprint}]);
});
test('UX optional always-on role status lives in Multi-host without requiring guide',async t=>{
 const page=await renderer(t,appState(server()));
 await page.evaluate(()=>{const old=window.seedhost.call;window.seedhost.call=async(m,p)=>m==='alwaysOnStatus'?{enabled:false,running:false}:old(m,p);});
 await page.locator('.server-row-name').click();await page.locator('#peers-tab').click();
 await page.waitForFunction(()=>document.querySelector('#multi-always-on-status').textContent==='Off. Your group and worlds are kept.',{},{timeout:4000});
 assert.equal(await page.locator('#setup-dialog').isVisible(),false);
});
test('UX social failed progress save cannot tick Friends optimistically',async t=>{
 const page=await renderer(t,{...appState(server()),account:{status:signedIn}});await page.locator('#nav-setup').click();await page.locator('[data-setup-step="friends"]').click();await settled(page);
 await page.evaluate(()=>{window.fixture.failure='saveOnboarding';const old=window.seedhost.call;window.seedhost.call=async(m,p)=>m==='accountFriendSend'?{sent:true,id:'request-1',username:p.username}:old(m,p);});
 await page.locator('#setup-friend-username').fill('sam');await page.locator('#setup-friend-send').click();await page.waitForFunction(()=>document.querySelector('#action-loading').hidden);
 assert.equal(await page.locator('[data-setup-step="friends"]').getAttribute('data-done'),'false');
 assert.equal(await page.evaluate(()=>window.fixture.state.onboarding.friendsConfigured),undefined);
});
test('UX stale guide request cannot repopulate a reopened guide or persist social progress',async t=>{
 const page=await renderer(t,{...appState(server()),account:{status:signedIn}});await page.locator('#nav-setup').click();await page.locator('[data-setup-step="friends"]').click();await settled(page);
 await page.evaluate(()=>{const old=window.seedhost.call;window.seedhost.call=async(m,p)=>m==='accountFriendSend'?new Promise(resolve=>{window.finishSend=()=>resolve({sent:true,id:'late-request',username:p.username});}):old(m,p);});
 await page.locator('#setup-friend-username').fill('sam');await page.locator('#setup-friend-send').click();await page.waitForFunction(()=>!!window.finishSend);
 await page.locator('#setup-save-close').click();await settled(page);await page.locator('#nav-setup').click();
 await page.evaluate(()=>{document.querySelector('#setup-friend-feedback').textContent='New guide context';window.finishSend();});await page.waitForFunction(()=>document.querySelector('#action-loading').hidden);
 assert.equal(await page.evaluate(()=>window.fixture.state.onboarding.friendsConfigured),undefined);
 assert.equal(await page.locator('#setup-friend-feedback').textContent(),'New guide context');
});
test('UX passive dashboard sampling is five-second data-page-only and manual refresh stays immediate',async t=>{
 const page=await renderer(t,appState(server()));
 await page.evaluate(()=>{window.clock=10000;Date.now=()=>window.clock;const old=window.seedhost.call;window.seedhost.call=async(m,p)=>m==='getServerDashboard'?(window.fixture.calls.push({method:m,payload:p}),{serverId:p.id}):old(m,p);});
 await page.locator('.server-row-name').click();await page.waitForFunction(()=>document.querySelector('#dashboard-status').textContent==='Updated from this server');
 const counts=await page.evaluate(async()=>{
   const count=()=>window.fixture.calls.filter(c=>c.method==='getServerDashboard').length;
   const before=count();for(const clock of [11000,12000,14000]){window.clock=clock;window.seedDashboard.update(window.fixture.state,false);await new Promise(r=>setTimeout(r,0));}
   const early=count();window.clock=15000;window.seedDashboard.update(window.fixture.state,false);await new Promise(r=>setTimeout(r,0));
   const due=count();window.seedDashboard.selectPage('mods');window.clock=25000;window.seedDashboard.update(window.fixture.state,false);await new Promise(r=>setTimeout(r,0));
   return {before,early,due,mods:count()};
 });
 assert.equal(counts.early,counts.before);assert.equal(counts.due,counts.before+1);assert.equal(counts.mods,counts.due);
 await page.locator('#dashboard-refresh').click();await page.waitForFunction(n=>window.fixture.calls.filter(c=>c.method==='getServerDashboard').length===n,counts.due+1);
});
test('UX library retains focused cards through unchanged and busy polling while real labels update',async t=>{
 const page=await renderer(t,appState(server()));await page.locator('.server-row').focus();
 const result=await page.evaluate(()=>{
   const row=document.querySelector('.server-row');const next=window.fixture.state;
   for(let i=0;i<5;i++){next.servers[0].sampledAt=i;window.seedDashboard.renderServers(structuredClone(next),false);}
   const unchanged=document.activeElement===row&&row.isConnected;
   window.seedDashboard.renderServers(structuredClone(next),true);
   const busy=document.activeElement===row&&row.isConnected&&row.getAttribute('aria-disabled')==='true';
   window.seedDashboard.renderServers(structuredClone(next),false);
   const idle=document.activeElement===row&&row.isConnected&&row.getAttribute('aria-disabled')==='false';
   next.servers[0].name='Updated world';window.seedDashboard.renderServers(structuredClone(next),false);
   return {unchanged,busy,idle,label:document.querySelector('.server-row-name').textContent};
 });assert.deepEqual(result,{unchanged:true,busy:true,idle:true,label:'Updated world'});
});
test('UX failed or malformed social acknowledgments cannot tick Friends; acceptance needs readback',async t=>{
 const page=await renderer(t,{...appState(server()),account:{status:signedIn,friendRequests:[{id:'request-1',from:'sam'}]}});await page.locator('#nav-setup').click();await page.locator('[data-setup-step="friends"]').click();await settled(page);
 await page.evaluate(()=>{const old=window.seedhost.call;window.seedhost.call=async(m,p)=>m==='accountFriendSend'?{sent:false,id:'request-2',username:p.username}:m==='accountFriendAccept'?{added:true,username:'sam'}:old(m,p);});
 await page.locator('#setup-friend-username').fill('taylor');await page.locator('#setup-friend-send').click();await page.waitForFunction(()=>document.querySelector('#setup-friend-feedback').textContent.includes('could not be confirmed'));
 assert.equal(await page.evaluate(()=>window.fixture.state.onboarding.friendsConfigured),undefined);
 await page.locator('#setup-friend-request-list [data-friend-accept="request-1"]').click();await page.waitForFunction(()=>document.querySelector('#setup-friend-feedback').textContent.includes('directory did not confirm'));
 assert.equal(await page.evaluate(()=>window.fixture.state.onboarding.friendsConfigured),undefined);
 await page.evaluate(()=>{window.fixture.state.account.friends=[{username:'sam'}];});
 await page.locator('#setup-friend-request-list [data-friend-accept="request-1"]').click();await page.waitForFunction(()=>window.fixture.state.onboarding.friendsConfigured==='accepted');
 assert.equal(await page.locator('[data-setup-step="friends"]').getAttribute('data-done'),'true');
 await page.locator('#setup-save-close').click();await settled(page);await page.locator('#nav-setup').click();
 assert.equal(await page.locator('[data-setup-step="friends"]').getAttribute('data-done'),'true');
});
test('UX social guide marks validated request pending for its world and omits gateway',async t=>{
 const state={...appState(server()),account:{status:signedIn}};
 const page=await renderer(t,state);await page.locator('#nav-setup').click();await page.locator('[data-setup-step="friends"]').click();await settled(page);
 await page.evaluate(()=>{const original=window.seedhost.call;window.seedhost.call=async(m,p)=>m==='accountFriendSend'?{sent:true,id:'fixture-request',username:p.username}:original(m,p);});
 await page.locator('#setup-friend-username').fill('sam');await page.locator('#setup-friend-send').click();
 await page.waitForFunction(()=>window.fixture.state.onboarding.friendsConfigured==='request-pending',{},{timeout:4000});
 assert.equal(await page.locator('[data-setup-step="friends"]').getAttribute('data-done'),'true');
 assert.match(await page.locator('#setup-friend-feedback').textContent(),/accept|pending/);
 assert.equal(await page.locator('[data-setup-step="gateway"]').count(),0);
 assert.equal(await page.locator('#setup-dialog #setup-gateway').count(),0);
 await page.locator('#setup-next').click();await settled(page);assert.equal(await page.locator('#setup-ready').isVisible(),true);
});
