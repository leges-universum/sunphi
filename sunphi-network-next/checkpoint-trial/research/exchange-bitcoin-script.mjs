// Regtest-only P2WSH hashlock template; transaction signing stays in QA for now.
import assert from 'node:assert/strict';
import {hex,integer,digest} from '../crypto.mjs';
const push=b=>{assert(b.length<76);return Buffer.concat([Buffer.from([b.length]),b]);};
function scriptNumber(n){let v=BigInt(n),a=[];while(v){a.push(Number(v&255n));v>>=8n;}if(a.at(-1)&128)a.push(0);return Buffer.from(a);}
export function bitcoinExchangeScript({network,hashlock,claimKey,refundKey,refundAt}){
 assert.equal(network,'bitcoin-regtest');hex(hashlock);integer(refundAt,500000000);assert(refundAt<=0x7fffffff);
 for(const key of [claimKey,refundKey])assert(/^(02|03)[a-f0-9]{64}$/.test(key),'compressed secp256k1 public key');assert.notEqual(claimKey,refundKey);
 // IF SIZE 32 EQUALVERIFY SHA256 <hash> EQUALVERIFY <claim pubkey>
 // ELSE <UTC/MTP deadline> CLTV DROP <refund pubkey> ENDIF CHECKSIG
 const script=Buffer.concat([Buffer.from('6382012088a820','hex'),Buffer.from(hashlock,'hex'),Buffer.from('8821','hex'),Buffer.from(claimKey,'hex'),Buffer.from('67','hex'),push(scriptNumber(refundAt)),Buffer.from('b17521','hex'),Buffer.from(refundKey,'hex'),Buffer.from('68ac','hex')]);
 return {witnessScript:script.toString('hex'),scriptPubKey:'0020'+digest(script)};
}
