import assert from 'node:assert/strict';
import {createHash,verify} from 'node:crypto';
import {publicKey} from './crypto.mjs';
import {rpc} from './client.mjs';
import {signBytes} from '../../duebyte-node-installer-20261119/seat-witness.mjs';

// The wallet verifier authenticates the target block. Each displayed signature
// must independently verify for that exact block and a known consensus key.
export function readBlockSignatures(chain,certificate,validators,reply){
 const {commit,header}=reply.signed_header;
 assert.equal(header.chain_id,chain);
 assert.equal(Number(header.height),certificate.height);
 assert.equal(Number(commit.height),certificate.height);
 assert(/^[0-9a-f]{64}$/i.test(certificate.blockHash));
 assert.equal(commit.block_id.hash.toLowerCase(),certificate.blockHash.toLowerCase());
 assert(/^[0-9a-f]{64}$/i.test(commit.block_id.parts.hash));
 assert(Number.isSafeInteger(commit.block_id.parts.total)&&commit.block_id.parts.total>0);
 assert(Number.isSafeInteger(commit.round)&&commit.round>=0);
 assert(Array.isArray(commit.signatures)&&commit.signatures.length<=256);
 const known=new Map(validators.map(({key})=>[
  createHash('sha256').update(Buffer.from(key,'base64url')).digest('hex').slice(0,40).toUpperCase(),key
 ]));
 const rows=[],seen=new Set();
 for(const sig of commit.signatures){
  if(sig.block_id_flag!==2||!known.has(sig.validator_address))continue;
  const key=known.get(sig.validator_address),bytes=Buffer.from(sig.signature,'base64');
  assert(!seen.has(key)&&bytes.length===64&&bytes.toString('base64')===sig.signature);
  assert(verify(null,signBytes(commit,sig,chain),publicKey(key),bytes),'Invalid block signature');
  seen.add(key);rows.push({validator:key,address:sig.validator_address,signature:sig.signature});
 }
 return {height:certificate.height,blockHash:certificate.blockHash,rows};
}

export async function recentBlockSignatures(wallet){
 const {state,certificate}=await wallet.view(),authority=state.authority;
 const keys=authority?.posSlashing?.voting?.validators??authority?.validators??wallet.client.config.control.validators;
 const reply=await rpc(wallet.url,'commit',{height:String(certificate.height)});
 return readBlockSignatures(wallet.client.config.chainId,certificate,keys,reply);
}
