const {contextBridge,ipcRenderer}=require('electron');
const methods=new Set(['status','lock','create','open','restore','backup','password','prepare','confirm','inspect','import-trust','import-package','export-approval','statement']);
contextBridge.exposeInMainWorld('wallet',{
  request:(method,args={})=>{if(!methods.has(method))return Promise.reject(Error('Unsupported operation'));return ipcRenderer.invoke('wallet:request',method,args);},
  onLock:callback=>{ipcRenderer.on('wallet:locked',()=>callback());}
});
