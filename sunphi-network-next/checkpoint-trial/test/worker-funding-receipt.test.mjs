import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {writeFundingReceipt} from '../worker-funding-operator.mjs';

function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'duebyte-funding-receipt-'));
 const output=path.join(dir,'handoff.json'),receipt={format:'ISOLATED_RECEIPT',status:'SIGNED_NOT_SUBMITTED',submitted:false};
 return {dir,output,receipt,clean(){assert(path.basename(dir).startsWith('duebyte-funding-receipt-'));fs.rmSync(dir,{recursive:true,force:true});}};
}
test('funding receipt: partial write and sync failure never expose a final handoff',()=>{
 const f=fixture();try{
  for(const fault of ['write','sync']){
   const io={...fs,...(fault==='write'?{writeFileSync(fd){fs.writeSync(fd,'{"incomplete":');throw new Error('ENOSPC fixture');}}:{fsyncSync(){throw new Error('EIO fixture');}})};
   assert.throws(()=>writeFundingReceipt(f.output,f.receipt,io),/fixture/);
   assert(!fs.existsSync(f.output));assert.deepEqual(fs.readdirSync(f.dir),[]);
  }
  writeFundingReceipt(f.output,f.receipt);assert.deepEqual(JSON.parse(fs.readFileSync(f.output)),f.receipt);
  assert.throws(()=>writeFundingReceipt(f.output,{changed:true}),/output already exists/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.output)),f.receipt);
 }finally{f.clean();}
});
test('funding receipt: concurrent output and unsupported publication never overwrite evidence',()=>{
 const f=fixture();try{
  assert.throws(()=>writeFundingReceipt(f.output,f.receipt,{...fs,linkSync(){throw new Error('unsupported publication');}}),/unsupported/);
  assert.deepEqual(fs.readdirSync(f.dir),[]);
  const existing='other operator receipt';
  assert.throws(()=>writeFundingReceipt(f.output,f.receipt,{...fs,linkSync(a,b){fs.writeFileSync(b,existing,{flag:'wx'});fs.linkSync(a,b);}}),/EEXIST/);
  assert.equal(fs.readFileSync(f.output,'utf8'),existing);assert.deepEqual(fs.readdirSync(f.dir),['handoff.json']);
 }finally{f.clean();}
});
test('funding receipt: interruption after publication retains complete evidence',()=>{
 const f=fixture();try{
  assert.throws(()=>writeFundingReceipt(f.output,f.receipt,{...fs,unlinkSync(){throw new Error('interrupted cleanup');}}),/interrupted/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.output)),f.receipt);
  const partial=fs.readdirSync(f.dir).find(n=>n.endsWith('.partial'));assert(partial);
  assert.deepEqual(fs.readFileSync(path.join(f.dir,partial)),fs.readFileSync(f.output));
  assert.throws(()=>writeFundingReceipt(f.output,f.receipt),/output already exists/);
 }finally{f.clean();}
});
