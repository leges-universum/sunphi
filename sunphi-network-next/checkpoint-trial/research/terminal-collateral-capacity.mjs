// Planning only: terminal release is NOT enabled by this calculator.
import assert from 'node:assert/strict';
import {paymentFee,INITIAL_TARIFF} from '../payment-tariff.mjs';
export function terminalCollateralCapacity({stakeMicro,paymentMicro,spacingSeconds,
 timeoutSeconds=120,blockSeconds=10,postTerminalSeconds=0}){
 for(const n of [spacingSeconds,timeoutSeconds,blockSeconds])assert(Number.isSafeInteger(n)&&n>0);
 assert(Number.isSafeInteger(postTerminalSeconds)&&postTerminalSeconds>=0);
 for(const x of [stakeMicro,paymentMicro])assert(typeof x==='string'&&/^[1-9][0-9]*$/.test(x));
 const stake=BigInt(stakeMicro),value=BigInt(paymentMicro),reserve=1000000n;
 assert(stake>reserve);
 const horizon=timeoutSeconds+2*blockSeconds+postTerminalSeconds;
 const outstanding=1+Math.ceil(horizon/spacingSeconds);
 const held=BigInt(outstanding)*value,free=stake-reserve,budget=free*80n/100n;
 const recordsBudget=Math.floor(256*0.8),assignmentsBudget=Math.floor(768*0.8);
 const maxByCapital=budget/value;
 const maxOutstanding=Number(maxByCapital>BigInt(recordsBudget)?BigInt(recordsBudget):maxByCapital);
 const minimumSpacing=maxOutstanding>1?Math.ceil(horizon/(maxOutstanding-1)):null;
 return {preparedOnly:true,issuanceAuthorized:false,terminalReleasePolicyVersion:4,terminalReleaseActivated:false,
  stakeMicro,paymentMicro,spacingSeconds,horizonSeconds:horizon,consensusReserveMicro:String(reserve),
  capitalMarginPercent:20,maximumOutstanding:outstanding,assignments:outstanding*3,
  heldMicro:String(held),operatingCapitalMicro:String(budget),requiredWithReserveMicro:String(held+reserve),
  covered:held<=budget,recordsFit:outstanding<=recordsBudget&&outstanding*3<=assignmentsBudget,
  minimumSpacingSeconds:minimumSpacing,attemptsPerDay:Math.floor(86400/spacingSeconds),
  maximumDailyFeeMicro:String(paymentFee(INITIAL_TARIFF,paymentMicro)*BigInt(Math.floor(86400/spacingSeconds))),
  assumptions:['ONE_PART_WITH_THREE_WORKERS_EACH_COVERS_FULL_PART',
   'SAME_WORKERS_MAY_RECEIVE_EVERY_PAYMENT_NO_ROTATION_ASSUMED',
   'SIGNED_PILOT_TIMEOUT_120_SECONDS_NOT_GENERAL_WALLET_DEFAULT',
   'TWO_BLOCK_PROCESSING_MARGIN_IS_AN_ASSUMPTION_NOT_A_LIVENESS_GUARANTEE',
   'PAUSE_ADMISSION_IF_ACTUAL_AVAILABLE_COLLATERAL_OR_RECORD_CAPACITY_IS_INSUFFICIENT',
   'FAULT_PENALTIES_MUST_BE_ACCOUNTED_BEFORE_RELEASE',
   'RECIPIENT_SPENDING_LOCK_DOES_NOT_EXTEND_WORKER_LIABILITY',
   'CURRENT_PILOT_GATES_AND_POST_TERMINAL_RELEASE_REQUIRE_PROSPECTIVE_UPGRADE']};
}
export function collateralCapacityScenarios(){
 return ['10000000','100000000'].flatMap(stakeMicro=>[1,10,60].map(spacingSeconds=>{
  const paymentMicro=stakeMicro==='10000000'?({1:'50000',10:'400000',60:'1000000'})[spacingSeconds]:({1:'500000',10:'5000000',60:'10000000'})[spacingSeconds];
  const args={stakeMicro,paymentMicro,spacingSeconds};
  return {terminal:terminalCollateralCapacity(args),currentDayHold:terminalCollateralCapacity({...args,postTerminalSeconds:86400})};
 }));
}
