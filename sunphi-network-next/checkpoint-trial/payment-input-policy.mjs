// Share the existing 64-transactions x 8-inputs work envelope across payments.
// The legacy policy/hash remains immutable. New intents opt in after quorum activation.
import assert from 'node:assert/strict';
export const INPUT_FEATURE='DUEBYTE_SHARED_PAYMENT_INPUTS_V1';
export const INPUT_ACTION='ENABLE_SHARED_PAYMENT_INPUTS_V1';
export const LEGACY_INPUTS=8;
export const BLOCK_INPUTS=64*LEGACY_INPUTS;
export const sharedInputsEnabled=s=>!!s.authority?.sharedPaymentInputs&&s.height>=s.authority.sharedPaymentInputs.activation;
export const paymentInputLimit=s=>sharedInputsEnabled(s)?BLOCK_INPUTS:LEGACY_INPUTS;
export function intentInputLimit(i){if(!Object.hasOwn(i,'inputPolicy'))return LEGACY_INPUTS;assert.equal(i.inputPolicy,INPUT_FEATURE,'unsupported payment input policy');assert(['DUEBYTE_TRANSITION_MODEL_V1/INTENT','DUEBYTE_SCHEDULED_PAYMENT_V1'].includes(i.domain),'input policy payment domain');return BLOCK_INPUTS;}
export function checkInputCapability(s,i){if(Object.hasOwn(i,'inputPolicy')){intentInputLimit(i);assert(sharedInputsEnabled(s),'Shared payment inputs are not activated.');}}
export function inputBudget(){let used=0;return {consume(s,action){
 if(!sharedInputsEnabled(s))return;
 // Every other action retains its original eight-input work allowance. This
 // includes collateral, exchange/purchase funding and programme reservations;
 // they cannot be combined with an expanded payment to bypass the block cap.
 const n=['RESERVE','SCHEDULE_PAYMENT_V1'].includes(action?.type)?action.signed?.intent?.inputs?.length:LEGACY_INPUTS;
 assert(Number.isSafeInteger(n)&&n>0&&n<=BLOCK_INPUTS,'payment input count');assert(used+n<=BLOCK_INPUTS,'block payment input budget');used+=n;
},get used(){return used;}};}
