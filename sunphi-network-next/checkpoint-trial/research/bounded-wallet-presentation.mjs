import {reserveStatement} from './network-reserve.mjs';
import {openValidatorsActive,OPEN_VALIDATOR_POLICY,validatorFactorBps} from './open-validator-policy.mjs';
import {isBoundedWalletView} from './bounded-wallet-view.mjs';
import {monetaryAnalytics,displayAmounts} from '../wallet-amounts.mjs';
import {intentUnits,unitScale} from '../token-units.mjs';

// The certified event journal is append-only. Its terminal transitions count
// payments once, independently of how many wallets participated in them.
export async function advanceNetworkTotals(read,scale,previous){
 const cursor=previous?.scale===scale?{...previous}:{scale,offset:0,settled:0,volume:'0'};
 for(let n=0;n<4;n++){
  const page=await read({type:'payment-events',id:{offset:cursor.offset,limit:8}});
  for(const {value:event} of page.items){
   if(event.status==='SETTLED'){
    cursor.settled++;
    cursor.volume=String(BigInt(cursor.volume)+BigInt(intentUnits(event.intent,event.intent.value,scale)));
   }
  }
  cursor.offset+=page.items.length;
  if(cursor.offset===page.total)return {cursor,totals:{settled:cursor.settled,volume:cursor.volume}};
 }
 return {cursor,totals:{}};
}

export function walletAnalytics(v,totals={}){
 const m=v.state.money,requests=Object.values(m.requests),indexed=isBoundedWalletView(v.state),scale=String(unitScale(v.state));
 const reserve=reserveStatement(v.state.rewards?.calendarService);
 const calendar=v.state.rewards?.calendarService,changes=calendar?.closedFund?.annualChanges??[];
 const validatorPolicy=openValidatorsActive(calendar)
  ?{...OPEN_VALIDATOR_POLICY,activeTarget:calendar.closedFund.expansion?.target??OPEN_VALIDATOR_POLICY.firstTarget,changes,currentFactorBps:validatorFactorBps(m.time,changes)}:null;
 return {...(reserve?{networkReserve:{...displayAmounts(Object.fromEntries(Object.entries(reserve).filter(([key])=>key.endsWith('Micro'))),'1000000'),...(reserve.mode==='CLOSED'?{mode:reserve.mode,preparedHeight:reserve.preparedHeight}:{}),...(validatorPolicy?{validatorPolicy}:{}),...(reserve.credit?{credit:displayAmounts(reserve.credit,'1000000')}:{})}}:{}),scope:indexed?'owner':'retained-network',height:v.certificate.height,appHeight:v.state.height,blockHash:v.certificate.blockHash,checkpoint:v.checkpointId,
  ...(indexed?{unitScale:scale,supply:m.supply,volume:totals.volume??null,display:displayAmounts({supply:m.supply,volume:totals.volume??null},scale)}:monetaryAnalytics(v.state)),
  outputs:Object.keys(m.outputs).length,settled:indexed?(totals.settled??null):requests.filter(r=>r.status==='SETTLED').length,
  reserved:requests.filter(r=>r.status==='RESERVED').length};
}
