// Separate validating regtest databases, synchronized with actual serialized blocks.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {localRpc} from '../../research/purchase-observer.mjs';
import {until} from './purchase-comet-network.mjs';
export async function bitcoinReplica(out,exe,port,source){
 assert(!fs.existsSync(out));fs.mkdirSync(out,{recursive:true});let child,rpc;
 const connection={url:'http://127.0.0.1:'+port,cookieFile:join(out,'regtest/.cookie')};
 const stop=async()=>{if(child.exitCode===null){const done=new Promise(r=>child.once('exit',r));try{await rpc('stop');}catch{child.kill();}await done;}};
 const start=async()=>{const fd=fs.openSync(join(out,'console.log'),'a');child=spawn(exe,['-regtest','-server=1','-disablewallet=1','-listen=0','-connect=0','-dnsseed=0','-discover=0','-txindex=1','-rpcbind=127.0.0.1','-rpcport='+port,'-datadir='+out],{windowsHide:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);await until(async()=>{rpc=localRpc(connection.url,{headers:{Authorization:'Basic '+Buffer.from(fs.readFileSync(connection.cookieFile,'utf8')).toString('base64')}});assert.equal((await rpc('getblockchaininfo')).chain,'regtest');});};
 try{await start();
  return {get rpc(){return rpc;},connection,stop,async restart(){await stop();await start();},async sync(){const top=await source.rpc('getblockcount');for(let h=(await rpc('getblockcount'))+1;h<=top;h++){const id=await source.rpc('getblockhash',[h]),block=await source.rpc('getblock',[id,0]);assert.equal(await rpc('submitblock',[block]),null);}assert.equal(await rpc('getbestblockhash'),await source.rpc('getbestblockhash'));assert.equal((await rpc('getnetworkinfo')).connections,0);}};
 }catch(e){await stop();throw e;}
}
