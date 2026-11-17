import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {hash,keys,verify} from '../crypto.mjs';
import {bondPolicy,bondBody,checkBondRequest} from '../bond-request.mjs';
import {WalletBond} from '../wallet-bond.mjs';

const run=(module,...args)=>spawnSync(process.execPath,[fileURLToPath(new URL(module,import.meta.url)),...args],{encoding:'utf8',windowsHide:true});
function temporary(t){const dir=fs.mkdtempSync(join(tmpdir(),'duebyte-bond-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('operator signs only the reviewed template and retries the same exported files',t=>{
 const dir=temporary(t),validator=keys(),worker=keys(),owner=keys(),now=Math.floor(Date.now()/1000);
 const template={network:'lab',configHash:hash('config'),node:hash('node'),validator:validator.publicKey,workerKey:worker.publicKey,owner:owner.publicKey,bond:'1000000',policyHash:hash(bondPolicy)};
 const put=(name,data)=>fs.writeFileSync(join(dir,name),JSON.stringify(data),{mode:0o600});
 put('approved',{template});put('request',{template,body:bondBody(template,now,now+300)});
 put('validator',{pub_key:{type:'tendermint/PubKeyEd25519',value:Buffer.from(validator.publicKey,'base64url').toString('base64')},
  priv_key:{type:'tendermint/PrivKeyEd25519',value:Buffer.concat([Buffer.from(validator.privateKey,'base64url').subarray(-32),Buffer.from(validator.publicKey,'base64url')]).toString('base64')}});
 put('worker',{node:template.node,...worker});
 const operator=(role,from,to)=>run('../bond-operator.mjs',role,...['approved',from,role,to].map(n=>join(dir,n)));
 for(let i=0;i<2;i++){const r=operator('validator','request','first');assert.equal(r.status,0,r.stderr);}
 for(let i=0;i<2;i++){const r=operator('worker','first','second');assert.equal(r.status,0,r.stderr);}
 const packet=JSON.parse(fs.readFileSync(join(dir,'second')));checkBondRequest(packet,now,['validator','worker']);
 put('approved',{template:{...template,bond:'1000001'}});
 assert.notEqual(operator('validator','request','rejected').status,0);assert(!fs.existsSync(join(dir,'rejected')));
});
for(const phase of ['before','after'])test('wallet killed '+phase+' receipt commit',t=>{
 const dbFile=join(temporary(t),'wallet.sqlite'),child=run('./bond-wallet-crash-child.mjs',dbFile,phase);
 assert(child.signal || child.status!==0);assert.equal(child.stdout,'CRASH '+phase,child.stderr);
 const db=new DatabaseSync(dbFile);try{
  const flow=new WalletBond({db}),receipt=flow.saved(hash('crash worker'));
  if(phase==='before')assert.equal(receipt,null);
  else{
   assert.equal(receipt.type,'BIND_CONSENSUS_BOND_V1');
   assert(verify(receipt.consent.body,receipt.consent.ownerSignature,receipt.consent.body.owner));
   assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bond_receipts').get().n,1);
  }
 }finally{db.close();}
});
