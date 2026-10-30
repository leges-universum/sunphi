import {WebContentsView} from 'electron';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
async function bounded(promise,ms){
 let timer;
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Wallet screen did not finish loading')),ms);timer.unref();})]);}
 finally{clearTimeout(timer);}
}
const paint="new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))";
export async function readyView(win){
 await bounded(win.webContents.executeJavaScript('window.sunphiViewReady || document.fonts.ready'),12000);
}
// Retain a password-free frame in memory while the next document is prepared.
// The cover has no preload or IPC privileges and is destroyed after every switch.
export async function switchView(win,url,root){
 let cover,attached=false,loading=false;const previous=win.webContents.getURL();
 const resize=()=>{if(cover){const [width,height]=win.getContentSize();cover.setBounds({x:0,y:0,width,height});}};
 const removeCover=()=>{win.removeListener('resize',resize);if(cover){if(attached&&!win.isDestroyed())win.contentView.removeChildView(cover);if(!cover.webContents.isDestroyed())cover.webContents.close();cover=null;attached=false;}};
 try{
  // Clearing secrets is required. A compositor frame is only a visual enhancement.
  await bounded(win.webContents.executeJavaScript("document.querySelectorAll('input[type=password],.password-field input').forEach(e=>{e.value='';e.type='password';});"),2000);
  try{
   await bounded(win.webContents.executeJavaScript(paint),150).catch(()=>{});
   const frame=await bounded(win.webContents.capturePage(),600);
   cover=new WebContentsView({webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,devTools:false}});
   cover.webContents.setWindowOpenHandler(()=>({action:'deny'}));cover.webContents.on('will-navigate',e=>e.preventDefault());
   await bounded(cover.webContents.loadURL(pathToFileURL(join(root,'desktop/transition.html')).href),2000);
   await bounded(cover.webContents.executeJavaScript(`document.getElementById('frame').src=${JSON.stringify(frame.toDataURL())};document.getElementById('frame').decode()`),1000);
   resize();win.contentView.addChildView(cover);attached=true;win.on('resize',resize);
   await bounded(cover.webContents.executeJavaScript(paint),150).catch(()=>{});
  }catch{removeCover();} // A missing screenshot must never block wallet navigation.
  loading=true;await bounded(win.loadURL(url),12000);await readyView(win);
  await bounded(win.webContents.executeJavaScript(paint),150).catch(()=>{});
 }catch(e){
  if(!win.isDestroyed()&&!win.webContents.isDestroyed()){
   win.webContents.stop();
   // A failed destination must return to a usable locked screen, not Chromium's
   // error document or a screenshot with controls that can no longer respond.
   if(loading)await bounded(win.loadURL(previous),12000).then(()=>readyView(win)).catch(()=>{});
   await bounded(win.webContents.executeJavaScript("(()=>{delete document.documentElement.dataset.viewPending;const n=document.getElementById('notice');if(n){n.hidden=false;n.className='error';n.textContent='The screen could not be opened. Your wallet remains locked. Please try again.';}})()"),1000).catch(()=>{});
  }
  throw e;
 }finally{removeCover();}
}
