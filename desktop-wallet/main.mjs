import {app,BrowserWindow,ipcMain,dialog,powerMonitor,session,shell,clipboard} from 'electron';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,join} from 'node:path';
import {LastWallet} from './last-wallet.mjs';
import {WalletFileSelection,restoreSelectedBackup} from './file-selection.mjs';
import {DesktopWallet} from './core.mjs';
import {readRecord,writeNew} from '../wallet/files.mjs';
import {LaboratoryAdapter} from './lab-adapter.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const entry=pathToFileURL(join(root,'index.html')).href;
const wallet=new DesktopWallet({adapter:new LaboratoryAdapter(join(app.getPath('userData'),'procedure-laboratory-v1'))});
let win;
const lastWallet=new LastWallet(join(app.getPath('userData'),'last-wallet.json'));
async function rememberWallet(path,value){try{await lastWallet.remember(path);return value;}catch{return {...value,rememberWarning:true};}}
const fileSelection=new WalletFileSelection(mode=>chooseWalletFile(mode));
async function chooseWalletFile(mode){const r=await dialog.showOpenDialog(win,{title:mode==='restore'?'Choose encrypted backup':'Choose wallet file',properties:['openFile'],filters:[{name:'SunPhi encrypted wallet',extensions:['json']}]});return r.canceled?null:r.filePaths[0];}
if(!app.requestSingleInstanceLock())app.quit();
else {
  app.on('second-instance',()=>{win?.show();win?.focus();});
  app.whenReady().then(async()=>{
  session.defaultSession.setPermissionRequestHandler((_w,_p,done)=>done(false));
  session.defaultSession.setPermissionCheckHandler(()=>false);
  session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:!details.url.startsWith(pathToFileURL(root+'/').href)}));
  win=new BrowserWindow({width:1220,height:850,minWidth:700,minHeight:580,backgroundColor:'#101010',icon:join(root,'brand','sunflower.png'),show:false,
    webPreferences:{preload:join(root,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true,devTools:false}});
  win.removeMenu();
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',e=>e.preventDefault());
  win.on('closed',()=>{fileSelection.clear();wallet.lock();win=null;});
  for(const event of ['suspend','lock-screen'])powerMonitor.on(event,()=>{fileSelection.clear();wallet.lock();win?.webContents.send('wallet:locked');});
  const filters=[{name:'SunPhi encrypted wallet',extensions:['json']}];
  async function chooseOpen(){const r=await dialog.showOpenDialog(win,{properties:['openFile'],filters});return r.canceled?null:r.filePaths[0];}
  async function chooseSave(name){const r=await dialog.showSaveDialog(win,{defaultPath:name,filters,properties:['showOverwriteConfirmation']});return r.canceled?null:r.filePath;}
  ipcMain.handle('wallet:request',async(event,method,args={})=>{
    if(event.sender!==win?.webContents||event.senderFrame!==win.webContents.mainFrame||event.senderFrame.url!==entry)throw Error('Untrusted wallet frame');
    try {
      if(typeof method!=='string'||!args||typeof args!=='object'||JSON.stringify(args).length>140000)throw Error('Invalid request');
      switch(method){
        case 'status':return {ok:true,value:wallet.view()};
        case 'copy-address': {const current=wallet.view();if(current.locked)throw Error('Unlock your wallet first');clipboard.writeText(current.address);return {ok:true,value:{copied:true}};}
        case 'procedure-status':return {ok:true,value:wallet.procedureView()};
        case 'procedure':return {ok:true,value:await wallet.procedure(args.action,args.input??{})};
        case 'procedure-export': {const record=wallet.exportProcedures(),path=await chooseSave('SunPhi laboratory evidence.json');if(path)await writeNew(path,record);return {ok:true,value:path?{saved:true}:null};}
        case 'help-link': {const links={home:'https://sun-phi.com/',standard:'https://coin.sun-phi.com/#/standard',resources:'https://coin.sun-phi.com/#/resources'};if(!Object.hasOwn(links,args.id))throw Error('Link is not allowed');await shell.openExternal(links[args.id]);return {ok:true,value:true};}
        case 'last-wallet': {if(!wallet.view().locked)throw Error('Lock the wallet first.');return {ok:true,value:await fileSelection.recall(()=>lastWallet.read())};}
        case 'select-wallet': {if(!wallet.view().locked)throw Error('Lock the current wallet before choosing another.');return {ok:true,value:await fileSelection.choose(args.mode)};}
        case 'clear-wallet-selection':fileSelection.clear();return {ok:true,value:true};
        case 'lock':fileSelection.clear();return {ok:true,value:wallet.lock()};
        case 'create': {fileSelection.clear();const path=await chooseSave('My SunPhi.sunphi-desktop.json');if(!path)return {ok:true,value:null};const value=await wallet.create(path,args.password,args.label);return {ok:true,value:await rememberWallet(path,value)};}
        case 'open': {const path=fileSelection.resolve('open',args.selectionId);const value=await wallet.open(path,args.password);fileSelection.clear();return {ok:true,value:await rememberWallet(path,value)};}
        case 'restore': {const source=fileSelection.resolve('restore',args.selectionId);const value=await restoreSelectedBackup({source,password:args.password,chooseTarget:()=>chooseSave('Restored SunPhi.sunphi-desktop.json'),wallet,checkSelection:()=>fileSelection.resolve('restore',args.selectionId)});if(!value)return {ok:true,value:null};fileSelection.clear();const {restoredPath,...view}=value;return {ok:true,value:await rememberWallet(restoredPath,view)};}
        case 'backup': {const path=await chooseSave('SunPhi backup.sunphi-desktop.json');return {ok:true,value:path?await wallet.backup(path):null};}
        case 'password':return {ok:true,value:await wallet.changePassword(args.oldPassword,args.newPassword)};
        case 'prepare':return {ok:true,value:wallet.prepare(args)};
        case 'confirm':return {ok:true,value:await wallet.confirm(args.id)};
        case 'inspect':return {ok:true,value:wallet.inspectPackage(args.id)};
        case 'import-trust': {const path=await chooseOpen();return {ok:true,value:path?await wallet.importTrust(await readRecord(path),args.fingerprint):null};}
        case 'import-package': {const path=await chooseOpen();return {ok:true,value:path?await wallet.importPackage(await readRecord(path)):null};}
        case 'export-approval': {const record=wallet.exportApproval(args.id),path=await chooseSave('SunPhi signed approval.json');if(path)await writeNew(path,record);return {ok:true,value:path?{saved:true}:null};}
        case 'statement': {const record=wallet.exportStatement(),path=await chooseSave('SunPhi test statement.json');if(path)await writeNew(path,record);return {ok:true,value:path?{saved:true}:null};}
        default:throw Error('Unsupported wallet request');
      }
    }catch(e){return {ok:false,error:e.code==='EEXIST'?'That file exists. Choose a new file name.':String(e.message).slice(0,300)};}
  });
  await win.loadFile(join(root,'index.html'));
  if(process.argv.includes('--smoke-test')){
    const result=await win.webContents.executeJavaScript('(async()=>({title:document.title,bridge:typeof window.wallet.request,ready:!!document.querySelector("#locked"),nodeExposed:typeof window.require!=="undefined",status:await window.wallet.request("status")}))()');
    const p=win.webContents.getLastWebPreferences(),isolation={sandbox:p.sandbox,contextIsolation:p.contextIsolation,nodeIntegration:p.nodeIntegration};
    console.log(JSON.stringify({smoke:result,isolation,electron:process.versions.electron,node:process.versions.node}));
    app.exit(result.ready&&result.bridge==='function'&&!result.nodeExposed&&result.status.ok&&result.status.value.locked&&p.sandbox&&p.contextIsolation&&!p.nodeIntegration?0:1);
  } else win.show();
  }).catch(error=>{console.error(error.message);app.exit(1);});
}
app.on('window-all-closed',()=>app.quit());
