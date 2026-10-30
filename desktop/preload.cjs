const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('sunphi',Object.freeze({request:(action,args={})=>ipcRenderer.invoke('sunphi:request',action,args),onLock:callback=>ipcRenderer.on('sunphi:locked',()=>callback())}));
