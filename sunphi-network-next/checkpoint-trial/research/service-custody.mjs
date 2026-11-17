// Existing warmup outputs -> existing reward payable custody. No new account,
// ordinary-transfer exception, mint, or caller-supplied payout destination.
import assert from 'node:assert/strict';
import {exact,hash,hex,integer} from '../crypto.mjs';
import {amount} from '../payment-model.mjs';
import {ownedOutputs} from '../controller-context.mjs';
export const SERVICE_CUSTODY='DUEBYTE_PREISSUED_SERVICE_CUSTODY_V1';
export function auditServiceCustody(book){
 const f=book?.serviceFunding;if(!f)return;
 exact(f,['version','reservedMicro','spentMicro','sequence']);assert.equal(f.version,SERVICE_CUSTODY);
 amount(f.reservedMicro);amount(f.spentMicro);integer(f.sequence);
 assert(amount(f.reservedMicro)+amount(f.spentMicro)<=amount(book.fundedMicro),'service source limit');
}
export function serviceFundingAvailable(book,money){
 auditServiceCustody(book);
 const custody=book.accounts.flatMap(owner=>ownedOutputs(money,owner))
  .filter(([,o])=>o.unlock<=money.time).reduce((n,[,o])=>n+amount(o.value),0n);
 const reserved=amount(book.serviceFunding?.reservedMicro??'0')+amount(book.controller.reservedMicro);
 return custody>reserved?custody-reserved:0n;
}
export function reserveServiceCustody(s,valueMicro){
 const b=s.centuryWarmup;assert(b&&s.rewards&&s.centuryFees,'existing funded custody and reward ledger required');
 const value=amount(valueMicro);assert(value>0n&&value<=serviceFundingAvailable(b,s.money),'insufficient unreserved service custody');
 assert(!s.centurySubsidy,'preissued pilot source only');
 b.serviceFunding??={version:SERVICE_CUSTODY,reservedMicro:'0',spentMicro:'0',sequence:0};
 s.rewards.preissuedServiceMicro??='0';
 assert.equal(s.rewards.preissuedServiceMicro,b.serviceFunding.spentMicro,'funded reward source binding');
 b.serviceFunding.reservedMicro=String(amount(b.serviceFunding.reservedMicro)+value);
 auditServiceCustody(b);
}
// Called only by the authenticated, frozen work allocator in the SAME monetary
// transaction. This is deliberately not a public action accepting credit rows.
export function creditServiceCustody(s,rows,sumMicro){
 const b=s.centuryWarmup,f=b?.serviceFunding;assert(f&&s.rewards,'reserved service custody required');auditServiceCustody(b);
 assert(Array.isArray(rows)&&rows.length>0&&rows.length<=32,'bounded service credit page');
 let sum=0n,last='';for(const row of rows){exact(row,['node','valueMicro']);hex(row.node);assert(row.node>last,'canonical unique service recipients');last=row.node;
  assert(s.rewards.nodes[row.node],'registered reward account required');sum+=amount(row.valueMicro);}
 assert.equal(sum,amount(sumMicro),'service credit total');assert(sum<=amount(f.reservedMicro),'unbacked service credit');
 assert.equal(s.rewards.preissuedServiceMicro,f.spentMicro,'funded reward source binding');
 const sequence=integer(f.sequence+1,1),change=hash({domain:SERVICE_CUSTODY,configHash:s.configHash,sequence,rows});
 assert(!s.money.outputs[change],'service custody output collision');
 const entries=b.accounts.flatMap(owner=>ownedOutputs(s.money,owner)).filter(([,o])=>o.unlock<=s.money.time&&amount(o.value)>0n).sort(([a],[b])=>a<b?-1:1);
 let total=0n;const inputs=[];for(const [id,o]of entries){if(total>=sum)break;inputs.push(id);total+=amount(o.value);}
 assert(total>=sum,'service custody held in another obligation');
 // Preflight every amount before any mutation; outer monetary transaction still
 // supplies atomic rollback if the process exits before COMMIT.
 const nextEarned=rows.map(r=>[r.node,String(amount(s.rewards.nodes[r.node].earned)+amount(r.valueMicro))]);
 nextEarned.forEach(([,value])=>amount(value));const fees=String(amount(s.money.fees)+sum);amount(fees);
 const spent=String(amount(f.spentMicro)+sum);amount(spent);
 for(const id of inputs)delete s.money.outputs[id];
 if(total>sum)s.money.outputs[change]={owner:b.accounts[0],value:String(total-sum),unlock:0};
 for(const [node,earned]of nextEarned)s.rewards.nodes[node].earned=earned;
 // `money.fees` is the existing aggregate payable custody. `collected` remains
 // actual fees; the separate source counter prevents misreporting old tokens as
 // either fees or emission. Existing payout consent and earned/paid queue apply.
 s.money.fees=fees;s.rewards.preissuedServiceMicro=spent;
 f.spentMicro=spent;f.reservedMicro=String(amount(f.reservedMicro)-sum);f.sequence=sequence;
 auditServiceCustody(b);
}
