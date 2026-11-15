// Synthetic signing backend for process-boundary tests, never a chain adapter.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {hash,sign,verify} from '../../crypto.mjs';
export async function createBackend(config,secrets){
 return {
  authorize:async packet=>assert(config.allowed.includes(hash(packet))),
  plan:async()=>({resources:['isolated:nonce:0']}),
  sign:async(packet,plan)=>{
   if(config.signCounterFile)fs.appendFileSync(config.signCounterFile,'1\n');
   if(config.signReleaseFile){
    const deadline=Date.now()+15000;
    while(!fs.existsSync(config.signReleaseFile)){
     assert(Date.now()<deadline,'Test signing gate timed out');
     await new Promise(r=>setTimeout(r,10));
    }
   }
   if(config.crash)process.exit(73);
   if(config.delay)await new Promise(r=>setTimeout(r,config.delay));
   const raw=Buffer.from(sign({packet,plan},secrets.privateKey),'base64url').toString('hex');return {raw,transaction:hash(raw)};
  },
  inspect:async(packet,signed,plan)=>{assert.equal(signed.transaction,hash(signed.raw));assert(verify({packet,plan},Buffer.from(signed.raw,'hex').toString('base64url'),config.publicKey));}
 };
}
