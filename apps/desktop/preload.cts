import { contextBridge, ipcRenderer } from 'electron';
const methods=new Set(['getState','importServer','createSnapshot','saveProfile','startServer','stopServer','sendCommand','saveSettings','startPeerListener','addPeer','sendSnapshot','handoff','recoverStopped','cleanUp','saveRelay','parkAtRelay','claimFromRelay','checkRelay','addMods','removeMod','exportClientPack','searchMods','installMod','saveModTarget','openModPage','createInvite','joinWithInvite','listFriends','saveOnboarding','listSnapshots','restoreSnapshot','listServerVersions','discoverJava','pickJava','createServer','configureSimpleProfile','saveGameGateway','checkGameGateway','openSetupLink']);
contextBridge.exposeInMainWorld('peerhost',Object.freeze({
  call:(method:string,payload?:unknown):Promise<unknown>=>{
    if(typeof method!=='string'||!methods.has(method))return Promise.reject(new Error('Unknown method'));
    return ipcRenderer.invoke('peerhost:call',method,payload);
  }
}));
