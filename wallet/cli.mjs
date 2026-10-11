#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createVault, unlock, validateVault, seal } from './vault.mjs';
import { readRecord, writeNew } from './files.mjs';
import { identity, digest } from './crypto.mjs';
import { checkMain, makeReservation, makeReceipt, checkTransfer, checkReceiptPackage } from './protocol.mjs';
import { labState, demo } from './lab-ledger.mjs';
import { prompt } from './prompt.mjs';

const HELP=`SunPhi Wallet 0.1 — local laboratory wallet (Node.js 24+)
No real tokens, network connection, banking or reserve custody.

node wallet/cli.mjs create --wallet <new.sunphi-wallet.json>
node wallet/cli.mjs address --wallet <file>
node wallet/cli.mjs backup --wallet <file> --out <new.sunphi-wallet.json>
node wallet/cli.mjs restore --wallet <backup> --out <new.sunphi-wallet.json>
node wallet/cli.mjs rekey --wallet <file> --out <new.sunphi-wallet.json>
node wallet/cli.mjs lab-state --to <lab-address> --out <state.json>
node wallet/cli.mjs reserve --wallet <file> --state <state.json> --to <lab-address> --out <transfer.json>
node wallet/cli.mjs receive --wallet <file> --transfer <transfer.json> --out <receipt.json>
node wallet/cli.mjs verify --file <transfer-or-receipt.json>
node wallet/cli.mjs demo

All output files must be new. Keep encrypted wallet backups outside this repository.
Passwords are entered invisibly in an interactive terminal. Lost password = no recovery.
Reserve/receive sign offline candidates only; they do not establish network acceptance.
One whole laboratory token per operation. BTC/USDC and hardware wallets are not supported.`;
const fields={create:['wallet'],address:['wallet'],backup:['wallet','out'],restore:['wallet','out'],
  rekey:['wallet','out'],'lab-state':['to','out'],reserve:['wallet','state','to','out'],receive:['wallet','transfer','out'],verify:['file'],demo:[]};
async function newPassword() {
  const first=await prompt('New password (12+ characters): ',{secret:true});
  const second=await prompt('Repeat password: ',{secret:true});
  if(first!==second)throw Error('Passwords do not match');return first;
}
async function opened(path) {
  const vault=await readRecord(path);validateVault(vault);
  const key=await unlock(vault,await prompt('Wallet password: ',{secret:true}));
  return {vault,key};
}
async function confirm() { if(await prompt('Type SIGN to approve this laboratory operation: ')!=='SIGN')throw Error('Not signed'); }
export async function main(argv=process.argv.slice(2)) {
  const command=argv[0];
  if(!command||command==='help'||command==='--help'){console.log(HELP);return;}
  if(!Object.hasOwn(fields,command))throw Error('Unknown command; use help');
  const {values,positionals}=parseArgs({args:argv.slice(1),allowPositionals:false,
    options:Object.fromEntries(fields[command].map(name=>[name,{type:'string'}]))});
  if(positionals.length||fields[command].some(k=>!values[k]))throw Error('Missing option; use help');
  if(command==='demo'){console.log(JSON.stringify(demo(),null,2));return;}
  if(command==='create'){
    const vault=await createVault(await newPassword());await writeNew(values.wallet,vault);
    console.log('Encrypted laboratory wallet created. Public address:',vault.header.address);return;
  }
  if(command==='address'){
    const v=await readRecord(values.wallet);validateVault(v);
    console.log(v.header.address);console.log('Public header only; use backup or unlock to authenticate the encrypted file.');return;
  }
  if(['backup','restore','rekey'].includes(command)){
    const {vault,key}=await opened(values.wallet);
    const output=command==='rekey'?await seal(key,await newPassword()):vault;
    await writeNew(values.out,output);
    console.log('Verified encrypted copy saved; original preserved. Address:',identity(key).address);
    if(command==='rekey')console.log('Old backups still unlock with their old password.');return;
  }
  if(command==='lab-state'){
    await writeNew(values.out,labState(values.to));
    console.log('Unaccepted laboratory fixture created. It is not an issued token or balance.');return;
  }
  if(command==='verify'){
    const pkg=await readRecord(values.file);
    const p=pkg.format==='sunphi-transfer-v1'?checkTransfer(pkg):checkReceiptPackage(pkg);
    console.log(JSON.stringify({validSignatures:true,network:p.network,tokenId:p.tokenId,sender:p.sender,recipient:p.recipient,transferId:p.transferId,acceptedState:'unknown — requires network acceptance'},null,2));return;
  }
  if(command==='reserve'){
    const state=checkMain(await readRecord(values.state));
    console.log(JSON.stringify({operation:'reserve one laboratory token',tokenId:state.tokenId,
      sender:state.owner,recipient:values.to,mainHash:digest(state),expiresAfterSeconds:300,
      acceptedState:'unknown; offline snapshot'},null,2));
    await confirm();const {key}=await opened(values.wallet);
    await writeNew(values.out,makeReservation(key,state,values.to));
    console.log('Signed reservation candidate saved. No network reservation or debit occurred.');return;
  }
  const transfer=await readRecord(values.transfer),r=checkTransfer(transfer);
  console.log(JSON.stringify({operation:'acknowledge one laboratory token',tokenId:r.tokenId,sender:r.sender,
    recipient:r.recipient,transferId:r.transferId,expiresAt:r.expiresAt,acceptedState:'unknown; offline package'},null,2));
  await confirm();const {key}=await opened(values.wallet);
  await writeNew(values.out,makeReceipt(key,transfer));
  console.log('Recipient signature saved. This is not an accepted credit or spendable balance.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main().catch(error=>{
    // Do not print arbitrary parser text, file contents, passwords or stack traces.
    const safe=error.code==='EEXIST'?'Output already exists; original preserved':
      error.code==='ENOENT'?'Input file or output directory does not exist':
      error instanceof SyntaxError?'Invalid JSON input':
      error.code?.startsWith('ERR_PARSE_ARGS')?'Invalid command options; use help':error.message;
    console.error(safe);process.exitCode=1;
  });
}
