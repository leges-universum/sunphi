// One reviewed funding step at a time. No signing, broadcast or settlement
// authority. The custody worker must revalidate this plan against independent
// current observations and reserve its exact nonce through the existing signer.
import assert from 'node:assert/strict';
import {exact,hex,integer,hash} from '../crypto.mjs';
import {ETHEREUM_GENESIS,ETHEREUM_USDC,ETHEREUM_USDT} from './exchange-evm-networks.mjs';
const uint=v=>{assert(typeof v==='string'&&/^(0|[1-9][0-9]{0,23})$/.test(v));return BigInt(v);};
const word=v=>BigInt(v).toString(16).padStart(64,'0');
const addr=v=>assert(typeof v==='string'&&/^0x[a-f0-9]{40}$/.test(v)&&v!=='0x'+'0'.repeat(40));
export function nextEthereumTokenFundingStep(terms,observation,now){
 exact(terms,['asset','genesis','token','order','escrow','codeHash','payer','recipient','amountAtomic','hashlock','refundAt','minClaimWindowSeconds','maxGasCostWei']);
 assert(['USDC','USDT'].includes(terms.asset));assert.equal(terms.genesis,ETHEREUM_GENESIS);
 assert.equal(terms.token,terms.asset==='USDT'?ETHEREUM_USDT:ETHEREUM_USDC);
 for(const k of ['order','codeHash','hashlock'])hex(terms[k]);for(const k of ['escrow','payer','recipient'])addr(terms[k]);
 assert.equal(new Set([terms.escrow,terms.payer,terms.recipient]).size,3);assert(uint(terms.amountAtomic)>0n);assert(uint(terms.maxGasCostWei)>0n);
 integer(now,1);integer(terms.refundAt,1);integer(terms.minClaimWindowSeconds,1);assert(terms.refundAt-now>=terms.minClaimWindowSeconds,'insufficient funding/recovery window');
 exact(observation,['termsHash','block','observedAt','status','allowanceAtomic','balanceAtomic','gasBalanceWei','latestNonce','pendingNonce']);
 assert.equal(observation.termsHash,hash(terms),'changed inspected escrow terms');hex(observation.block);
 integer(observation.observedAt,1);assert(observation.observedAt<=now&&now-observation.observedAt<=30,'stale funding observation');
 assert.equal(observation.status,'UNFUNDED','already funded, cancelled or unresolved escrow');
 const allowance=uint(observation.allowanceAtomic),amount=uint(terms.amountAtomic);
 assert(uint(observation.balanceAtomic)>=amount,'insufficient token balance');
 assert(uint(observation.gasBalanceWei)>=uint(terms.maxGasCostWei),'insufficient ETH gas reserve');
 uint(observation.latestNonce);assert.equal(observation.pendingNonce,observation.latestNonce,'resolve pending Ethereum transaction first');
 let step,to,data;
 if(allowance===amount){step='FUND';to=terms.escrow;data='0x01670ba9'+terms.order;}
 else{step=allowance===0n?'APPROVE_EXACT':'RESET_ALLOWANCE';to=terms.token;data='0x095ea7b3'+terms.escrow.slice(2).padStart(64,'0')+word(allowance===0n?amount:0n);}
 return {domain:'DUEBYTE_ETHEREUM_TOKEN_FUNDING_STEP_V1',termsHash:hash(terms),step,chainId:'1',from:terms.payer,to,data,valueWei:'0',nonce:observation.latestNonce,
  maxGasCostWei:terms.maxGasCostWei,observationBlock:observation.block,requiresFreshAuthorization:true};
}
