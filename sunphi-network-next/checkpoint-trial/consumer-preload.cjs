const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('sunphiNode',{request:(action,args={})=>ipcRenderer.invoke('duebyte-node',action,args)});
window.addEventListener('DOMContentLoaded',()=>{
 if(process.platform==='win32'){
  const caption=document.createElement('div');caption.className='desktop-caption';caption.setAttribute('aria-hidden','true');document.body.prepend(caption);
  const update=()=>{const light=document.documentElement.dataset.theme==='light';void ipcRenderer.invoke('duebyte-node','appearance',{light});};
  new MutationObserver(update).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});update();
 }
 if(location.protocol!=='http:')return;
 const button=document.createElement('button');button.id='duebyte-back';button.textContent='← Back to node';button.type='button';
 button.onclick=async()=>{button.disabled=true;try{const r=await ipcRenderer.invoke('duebyte-node','back');if(!r.ok)throw Error(r.error);}catch(e){const message=document.getElementById('message');if(message)message.textContent=e.message;button.disabled=false;}};
 document.querySelector('header')?.append(button);
});
