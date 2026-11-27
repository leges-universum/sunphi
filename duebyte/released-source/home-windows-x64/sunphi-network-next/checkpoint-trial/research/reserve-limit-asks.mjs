import assert from 'node:assert/strict';
import {exact,hash,hex,integer} from '../crypto.mjs';
import {reserveSymbol} from './settlement-asset.mjs';
import {amount,MAX} from '../payment-model.mjs';

export function askId(configHash,maker,terms){
 return hash({domain:'DUEBYTE_RESERVE_LIMIT_ASK_V1',configHash,maker,terms});
}
const output=(configHash,id,role)=>hash({domain:'DUEBYTE_RESERVE_LIMIT_OUTPUT_V1',configHash,id,role});
const held=(owner,value)=>({owner,value:String(value),unlock:Number.MAX_SAFE_INTEGER});

export function askFundingInputs(s,owner,required){
 const eligible=Object.entries(s.money.outputs).filter(([,o])=>o.owner===owner&&o.unlock<=s.money.time)
  .sort(([a,x],[b,y])=>BigInt(x.value)===BigInt(y.value)?a.localeCompare(b):BigInt(x.value)>BigInt(y.value)?-1:1);
 const inputs=[];let sum=0n;
 for(const [id,o] of eligible){if(sum>=required||inputs.length===8)break;inputs.push(id);sum+=amount(o.value);}
 assert(sum>=required,'Insufficient available DUBYT including the execution fee.');return inputs.sort();
}
export function assertAskTerms(t,now){
 exact(t,['nonce','quantity','price','expires']);hex(t.nonce);
 assert(amount(t.quantity)>0n&&amount(t.price)>0n,'Positive quantity and limit price required.');
 integer(t.expires,now+1);assert(t.expires<=now+7*86400,'Order expiry exceeds seven days.');
}
export function applyAsk(s,b,a,author,fee){
 const cmd=a.command,time=s.money.time,asks=b.asks??={};
 if(cmd.type==='PLACE_ASK'){
  exact(cmd,['type','terms']);const id=askId(s.configHash,author,cmd.terms);
  if(asks[id])return;
  assertAskTerms(cmd.terms,time);assert(Object.keys(asks).length<32,'Isolated order capacity reached.');
  assert.equal(author,b.policy.provider,'Unregistered test market maker.');
  const quantity=amount(cmd.terms.quantity);let sum=0n;
  for(const key of a.inputs){const o=s.money.outputs[key];assert(o&&o.owner===author&&o.unlock<=time,'Unavailable ask funding.');sum+=amount(o.value);}
  assert(sum>=quantity+fee&&sum<=MAX,'Insufficient ask funding.');
  for(const key of a.inputs)delete s.money.outputs[key];
  if(sum>quantity+fee)s.money.outputs[output(s.configHash,id,'change')]={owner:author,value:String(sum-quantity-fee),unlock:0};
  s.money.outputs[output(s.configHash,id,'hold')]=held(author,quantity);
  s.money.fees=String(amount(s.money.fees)+fee);
  asks[id]={maker:author,terms:cmd.terms,height:s.height,remaining:String(quantity),allocated:'0',released:'0',closed:false};
 }else{
  exact(cmd,['type','id']);hex(cmd.id);assert.equal(a.inputs.length,0);const o=asks[cmd.id];assert(o,'Unknown sell order.');
  assert(author===o.maker||time>=o.terms.expires,'Only the owner can cancel an open order.');if(o.closed)return;
  const key=output(s.configHash,cmd.id,'hold');assert.deepEqual(s.money.outputs[key],held(o.maker,o.remaining));delete s.money.outputs[key];
  s.money.outputs[output(s.configHash,cmd.id,'released')]={owner:o.maker,value:o.remaining,unlock:0};
  o.closed=true;o.released=o.remaining;o.remaining='0';
 }
}
export function bestAsk(book,q,now){
 if(!book?.asks||q.direction!=='BUY_DUBYT'||q.asset!==reserveSymbol(book.policy))return null;
 const quantity=amount(q.dubytAtomic),gross=amount(q.externalAtomic);
 const matches=Object.entries(book.asks).filter(([,o])=>!o.closed&&o.maker===q.provider&&o.terms.expires>now
  &&amount(o.remaining)>=quantity&&gross*1000000n>=quantity*amount(o.terms.price));
 matches.sort(([a,x],[b,y])=>x.terms.price===y.terms.price?x.height-y.height||a.localeCompare(b):amount(x.terms.price)<amount(y.terms.price)?-1:1);
 return matches[0]?.[0]??null;
}
export function allocateAsk(s,b,q,id){
 hex(id);assert.equal(bestAsk(b,q,s.money.time),id,'Sell order unavailable at these terms.');
 const ask=b.asks[id],key=output(s.configHash,id,'hold'),value=amount(q.dubytAtomic);
 assert.deepEqual(s.money.outputs[key],held(ask.maker,ask.remaining));
 ask.allocated=String(amount(ask.allocated)+value);ask.remaining=String(amount(ask.remaining)-value);
 if(ask.remaining==='0'){delete s.money.outputs[key];ask.closed=true;}
 else s.money.outputs[key]=held(ask.maker,ask.remaining);
 return value;
}
export function auditAsks(s,b){
 for(const [id,o] of Object.entries(b.asks??{})){
  assert.equal(id,askId(s.configHash,o.maker,o.terms));assert.equal(o.maker,b.policy.provider);
  assert.equal(amount(o.allocated)+amount(o.remaining)+amount(o.released),amount(o.terms.quantity));
  const v=s.money.outputs[output(s.configHash,id,'hold')];
  if(o.closed){assert.equal(o.remaining,'0');assert(!v);}else assert.deepEqual(v,held(o.maker,o.remaining));
 }
}
