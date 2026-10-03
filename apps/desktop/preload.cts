import { contextBridge, ipcRenderer } from 'electron';
const methods=new Set(['getState','importServer','createSnapshot','saveProfile','startServer','stopServer','sendCommand','saveSettings','startPeerListener','addPeer','sendSnapshot','handoff','recoverStopped']);
contextBridge.exposeInMainWorld('peerhost',Object.freeze({
  call:(method:string,payload?:unknown):Promise<unknown>=>{
    if(typeof method!=='string'||!methods.has(method))return Promise.reject(new Error('Unknown method'));
    return ipcRenderer.invoke('peerhost:call',method,payload);
  }
}));
