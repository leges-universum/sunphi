import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, unlink, rmdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { NETWORK, newKey, identity, digest, canonical, signRecord } from './crypto.mjs';
import { createVault, unlock, seal, validateVault } from './vault.mjs';
import { makeReservation, makeReceipt, checkTransfer, checkReceiptPackage, candidateMain, checkMain } from './protocol.mjs';
import { LabLedger, labState, demo } from './lab-ledger.mjs';
import { readRecord, writeNew } from './files.mjs';
import { prompt } from './prompt.mjs';

const password='laboratory-only password example';
const clone=structuredClone;
function setup() {
  const a=newKey(),b=newKey(),c=newKey();
  const ledger=new LabLedger(identity(a).address,1000);
  const transfer=makeReservation(a,ledger.state,identity(b).address,1000,10000);
  return {a,b,c,ledger,transfer};
}
test('encrypted backup round trip and password change preserve identity',async()=>{
  const vault=await createVault(password),key=await unlock(vault,password);
  assert.equal(identity(key).address,vault.header.address);
  assert.equal(JSON.stringify(vault).includes(key.export({format:'der',type:'pkcs8'}).toString('base64')),false);
  const copy=JSON.parse(JSON.stringify(vault));
  assert.equal(identity(await unlock(copy,password)).address,vault.header.address);
  const changed=await seal(key,password+' changed');
  assert.notEqual(changed.header.iv,vault.header.iv);assert.notEqual(changed.header.salt,vault.header.salt);
  assert.equal(identity(await unlock(changed,password+' changed')).address,vault.header.address);
  await assert.rejects(unlock(changed,password),/Wrong password/);
});
test('wrong password, ciphertext and authenticated header changes cannot unlock',async()=>{
  const vault=await createVault(password);
  await assert.rejects(unlock(vault,'another password entirely'),/Wrong password/);
  for(const field of ['ciphertext','tag']) {
    const changed=clone(vault),buf=Buffer.from(changed[field],'base64');buf[0]^=1;changed[field]=buf.toString('base64');
    await assert.rejects(unlock(changed,password),/Wrong password/);
  }
  const changed=clone(vault);
  Object.assign(changed.header,identity(newKey()));
  await assert.rejects(unlock(changed,password),/Wrong password/);
});
test('fixed KDF bounds, strict encoding and weak-password rejection',async()=>{
  await assert.rejects(createVault('short'),/12/);
  const vault=await createVault(password);
  for(const n of [2,1073741824]) {
    const bad=clone(vault);bad.header.kdf.N=n;
    assert.throws(()=>validateVault(bad),/Unsupported/);
  }
  const bad=clone(vault);bad.ciphertext+=' ';assert.throws(()=>validateVault(bad),/encoding/);
  bad.ciphertext=vault.ciphertext;bad.extra=true;assert.throws(()=>validateVault(bad),/fields/);
});
test('canonical representation is stable and rejects ambiguous numeric values',()=>{
  assert.equal(canonical({b:1,a:'x'}),canonical({a:'x',b:1}));
  for(const v of [NaN,Infinity,-0,-1,0.5,undefined])assert.throws(()=>canonical(v));
});
test('two signatures produce only a candidate until independent lab acceptance',()=>{
  const {b,ledger,transfer}=setup(),before=ledger.state;
  ledger.reserve(transfer);
  assert.equal(digest(ledger.state),digest(before));
  assert.equal(ledger.status,'reserved');
  const receipt=makeReceipt(b,transfer,2000),candidate=candidateMain(receipt);
  assert.equal(ledger.state.owner,before.owner);
  assert.equal(candidate.owner,identity(b).address);
  ledger.advance(2000);assert.equal(ledger.credit(receipt),'credited');
  assert.equal(ledger.state.owner,identity(b).address);
  assert.notEqual(digest(ledger.state),digest(before));
  assert.equal(ledger.credit(receipt),'credited');
  assert.equal(ledger.state.revision,1);
});
test('copied public state cannot be signed by an unrelated wallet',()=>{
  const {c,ledger,transfer}=setup();
  assert.throws(()=>makeReservation(c,ledger.state,identity(newKey()).address,1000),/owner/);
  assert.throws(()=>makeReceipt(c,transfer,2000),/recipient/);
});
test('changed recipient, time, main hash, network and signature are rejected',()=>{
  const {b,c,transfer}=setup();
  for(const [field,value] of [['recipient',identity(c).address],['sentAt',1001],['mainHash','a'.repeat(64)],['network','sunphi-mainnet']]){
    const bad=clone(transfer);bad.reservation.payload[field]=value;
    assert.throws(()=>checkTransfer(bad));
  }
  const bad=clone(transfer);bad.main.owner=identity(c).address;assert.throws(()=>checkTransfer(bad));
  const receipt=makeReceipt(b,transfer,2000);
  receipt.receipt.payload.receivedAt++;assert.throws(()=>checkReceiptPackage(receipt));
});
test('a valid signature cannot move a receipt to another reservation',()=>{
  const {a,b,ledger,transfer}=setup();
  const second=makeReservation(a,ledger.state,identity(b).address,1000,10000);
  const receipt=makeReceipt(b,transfer,2000);receipt.transfer=second;
  assert.throws(()=>checkReceiptPackage(receipt),/match/);
});
test('strict signing domain and record schema reject arbitrary operations',()=>{
  const {a,transfer}=setup();
  assert.throws(()=>signRecord(a,{network:'bitcoin',kind:'reservation'}),/domain/);
  assert.throws(()=>signRecord(a,{network:NETWORK,kind:'withdraw'}),/domain/);
  const bad=clone(transfer);bad.reservation.payload.amount=999;
  bad.reservation=signRecord(a,bad.reservation.payload);assert.throws(()=>checkTransfer(bad),/fields/);
});
test('two genuine conflicting signatures cannot both reserve in the serial arbiter',()=>{
  const {a,b,c,ledger,transfer}=setup();
  const other=makeReservation(a,ledger.state,identity(c).address,1000,10000);
  ledger.reserve(transfer);assert.equal(ledger.reserve(transfer),'reserved');
  assert.throws(()=>ledger.reserve(other),/not accepted/);
  ledger.advance(2000);ledger.credit(makeReceipt(b,transfer,2000));
  assert.throws(()=>ledger.reserve(other),/not accepted/);
});
test('expiry requires resolution; delayed receipt and cancelled ID cannot revive credit',()=>{
  const {b,ledger,transfer}=setup();
  ledger.reserve(transfer);const receipt=makeReceipt(b,transfer,2000);
  assert.throws(()=>ledger.cancel(transfer.reservation.payload.transferId),/not accepted/);
  ledger.advance(11000);assert.equal(ledger.status,'reserved');
  assert.throws(()=>ledger.credit(receipt),/not accepted/);
  ledger.cancel(transfer.reservation.payload.transferId);
  assert.equal(ledger.status,'owned');
  assert.throws(()=>ledger.credit(receipt),/resolved/);
  assert.throws(()=>ledger.reserve(transfer),/not accepted/);
});
test('lost acknowledgement does not permit cancellation after credit',()=>{
  const {b,ledger,transfer}=setup();ledger.reserve(transfer);ledger.advance(2000);
  ledger.credit(makeReceipt(b,transfer,2000));ledger.advance(12000);
  assert.throws(()=>ledger.cancel(transfer.reservation.payload.transferId));
  assert.equal(ledger.state.owner,identity(b).address);
});
test('future/backward clocks and receipt at expiry fail',()=>{
  const {a,b,ledger,transfer}=setup();
  assert.throws(()=>makeReceipt(b,transfer,999));
  assert.throws(()=>makeReceipt(b,transfer,11000));
  assert.throws(()=>ledger.advance(999));
  assert.throws(()=>ledger.reserve(makeReservation(a,ledger.state,identity(b).address,2000)));
  ledger.reserve(transfer);
  assert.throws(()=>ledger.credit(makeReceipt(b,transfer,2000)),/not accepted/);
});
test('last ten signed transfers survive repeated ownership changes without recursive growth',()=>{
  const a=newKey(),b=newKey(),ledger=new LabLedger(identity(a).address,0);
  for(let i=0;i<12;i++){
    const sender=i%2?b:a,recipient=i%2?a:b,now=1000*(i+1);
    ledger.advance(now);
    const transfer=makeReservation(sender,ledger.state,identity(recipient).address,now,500);
    ledger.reserve(transfer);ledger.advance(now+1);ledger.credit(makeReceipt(recipient,transfer,now+1));
  }
  const state=ledger.state;checkMain(state);
  assert.equal(state.revision,12);assert.equal(state.history.length,10);
  assert.ok(Buffer.byteLength(canonical(state))<30000);
  state.history[9].receipt.payload.receivedAt++;assert.throws(()=>checkMain(state));
  assert.equal(ledger.state.revision,12);
});
test('wallet files are exclusive, bounded, canonical and preserve original backups',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sunphi-wallet-test-'));
  const one=join(dir,'one.json'),two=join(dir,'two.json');
  try{
    await writeNew(one,{a:1});await assert.rejects(writeNew(one,{a:2}),{code:'EEXIST'});
    assert.deepEqual(await readRecord(one),{a:1});
    await writeFile(two,'{"a":1,"a":2}');await assert.rejects(readRecord(two),/canonical/);
    await writeFile(two,' '.repeat(128*1024+1));await assert.rejects(readRecord(two),/128/);
    assert.equal((await readFile(one,'utf8')).trim(),'{"a":1}');
  }finally{await unlink(one).catch(()=>{});await unlink(two).catch(()=>{});await rmdir(dir);}
});
test('secret prompt never echoes input and restores terminal state',async()=>{
  const input=new EventEmitter();input.isTTY=true;input.isRaw=false;
  input.setRawMode=v=>{input.isRaw=v;};input.resume=()=>{};input.pause=()=>{};
  input.readableEncoding='utf8';
  let outputText='';const output={isTTY:true,write:v=>{outputText+=v;}};
  const result=prompt('Password: ',{secret:true,input,output});
  input.emit('keypress','test-only-secret',{name:'t'});
  input.emit('keypress','',{name:'return'});
  assert.equal(await result,'test-only-secret');assert.equal(outputText,'Password: \n');assert.equal(input.isRaw,false);
});
test('CLI rejects piped password entry, unknown commands and private-key export options',()=>{
  const cli=resolve('wallet/cli.mjs');
  for(const args of [['create','--wallet','unused.json'],['export-private-key'],['create','--wallet','unused.json','--password','not-allowed']]){
    const result=spawnSync(process.execPath,[cli,...args],{input:'not-a-real-password\n',encoding:'utf8'});
    assert.equal(result.status,1);assert.equal((result.stdout+result.stderr).includes('not-a-real-password'),false);
  }
  const run=spawnSync(process.execPath,[cli,'demo'],{encoding:'utf8'});
  assert.equal(run.status,0);assert.equal(JSON.parse(run.stdout).recipientCredited,true);
  assert.equal(demo().receiptSignatureAloneDoesNotCredit,true);
});
