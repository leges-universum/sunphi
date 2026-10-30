import {app,BrowserWindow,ipcMain,dialog,session,powerMonitor} from 'electron';
import {fork} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,join} from 'node:path';
import {NodeController} from './node-controller.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url))),entry=pathToFileURL(join(root,'desktop/index.html')).href;
const nodeEdition=process.argv.includes('--sunphi-node'),nodeEntry=pathToFileURL(join(root,'desktop/node.html')).href;
app.setName(nodeEdition?'SunPhi Native Node':'SunPhi Native Wallet');app.setPath('userData',join(app.getPath('appData'),nodeEdition?'SunPhi Native Node Preview':'SunPhi Native Wallet Preview'));
let controller,closing=false,nodeBusy=false;
let win,worker,seq=0,busy=false,profile=join(root,'profile');const pending=new Map();
function start(){const p=fork(join(root,'desktop/worker.mjs'),[root,profile],{execPath:join(root,'runtime/node.exe'),stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});worker=p;p.on('message',m=>{const job=pending.get(m.id);if(job){pending.delete(m.id);job(m);}});p.on('error',()=>{win?.webContents.send('sunphi:locked');});p.on('exit',()=>{if(worker!==p)return;worker=null;for(const job of pending.values())job({ok:false,error:'Wallet worker stopped. Reopen to recover saved payments.'});pending.clear();win?.webContents.send('sunphi:locked');});}
function call(action,args){if(!worker)start();return new Promise(resolve=>{const id=++seq;pending.set(id,resolve);worker.send({id,action,args});});}
async function choose(save,name,extensions=['json']){const filters=[{name,extensions}];const r=save?await dialog.showSaveDialog(win,{defaultPath:name,filters}):await dialog.showOpenDialog(win,{properties:['openFile'],filters});return r.canceled?null:save?r.filePath:r.filePaths[0];}
const allowed=new Set(['status','create','open','restore','lock','invoice','import','backup','review-invoice','refresh','inspect','prepare','send','recover','export-receipt','profile']);
if(!app.requestSingleInstanceLock())app.quit();else app.whenReady().then(async()=>{
 session.defaultSession.setPermissionRequestHandler((_w,_p,done)=>done(false));session.defaultSession.setPermissionCheckHandler(()=>false);
 session.defaultSession.webRequest.onBeforeRequest((d,done)=>done({cancel:!d.url.startsWith(pathToFileURL(join(root,'desktop')+'/').href)}));
 win=new BrowserWindow({width:1180,height:850,minWidth:360,minHeight:520,show:false,backgroundColor:'#08090b',icon:join(root,'desktop/brand.png'),webPreferences:{preload:join(root,'desktop/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,devTools:false}});
 win.removeMenu();win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());
 if(nodeEdition){
  controller=new NodeController(root,join(app.getPath('userData'),'node'),()=>{});
  ipcMain.handle('sunphi:node',async(e,action,args={})=>{
   if(e.sender!==win?.webContents||e.senderFrame!==win.webContents.mainFrame||![entry,nodeEntry].includes(e.senderFrame.url))throw Error('Untrusted frame');
   if(action==='edition')return {ok:true,value:true};
   if(action==='status')return {ok:true,value:await controller.status()};
   if(nodeBusy||busy)return {ok:false,error:'Wait for the current operation to finish'};
   nodeBusy=true;
   try{
    if(action==='wallet'){setImmediate(()=>win.loadURL(entry));return {ok:true};}
    if(action==='home'){if(worker)await call('lock',{});setImmediate(()=>win.loadURL(nodeEntry));return {ok:true};}
    if(e.senderFrame.url!==nodeEntry)throw Error('Open the node section first');
    if(action==='verify')return {ok:true,value:controller.verify()};
    if(action==='stop'){await controller.stop();return {ok:true,value:controller.snapshot()};}
    if(action==='start'){
     const base=args?.base;if(!Number.isInteger(base)||base<1024||base>65530)throw Error('Base port must be 1024–65530');
     if(controller.child)throw Error('A node operation is already running');
     const r=await dialog.showOpenDialog(win,{properties:['openDirectory'],title:'Choose an operator-prepared isolated node home'});
     return {ok:true,value:r.canceled?null:controller.start(r.filePaths[0],base)};
    }
    throw Error('Unknown node operation');
   }catch(e){return {ok:false,error:e.message};}finally{nodeBusy=false;}
  });
  win.on('close',e=>{
   if(closing)return;
   if(controller.child){e.preventDefault();
    if(controller.value.role==='archive-verifier'){dialog.showMessageBox(win,{type:'info',message:'Archive verification is still running.',detail:'Let it finish before closing. You can open the wallet meanwhile.'});return;}
    closing=true;controller.stop().then(()=>app.quit());
   }
  });
 }
 ipcMain.handle('sunphi:request',async(e,action,args={})=>{
  if(e.sender!==win?.webContents||e.senderFrame!==win.webContents.mainFrame||e.senderFrame.url!==entry)throw Error('Untrusted frame');
  if(!allowed.has(action)||!args||typeof args!=='object'||JSON.stringify(args).length>20000)return {ok:false,error:'Invalid request'};
  if(busy)return {ok:false,error:'Wait for the current operation to finish'};busy=true;
  try{
   // Paths and public trust selection come only from native dialogs, never renderer input.
   const safe={};for(const k of ['password','backupPassword','amount','ids','fee','txid'])if(Object.hasOwn(args,k))safe[k]=args[k];
   if(action==='profile'){
    const status=await call('status',{});if(!status.value?.locked)return {ok:false,error:'Lock your wallet before selecting a network profile'};
    const r=await dialog.showOpenDialog(win,{properties:['openDirectory'],title:'Select independently obtained public laboratory profile'});if(r.canceled)return {ok:true,value:null};
    const check=await dialog.showMessageBox(win,{type:'warning',buttons:['Cancel','Use this laboratory profile'],defaultId:0,cancelId:0,message:'This folder defines a different network trust root.',detail:'Use only public genesis and checkpoint files obtained independently from your laboratory operator. This does not connect to the existing SunPhi or Coin balances.'});
    if(check.response!==1)return {ok:true,value:null};worker?.disconnect();worker=null;profile=r.filePaths[0];return {ok:true,value:{profile}};
   }
   if(['create','restore','open'].includes(action)){safe.path=await choose(action!=='open','SunPhi native wallet.db',['db']);if(!safe.path)return {ok:true,value:null};}
   if(action==='restore'){safe.backup=await choose(false,'Encrypted backup');if(!safe.backup)return {ok:true,value:null};}
   if(['invoice','backup','export-receipt'].includes(action)){safe.path=await choose(true,action==='invoice'?'SunPhi invoice.json':action==='backup'?'SunPhi encrypted backup.json':'SunPhi payment receipt.json');if(!safe.path)return {ok:true,value:null};}
   if(['import','review-invoice'].includes(action)){safe.path=await choose(false,action==='import'?'Payment receipt':'Signed invoice');if(!safe.path)return {ok:true,value:null};}
   if(action==='send'){
    const status=await call('status',{}),p=status.value?.prepared.find(p=>p.txid===safe.txid);if(!p)return {ok:false,error:'No saved payment selected'};
    const r=await dialog.showMessageBox(win,{type:'question',buttons:['Cancel','Send saved payment'],defaultId:0,cancelId:0,message:'Send this exact prepared payment?',detail:`Recipient: ${p.recipient}\nPayment: ${p.txid}\nInvoice: ${p.invoiceId}\nAmount (base units): ${p.amount}\nFee (base units): ${p.fee}\n100,000,000 base units = 1 SUN. No new proof or payment will be generated.`});if(r.response!==1)return {ok:true,value:null};
   }
   return await call(action,safe);
  }catch{return {ok:false,error:'The file or operation could not be opened. No existing file was overwritten.'};}finally{busy=false;}
 });
 for(const event of ['suspend','lock-screen'])powerMonitor.on(event,()=>{win?.webContents.send('sunphi:locked');if(worker?.connected)worker.disconnect();});
 await win.loadURL(nodeEdition?nodeEntry:entry);win.show();
 if(process.argv.includes('--smoke')){const r=await win.webContents.executeJavaScript('({bridge:typeof window.sunphi.request,node:typeof require,title:document.title})');console.log(JSON.stringify({smoke:r,preferences:win.webContents.getLastWebPreferences().sandbox}));app.quit();}
});
app.on('window-all-closed',()=>app.quit());app.on('before-quit',()=>{if(worker?.connected)worker.disconnect();});
