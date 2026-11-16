// Conditional exchange admission is genesis-pinned and isolated-only.
import assert from 'node:assert/strict';
import {exact,hash,hex} from '../crypto.mjs';
import {amount,MAX} from '../payment-model.mjs';
import {spendPolicy} from '../spend-protection.mjs';
import {centuryRestrictedAccounts} from '../century-funds.mjs';
import {centuryWarmupAccounts,memorialPolicy} from '../economic-policy-v3.mjs';
import {reserveAddresses} from '../network-reserves.mjs';
import {supportAccount} from '../support-accounting.mjs';
import {exchangePolicy,exchangeGenesis,applyExchange,auditExchange} from './exchange-escrow.mjs';
export const EXCHANGE_ACTION='EXECUTE_EXCHANGE_LAB_V1';
export const exchangeOutput=(configHash,id,role)=>hash({domain:EXCHANGE_ACTION,configHash,id,role});
export function checkExchangeConfig(c){
 if(!c.exchangeLab)return;
 exact(c.exchangeLab,['policy','feeMicro']);exchangePolicy(c.exchangeLab.policy);
 assert.equal(c.trialOnly,true);assert(/^duebyte-trial-exchange-lab-[a-z0-9-]+$/.test(c.chainId),'isolated exchange chain only');
 assert.equal(c.exchangeLab.policy.chain,c.chainId.replace('duebyte-trial-','duebyte-'));
 assert(amount(c.exchangeLab.feeMicro)>0n,'explicit exchange fee required');
}
const payer=q=>q.direction==='BUY_DUBYT'?q.provider:q.user;
export function auditNativeExchange(s,c){
 if(!s.exchangeBook)return;
 assert(c.exchangeLab,'exchange state without admission');checkExchangeConfig(c);
 const b=s.exchangeBook;auditExchange(b);assert.deepEqual(b.policy,c.exchangeLab.policy);
 assert(Object.values(b.balances).every(v=>v==='0'),'undrained native exchange balance');
 for(const [id,o]of Object.entries(b.orders)){
  const held=s.money.outputs[exchangeOutput(s.configHash,id,'escrow')];
  if(o.status==='LOCKED')assert.deepEqual(held,{owner:payer(o.quote),value:o.quote.dubytAtomic,unlock:Number.MAX_SAFE_INTEGER},'exchange backing');
  else assert(!held,'terminal exchange escrow retained');
 }
}
export function executeNativeExchange(s,a,author,c){
 assert(c.exchangeLab,'two-way exchange admission disabled');checkExchangeConfig(c);
 exact(a,['type','command','inputs']);assert.equal(a.type,EXCHANGE_ACTION);
 assert.equal(s.money.unitScale,'1000000','fractional denomination required');
 assert(Array.isArray(a.inputs)&&a.inputs.length<=8);a.inputs.forEach(hex);
 assert.deepEqual(a.inputs,[...new Set(a.inputs)].sort(),'canonical exchange inputs');
 const p=c.exchangeLab.policy,cmd=a.command,id=cmd.type==='LOCK'?hash(cmd.quote):cmd.id;hex(id);
 let b=structuredClone(s.exchangeBook??exchangeGenesis(p,{}));const prior=b.orders[id];
 const escrow=exchangeOutput(s.configHash,id,'escrow');
 if(cmd.type==='LOCK'){
  const owner=payer(cmd.quote);assert.equal(author,owner,'DUBYT payer signs native funding');
  assert(![...centuryRestrictedAccounts(s.configHash),...centuryWarmupAccounts(s.configHash),memorialPolicy(s.configHash).account,...Object.values(reserveAddresses(s.configHash)),supportAccount(s.configHash)].includes(owner),'programme funds cannot fund exchange');
  const protection=spendPolicy(s,owner);assert(!protection?.enabled&&!protection?.pending,'protected payer requires separate exchange consent');
  if(prior)b=applyExchange(b,cmd,s.money.time);
  else{
   assert(a.inputs.length>0);const value=amount(cmd.quote.dubytAtomic),fee=amount(c.exchangeLab.feeMicro);let total=0n;
   for(const input of a.inputs){const o=s.money.outputs[input];assert(o&&o.owner===owner,'missing or foreign exchange funding');assert(o.unlock<=s.money.time,'locked exchange funding');total+=amount(o.value);}
   assert(total>=value+fee&&total<=MAX,'exchange inventory and fee unavailable');
   const change=exchangeOutput(s.configHash,id,'change');assert(!s.money.outputs[escrow]&&!s.money.outputs[change],'exchange output collision');
   b.balances[owner]=String(value);b.total=String(amount(b.total)+value);b=applyExchange(b,cmd,s.money.time);
   for(const input of a.inputs)delete s.money.outputs[input];
   s.money.outputs[escrow]={owner,value:String(value),unlock:Number.MAX_SAFE_INTEGER};
   if(total>value+fee)s.money.outputs[change]={owner,value:String(total-value-fee),unlock:0};
   s.money.fees=String(amount(s.money.fees)+fee);
  }
 }else{
  assert.equal(a.inputs.length,0);assert(prior,'unknown native exchange');
  assert([prior.quote.user,p.provider,...p.observers].includes(author),'exchange participant or observer required');
  b=applyExchange(b,cmd,s.money.time);
  for(const [owner,value]of Object.entries(b.balances))if(value!=='0'){
   const held=s.money.outputs[escrow];assert.deepEqual(held,{owner:payer(prior.quote),value,unlock:Number.MAX_SAFE_INTEGER},'exchange backing required');
   const output=exchangeOutput(s.configHash,id,'settlement');assert(!s.money.outputs[output],'exchange already settled');
   delete s.money.outputs[escrow];s.money.outputs[output]={owner,value,unlock:0};b.balances[owner]='0';b.total=String(amount(b.total)-amount(value));
  }
 }
 s.exchangeBook=b;auditNativeExchange(s,c);return s;
}
