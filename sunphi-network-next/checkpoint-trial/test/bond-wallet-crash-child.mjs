// Synthetic keys live only in this child. Kill at the receipt write boundary.
import {DatabaseSync} from 'node:sqlite';
import {writeSync} from 'node:fs';
import {hash,keys,sign} from '../crypto.mjs';
import {WalletBond} from '../wallet-bond.mjs';
import {bondPolicy,bondBody} from '../bond-request.mjs';
const [file,phase]=process.argv.slice(2),owner=keys(),validator=keys(),worker=keys();
const db=new DatabaseSync(file);
db.exec('PRAGMA synchronous=FULL');
const flow=new WalletBond({key:owner,db});
flow.terms=async()=>({ready:true,time:12345,amount:'1'});
const template={network:'isolated',configHash:hash('test config'),node:hash('crash worker'),owner:owner.publicKey,
 workerKey:worker.publicKey,validator:validator.publicKey,bond:'1000000',policyHash:hash(bondPolicy)};
const body=bondBody(template,12345,12445);
const review=await flow.review({template,body,validatorSignature:sign(body,validator.privateKey),workerSignature:sign(body,worker.privateKey)});
function crash(){writeSync(1,'CRASH '+phase);process.kill(process.pid,'SIGKILL');}
if(phase==='before'){
 db.function('interrupt_write',crash);
 db.exec('CREATE TEMP TRIGGER interrupt_bond AFTER INSERT ON bond_receipts BEGIN SELECT interrupt_write(); END');
}
await flow.confirm({id:review.id},()=>true);
if(phase==='after')crash();
