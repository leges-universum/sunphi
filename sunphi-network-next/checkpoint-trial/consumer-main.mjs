import {app,BrowserWindow,ipcMain,clipboard,session,dialog,shell} from 'electron';
import {fork} from 'node:child_process';
import {readFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {consumerRuntime} from './runtime-compatibility.mjs';
import {randomUUID} from 'node:crypto';
import {allowedAccountUrl} from './sunphi-connection.mjs';
import {HomeUpdates,forwardHome,reportHomeBoot} from './home-updates.mjs';
import {homeRuntimeHealthy} from './home-boot-health.mjs';
import {createAutoStart} from './consumer-autostart.mjs';
const here=import.meta.dirname,root=resolve(here,'../..'),profileFile=join(root,'connection-profile.json');
// These two immutable files are generated only after server-profile qualification.
const pin=JSON.parse(readFileSync(join(root,'connection-pin.json'))),profile=(await consumerRuntime(root,JSON.parse(readFileSync(profileFile)),pin.sha256)).profile;
app.setName('DueByte Node');
app.setAppUserModelId('com.duebyte.node');
// Respect Electron's explicit data-directory switch for isolated installations.
// Ordinary launches retain the standard persistent wallet location.
if(!app.commandLine.hasSwitch('user-data-dir'))app.setPath('userData',join(app.getPath('appData'),'Duebyte','checkpoint-node'));
const state=join(app.getPath('userData'),profile.config.chainId),nodeURL=pathToFileURL(join(here,'consumer.html')).href;
let win,runner=null,done=Promise.resolve(),quitting=false,appearance={light:false,zoom:1},value={configured:true,progress:'idle',network:profile.config.chainId,walletReady:false};
const rewardRequests=new Map(),updateRequests=new Map();let updates;
const userDataDir=app.commandLine.hasSwitch('user-data-dir')?app.getPath('userData'):undefined;
if(forwardHome(root,state,{connect:process.argv.includes('--connect'),userDataDir}))app.exit(0);
const single=app.requestSingleInstanceLock({version:app.getVersion()});if(!single){
 void app.whenReady().then(()=>{dialog.showMessageBoxSync({type:'info',title:'DueByte is already running',message:'Another DueByte window is already running.',detail:'This launch is version '+app.getVersion()+'. Close the running copy before starting this version. If the older copy stays open, select Back to node, then Disconnect, and close its window. Your saved wallet will remain available.',buttons:['OK']});app.quit();});
}else{
 app.on('second-instance',()=>{win?.show();win?.focus();});
 void app.whenReady().then(async()=>{mkdirSync(state,{recursive:true});
 session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
 session.defaultSession.setPermissionCheckHandler(()=>false);
 win=new BrowserWindow({width:1180,height:860,minWidth:800,minHeight:600,show:false,title:'DueByte '+app.getVersion()+' — Node',icon:join(here,'../desktop/brand/sunphi-windows.ico'),...(process.platform==='win32'?{titleBarStyle:'hidden',titleBarOverlay:{color:'#030305',symbolColor:'#f3f4f5',height:32}}:{}),webPreferences:{preload:join(here,'consumer-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 win.setMenuBarVisibility(false);win.webContents.setWindowOpenHandler(({url})=>{if(url==='https://sun-phi.com/'||allowedAccountUrl(url))void shell.openExternal(url).catch(()=>{});return {action:'deny'};});
 ipcMain.on('duebyte-window-state',(event)=>{if(event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame)event.returnValue={...appearance};else event.returnValue=null;});
 win.webContents.on('will-navigate',(e,url)=>{if(url!==nodeURL&&url!==`http://127.0.0.1:${profile.walletPort}/`)e.preventDefault();});
 const autoStart=createAutoStart(app,{isolated:!!userDataDir});
 function snapshot(){return {...value,autoStart:autoStart.get(),autoStartAvailable:autoStart.available,updates:updates?.snapshot()};}
 function connect(){assert(!runner,'connection already active');value={...value,progress:'connecting',error:null,rpc:null,walletReady:false};
  runner=fork(join(here,'consumer-runner.mjs'),[profileFile,pin.sha256,state],{execPath:join(root,'runtime/node.exe'),windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
  const owned=runner;done=new Promise(r=>owned.once('close',code=>{runner=null;value={...value,walletReady:false,rpc:null,progress:value.progress==='failed'?'failed':code===0?'stopped':'failed'};r();}));
  runner.on('message',m=>{if(m?.updateRequest){updateRequests.get(m.updateRequest)?.(m.ready===true);return;}if(m?.rewardRequest){const request=rewardRequests.get(m.rewardRequest);if(request){clearTimeout(request.timer);rewardRequests.delete(m.rewardRequest);m.ok?request.resolve():request.reject(Error(m.error));}return;}if(m&&typeof m.progress==='string'){if(value.progress==='failed'&&['stopping','stopped'].includes(m.progress))return;value={...value,...m};if(homeRuntimeHealthy(m,profile.config.chainId))reportHomeBoot(root,state);}});
  runner.once('error',e=>{value={...value,progress:'failed',error:e.message};});
 }
 async function stop(){if(!runner)return;value={...value,progress:'stopping'};if(runner.connected)runner.send({command:'stop'},()=>{});await done;}
 async function prepareUpdate(){if(win.webContents.getURL()!==nodeURL)return false;if(!runner)return true;if(!runner.connected)return false;const request=randomUUID();return new Promise(resolve=>{const finish=ready=>{clearTimeout(timer);updateRequests.delete(request);resolve(ready);},timer=setTimeout(()=>finish(false),5000);updateRequests.set(request,finish);runner.send({command:'prepare-update',request},()=>{});});}
 updates=new HomeUpdates({root,state,prepare:prepareUpdate,stop,quit:()=>app.quit(),connected:()=>!!runner,userDataDir});updates.start();
 async function lockWallet(){if(win.webContents.getURL()!==`http://127.0.0.1:${profile.walletPort}/`)return;await win.webContents.executeJavaScript("(async()=>{const end=Date.now()+30000;while(true){try{await api('/lock',{});return true;}catch(e){if(!e.message.includes('wait for current operation')||Date.now()>=end)throw e;await new Promise(r=>setTimeout(r,200));}}})()");}
 ipcMain.handle('duebyte-node',async(event,action,args={})=>{try{
  assert(event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame,'main window only');
  const url=event.senderFrame.url,isNode=url===nodeURL,isWallet=url===`http://127.0.0.1:${profile.walletPort}/`;
  assert(isNode||isWallet,'untrusted document');assert(isNode||action==='back'||action==='appearance','wallet navigation only');
  if(action==='appearance'){assert(typeof args.light==='boolean');if(args.zoom!==undefined){assert(Number.isFinite(args.zoom)&&args.zoom>=.5&&args.zoom<=3);appearance.zoom=args.zoom;}appearance.light=args.light;win.setBackgroundColor(args.light?'#f8f9fa':'#030305');if(process.platform==='win32')win.setTitleBarOverlay({color:args.light?'#f8f9fa':'#030305',symbolColor:args.light?'#111317':'#f3f4f5',height:32});return {ok:true};}
  if(action==='status')return {ok:true,value:snapshot()};
  if(action==='check-updates'){void updates.check();return {ok:true,value:snapshot()};}
  if(action==='automatic-updates'){updates.setAutomatic(args.enabled);return {ok:true,value:snapshot()};}
  if(action==='connect')connect();else if(action==='stop'){await stop();}
  else if(action==='wallet'){assert(value.walletReady,'Wallet is connecting. Please wait.');await win.loadURL(`http://127.0.0.1:${profile.walletPort}/`);}
  else if(action==='back'){await lockWallet();await win.loadURL(nodeURL);}
  else if(action==='reward-wallets'){assert(runner?.connected&&value.walletReady,'Wait for the wallet service to start.');assert(Array.isArray(args.ids)&&args.ids.length>=1&&args.ids.length<=16&&args.ids.every(x=>typeof x==='string'&&x.length<=36),'Choose reward wallets.');const request=randomUUID();await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{rewardRequests.delete(request);reject(Error('The selection is awaiting confirmation. Check the saved selection before retrying.'));},10000);rewardRequests.set(request,{resolve,reject,timer});runner.send({command:'reward-wallets',request,ids:args.ids});});}
  else if(action==='copy-request'){if(value.deviceId)clipboard.writeText(value.deviceId);}
  else if(action==='auto-start'){assert(typeof args.enabled==='boolean');autoStart.set(args.enabled);}
  else assert.fail('unknown action');return {ok:true,value:snapshot()};
 }catch(e){return {ok:false,error:e.message};}});
 win.on('close',e=>{if(runner){e.preventDefault();if(!quitting)app.quit();}});
 app.on('before-quit',e=>{updates?.close();if(runner){e.preventDefault();if(!quitting){quitting=true;void stop().then(()=>app.quit());}}});
 app.on('window-all-closed',()=>app.quit());
 await win.loadURL(nodeURL);win.show();reportHomeBoot(root,state,process.argv.includes('--connect')?'starting':'ready');if(process.argv.includes('--connect'))connect();
 }).catch(e=>{console.error(e);app.exit(1);});
}
