import { mkdirSync,mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonical,exact } from './protocol.mjs';
import { runVerifier } from './history-io.mjs';
import { verifyPaymentEnvelope } from './payment-receipt.mjs';

// The caller obtains anchor from its reauthenticated RenewalBook, NEVER from
// a claimed verified flag, receipt file, RPC, or the sender of a payment.
export async function verifyReceipt(receipt,anchor,{bin,genesis,temporary,proofs,chainId}){
 exact(receipt,['version','anchorEpoch','wire','envelope','headers']);
 if(![1,2].includes(receipt.version)||receipt.anchorEpoch!==anchor?.body.epoch)throw new Error('receipt anchor unavailable');
 const bytes=canonical(receipt.headers);if(Buffer.byteLength(bytes)>2*1024*1024)throw new Error('receipt headers bound');
 await proofs.check(receipt.wire);
 // CometBFT's canonical JSON represents Go integers as decimal strings.
 if(receipt.headers.version!==String(receipt.version))throw new Error('receipt protection version mismatch');
 if(receipt.version===2&&(anchor.body.chainId!==chainId||receipt.envelope.height<anchor.body.fromHeight||receipt.envelope.height>anchor.body.endHeight))throw new Error('receipt sealed range');
 mkdirSync(temporary,{recursive:true});const dir=mkdtempSync(join(temporary,'receipt-')),path=join(dir,'headers.json');
 try{
  writeFileSync(path,bytes,{flag:'wx'});
  const v=JSON.parse(await runVerifier(bin,['-verify-receipt-proof',path,'-genesis',genesis,'-trusted-height',String(anchor.body.headerHeight),'-trusted-hash',anchor.body.headerHash],{timeoutMs:4000}));
  if(v.verified!==true||v.chain!==chainId||v.headerHeight!==receipt.envelope.height+1||v.applicationHeight!==receipt.envelope.height)throw new Error('receipt signed height mismatch');
  return {...verifyPaymentEnvelope(receipt.envelope,v.appHash,receipt.wire),historyProtection:receipt.version===2?'witness-sealed':'consensus-tail'};
 }finally{rmSync(dir,{recursive:true,force:true});}
}
