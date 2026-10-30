import {readFile,writeFile,mkdir,rename,unlink,stat} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';

// Device-local convenience only: no password, key, balance or automatic unlock.
export class LastWallet {
  constructor(file){this.file=file;}
  async read(){
    try{
      if((await stat(this.file)).size>16384)return null;
      const data=JSON.parse(await readFile(this.file,'utf8'));
      return data.version===1&&typeof data.path==='string'&&isAbsolute(data.path)?data.path:null;
    }catch{return null;}
  }
  async remember(path){
    if(typeof path!=='string'||!isAbsolute(path))throw Error('Invalid wallet path');
    await mkdir(dirname(this.file),{recursive:true});
    const temp=this.file+'.'+randomUUID()+'.tmp';
    try{
      await writeFile(temp,JSON.stringify({version:1,path})+'\n',{flag:'wx',mode:0o600});
      await rename(temp,this.file);
    }finally{await unlink(temp).catch(()=>{});}
  }
}
