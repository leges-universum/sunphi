import {readFileSync,statSync,mkdtempSync,mkdirSync,unlinkSync,rmdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {canonical,digest,exact} from './protocol.mjs';
import {RenewalBook} from './renewing-history.mjs';
import {canonicalHistory} from './canonical-history.mjs';
import {verifyApplicationSnapshot} from './application-snapshot.mjs';
const permit=Symbol('verified snapshot'),CHUNK=256*1024;
export class CertifiedSnapshot{
 #snapshot;#blocks;#bytes;#tip;#initialKeys;
 constructor(token,snapshot,blocks,tip,initialKeys){if(token!==permit)throw Error('independent snapshot verification required');this.#snapshot=snapshot;this.#blocks=blocks;this.#tip=tip;this.#initialKeys=initialKeys;this.#bytes=Buffer.from(canonical(snapshot));}
 static async open({bundlePath,genesisPath,bin,temporary}){
  if(statSync(bundlePath).size>128*1024*1024)throw Error('bootstrap bundle size');
  const bundle=JSON.parse(readFileSync(bundlePath)),genesis=JSON.parse(readFileSync(genesisPath)),config=genesis.app_state;
  exact(bundle,['version','snapshot','history']);
  if(bundle.version!==1||config?.mode!=='isolated'||genesis.chain_id!==config.chainId||!Array.isArray(bundle.history)||bundle.history.length<1||bundle.history.length>512)throw Error('bootstrap bundle contract');
  const policy={chainId:config.chainId,genesis:digest(config),history:config.history};
  mkdirSync(temporary,{recursive:true});const dir=mkdtempSync(join(temporary,'verify-bootstrap-'));let book;
  try{
   book=await RenewalBook.open(join(dir,'history.db'),policy,{genesis:genesisPath,bin,temporary:dir});const blocks=[];
   for(const item of bundle.history){
    exact(item,['certificate','archive']);if(typeof item.archive!=='string'||item.archive.length>24*1024*1024)throw Error('bootstrap archive bound');
    const bytes=Buffer.from(item.archive,'base64');if(bytes.toString('base64')!==item.archive)throw Error('bootstrap archive encoding');
    await book.accept(item.certificate,bytes);
    const entries=JSON.parse(canonicalHistory(bytes,3)).entries;
    for(let i=0;i<8;i++){const e=entries[i];if(e.height!==blocks.length+1)throw Error('bootstrap history gap');blocks.push({height:e.height,blockHash:Buffer.from(e.hash,'hex').toString('base64'),txs:e.txs,root:entries[i+1].appHash});}
   }
   const tip=book.context.last.body,anchor={genesis:policy.genesis,height:tip.endHeight,appHash:tip.appHash};
   const snapshot=verifyApplicationSnapshot(bundle.snapshot,config,anchor);
   if(blocks.at(-1)?.root!==snapshot.appHash)throw Error('snapshot/archive root mismatch');
   return new CertifiedSnapshot(permit,snapshot,blocks,tip,genesis.validators.map(v=>Buffer.from(v.pub_key.value,'base64').toString('hex')));
  }finally{book?.close();for(const name of ['history.db','history.db-wal','history.db-shm']){const p=join(dir,name);if(existsSync(p))unlinkSync(p);}rmdirSync(dir);}
 }
 get snapshot(){return structuredClone(this.#snapshot);}
 get blocks(){return structuredClone(this.#blocks);}
 get anchor(){return {genesis:this.#snapshot.genesis,height:this.#snapshot.height,appHash:this.#snapshot.appHash};}
 get trust(){return {height:this.#tip.headerHeight,hash:this.#tip.headerHash};}
 isKnownSigningKey(key){const g=this.#snapshot.governance;return this.#initialKeys.includes(key)||!!g&&(g.members.some(m=>m.key===key||m.recovery===key)||g.usedKeys.includes(key)||g.pending?.newKey===key);}
 get descriptor(){return {height:this.#snapshot.height,format:1,chunks:Math.ceil(this.#bytes.length/CHUNK),hash:Buffer.from(digest(this.#snapshot),'hex').toString('base64')};}
 chunk(index){if(!Number.isInteger(index)||index<0||index>=this.descriptor.chunks)throw Error('snapshot chunk index');return this.#bytes.subarray(index*CHUNK,(index+1)*CHUNK).toString('base64');}
}
