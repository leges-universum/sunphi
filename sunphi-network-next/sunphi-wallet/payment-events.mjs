// Called only after authenticating the complete checkpoint and its state.
import {hash,need} from '../operator-registry/contract.mjs';
import {paymentDisplay} from './frontend/payment-amounts.mjs';
const key=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{43}$/.test(s);
const hex=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const amount=s=>typeof s==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(s);
export async function paymentEvents(state,checkpoint){
 const requests=Object.values(state.money.requests);need(requests.length<=512,'Notification snapshot capacity');
 const events=[];
 for(const r of requests){
  need(['RESERVED','SCHEDULED','SETTLED','EXPIRED','CANCELLED'].includes(r.status),'Unknown payment state');
  const i=r.intent;need(hex(i.pid)&&key(i.sender)&&key(i.recipient)&&amount(i.value)&&amount(i.fee)&&amount(i.abortFee),'Invalid payment fields');
  paymentDisplay(i);
  need(r.digest===await hash(i),'Invalid payment intent');
  // Internal dust accounting is not a transfer to a user. Do not let its zero
  // principal prevent delivery of unrelated user events in this snapshot.
  if(i.domain==='DUEBYTE_PROGRAM_TERMINAL_FEE_V1'&&i.value==='0'&&i.fee==='1'&&i.abortFee==='0')continue;
  need(i.value!=='0','Invalid payment intent');
  const id=await hash({domain:'DUEBYTE_PAYMENT_EVENT_V1',network:checkpoint.body.network,configHash:state.configHash,pid:i.pid,status:r.status});
  const terminal=['SETTLED','EXPIRED','CANCELLED'].includes(r.status);
  need(Number.isSafeInteger(r.terminalHeight)&&(!terminal||r.terminalHeight>0),'Invalid terminal height');
  events.push({id,network:checkpoint.body.network,configHash:state.configHash,pid:i.pid,status:r.status,sender:i.sender,recipient:i.recipient,amount:i.value,fee:i.fee,
   chargedFee:terminal?(r.status==='SETTLED'?i.fee:i.abortFee):null,
   terminalHeight:terminal?r.terminalHeight:null,executeAt:r.status==='SCHEDULED'?r.executeAt:null,
   ...(i.unitScale===undefined?{}:{unitScale:i.unitScale})});
 }
 return events.sort((a,b)=>a.id.localeCompare(b.id));
}
