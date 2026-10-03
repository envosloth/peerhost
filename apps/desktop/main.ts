import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, Tray } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PeerHostApplication } from '../../src/core/application.js';
import { loadIdentity } from '../../src/core/identity-store.js';
import { validateCall } from '../../src/core/ipc-policy.js';
let window:BrowserWindow;let tray:Tray;let backend:PeerHostApplication;let quitAllowed=false;let quitting=false;
app.setName('PeerHost');
const profileArgument=process.argv.find(a=>a.startsWith('--profile-root='));
const root=profileArgument?path.resolve(profileArgument.slice('--profile-root='.length)):path.join(app.getPath('appData'),'PeerHost');
app.setPath('userData',root);
const html=fileURLToPath(new URL('../../../apps/desktop/index.html',import.meta.url));
const rendererUrl=pathToFileURL(html).href;
function show(){if(window&&!window.isDestroyed()){window.show();window.focus();}}
async function confirm(message:string,detail:string):Promise<boolean>{return (await dialog.showMessageBox(window,{type:'warning',message,detail,buttons:['Cancel','Continue'],defaultId:0,cancelId:0,noLink:true})).response===1;}
async function quit(){
  if(quitting)return;quitting=true;
  try{
    const state=await backend.getState();
    if(state.busy){show();await dialog.showMessageBox(window,{type:'warning',message:'An operation is still in progress.',detail:'Wait until it completes before quitting.',buttons:['Keep app open']});return;}
    if(state.server?.state==='running'||state.server?.state==='starting'){
      show();if(!await confirm('Stop hosting and quit?','Players will disconnect. PeerHost will request a clean stop and save a final local snapshot. This does not guarantee another device has received it.'))return;
    }
    await backend.close();quitAllowed=true;app.quit();
  }catch(e){show();await dialog.showMessageBox(window,{type:'error',message:'PeerHost could not quit safely.',detail:String(e),buttons:['Keep app open']});}
  finally{quitting=false;}
}
if(!app.requestSingleInstanceLock()){app.quit();}else{
  app.on('second-instance',show);
  app.on('before-quit',event=>{if(!quitAllowed){event.preventDefault();void quit();}});
  app.whenReady().then(async()=>{
    if(!safeStorage.isEncryptionAvailable())throw new Error('Windows protected key storage is unavailable. Refusing to store an unencrypted identity.');
    const identity=await loadIdentity(root,{encrypt:v=>safeStorage.encryptString(v),decrypt:v=>safeStorage.decryptString(v)});
    backend=new PeerHostApplication(root,identity,{confirmIncomingHandoff:async(source,snapshot)=>{
      show();return confirm('Accept hosting ownership from this peer?','Verified peer: '+source+'\nSnapshot: '+snapshot.id+'\nThis copies server files into a new local directory. Old files are retained. It will not start automatically; review the local launch profile and executable/mod trust first.');
    }});await backend.open();
    window=new BrowserWindow({width:1240,height:860,minWidth:1000,minHeight:700,title:'PeerHost',backgroundColor:'#171b1a',show:true,webPreferences:{preload:fileURLToPath(new URL('./preload.cjs',import.meta.url)),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',event=>event.preventDefault());
    window.on('close',event=>{if(!quitAllowed){event.preventDefault();window.hide();}});
    ipcMain.handle('peerhost:call',async(event,method,payload)=>{
      const sender=new URL(event.senderFrame?.url??'about:blank');sender.hash='';
      const p=validateCall(method,payload,sender.href,rendererUrl,{senderId:event.sender.id,expectedSenderId:window.webContents.id,isMainFrame:event.senderFrame===window.webContents.mainFrame});
      switch(method){
        case 'getState':return backend.getState();
        case 'importServer':{
          const selected=await dialog.showOpenDialog(window,{title:'Import a stopped Minecraft Java server',properties:['openDirectory']});
          if(selected.canceled||!selected.filePaths[0])return;
          if(!await confirm('Is the source server stopped?','Copying a running world can produce an inconsistent snapshot. Confirm that the source has stopped. PeerHost creates its own copy and will not edit the source.'))return;
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
        case 'recoverStopped':if(await confirm('Confirm every previous server process is stopped?','An uncertain session is not proof of process exit. Check for orphaned Java/server processes before continuing. This only restores local uncertain ownership without a pending handoff; it cannot take ownership back from a peer.'))return backend.recoverStopped(true);return;
        default:throw new Error('This operation is not available in this build');
      }
    });
    const image=nativeImage.createFromPath(fileURLToPath(new URL('../../../apps/desktop/icon.png',import.meta.url)));
    if(image.isEmpty())throw new Error('Tray icon could not be loaded');
    tray=new Tray(image);tray.setToolTip('PeerHost — local-first server hosting');
    tray.setContextMenu(Menu.buildFromTemplate([{label:'Open PeerHost',click:show},{type:'separator'},{label:'Quit safely',click:()=>{void quit();}}]));
    tray.on('double-click',show);
    Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'PeerHost',submenu:[{label:'Open',click:show},{label:'Quit safely',click:()=>{void quit();}}]},{label:'View',submenu:[{role:'reload'},{role:'toggleDevTools'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'}]}]));
    await window.loadFile(html);
  }).catch(error=>{console.error(error);dialog.showErrorBox('PeerHost startup failed',String(error));quitAllowed=true;app.quit();});
}
