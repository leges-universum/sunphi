// Recover the small Comet metadata side of a fully published application
// snapshot. Never replace application history or reset a signer. The bridge
// independently verifies the installed app root with Comet's light client.
import assert from 'node:assert/strict';
import {rpc} from '../client.mjs';
import {verifyCheckpoint} from '../checkpoint.mjs';
import {hash} from '../crypto.mjs';
export async function bootstrapRecoveryAnchor({pending,header,root,config,policy,previous,sources}){
 assert(pending&&pending.height===header.height&&pending.root===root);
 let failure;
 for(const source of sources){try{
  const reply=await rpc(source,'abci_query',{path:'/checkpoint'});assert(!reply.response.code);const document=JSON.parse(Buffer.from(reply.response.value,'base64'));
  verifyCheckpoint(document,policy,{previous,allowGap:true,configHash:hash(config)});assert(document.body.height>=pending.height,'current recovery anchor precedes installed state');
  return {height:pending.height,hash:Buffer.from(root,'hex').toString('base64'),anchorHeight:document.body.height,anchorHash:Buffer.from(document.body.blockHash,'hex').toString('base64')};
 }catch(e){failure=e;}}
 throw failure??Error('No independently authenticated bootstrap recovery anchor');
}
