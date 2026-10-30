const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('sunphi',Object.freeze({request:(action,args={})=>ipcRenderer.invoke('sunphi:request',action,args),onLock:callback=>ipcRenderer.on('sunphi:locked',()=>callback())}));
contextBridge.exposeInMainWorld('sunphiNode',Object.freeze({request:(action,args={})=>ipcRenderer.invoke('sunphi:node',action,args)}));
contextBridge.exposeInMainWorld('wallet',Object.freeze({request:(action,args={})=>ipcRenderer.invoke('wallet:request',action,args),onLock:callback=>ipcRenderer.on('wallet:locked',()=>callback())}));
contextBridge.exposeInMainWorld('sunphiShell',Object.freeze({request:(action,args={})=>ipcRenderer.invoke('sunphi:shell',action,args)}));
