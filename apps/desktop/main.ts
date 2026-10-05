import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, shell, Tray } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SeedHostApplication } from '../../src/core/application.js';
import { loadIdentity } from '../../src/core/identity-store.js';
import { validateCall } from '../../src/core/ipc-policy.js';
import { decodeInvite, previewInvite } from '../../src/core/invites.js';
import { applicationMenuTemplate } from './menu.js';
import { ServerSetupClient, discoverJava, probeJava, type CreateServerInput } from '../../src/core/server-setup.js';
const setupLinks: Record<string,string> = Object.freeze({
  eula:'https://www.minecraft.net/en-us/eula',
  java:'https://adoptium.net/temurin/releases/',
  fabric:'https://fabricmc.net/use/server/',
  relay:'https://github.com/envosloth/seedhost/blob/main/docs/relay.md',
});
let window:BrowserWindow;let tray:Tray;let backend:SeedHostApplication;let quitAllowed=false;let quitting=false;
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
async function confirm(message:string,detail:string):Promise<boolean>{return (await dialog.showMessageBox(window,{type:'warning',message,detail,buttons:['Cancel','Continue'],defaultId:0,cancelId:0,noLink:true})).response===1;}
async function quit(){
  if(quitting)return;quitting=true;
  try{
    const state=await backend.getState();
    if(state.busy){show();await dialog.showMessageBox(window,{type:'warning',message:'An operation is still in progress.',detail:'Wait until it completes before quitting.',buttons:['Keep app open']});return;}
    if(state.server?.state==='running'||state.server?.state==='starting'){
      show();if(!await confirm('Stop hosting and quit?','Players will disconnect. Seed Hosting will request a clean stop and save a final local snapshot. This does not guarantee another device has received it.'))return;
    }
    await backend.close();quitAllowed=true;app.quit();
  }catch(e){show();await dialog.showMessageBox(window,{type:'error',message:'Seed Hosting could not quit safely.',detail:String(e),buttons:['Keep app open']});}
  finally{quitting=false;}
}
if(!app.requestSingleInstanceLock()){app.quit();}else{
  app.on('second-instance',show);
  app.on('before-quit',event=>{if(!quitAllowed){event.preventDefault();void quit();}});
  app.whenReady().then(async()=>{
    if(!safeStorage.isEncryptionAvailable())throw new Error('OS protected key storage (Windows DPAPI, macOS Keychain, or a Linux Secret Service) is unavailable. Refusing to store an unencrypted identity.');
    const identity=await loadIdentity(root,{encrypt:v=>safeStorage.encryptString(v),decrypt:v=>safeStorage.decryptString(v)});
    backend=new SeedHostApplication(root,identity,{confirmIncomingHandoff:async(source,snapshot)=>{
      show();return confirm('Accept hosting ownership from this peer?','Verified peer: '+source+'\nSnapshot: '+snapshot.id+'\nThis copies server files into a new local directory. Old files are retained. It will not start automatically; review the local launch profile and executable/mod trust first.');
    }});await backend.open();
    const image=nativeImage.createFromPath(fileURLToPath(new URL('../../../apps/desktop/icon.png',import.meta.url)));
    if(image.isEmpty())throw new Error('App icon could not be loaded');
    window=new BrowserWindow({width:1240,height:860,minWidth:1000,minHeight:700,title:'Seed Hosting',icon:image,frame:false,fullscreenable:true,backgroundColor:'#0f1116',show:true,webPreferences:{preload:fileURLToPath(new URL('./preload.cjs',import.meta.url)),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',event=>event.preventDefault());
    window.on('close',event=>{if(!quitAllowed){event.preventDefault();window.hide();}});
    ipcMain.handle('seedhost:call',async(event,method,payload)=>{
      const sender=new URL(event.senderFrame?.url??'about:blank');sender.hash='';
      const p=validateCall(method,payload,sender.href,rendererUrl,{senderId:event.sender.id,expectedSenderId:window.webContents.id,isMainFrame:event.senderFrame===window.webContents.mainFrame});
      switch(method){
        case 'getState':return backend.getState();
        case 'listServerVersions':return new ServerSetupClient().listVersions();
        case 'discoverJava':return discoverJava();
        case 'pickJava':{
          const selected=await dialog.showOpenDialog(window,{title:'Choose an installed Java executable (java or java.exe)',properties:['openFile'],...(process.platform==='win32'?{filters:[{name:'Java executable',extensions:['exe']}]}:{})});
          if(selected.canceled||!selected.filePaths[0])return null;
          if(!await confirm('Check this Java executable?', 'Seed Hosting will execute this selected file with -version, without a shell. Select only an installed Java runtime you trust. No Java installation or server start occurs.'))return null;
          return probeJava(selected.filePaths[0]);
        }
        case 'createServer':{
          const input={...p} as CreateServerInput;
          if(input.eulaAccepted!==true)throw new Error('Explicit Minecraft EULA acceptance is required before creating a server');
          if(!await confirm('Create this Minecraft server and accept its EULA?', 'By continuing you explicitly accept https://www.minecraft.net/en-us/eula for this server. Seed Hosting downloads and checks official '+input.loader+' server files, creates a managed copy, and checks the chosen Java runtime. Checksums do not prove executable code harmless. Nothing starts automatically.'))return;
          return backend.createServer(input);
        }
        case 'configureSimpleProfile':
          if(!await confirm('Check Java and save this launch profile?', 'Seed Hosting will execute '+p.javaExecutable+' with -version, without a shell, then save Java and RAM. Only approve a trusted installed runtime. Nothing starts automatically.'))return;
          return backend.configureSimpleProfile(p as {javaExecutable:string;memoryMiB:number});
        case 'saveGameGateway':return backend.saveGameGateway(p as {enabled:boolean;localPort:number});
        case 'checkGameGateway':return backend.checkGameGateway();
        case 'openSetupLink':{
          const url=setupLinks[p.page];
          if(!url)throw new Error('Invalid setup link');
          return shell.openExternal(url);
        }
        case 'saveOnboarding':return backend.saveOnboarding(p);
        case 'listSnapshots':return backend.listSnapshots();
        case 'restoreSnapshot':
          if(!await confirm('Restore this saved world revision?', 'Stop hosting first. Seed Hosting will preserve a safety snapshot and the previous folder, then restore into a separate managed folder. Hosting ownership is not rewound. Nothing starts automatically.'))return;
          return backend.restoreSnapshot(p.snapshotId);
        case 'importServer':{
          const selected=await dialog.showOpenDialog(window,{title:'Import a stopped Minecraft Java server',properties:['openDirectory']});
          if(selected.canceled||!selected.filePaths[0])return;
          if(!await confirm('Is the source server stopped?','Copying a running world can produce an inconsistent snapshot. Confirm that the source has stopped. Seed Hosting creates its own copy and will not edit the source.'))return;
          return backend.importExisting(selected.filePaths[0],true);
        }
        case 'saveProfile':return backend.saveProfile(p as {executable:string;args:string[]});
        case 'startServer':return backend.startServerWithApproval(approval=>confirm('Run this server on this PC?','The selected executable, server JARs, and mods run code with your user permissions. Only continue if you trust them. No gateway is required.\n\nProfile: '+approval.root+'\nServer directory: '+approval.serverDir+'\nSnapshot: '+approval.snapshotId+'\nExecutable: '+approval.profile.executable+'\nArguments: '+JSON.stringify(approval.profile.args)));
        case 'stopServer':return backend.stopServer();
        case 'createSnapshot':return backend.createSnapshot();
        case 'sendCommand':return backend.sendCommand(p.command);
        case 'saveSettings':return backend.saveSettings(p as any);
        case 'addPeer':return backend.addPeer(p as any);
        case 'startPeerListener':return backend.startPeerListener();
        case 'sendSnapshot':return backend.sendSnapshot(p.fingerprint);
        case 'handoff':if(await confirm('Transfer hosting ownership to this peer?','Stop the server first. A fresh snapshot will be captured and shared, including server configuration/player data. This PC becomes fenced before transfer. If acknowledgment is lost or the peer declines, local hosting remains blocked until ownership is reconciled.'))return backend.handoff(p.fingerprint);return;
        case 'searchMods':return backend.searchMods(p as {query:string;offset:number});
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
        // Wayland tiling compositors may ignore native minimize requests; the tray keeps a hidden window recoverable.
        case 'windowMinimize':if(process.platform==='linux' && process.env.WAYLAND_DISPLAY)window.hide();else window.minimize();return windowState();
        case 'windowToggleFullscreen':window.setFullScreen(!window.isFullScreen());return windowState();
        case 'windowClose':window.close();return;
        case 'quitApp':void quit();return;
        case 'recoverStopped':if(await confirm('Confirm every previous server process is stopped?','An uncertain session is not proof of process exit. Check for orphaned Java/server processes before continuing. This only restores local uncertain ownership without a pending handoff; it cannot take ownership back from a peer.'))return backend.recoverStopped(true);return;
        default:throw new Error('This operation is not available in this build');
      }
    });
    tray=new Tray(image.resize({width:32,height:32,quality:'best'}));tray.setToolTip('Seed Hosting — Minecraft servers you share with friends');
    tray.setContextMenu(Menu.buildFromTemplate([{label:'Open Seed Hosting',click:show},{type:'separator'},{label:'Quit safely',click:()=>{void quit();}}]));
    tray.on('double-click',show);
    Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(app.isPackaged,{show,quit:()=>{void quit();}})));
    if(app.isPackaged)window.webContents.on('devtools-opened',()=>window.webContents.closeDevTools());
    await window.loadFile(html);
  }).catch(error=>{console.error(error);dialog.showErrorBox('Seed Hosting startup failed',String(error));quitAllowed=true;app.quit();});
}
