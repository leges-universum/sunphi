import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {hash, hex} from './crypto.mjs';
import {inspectSavedInvoice} from './invoice-receipt.mjs';
import {verifyRecordProof} from './research/record-proof.mjs';

// Read a single record against the application hash of the operator's local full node.
function paymentRecord(db, pid, rootKey, appHash) {
 const key = 'requests/' + pid;
 const select = db.prepare('SELECT key, value, valueHash, left, leftHash, right, rightHash FROM nodes WHERE key=?');
 const path = [];
 let cursor = rootKey;
 while (cursor && path.length < 256) {
  const node = select.get(cursor);
  assert(node, 'Settlement snapshot is incomplete.');
  const {value, ...branch} = node;
  path.push(branch);
  if (cursor === key) {
   const proof = {key, path, found: true, value: JSON.parse(value)};
   verifyRecordProof(proof, appHash);
   return proof.value;
  }
  cursor = key < cursor ? node.left : node.right;
 }
 throw new Error('This snapshot has no verifiable record for the payment.');
}

export async function readInvoiceSettlement(archive, profile, snapshot, rpcUrl) {
 const invoice = inspectSavedInvoice(archive);
 assert.equal(invoice.network, profile.config.chainId, 'Receipt belongs to a different network.');
 const {receipt} = archive;
 assert.equal(receipt.result, 'Confirmed');
 assert(Number.isSafeInteger(receipt.height) && receipt.height > 0 && receipt.payment.height === receipt.height);
 for (const [name,value] of Object.entries(invoice.fields)) assert.equal(receipt.fields[name],value);
 const endpoint = new URL(rpcUrl);
 assert(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && endpoint.pathname === '/' &&
  !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, 'Use the RPC of your local verifying node.');
 const db = new DatabaseSync(snapshot,{readOnly:true});
 let root, height, record;
 try {
  db.exec('BEGIN');
  const {rootKey,rootHash} = db.prepare('SELECT rootKey,rootHash FROM meta WHERE id=1').get();
  root = rootHash;
  hex(root);
  const head = db.prepare("SELECT value FROM nodes WHERE key='meta/blockHead'").get();
  height = JSON.parse(head.value).height;
  assert(Number.isSafeInteger(height) && height > 0);
  record = paymentRecord(db, invoice.pid, rootKey, root);
 } finally { db.close(); }
 const commit = new URL('/commit',endpoint);
 commit.searchParams.set('height',String(height+1));
 const response = await fetch(commit,{redirect:'error',signal:AbortSignal.timeout(8000)});
 assert(response.ok,'Committed state is unavailable.');
 const {result} = await response.json();
 const header = result?.signed_header?.header;
 assert.equal(result?.canonical,true,'Wait for this block to become canonical.');
 assert.equal(header.chain_id,invoice.network);
 assert.equal(header.height,String(height+1));
 assert.equal(header.app_hash.toLowerCase(),root,'The local node and settlement snapshot disagree.');
 const {bill,notice} = receipt.invoiceAdvice;
 const intent = record.intent;
 assert.equal(record.status,'SETTLED');
 assert.equal(record.digest,hash(intent));
 assert.equal(record.terminalHeight,receipt.height);
 assert.equal(intent.pid,invoice.pid);
 assert.equal(intent.sender,bill.body.buyer);
 assert.equal(intent.recipient,bill.body.supplier);
 assert.equal(intent.value,bill.body.amountMicro);
 assert.equal(intent.fee,notice.body.feeMicro);
 assert.equal(intent.unitScale,'1000000');
 return {network:invoice.network,pid:invoice.pid,owner:invoice.owner,role:invoice.direction==='Sent'?'buyer':'supplier',
  invoiceHash:notice.body.invoiceHash,reference:bill.body.reference,buyer:intent.sender,supplier:intent.recipient,
  principal:intent.value,fee:intent.fee,disputed:bill.body.disputedMicro??'0',
  outstanding:bill.body.remainingMicro??'0',face:bill.body.faceMicro??intent.value,appHeight:height,appHash:root};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
 try {
  const chunks=[];
  let size=0;
  for await (const chunk of process.stdin) {
   size+=chunk.length;
   assert(size<=131072,'Receipt exceeds the size limit.');
   chunks.push(chunk);
  }
  const profile=JSON.parse(readFileSync(new URL('../../connection-profile.json',import.meta.url)));
  const result=await readInvoiceSettlement(JSON.parse(Buffer.concat(chunks)),profile,
   process.env.DUEBYTE_SETTLEMENT_SNAPSHOT,process.env.DUEBYTE_SETTLEMENT_RPC);
  process.stdout.write(JSON.stringify(result)+'\n');
 } catch (error) { console.error('Settlement verification failed:',error.message);process.exitCode=1; }
}
