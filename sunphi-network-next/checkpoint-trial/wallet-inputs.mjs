import {paymentInputLimit} from './payment-input-policy.mjs';
import {formatToken} from './token-units.mjs';
export class WalletPreparationError extends Error{constructor(message,code='PAYMENT_NOT_CREATED'){super(message);this.name='WalletPreparationError';this.code=code;this.paymentOutcome='not_created';}}
export function selectWalletInputs(state,owner,need){
 const money=state.money,limit=paymentInputLimit(state),rows=Object.entries(money.outputs).filter(([,o])=>o.owner===owner&&o.unlock<=money.time&&BigInt(o.value)>0n);
 rows.sort(([a,x],[b,y])=>BigInt(x.value)===BigInt(y.value)?(a<b?-1:a>b?1:0):BigInt(x.value)>BigInt(y.value)?-1:1);
 const available=rows.reduce((n,[,o])=>n+BigInt(o.value),0n),scale=String(money.unitScale??'1');
 if(available<need)throw new WalletPreparationError('Available: '+formatToken(String(available),scale)+' DUBYT. The amount and fee require '+formatToken(String(need),scale)+' DUBYT.','INSUFFICIENT_FUNDS');
 const inputs=[];let total=0n;for(const [id,o]of rows){if(inputs.length===limit||total>=need)break;inputs.push(id);total+=BigInt(o.value);}
 if(total<need)throw new WalletPreparationError('Your balance is sufficient, but its accumulated receipts exceed the currently activated payment capacity. No funds were deducted.','PAYMENT_INPUT_CAPACITY');
 return {inputs,total,available,limit};
}
