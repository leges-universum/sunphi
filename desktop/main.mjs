import {app,BrowserWindow,ipcMain,dialog,session,powerMonitor,clipboard,shell} from 'electron';
import {fork} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,join} from 'node:path';
import {existsSync,writeFileSync,readFileSync} from 'node:fs';
import {NodeController} from './node-controller.mjs';
import {coinController} from './coin-controller.mjs';
import {NetworkFiles} from './network-files.mjs';
import {distributionPolicy} from './distribution-policy.mjs';
import {switchView,readyView} from './view-transition.mjs';
import {Navigation,operationLabel} from './navigation.mjs';
import {IdlePolicy} from './idle-policy.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url))),entry=pathToFileURL(join(root,'desktop/index.html')).href;
const distribution=distributionPolicy(JSON.parse(readFileSync(join(root,'distribution.json'),'utf8')),{nodeRequested:process.argv.includes('--sunphi-node'),trialChain:existsSync(join(root,'profile/trial.json'))?JSON.parse(readFileSync(join(root,'profile/trial.json'),'utf8')).chain:null});
const nodeEdition=distribution.nodeEdition,nodeEntry=pathToFileURL(join(root,'desktop/node.html')).href;
const coinEntry=pathToFileURL(join(root,'desktop/coin/desktop-wallet/unified.html')).href;
const trialEdition=existsSync(join(root,'profile/trial.json'));
app.setName(nodeEdition?'SunPhi Native Node':'SunPhi Wallet');app.setPath('userData',join(app.getPath('appData'),'SunPhi Native Trial'));
let controller,closing=false,nodeBusy=false,nodeOperation=null;
let win,worker,seq=0,busy=false,busyOperation=null,profile=join(root,'profile');const pending=new Map();
let coin,networkFiles,switching=false;
const idle=new IdlePolicy();
const navigation=new Navigation({isBusy:()=>busy||nodeBusy||switching,operation:()=>operationLabel(busyOperation||nodeOperation||'lock'),lock:()=>lockAll(false),load:async target=>{await switchView(win,target==='coin'?coinEntry:target==='node'?nodeEntry:entry,root);}});
function notifyWindow(channel,value){if(win&&!win.isDestroyed()&&!win.webContents.isDestroyed())win.webContents.send(channel,value);}
async function lockAll(notify=true,reason='manual'){idle.lock();networkFiles?.clear();coin?.lock();if(worker)await call('lock',{});if(notify){notifyWindow('sunphi:locked',reason);notifyWindow('wallet:locked',reason);}}
function trusted(e,entries){return e.sender===win?.webContents&&e.senderFrame===win.webContents.mainFrame&&entries.includes(e.senderFrame.url);}
const loginOptions=()=>({path:app.getPath('exe'),args:['--connect-on-login'],name:'SunPhi Native Trial'});
const nodeStatus=async()=>({...await controller.status(),autoStart:process.platform==='win32'&&app.getLoginItemSettings(loginOptions()).openAtLogin});
function start(){const p=fork(join(root,'desktop/worker.mjs'),[root,profile],{execPath:join(root,'runtime/node.exe'),stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});worker=p;p.on('message',m=>{if(worker!==p)return;if(m.type==='verification-idle'){idle.observe(m.value);return;}const job=pending.get(m.id);if(job){pending.delete(m.id);job(m);}});p.on('error',()=>{if(idle.direction==='network')idle.lock();notifyWindow('sunphi:locked');});p.on('exit',()=>{if(worker!==p)return;worker=null;if(idle.direction==='network')idle.lock();for(const job of pending.values())job({ok:false,error:'Wallet worker stopped. Reopen to recover saved payments.'});pending.clear();notifyWindow('sunphi:locked');});}
function call(action,args){if(!worker)start();return new Promise(resolve=>{const id=++seq;pending.set(id,resolve);worker.send({id,action,args});});}
async function choose(save,name,extensions=['json']){const filters=[{name,extensions}];const r=save?await dialog.showSaveDialog(win,{defaultPath:name,filters}):await dialog.showOpenDialog(win,{properties:['openFile'],filters});return r.canceled?null:save?r.filePath:r.filePaths[0];}
const allowed=new Set(['status','create','open','restore','lock','invoice','import','backup','review-invoice','refresh','inspect','prepare','send','recover','export-receipt','profile','last-wallet','select-wallet','clear-wallet-selection','copy-address','copy-locked','bitcoin']);
 if(!app.requestSingleInstanceLock())app.quit();else app.whenReady().then(async()=>{
 session.defaultSession.setPermissionRequestHandler((_w,_p,done)=>done(false));session.defaultSession.setPermissionCheckHandler(()=>false);
 session.defaultSession.webRequest.onBeforeRequest((d,done)=>done({cancel:!d.url.startsWith(pathToFileURL(join(root,'desktop')+'/').href)}));
 if(nodeEdition&&process.platform==='win32')app.setAppUserModelId('com.sunphi.native.trial');
 win=new BrowserWindow({width:1180,height:850,minWidth:360,minHeight:520,show:false,...(nodeEdition&&process.platform==='win32'?{titleBarStyle:'hidden',titleBarOverlay:{color:'#090c0f',symbolColor:'#f0f6fc',height:32}}:{}),backgroundColor:'#090c0f',icon:join(root,nodeEdition?'desktop/node-brand.png':'desktop/brand.png'),webPreferences:{preload:join(root,'desktop/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,devTools:false}});
 win.removeMenu();win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());
 // Reuse the original packaged Coin application's journal in place; never copy keys.
 coin=coinController({directory:join(app.getPath('appData'),'sunphi-wallet'),choose,clipboard,openExternal:url=>shell.openExternal(url)});
 networkFiles=new NetworkFiles(join(app.getPath('userData'),'network-last-wallet.json'),mode=>choose(false,mode==='restore'?'Network encrypted backup.json':'Network wallet.db',mode==='restore'?['json']:['db']));
 ipcMain.handle('sunphi:shell',async(e,action,args={})=>{
  if(!trusted(e,[entry,coinEntry]))throw Error('Untrusted frame');
  if(action==='activity'){idle.activity();return {ok:true};}
  if(action==='idle-status')return {ok:true,value:idle.status()};
  if(action==='edition')return {ok:true,value:nodeEdition};
  if(action==='navigation-status')return {ok:true,value:navigation.status()};
  if(action==='cancel-navigation')return {ok:true,value:navigation.cancel()};
  if(action!=='direction'||!['coin','network','node'].includes(args.direction)||args.direction==='node'&&!nodeEdition)return {ok:false,error:'Unknown direction'};
  try{return await navigation.go(args.direction);}catch{return {ok:false,error:'The screen could not be opened. Please try again.'};}
 });
 ipcMain.handle('wallet:request',async(e,action,args={})=>{
  if(!trusted(e,[coinEntry]))throw Error('Untrusted frame');
  if(busy||(navigation.pending&&!(navigation.loading&&['status','last-wallet','clear-wallet-selection'].includes(action)))||(switching&&!['status','last-wallet','clear-wallet-selection'].includes(action)))return {ok:false,error:'Please wait while the wallet finishes its current task.'};busy=true;busyOperation=action;
  try{const value=await coin.request(action,args);if(value&&!value.locked&&['create','open','restore'].includes(action))idle.open('coin');if(action==='lock')idle.lock();return {ok:true,value};}catch(e){return {ok:false,error:String(e.message).slice(0,300)};}finally{busy=false;busyOperation=null;}
 });
 const idleTimer=setInterval(()=>{if(!busy&&!nodeBusy&&!switching&&!navigation.pending&&idle.status().expired){switching=true;lockAll(true,'idle').catch(()=>{}).finally(()=>{switching=false;});}},1000);idleTimer.unref();
 if(nodeEdition){
  controller=new NodeController(root,join(app.getPath('userData'),'node'),()=>{});
  ipcMain.handle('sunphi:node',async(e,action,args={})=>{
   if(e.sender!==win?.webContents||e.senderFrame!==win.webContents.mainFrame||![entry,nodeEntry].includes(e.senderFrame.url))throw Error('Untrusted frame');
   if(action==='edition')return {ok:true,value:true};
   if(action==='status')return {ok:true,value:await nodeStatus()};
   if(nodeBusy||busy||navigation.pending)return {ok:false,error:'Wait for the current operation to finish'};
   nodeBusy=true;nodeOperation=action;
   try{
    if(action==='wallet'){await lockAll();setImmediate(()=>win.loadURL(entry));return {ok:true};}
    if(action==='home'){await lockAll();setImmediate(()=>win.loadURL(nodeEntry));return {ok:true};}
    if(e.senderFrame.url!==nodeEntry)throw Error('Open the node section first');
    if(action==='copy-request'&&trialEdition){const id=controller.snapshot().deviceId;if(!id)throw Error('Create a connection request first');clipboard.writeText(id);return {ok:true};}
    if(action==='auto-start'&&trialEdition){if(process.platform!=='win32'||typeof args.enabled!=='boolean')throw Error('Invalid startup setting');app.setLoginItemSettings({...loginOptions(),openAtLogin:args.enabled});return {ok:true,value:await nodeStatus()};}
    if(action==='connection-request'&&trialEdition){const path=await choose(true,'SunPhi connection request.json');if(path){const request=await controller.connectionRequest();writeFileSync(path,JSON.stringify(request,null,2),{flag:'wx'});}return {ok:true,saved:!!path,value:controller.snapshot()};}
    if(action==='connect'&&trialEdition)return {ok:true,value:controller.connect()};
    if(action==='verify')return {ok:true,value:controller.verify()};
    if(action==='stop'){await controller.stop();return {ok:true,value:controller.snapshot()};}
    if(action==='start'){
     const base=args?.base;if(!Number.isInteger(base)||base<1024||base>65530)throw Error('Base port must be 1024–65530');
     if(controller.child)throw Error('A node operation is already running');
     const r=await dialog.showOpenDialog(win,{properties:['openDirectory'],title:'Choose an operator-prepared isolated node home'});
     return {ok:true,value:r.canceled?null:controller.start(r.filePaths[0],base)};
    }
    throw Error('Unknown node operation');
   }catch(e){return {ok:false,error:e.message};}finally{nodeBusy=false;nodeOperation=null;}
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
  if(busy||(navigation.pending&&!(navigation.loading&&['status','last-wallet','clear-wallet-selection'].includes(action)))||(switching&&!['status','last-wallet','clear-wallet-selection'].includes(action)))return {ok:false,error:'Please wait while the wallet finishes its current task.'};busy=true;busyOperation=action;
  try{
   // Paths and public trust selection come only from native dialogs, never renderer input.
   const safe={};for(const k of ['password','backupPassword','amount','ids','fee','txid'])if(Object.hasOwn(args,k))safe[k]=args[k];
   if(['last-wallet','select-wallet','copy-locked'].includes(action)){const s=await call('status',{});if(!s.value?.locked)throw Error('Lock the wallet first');}
   if(action==='last-wallet')return {ok:true,value:await networkFiles.recall()};
   if(action==='select-wallet')return {ok:true,value:await networkFiles.choose(args.mode)};
   if(action==='clear-wallet-selection'){networkFiles.clear();return {ok:true,value:true};}
   if(action==='copy-locked'){const p=await choose(true,'SunPhi Network encrypted copy.db',['db']);return {ok:true,value:p?await networkFiles.copyLocked(args.selectionId,p):null};}
   if(action==='copy-address'){const s=await call('status',{});if(s.value?.locked||!s.value?.address)throw Error('Unlock first');clipboard.writeText(s.value.address);return {ok:true,value:{copied:true}};}
   if(action==='bitcoin'){
    // Public information only; no wallet identifiers leave this process.
    const response=await fetch('https://blockstream.info/api/blocks/tip/height',{signal:AbortSignal.timeout(8000),redirect:'error'});const height=await response.text();
    if(!response.ok||!/^\d{1,10}$/.test(height))throw Error('Bitcoin data unavailable');return {ok:true,value:{height,checkedAt:Date.now(),source:'Blockstream public data; not independently verified'}};
   }
   if(action==='profile'){
    const status=await call('status',{});if(!status.value?.locked)return {ok:false,error:'Lock your wallet before selecting a network profile'};
    const r=await dialog.showOpenDialog(win,{properties:['openDirectory'],title:'Select independently obtained public laboratory profile'});if(r.canceled)return {ok:true,value:null};
    const check=await dialog.showMessageBox(win,{type:'warning',buttons:['Cancel','Use this laboratory profile'],defaultId:0,cancelId:0,message:'This folder defines a different network trust root.',detail:'Use only public genesis and checkpoint files obtained independently from your laboratory operator. This does not connect to the existing SunPhi or Coin balances.'});
    if(check.response!==1)return {ok:true,value:null};worker?.disconnect();worker=null;profile=r.filePaths[0];return {ok:true,value:{profile}};
   }
   if(action==='open'){safe.path=networkFiles.resolve('open',args.selectionId);await networkFiles.validateDatabase(safe.path);}
   if(action==='restore')safe.backup=networkFiles.resolve('restore',args.selectionId);
   if(['create','restore'].includes(action)){const label=typeof args.label==='string'?args.label.replace(/[^\p{L}\p{N} _-]/gu,'').slice(0,60):'';safe.path=await choose(true,(label||'SunPhi Network wallet')+'.db',['db']);if(!safe.path)return {ok:true,value:null};}
   if(['invoice','backup','export-receipt'].includes(action)){safe.path=await choose(true,action==='invoice'?'SunPhi invoice.json':action==='backup'?'SunPhi encrypted backup.json':'SunPhi payment receipt.json');if(!safe.path)return {ok:true,value:null};}
   if(['import','review-invoice'].includes(action)){safe.path=await choose(false,action==='import'?'Payment receipt':'Signed invoice');if(!safe.path)return {ok:true,value:null};}
   if(action==='send'){
    const status=await call('status',{}),p=status.value?.prepared.find(p=>p.txid===safe.txid);if(!p)return {ok:false,error:'No saved payment selected'};
    const r=await dialog.showMessageBox(win,{type:'question',buttons:['Cancel','Send saved payment'],defaultId:0,cancelId:0,message:'Send this exact prepared payment?',detail:`Recipient: ${p.recipient}\nPayment: ${p.txid}\nInvoice: ${p.invoiceId}\nAmount (base units): ${p.amount}\nFee (base units): ${p.fee}\n100,000,000 base units = 1 SUN. No new proof or payment will be generated.`});if(r.response!==1)return {ok:true,value:null};
   }
   const result=await call(action,safe);
   if(result.ok&&['create','open','restore'].includes(action)){idle.open('network');networkFiles.clear();await networkFiles.last.remember(safe.path).catch(()=>{});}
   if(action==='lock'){idle.lock();networkFiles.clear();}return result;
  }catch{return {ok:false,error:'The file or operation could not be opened. No existing file was overwritten.'};}finally{busy=false;busyOperation=null;}
 });
 for(const event of ['suspend','lock-screen'])powerMonitor.on(event,()=>{idle.lock();networkFiles?.clear();coin?.lock();notifyWindow('wallet:locked');notifyWindow('sunphi:locked');if(worker?.connected)worker.disconnect();});
 await win.loadURL(nodeEdition?nodeEntry:distribution.defaultDirection==='coin'?coinEntry:entry);await readyView(win);win.show();
 if(nodeEdition&&trialEdition&&process.argv.includes('--connect-on-login')){try{controller.connect();}catch(e){controller.value.phase='failed';controller.value.log=String(e.message);}}
 if(process.argv.includes('--smoke')){const r=await win.webContents.executeJavaScript('({bridge:typeof window.sunphi.request,node:typeof require,title:document.title})');console.log(JSON.stringify({smoke:r,preferences:win.webContents.getLastWebPreferences().sandbox}));app.quit();}
});
app.on('window-all-closed',()=>app.quit());app.on('before-quit',()=>{coin?.lock();if(worker?.connected)worker.disconnect();});
app.on('second-instance',()=>{if(win&&!win.isDestroyed()){if(win.isMinimized())win.restore();win.show();win.focus();}});
