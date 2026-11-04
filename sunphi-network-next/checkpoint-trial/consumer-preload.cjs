const {contextBridge,ipcRenderer,webFrame}=require('electron');
contextBridge.exposeInMainWorld('sunphiNode',{request:(action,args={})=>ipcRenderer.invoke('duebyte-node',action,args)});
window.addEventListener('DOMContentLoaded',()=>{
 // Handle the physical =/+ key as well as the numeric keypad in all layouts.
 // The visible controls also let users recover from an accidentally tiny view.
 const levels=[.5,.67,.8,.9,1,1.1,1.25,1.5,1.75,2,2.5,3];
 const controls=document.createElement('div');controls.className='window-zoom';controls.setAttribute('role','group');controls.setAttribute('aria-label','Page zoom');
 const minus=document.createElement('button'),reset=document.createElement('button'),plus=document.createElement('button');
 for(const b of [minus,reset,plus])b.type='button';
 minus.textContent='−';minus.title='Zoom out (Ctrl+−)';minus.setAttribute('aria-label','Zoom out');
 plus.textContent='+';plus.title='Zoom in (Ctrl++ or Ctrl+=)';plus.setAttribute('aria-label','Zoom in');
 reset.title='Reset zoom to 100% (Ctrl+0)';reset.setAttribute('aria-label','Reset zoom to 100%');
 const updateZoom=()=>{const factor=webFrame.getZoomFactor();reset.textContent=Math.round(factor*100)+'%';minus.disabled=factor<=levels[0]+.001;plus.disabled=factor>=levels.at(-1)-.001;};
 const zoom=direction=>{const factor=webFrame.getZoomFactor();const next=direction===0?1:direction>0?(levels.find(n=>n>factor+.001)??levels.at(-1)):([...levels].reverse().find(n=>n<factor-.001)??levels[0]);webFrame.setZoomFactor(next);updateZoom();};
 minus.onclick=()=>zoom(-1);reset.onclick=()=>zoom(0);plus.onclick=()=>zoom(1);
 controls.append(minus,reset,plus);const theme=document.getElementById('theme'),footer=document.querySelector('footer');if(footer?.contains(theme))theme.before(controls);else footer?.append(controls);
 window.addEventListener('keydown',event=>{
  if(!(event.ctrlKey||event.metaKey)||event.altKey)return;
  const increase=['+','='].includes(event.key)||['Equal','NumpadAdd'].includes(event.code);
  const decrease=['-','_'].includes(event.key)||['Minus','NumpadSubtract'].includes(event.code);
  const normal=event.key==='0'||['Digit0','Numpad0'].includes(event.code);
  if(!increase&&!decrease&&!normal)return;
  event.preventDefault();event.stopImmediatePropagation();zoom(normal?0:increase?1:-1);
 },true);
 window.addEventListener('resize',updateZoom);updateZoom();
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
