import {basename,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {open,stat,copyFile,constants} from 'node:fs/promises';
import {LastWallet} from './coin/desktop-wallet/last-wallet.mjs';
import {lockController} from '../src/controller-lock.mjs';
// File-first access without accepting paths from the renderer.
export class NetworkFiles {
 constructor(path,picker){this.last=new LastWallet(path);this.picker=picker;this.clear();}
 clear(){this.selected=null;this.revision=(this.revision??0)+1;}
 async choose(mode){if(!['open','restore'].includes(mode))throw Error('Invalid file mode');this.clear();const rev=this.revision,p=await this.picker(mode);if(!p||rev!==this.revision)return null;return this.select(p,mode);}
 select(path,mode){this.selected={path,mode,id:randomUUID()};return {id:this.selected.id,name:basename(path),directory:dirname(path)};}
 async recall(){this.clear();const rev=this.revision,p=await this.last.read();if(!p||rev!==this.revision)return null;try{if(!(await stat(p)).isFile())throw Error();return this.select(p,'open');}catch{return {missing:true,name:basename(p),directory:dirname(p)};}}
 resolve(mode,id){if(this.selected?.mode!==mode||this.selected?.id!==id)throw Error('Choose the wallet file again');return this.selected.path;}
 async validateDatabase(path){const f=await open(path,'r');try{const b=Buffer.alloc(16);await f.read(b,0,16,0);if(b.toString()!=='SQLite format 3\0')throw Error('This is not a Network wallet file. Choose Coin for institutional wallet files.');}finally{await f.close();}}
 async copyLocked(id,target){const p=this.resolve('open',id),unlock=lockController([p]);try{await this.validateDatabase(p);let wal=null;try{wal=await stat(p+'-wal');}catch(e){if(e.code!=='ENOENT')throw e;}if(wal?.size)throw Error('Close the wallet normally before copying its encrypted file; pending journal data exists.');await copyFile(p,target,constants.COPYFILE_EXCL);return {saved:true};}finally{unlock();}}
}
