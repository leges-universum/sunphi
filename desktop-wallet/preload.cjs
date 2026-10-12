const {contextBridge,ipcRenderer}=require('electron');
const methods=new Set(['select-wallet','clear-wallet-selection','status','lock','create','open','restore','backup','password','prepare','confirm','inspect','import-trust','import-package','export-approval','statement','procedure-status','procedure','procedure-export','help-link']);
contextBridge.exposeInMainWorld('wallet',{
  request:(method,args={})=>{if(!methods.has(method))return Promise.reject(Error('Unsupported operation'));return ipcRenderer.invoke('wallet:request',method,args);},
  onLock:callback=>{ipcRenderer.on('wallet:locked',()=>callback());}
});
