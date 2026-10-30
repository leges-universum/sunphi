import {join} from 'node:path';
import {DesktopWallet} from './coin/desktop-wallet/core.mjs';
import {LaboratoryAdapter} from './coin/desktop-wallet/lab-adapter.mjs';
import {LastWallet} from './coin/desktop-wallet/last-wallet.mjs';
import {WalletFileSelection,restoreSelectedBackup} from './coin/desktop-wallet/file-selection.mjs';
import {readRecord,writeNew} from './coin/wallet/files.mjs';

// The original Coin wallet, journal and procedure engine are reused unchanged.
// Only the Electron window ownership moves to the common application.
export function coinController({directory,choose,clipboard,openExternal}){
 const wallet=new DesktopWallet({adapter:new LaboratoryAdapter(join(directory,'procedure-laboratory-v1'))});
 const last=new LastWallet(join(directory,'last-wallet.json'));
 const selection=new WalletFileSelection(mode=>choose(false,mode==='restore'?'Coin backup.json':'Coin wallet.json'));
 async function remember(path,value){try{await last.remember(path);return value;}catch{return {...value,rememberWarning:true};}}
 const lock=()=>{selection.clear();return wallet.lock();};
 async function request(method,args={}){
  if(typeof method!=='string'||!args||typeof args!=='object'||JSON.stringify(args).length>140000)throw Error('Invalid request');
  switch(method){
   case 'status':return wallet.view();
   case 'copy-address':{const s=wallet.view();if(s.locked)throw Error('Unlock your wallet first');clipboard.writeText(s.address);return {copied:true};}
   case 'procedure-status':return wallet.procedureView();
   case 'procedure':return wallet.procedure(args.action,args.input??{});
   case 'procedure-export':{const data=wallet.exportProcedures(),p=await choose(true,'SunPhi laboratory evidence.json');if(p)await writeNew(p,data);return p?{saved:true}:null;}
   case 'help-link':{const links={home:'https://sun-phi.com/',standard:'https://coin.sun-phi.com/#/standard',resources:'https://coin.sun-phi.com/#/resources'};if(!Object.hasOwn(links,args.id))throw Error('Link is not allowed');await openExternal(links[args.id]);return true;}
   case 'last-wallet':if(!wallet.view().locked)throw Error('Lock the wallet first');return selection.recall(()=>last.read());
   case 'select-wallet':if(!wallet.view().locked)throw Error('Lock the wallet first');return selection.choose(args.mode);
   case 'clear-wallet-selection':selection.clear();return true;
   case 'lock':return lock();
   case 'create':{selection.clear();const p=await choose(true,'My SunPhi Coin.sunphi-desktop.json');return p?remember(p,await wallet.create(p,args.password,args.label)):null;}
   case 'open':{const p=selection.resolve('open',args.selectionId),v=await wallet.open(p,args.password);selection.clear();return remember(p,v);}
   case 'restore':{const source=selection.resolve('restore',args.selectionId),v=await restoreSelectedBackup({source,password:args.password,chooseTarget:()=>choose(true,'Restored SunPhi Coin.sunphi-desktop.json'),wallet,checkSelection:()=>selection.resolve('restore',args.selectionId)});if(!v)return null;selection.clear();const {restoredPath,...view}=v;return remember(restoredPath,view);}
   case 'backup':{const p=await choose(true,'SunPhi Coin backup.sunphi-desktop.json');return p?wallet.backup(p):null;}
   case 'password':return wallet.changePassword(args.oldPassword,args.newPassword);
   case 'prepare':return wallet.prepare(args);
   case 'confirm':return wallet.confirm(args.id);
   case 'inspect':return wallet.inspectPackage(args.id);
   case 'import-trust':{const p=await choose(false,'Institution trust.json');return p?wallet.importTrust(await readRecord(p),args.fingerprint):null;}
   case 'import-package':{const p=await choose(false,'Signing package.json');return p?wallet.importPackage(await readRecord(p)):null;}
   case 'export-approval':{const data=wallet.exportApproval(args.id),p=await choose(true,'SunPhi signed approval.json');if(p)await writeNew(p,data);return p?{saved:true}:null;}
   case 'statement':{const data=wallet.exportStatement(),p=await choose(true,'SunPhi test statement.json');if(p)await writeNew(p,data);return p?{saved:true}:null;}
   default:throw Error('Unsupported wallet request');
  }
 }
 return {request,lock};
}
