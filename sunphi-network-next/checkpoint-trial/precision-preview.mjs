// Offline denomination rehearsal: no keys, signatures, storage writes or RPC.
import assert from 'node:assert/strict';
import {hash,integer} from './crypto.mjs';import {FRACTION_SCALE} from './token-units.mjs';
import {audit} from './payment-model.mjs';import {auditNetworkReserves} from './network-reserves.mjs';
import {auditEconomicPreparation} from './economic-preparation.mjs';
import {versionedEconomicPlan,memorialAware,ECONOMIC_POLICY_VERSION_V4} from './economic-policy-v3.mjs';
export function previewTokenPrecision(base){
 audit(base.money);auditNetworkReserves(base);auditEconomicPreparation(base);
 assert(!base.money.unitScale,'precision already activated');
 assert(!base.rewards&&!base.authority.nodeRewards&&!base.launchFund,'precision migration precedes reward activation');
 const r=base.networkReserves;assert(r&&!r.issued&&r.warmup.mode==='PAUSED'&&r.development.mode==='PAUSED','unissued paused reserves required');
 assert(!r.warmup.pending&&!r.development.pending&&!r.development.access?.pending,'settle pending reserve instructions');
 assert(!base.economicPreparation?.memorial.pending,'settle pending memorial succession');
 assert(!base.economicPreparation||memorialAware(base.economicPreparation.plan.version),'memorial-aware economic plan required');
 assert(Object.values(base.money.requests).every(q=>!['RESERVED','SCHEDULED'].includes(q.status)),'settle in-flight payments first');
 assert(!Object.keys(base.money.liability?.records??{}).length,'settle retained collateral first');assert(!base.money.liability?.protection.pending,'settle protection instructions');
 const s=structuredClone(base),changes=[];
 const scale=(o,k,path)=>{const old=o[k];assert(typeof old==='string'&&/^(0|[1-9][0-9]*)$/.test(old),'canonical migration amount');const n=BigInt(old)*FRACTION_SCALE;assert(n<(1n<<64n),'migration overflow');o[k]=String(n);changes.push({path,before:old,after:o[k]});};
 const m=s.money;for(const k of ['supply','fees'])scale(m,k,'money.'+k);
 for(const [id,o]of Object.entries(m.outputs))scale(o,'value','money.outputs.'+id+'.value');
 for(const [id,n]of Object.entries(m.nodes))for(const k of ['stake','consensusHeld','taskHeld','tier'])scale(n,k,'money.nodes.'+id+'.'+k);
 if(m.liability){scale(m.liability,'pool','money.liability.pool');for(const k of ['collected','compensated','exceptional'])scale(m.liability.protection,k,'money.liability.protection.'+k);}
 for(const k of ['dailyLimit','transferLimit'])scale(s.networkReserves.development.controls,k,'networkReserves.development.controls.'+k);
 // Historical policy, intents and evidence retain their original denomination.
 if(s.networkReserves.development.access)s.networkReserves.development.access.epoch++;
 // Memorial custody is already denominated in micro-units and has no spend path.
 // Preserve its public succession history and epoch exactly.
 m.unitScale=String(FRACTION_SCALE);m.precisionHeight=s.height;m.epoch++;
 integer(m.epoch);if(s.networkReserves.development.access)integer(s.networkReserves.development.access.epoch);
 const plan=versionedEconomicPlan(base,base.economicPreparation?.plan.version??ECONOMIC_POLICY_VERSION_V4);assert(BigInt(m.supply)<=BigInt(plan.programmeCapMicro),'existing supply exceeds ordinary programme');
 audit(m);auditNetworkReserves(s);auditEconomicPreparation(s);
 assert.equal(hash(base.money.requests),hash(m.requests),'signed payment history retained');assert.equal(hash(base.networkReserves.policy),hash(s.networkReserves.policy),'original reserve consent retained');
 return {state:s,review:{version:'DUEBYTE_PRECISION_PREVIEW_V1',sourceStateHash:hash(base),targetStateHash:hash(s),fromScale:'1',toScale:String(FRACTION_SCALE),changes,existingSupplyMicro:m.supply,programmeCapMicro:plan.programmeCapMicro,memorialMicro:plan.memorialMicro,totalCapMicro:plan.capMicro,prepared:Boolean(base.economicPreparation),publicActivationEnabled:false,issuance:false}};
}
