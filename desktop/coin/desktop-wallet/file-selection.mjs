import {basename,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {copyFile,constants,stat} from 'node:fs/promises';
import {DesktopWallet} from './core.mjs';

// Only a native picker can establish the file used by a later unlock request.
export class WalletFileSelection {
  #selected=null;
  #revision=0;
  constructor(chooseFile){this.chooseFile=chooseFile;}
  clear(){this.#selected=null;this.#revision++;}
  async choose(mode){
    if(!['open','restore'].includes(mode))throw Error('Invalid wallet selection mode.');
    this.clear();const revision=this.#revision;
    const path=await this.chooseFile(mode);
    if(revision!==this.#revision||!path)return null;
    const id=randomUUID();this.#selected={id,path,mode};
    return {id,name:basename(path),directory:dirname(path)};
  }
  async recall(loadPath){
    this.clear();const revision=this.#revision,path=await loadPath();
    if(revision!==this.#revision||!path)return null;
    let available=false;try{const s=await stat(path);available=s.isFile()&&s.size<=4*1024*1024;}catch{}
    if(revision!==this.#revision)return null;
    if(!available)return {missing:true,name:basename(path),directory:dirname(path)};
    const id=randomUUID();this.#selected={id,path,mode:'open'};
    return {id,name:basename(path),directory:dirname(path)};
  }
  resolve(mode,id){
    if(!this.#selected||this.#selected.mode!==mode||this.#selected.id!==id)
      throw Error('Choose the wallet file again before entering its password.');
    return this.#selected.path;
  }
}
export async function restoreSelectedBackup({source,password,chooseTarget,wallet,checkSelection=()=>{}}){
 const check=new DesktopWallet();
 try{await check.open(source,password);}finally{check.lock();}
 checkSelection();
 const target=await chooseTarget();
 if(!target)return null;
 checkSelection();
 await copyFile(source,target,constants.COPYFILE_EXCL);
 const value=await wallet.open(target,password);
 return {...value,restoredPath:target};
}

