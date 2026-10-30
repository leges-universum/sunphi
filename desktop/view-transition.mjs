import {WebContentsView} from 'electron';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const timeout=ms=>new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Wallet screen did not finish loading')),ms);timer.unref();});
export async function readyView(win){
 await Promise.race([win.webContents.executeJavaScript('window.sunphiViewReady || document.fonts.ready'),timeout(12000)]);
}
// Retain a password-free frame in memory while the next document is prepared.
// The cover has no preload or IPC privileges and is destroyed after every switch.
export async function switchView(win,url,root){
 let cover,attached=false;
 const resize=()=>{if(cover){const [width,height]=win.getContentSize();cover.setBounds({x:0,y:0,width,height});}};
 try{
  await win.webContents.executeJavaScript("document.querySelectorAll('input[type=password],.password-field input').forEach(e=>{e.value='';e.type='password';});new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  const frame=await win.webContents.capturePage();
  cover=new WebContentsView({webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,devTools:false}});
  cover.webContents.setWindowOpenHandler(()=>({action:'deny'}));cover.webContents.on('will-navigate',e=>e.preventDefault());
  await cover.webContents.loadURL(pathToFileURL(join(root,'desktop/transition.html')).href);
  await cover.webContents.executeJavaScript(`document.getElementById('frame').src=${JSON.stringify(frame.toDataURL())};document.getElementById('frame').decode()`);
  resize();win.contentView.addChildView(cover);attached=true;win.on('resize',resize);
  await cover.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  await win.loadURL(url);await readyView(win);
 }finally{win.removeListener('resize',resize);if(cover){if(attached)win.contentView.removeChildView(cover);cover.webContents.close();}}
}
