import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, shell, Tray } from 'electron';
import path from 'node:path';
import { loadAccountServiceConfig } from '../../src/core/account-service-config.js';
import { AccountIntegration } from '../../src/core/account-integration.js';
import { PlayitIntegration } from '../../src/core/playit.js';
import { playitApi, probeMinecraft } from '../../src/core/playit-network.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SeedHostApplication } from '../../src/core/application.js';
import { readServerPort } from '../../src/core/network-info.js';
import { loadIdentity } from '../../src/core/identity-store.js';
import { validateCall } from '../../src/core/ipc-policy.js';
import { decodeInvite, previewInvite } from '../../src/core/invites.js';
import { applicationMenuTemplate } from './menu.js';
import { ServerSetupClient, discoverJava, probeJava, type CreateServerInput } from '../../src/core/server-setup.js';
import type { SimpleProfileInput } from '../../src/core/java-arguments.js';
import type { ModSort } from '../../src/core/modrinth.js';
import { onboardingChecks } from '../../src/core/onboarding.js';
import { AlwaysOnHost } from '../../src/core/always-on.js';
import { Updater } from '../../src/core/updater.js';
import { PerServerPublicAddresses, playitClaim } from '../../src/core/public-address.js';
const setupLinks: Record<string,string> = Object.freeze({
  eula:'https://www.minecraft.net/en-us/eula',
  java:'https://adoptium.net/temurin/releases/',
  fabric:'https://fabricmc.net/use/server/',
  relay:'https://github.com/envosloth/seedhost/blob/main/docs/relay.md',
});
let window:BrowserWindow;let tray:Tray;let backend:SeedHostApplication;let alwaysOn:AlwaysOnHost;let publicAddress:PerServerPublicAddresses;let quitAllowed=false;let quitting=false;
// Display name; the profile folder below is SeedHost (or --profile-root).
app.setName('Seed Hosting');
const profileArgument=process.argv.find(a=>a.startsWith('--profile-root='));
const root=profileArgument?path.resolve(profileArgument.slice('--profile-root='.length)):path.join(app.getPath('appData'),'SeedHost');
app.setPath('userData',root);
const html=fileURLToPath(new URL('../../../apps/desktop/index.html',import.meta.url));
const rendererUrl=pathToFileURL(html).href;
function show(){if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();}}
// Borderless = the frameless window; fullscreen = the window owning the whole display, taskbar hidden.
function windowState(){return {fullScreen:window.isFullScreen(),maximized:window.isMaximized()};}
async function confirm(message:string,detail:string,action='Continue'):Promise<boolean>{return (await dialog.showMessageBox(window,{type:'question',message,detail,buttons:['Cancel',action],defaultId:0,cancelId:0,noLink:true})).response===1;}
async function quit(){
  if(quitting)return;quitting=true;
  try{
    const state=await backend.getState();
    if(state.busy){show();await dialog.showMessageBox(window,{type:'warning',message:'An operation is still in progress.',detail:'Wait until it completes before quitting.',buttons:['Keep app open']});return;}
    if(state.server?.state==='running'||state.server?.state==='starting'){
      show();if(!await confirm('Stop hosting and quit?','Players will disconnect. Seed Hosting will request a clean stop and save a final local snapshot. This does not guarantee another device has received it.'))return;
    }
    await backend.close();await publicAddress?.close();await alwaysOn?.close();quitAllowed=true;app.quit();
  }catch(e){show();await dialog.showMessageBox(window,{type:'error',message:'Seed Hosting could not quit safely.',detail:String(e),buttons:['Keep app open']});}
  finally{quitting=false;}
}
if(!app.requestSingleInstanceLock()){app.quit();}else{
  app.on('second-instance',show);
  app.on('before-quit',event=>{if(!quitAllowed){event.preventDefault();void quit();}});
  app.whenReady().then(async()=>{
    if(!safeStorage.isEncryptionAvailable())throw new Error('OS protected key storage (Windows DPAPI, macOS Keychain, or a Linux Secret Service) is unavailable. Refusing to store an unencrypted identity.');
    const identity=await loadIdentity(root,{encrypt:v=>safeStorage.encryptString(v),decrypt:v=>safeStorage.decryptString(v)});
    backend=new SeedHostApplication(root,identity,{beforeServerStart:async server=>{
      if(!publicAddress)throw new Error('Public route ownership guard is not ready; server launch refused');
      await publicAddress.assertCanStart(server);
    },confirmIncomingHandoff:async(source,snapshot)=>{
      show();return confirm('Accept hosting ownership from this peer?','Verified peer: '+source+'\nSnapshot: '+snapshot.id+'\nThis copies server files into a new local directory. Old files are retained. It will not start automatically; review the local launch profile and executable/mod trust first.');
    }});await backend.open();
    const accountConfig=await loadAccountServiceConfig({profileRoot:root,
      bundledDirectory:fileURLToPath(new URL('../../../apps/desktop/',import.meta.url)),
      isolated:!!profileArgument,override:process.env.SEEDHOST_ACCOUNT_SERVICE});
    const accounts=new AccountIntegration(root,identity,{encrypt:v=>safeStorage.encryptString(v),decrypt:v=>safeStorage.decryptString(v)},backend,accountConfig);
    // The always-on PC role runs inside this app: no Node.js install, terminal or commands. Its relay data and
    // OS-encrypted-at-rest identity live under the profile; it restarts with the app when it was turned on.
    const reservedGamePorts=(await backend.getState()).servers.map(server=>server.playerPort);
    const roleOptions=profileArgument && process.env.SEEDHOST_TEST_LOOPBACK==='1' ? {host:'127.0.0.1',port:0,gamePorts:[0],discoveryPort:0,reservedGamePorts} : {reservedGamePorts};
    alwaysOn=new AlwaysOnHost(path.join(root,'always-on'),await loadIdentity(path.join(root,'always-on'),{encrypt:v=>safeStorage.encryptString(v),decrypt:v=>safeStorage.decryptString(v)}),{...roleOptions,loadGroupIdentity:groupRoot=>loadIdentity(groupRoot,{encrypt:v=>safeStorage.encryptString(v),decrypt:v=>safeStorage.decryptString(v)})});
    await alwaysOn.restore();
    // Independent local-server addresses use one approved agent, not the singleton shared-hosting gateway.
    publicAddress=new PerServerPublicAddresses(root,{vault:{encrypt:v=>safeStorage.encryptString(v),decrypt:v=>safeStorage.decryptString(v)},
      api:playitApi,claim:playitClaim,probe:probeMinecraft,openBrowser:url=>shell.openExternal(url),
      servers:async()=>(await backend.getState()).servers,
      reservedPorts:async()=>{const helper=await alwaysOn.status();return helper.running&&helper.gamePort!==null?[helper.gamePort]:[];}});
    await publicAddress.restore((await backend.getState()).servers);
    // In-app updates: checks the official GitHub releases, downloads and verifies the Windows package,
    // and stages the swap that runs after this app exits. SEEDHOST_UPDATE_ORIGIN redirects it for tests.
    const updater=new Updater({root:path.join(root,'updates'),currentVersion:app.getVersion(),packaged:app.isPackaged,platform:process.platform,arch:process.arch,apiOrigin:process.env.SEEDHOST_UPDATE_ORIGIN||undefined});
    let publicSelectionEpoch=0;
    const image=nativeImage.createFromPath(fileURLToPath(new URL('../../../apps/desktop/icon.png',import.meta.url)));
    if(image.isEmpty())throw new Error('App icon could not be loaded');
    window=new BrowserWindow({width:1240,height:860,minWidth:1000,minHeight:700,title:'Seed Hosting',icon:image,frame:false,fullscreen:true,fullscreenable:true,backgroundColor:'#0f1116',show:true,webPreferences:{preload:fileURLToPath(new URL('./preload.cjs',import.meta.url)),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',event=>event.preventDefault());
    window.on('close',event=>{if(!quitAllowed){event.preventDefault();window.hide();}});
    const playit = new PlayitIntegration(root, {vault:{encrypt:v=>safeStorage.encryptString(v),decrypt:v=>safeStorage.decryptString(v)},api:playitApi,probe:probeMinecraft,gateway:async()=>{
      const state=await backend.getState();const relay=state.peers.find(p=>p.fingerprint===state.relay?.fingerprint);
      return {...await backend.checkGameGateway(),fingerprint:relay?.fingerprint??'',controlPort:relay?.port??0};
    }});
    ipcMain.handle('seedhost:call',async(event,method,payload)=>{
      const sender=new URL(event.senderFrame?.url??'about:blank');sender.hash='';
      const p=validateCall(method,payload,sender.href,rendererUrl,{senderId:event.sender.id,expectedSenderId:window.webContents.id,isMainFrame:event.senderFrame===window.webContents.mainFrame});
      switch(method){
        case 'accountStartGroup':{
          const a=await accounts.status();if(!a.signedIn||!a.online||!a.username)throw new Error('Sign in first');
          const state=await backend.getState();
          if(state.relay)throw new Error('This PC already belongs to a group');
          if(!await confirm('Create a hosting group for '+(state.server?.name??'your next server')+'?','Only group control runs while this app is open. The optional always-on PC/player gateway stays off unless you explicitly enable it in Multi-host. Worlds, friendships and public addresses are unchanged.'))return null;
          const role=await alwaysOn.startGroup(a.username+'’s group',true);
          const invite=await alwaysOn.ownerInvite(a.username,identity.fingerprint);
          // Bind the group to the selected world when there is one; otherwise it is stored as this PC's group to use.
          await backend.joinHostingGroup({code:invite.code,name:a.username,serverId:state.server?.id??null,parkOnStop:role.enabled});
          return {created:true};
        }
        case 'accountStatus':return accounts.status();
        case 'accountRequests':return accounts.requests();
        case 'accountUpdateProfile':return accounts.updateProfile(p as {username:string;currentPassword:string;newPassword?:string});
        case 'accountRegister':return accounts.authenticate('register',p as any);
        case 'accountLogin':return accounts.authenticate('login',p as any);
        case 'accountLogout':return accounts.logout();
        case 'accountSend':return accounts.send(p.username);
        case 'accountAccept':return accounts.accept(p.id);
        case 'accountDecline':return accounts.decline(p.id);
        case 'accountFriends':return accounts.socialFriends();
        case 'accountFriendRequests':return accounts.socialRequests();
        case 'accountFriendSend':return accounts.socialSend(p.username);
        case 'accountFriendAccept':return accounts.socialAccept(p.id);
        case 'accountFriendDecline':return accounts.socialDecline(p.id);
        case 'accountFriendRemove':return accounts.socialRemove(p.username);
        case 'disbandGroup':{
          const epoch=publicSelectionEpoch,state=await backend.getState();
          if(!state.server||state.server.id!==p.id||state.relay?.fingerprint!==p.fingerprint)throw new Error('The selected server or group changed. Refresh before continuing.');
          await backend.checkGroupDisband(p.id,p.fingerprint);
          if(epoch!==publicSelectionEpoch)throw new Error('The selected server changed. Refresh before continuing.');
          if(!await confirm('Disband the group for “'+state.server.name+'”?','This permanently revokes ALL group members and outstanding invitations at the group relay. Copies of worlds already held by other PCs cannot be erased. This server must be stopped and safely owned here, with every handoff finished. Worlds, local and relay backups, account-level friendships, accounts, Playit routes and your app-wide always-on opt-in are retained. Older relays without verified revocation refuse this action; a local disconnect is not disbanding. This group identity cannot be reused.','Disband group'))return null;
          const latest=await backend.getState();
          if(epoch!==publicSelectionEpoch||latest.server?.id!==p.id||latest.relay?.fingerprint!==p.fingerprint)throw new Error('The selected server or group changed. Refresh before continuing.');
          return backend.disbandGroup(p.id,p.fingerprint);
        }
        case 'removeFriend':{
          const friends=await backend.listFriends(),target=friends.members.find(m=>m.fingerprint===p.fingerprint);
          if(!friends.canManage||!target||target.you||target.fingerprint===friends.owner)throw new Error('Only the group owner can remove a friend');
          if(!await confirm('Remove “'+target.name+'” from your group?','They will lose access to shared hosting here. Copies of world files they already have cannot be erased. This does not ban them from Minecraft; use the Minecraft whitelist for that.'))return {removed:false};
          await backend.removeFriend(p.fingerprint);return {removed:true};
        }
        case 'playitStatus':return playit.status();
        case 'playitSetup':return shell.openExternal('https://playit.gg/download');
        case 'playitCheck':return playit.check();
        case 'playitCreate':if(await confirm('Make the Minecraft gateway public?', 'This creates a free playit Minecraft Java tunnel to your configured always-on player gateway. Anyone with its address can attempt to join; keep Minecraft online-mode enabled and use a whitelist for private play. Your playit agent must run on the always-on PC. No router, firewall or startup settings are changed.'))return playit.create();return null;
        case 'playitDisconnect':if(await confirm('Disconnect playit from this app?', 'Only this app’s encrypted connection is removed. The public tunnel and external agent keep running. Disable or delete the tunnel in your playit account to stop public access.')){await playit.disconnect();return playit.status();}return null;
        case 'playitImport':{
          const selected=await dialog.showOpenDialog(window,{title:'Select the approved playit agent secret file (plain hex)',properties:['openFile']});
          if(selected.canceled||!selected.filePaths[0])return null;
          if(!await confirm('Connect this playit agent?', 'Seed Hosting stores an OS-encrypted copy of this agent credential to check or create its public Minecraft tunnel. Select the agent running on your always-on PC; never send this file to friends.'))return null;
          try{await playit.importAgentFile(selected.filePaths[0]);return playit.status();}catch{throw new Error('Could not connect that agent. Select its plain hexadecimal secret file and check playit approval.');}
        }
        case 'selectServer':++publicSelectionEpoch;return backend.selectServer(p.id);
        case 'deleteServer':{
          const state=await backend.getState();
          const target=state.servers.find(entry=>entry.id===p.id);
          if(!target)throw new Error('That server is no longer in the library. Refresh and try again.');
          if(!await confirm('Delete “'+target.name+'” from this PC?','This permanently deletes this app’s managed copy of that server, its saved backups and its ownership record on this PC. Other servers, your group, your playit tunnel and the folder you originally imported are not touched. This cannot be undone.','Delete server'))return null;
          return backend.deleteServer(p.id);
        }
        case 'getServerDashboard':return backend.getServerDashboard(p.id);
        case 'listServerFiles':return backend.listServerFiles(p.id,p.path);
        case 'readServerFile':return backend.readServerFile(p.id,p.path);
        case 'writeServerFile':case 'saveServerSettings':case 'saveServerSchedule':case 'deleteServerSchedule':case 'runServerSchedule':case 'managePlayer':{
          const state=await backend.getState();
          if(!state.server||state.server.id!==p.id)throw new Error('The selected server changed. Refresh before continuing.');
          const prompts:Record<string,[string,string]>={
            writeServerFile:['Save changes to “'+p.path+'” for '+state.server.name+'?','Only the managed copy is edited. The server must be stopped and owned here; a rollback copy is saved first. This can change server behavior.'],
            saveServerSettings:['Save Minecraft settings for '+state.server.name+'?','These settings apply on the next start. The managed server must be stopped and owned here. A rollback copy of server.properties is saved first. No router/firewall settings are changed.'],
            saveServerSchedule:['Save a schedule for '+state.server.name+'?','Schedules run only while Seed Hosting is open, including in the tray. An enabled schedule may stop this server, save a stopped-world backup, or send the exact console command you selected. No server starts automatically and no OS task is created.'],
            deleteServerSchedule:['Delete this server schedule?','The local schedule is removed. Existing world files and backups are not changed.'],
            runServerSchedule:['Run this server schedule now?','Its configured backup, graceful stop, or console command will run once. Ownership and server state are checked again before execution.'],
            managePlayer:['Send “'+p.action+'” for '+p.name+'?','This sends a Minecraft player command only to '+state.server.name+' while it is running and owned here. Console shows the result; membership in your hosting group is unchanged.'],
          };
          const prompt=prompts[method]!;
          if(method==='saveServerSchedule'&&p.schedule.command)prompt[1]+='\nCommand: '+p.schedule.command;
          if(!await confirm(prompt[0],prompt[1]))return null;
          if(method==='writeServerFile')return backend.writeServerFile(p.id,p.path,p.text,p.expectedHash);
          if(method==='saveServerSettings')return backend.saveServerSettings(p.id,p.settings);
          if(method==='saveServerSchedule')return backend.saveServerSchedule(p.id,p.schedule);
          if(method==='deleteServerSchedule')return backend.deleteServerSchedule(p.id,p.scheduleId);
          if(method==='runServerSchedule')return backend.runServerSchedule(p.id,p.scheduleId);
          return backend.managePlayer(p.id,p.action,p.name);
        }
        case 'getState':{
          const state=await backend.getState();
          const alwaysStatus=await alwaysOn.status();
          const checks=onboardingChecks(state.onboarding,{...state,alwaysOn:alwaysStatus});
          const publicJoin=(entry:typeof state.servers[number])=>{
            const pub=publicAddress.status(entry);
            const collision=state.servers.some(other=>other.id!==entry.id&&other.playerPort===entry.playerPort)||alwaysStatus.running&&alwaysStatus.gamePort===entry.playerPort;
            return !collision&&pub.address&&['reachable','reserved','pending'].includes(pub.state)
              ?{address:pub.address,reachability:(pub.state==='reachable'?'verified':'unverified') as 'verified'|'unverified',source:'playit' as const,targetServerId:entry.id}:null;
          };
          return {...state,servers:state.servers.map(entry=>({...entry,publicJoinAddress:publicJoin(entry)})),
            onboarding:{...state.onboarding,checks,completed:checks.ready==='complete'}};
        }
        case 'alwaysOnStatus':return alwaysOn.status();
        case 'alwaysOnEnable':{
          const status=await alwaysOn.status();
          if(!status.running&&!await confirm('Make this PC the always-on PC?','Seed Hosting will keep your friends’ world here between play sessions and give players one address to join. It listens on this network (control port 47625 and a separate player gateway port, normally 25566) while the app is open; managed Minecraft server ports are kept separate. Only PCs you approve for the group can store or take the world. Keep this PC on and Seed Hosting open (it can sit in the tray). Nothing else on this PC is changed.'))return status;
          return alwaysOn.enable(p.name,(await backend.getState()).servers.map(server=>server.playerPort));
        }
        case 'alwaysOnDisable':
          if(!await confirm('Stop being the always-on PC?','Paired PCs can’t store or take the world here until you turn it back on, and the shared player gateway goes offline. Local per-server public addresses are separate. The stored world and pairings are kept.'))return alwaysOn.status();
          return alwaysOn.disable();
        case 'alwaysOnNewCode':return alwaysOn.newCode();
        case 'publicAddressStatus':case 'publicAddressEnable':case 'publicAddressDisable':case 'publicAddressOpenApproval':{
          const selectionEpoch=publicSelectionEpoch;
          const state=await backend.getState();
          const selected=state.servers.find(server=>server.id===p.id);
          if(!selected||state.server?.id!==p.id)throw new Error('The selected server changed. Refresh before continuing.');
          const helper=await alwaysOn.status();
          const latest=await backend.getState();
          if(selectionEpoch!==publicSelectionEpoch||latest.server?.id!==p.id||latest.server?.playerPort!==selected.playerPort)throw new Error('The selected server changed. Refresh before continuing.');
          const collision=latest.servers.some(other=>other.id!==selected.id&&other.playerPort===selected.playerPort)||helper.running&&helper.gamePort===selected.playerPort;
          if(collision&&method!=='publicAddressDisable'){
            const detail='This Minecraft port conflicts with another server or the helper gateway. Set a distinct server-port in Server settings first.';
            if(method==='publicAddressEnable')throw new Error(detail);
            return {state:'error',address:null,approveUrl:null,detail};
          }
          if(method==='publicAddressEnable')return publicAddress.enable(selected,latest.servers);
          if(method==='publicAddressDisable')return publicAddress.disable(selected);
          if(method==='publicAddressStatus')return publicAddress.refresh(selected);
          const status=publicAddress.status(selected),url=status.approveUrl;
          if(url&&/^https:\/\/playit\.gg\/claim\/[a-f0-9]{10}$/.test(url))await shell.openExternal(url);
          return status;
        }
        case 'pairAlwaysOn':
          if(!await confirm('Connect to your always-on PC?','Seed Hosting will look for the always-on PC that shows this code on your network, check that it really knows the code, and connect to it. From then on your world is kept there when you stop playing, and friends join one address.'))return null;
          return backend.pairAlwaysOn(p as {code:string;name:string});
        case 'searchSetupMods':return backend.searchSetupMods(p as {query:string;gameVersion:string;offset:number;sort?:ModSort});
        case 'setupFabricMods':return backend.setupFabricMods(p as {projectIds:string[]});
        case 'listServerVersions':return new ServerSetupClient().listVersions();
        case 'discoverJava':return discoverJava(path.join(root,'runtimes'));
        case 'pickJava':{
          const selected=await dialog.showOpenDialog(window,{title:'Choose an installed Java executable (java or java.exe)',properties:['openFile'],...(process.platform==='win32'?{filters:[{name:'Java executable',extensions:['exe']}]}:{})});
          if(selected.canceled||!selected.filePaths[0])return null;
          if(!await confirm('Check this Java executable?', 'Seed Hosting will execute this selected file with -version, without a shell. Select only an installed Java runtime you trust. No Java installation or server start occurs.'))return null;
          return probeJava(selected.filePaths[0]);
        }
        case 'createServer':{
          const input={...p} as CreateServerInput;
          if(input.eulaAccepted!==true)throw new Error('Explicit Minecraft EULA acceptance is required before creating a server');
          if(!await confirm('Create “'+input.name+'”?', 'Seed Hosting downloads the official '+(input.loader==='fabric'?'Fabric':'Minecraft')+' server files'+(input.javaExecutable?'':' and, if this PC needs it, the matching official Java from Mojang')+', and checks every file. Nothing starts until you press Start.\n\nBy creating this world you agree to the Minecraft EULA: https://www.minecraft.net/en-us/eula'))return null;
          return backend.createServer(input);
        }
        case 'configureSimpleProfile':
          if(!await confirm('Check Java and save this launch profile?', 'Seed Hosting will execute '+p.javaExecutable+' with -version, without a shell, then save Java and RAM. Only approve a trusted installed runtime. Nothing starts automatically.'))return null;
          return backend.configureSimpleProfile(p as unknown as SimpleProfileInput);
        case 'saveGameGateway':return backend.saveGameGateway(p as {enabled:boolean;localPort:number});
        case 'checkGameGateway':return backend.checkGameGateway();
        case 'openSetupLink':{
          const url=setupLinks[p.page];
          if(!url)throw new Error('Invalid setup link');
          return shell.openExternal(url);
        }
        case 'saveOnboarding':{
          const {serverId,...progress}=p;
          return backend.saveOnboarding(progress,await alwaysOn.status(),serverId as string|null|undefined);
        }
        case 'listSnapshots':return backend.listSnapshots();
        case 'restoreSnapshot':
          if(!await confirm('Restore this saved world revision?', 'Stop hosting first. Seed Hosting will preserve a safety snapshot and the previous folder, then restore into a separate managed folder. Hosting ownership is not rewound. Nothing starts automatically.'))return;
          return backend.restoreSnapshot(p.snapshotId);
        case 'importServer':{
          const selected=await dialog.showOpenDialog(window,{title:'Import a stopped Minecraft Java server',properties:['openDirectory']});
          if(selected.canceled||!selected.filePaths[0])return null;
          if(!await confirm('Is the source server stopped?','Copying a running world can produce an inconsistent snapshot. Confirm that the source has stopped. Seed Hosting creates its own copy and will not edit the source.'))return null;
          return backend.importExisting(selected.filePaths[0],true);
        }
        case 'saveProfile':return backend.saveProfile(p as {executable:string;args:string[]});
        case 'startServer':return backend.startServerWithApproval(async approval=>{
          // Check the captured server under the backend approval lock, before any hosting ledger mutation.
          const gateway=await alwaysOn.status(),minecraftPort=await readServerPort(approval.serverDir);
          if(gateway.running&&gateway.gamePort===minecraftPort)throw new Error('Minecraft port '+minecraftPort+' is used by Seed Hosting’s player gateway. Choose a different Minecraft port in Server settings before starting. No server process was launched and ownership was not changed.');
          // The explicit Start server action approves the captured local launch profile.
          // Receiving a world never calls this handler or starts code automatically.
          // Backend still revalidates the captured profile, snapshots and ownership before spawn.
          return true;
        });
        case 'stopServer':return backend.stopServer();
        case 'createSnapshot':return backend.createSnapshot();
        case 'sendCommand':return backend.sendCommand(p.command);
        case 'saveSettings':return backend.saveSettings(p as any);
        case 'addPeer':return backend.addPeer(p as any);
        case 'startPeerListener':return backend.startPeerListener();
        case 'sendSnapshot':return backend.sendSnapshot(p.fingerprint);
        case 'handoff':if(await confirm('Transfer hosting ownership to this peer?','Stop the server first. A fresh snapshot will be captured and shared, including server configuration/player data. This PC becomes fenced before transfer. If acknowledgment is lost or the peer declines, local hosting remains blocked until ownership is reconciled.'))return backend.handoff(p.fingerprint);return;
        case 'searchMods':return backend.searchMods(p as {query:string;offset:number;sort?:ModSort});
        case 'saveModTarget':return backend.saveModTarget(p as any);
        case 'installMod':
          if(!await confirm('Install this Modrinth mod and its required dependencies?', 'Files are filtered for your selected Minecraft version and loader and verified against Modrinth’s SHA-512 checksums. Mods run code; a valid checksum does not make a mod safe. Server/client placement follows its published metadata unless you choose a destination. Nothing starts automatically.'))return;
          return backend.installMod(p as any);
        case 'openModPage':return shell.openExternal('https://modrinth.com/mod/'+encodeURIComponent(p.slug));
        case 'createInvite':
          if(!await confirm('Invite a friend to share hosting?', 'Anyone who redeems this one-use invitation can access the server files and take a turn hosting through your relay. Send it privately to someone you trust.'))return;
          return backend.createInvite();
        case 'listFriends':return backend.listFriends();
        case 'previewInvite': {
          return previewInvite(p.code);
        }
        case 'joinWithInvite': {
          const invite=decodeInvite(p.code);
          if(!await confirm('Join this friend’s hosting relay?', `Group: ${invite.relayName}
Always-on PC: ${invite.host}:${invite.port}
Invitation expires: ${new Date(invite.expiresAt * 1000).toISOString()}
Full relay fingerprint: ${invite.relayFingerprint}

These details are parsed locally from the invitation; they do not prove the group is authentic or the always-on PC is reachable. Compare the full relay fingerprint with your friend via a trusted channel before continuing. Only use an invitation received privately from a trusted friend.

Joining pins the relay certificate and authorizes this PC. Members of this group can read your world files and share hosting. It does not download or start a server. Clean stops will attempt to send the world to the always-on PC. If that PC is offline, the world stays local.`))return;
          return backend.joinWithInvite(p as {code:string;name:string});
        }
        case 'addMods':{
          // Paths come only from the native picker, never from the renderer.
          const client=p.kind==='client';
          const picked=await dialog.showOpenDialog(window,{title:client?'Add client-only mods (for players)':'Add server mods',buttonLabel:'Add mods',filters:[{name:'Minecraft mods',extensions:['jar']}],properties:['openFile','multiSelections']});
          if(picked.canceled||!picked.filePaths.length)return [];
          return backend.addMods(p.kind,picked.filePaths);
        }
        case 'removeMod':if(await confirm('Remove '+p.name+'?',p.kind==='server'?'It is deleted from the server\'s mods folder and will not load on the next start. Earlier snapshots still contain it.':'It is removed from the client pack. Earlier snapshots still contain it.'))return backend.removeMod(p.kind,p.name);return;
        case 'exportClientPack':{
          const state=await backend.getState();
          const saved=await dialog.showSaveDialog(window,{title:'Save the client mod pack',buttonLabel:'Save pack',defaultPath:path.join(app.getPath('downloads'),(state.server?.name||'server').replace(/[^\w .-]+/g,'_')+' client mods.zip'),filters:[{name:'Zip archive',extensions:['zip']}]});
          if(saved.canceled||!saved.filePath)return;
          const destination=/\.zip$/i.test(saved.filePath)?saved.filePath:saved.filePath+'.zip';
          return backend.exportClientPack(destination);
        }
        case 'saveRelay':return backend.saveRelay(p.relay);
        case 'checkRelay':return backend.checkRelay();
        case 'parkAtRelay':if(await confirm('Park the server on the relay?','A final snapshot is captured and stored on the always-on relay. This PC stops being the host until a PC claims the server back. Any PC that trusts the relay can claim it while this one is off.'))return backend.parkAtRelay();return;
        case 'claimFromRelay':if(await confirm('Claim the server from the relay?','The newest stored revision is copied into a new folder on this PC and this PC becomes the host. Old folders are kept. Nothing starts automatically; review the launch profile and executable/mod trust first.'))return backend.claimFromRelay();return;
        case 'cleanUp':if(await confirm('Delete old server copies and revisions?','This permanently deletes earlier managed server folders, interrupted transfers, and snapshot revisions older than the current one and its two parents. The current server folder and current revision are kept. Your original imported folder is never touched.'))return backend.cleanUp();return;
        case 'getWindowState':return windowState();
        case 'updateStatus':return updater.status();
        case 'updateCheck':return updater.check();
        case 'updateDownload':return updater.download();
        case 'updateInstall':{
          if(!app.isPackaged)throw new Error('Updates install only in the packaged app');
          if(process.platform!=='win32')throw new Error('Automatic install is available on Windows only');
          const staged=updater.status().staged;
          if(!staged)throw new Error('No verified update is staged yet; download an update first');
          const state=await backend.getState();
          if(state.busy||state.server?.state==='running'||state.server?.state==='starting')throw new Error('Stop the server before installing an update');
          if(!await confirm('Restart and install Seed Hosting '+staged.version+'?','The app will close, replace its files with the downloaded, checksum-verified update and open again. Worlds, servers and settings are unchanged.'))return updater.status();
          await updater.install();
          void quit();
          return updater.status();
        }
        // Wayland tiling compositors may ignore native minimize requests; the tray keeps a hidden window recoverable.
        case 'windowMinimize':if(process.platform==='linux' && process.env.WAYLAND_DISPLAY)window.hide();else window.minimize();return windowState();
        case 'windowToggleFullscreen':window.setFullScreen(!window.isFullScreen());return windowState();
        case 'windowClose':window.close();return;
        case 'quitApp':void quit();return;
        // The explicitly labelled recovery button supplies confirmed:true; the IPC policy
        // rejects false/missing confirmation and the backend retains every stopped/ownership fence.
        case 'recoverStopped':return backend.recoverStopped(p.confirmed as boolean);
        default:throw new Error('This operation is not available in this build');
      }
    });
    tray=new Tray(image.resize({width:32,height:32,quality:'best'}));tray.setToolTip('Seed Hosting — Minecraft servers you share with friends');
    tray.setContextMenu(Menu.buildFromTemplate([{label:'Open Seed Hosting',click:show},{type:'separator'},{label:'Quit safely',click:()=>{void quit();}}]));
    tray.on('double-click',show);
    Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(app.isPackaged,{show,quit:()=>{void quit();}})));
    if(app.isPackaged)window.webContents.on('devtools-opened',()=>window.webContents.closeDevTools());
    await window.loadFile(html);
    // Quietly check for updates shortly after launch; the Settings card shows the result.
    setTimeout(()=>{void updater.check().catch(()=>undefined);},4000);
  }).catch(error=>{console.error(error);dialog.showErrorBox('Seed Hosting startup failed',String(error));quitAllowed=true;app.quit();});
}
