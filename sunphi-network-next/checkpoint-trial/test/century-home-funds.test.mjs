import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {subsidyFixture,openSubsidy,settleProgramme,closeSubsidy} from './century-subsidy.test.mjs';
import {keys,sign,hash} from '../crypto.mjs';import {applyTx,stateHash} from '../core.mjs';
import {REWARDS,rewardNodeId,walletConsent} from '../node-rewards.mjs';
import {CENTURY_HOME,CENTURY_HOME_ACTION,centuryHomeBody,completeCenturyHome,homeHeld} from '../century-home.mjs';
import {CENTURY_SERVICE} from '../century-subsidy.mjs';
import {CENTURY_FUNDS_ACTION,centuryFundsManifest,applyCenturyFunds,centuryFundsReadiness,centuryFundAllowance,checkCenturyFundsPayment} from '../century-funds.mjs';
import {anniversary} from '../economic-policy-v2.mjs';import {Store} from '../store.mjs';import {WalletStore} from '../wallet-store.mjs';import {RewardWorker} from '../reward-worker.mjs';
import {setup as liabilityFixture} from './payment-liability.test.mjs';
import {makeEconomicPlanV3,economicTermsHash,ECONOMIC_POLICY_VERSION_V3} from '../economic-policy-v3.mjs';import {applyEconomicPreparation} from '../economic-preparation.mjs';import {previewTokenPrecision} from '../precision-preview.mjs';
export function homeFixture(count=2,over={}){
 const x=subsidyFixture(),homes=Array.from({length:count},()=>({identity:keys(),work:keys(),management:keys()}));let s=x.s;
 const peers=homes.map(h=>createHash('sha256').update(Buffer.from(h.identity.publicKey,'base64url')).digest('hex').slice(0,40));
 const body={domain:REWARDS+'/ALLOW_REWARD_NODES_V1',network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,notBefore:s.height+1,expires:s.height+3,peers};
 s=x.run(s,[x.wire({type:'ALLOW_REWARD_NODES_V1',certificate:{body,approvals:x.approvals(body)}})]);
 for(const h of homes){h.node=rewardNodeId(s.configHash,h.work.publicKey);const b={domain:REWARDS+'/REGISTER',configHash:s.configHash,identity:h.identity.publicKey,work:h.work.publicKey,management:h.management.publicKey};s=x.run(s,[x.wire({type:'REGISTER_REWARD_NODE_V1',body:b,identitySignature:sign(b,h.identity.privateKey),workSignature:sign(b,h.work.privateKey),managementSignature:sign(b,h.management.privateKey)},h.work)]);}
 const history=new Map([[s.height,s]]),run=(...args)=>{const out=x.run(...args);history.set(out.height,out);return out;};while(s.height<s.rewards.period.end-1)s=run(s);s=run(s);
 const policy={service:CENTURY_SERVICE,intervalSeconds:300,costPerPaymentMicro:'100000',intervalCapMicro:'1000000',nodeCapMicro:'500000',groupCapMicro:'1000000',maxPayments:32,
  home:{version:CENTURY_HOME,nodes:Object.fromEntries(homes.map(h=>[h.node,null])),costPerSampleMicro:'10000',feeSharePPM:500000,responseSeconds:60},...over};
 s=openSubsidy(x,s,{policy,to:s.money.time+300});s=run(s);
 return {...x,s,homes,history,run};
}
function answer(s,h){const body=centuryHomeBody(s,h.node);return {type:CENTURY_HOME_ACTION,body,signature:sign(body,h.work.privateKey)};}
function accept(s,h){return completeCenturyHome(s,answer(s,h),h.work.publicKey);}
const owned=(s,key)=>Object.values(s.money.outputs).filter(o=>o.owner===key.publicKey).reduce((a,o)=>a+BigInt(o.value),0n);
function bind(x,s,h,w){const b={domain:REWARDS+'/BIND',configHash:s.configHash,node:h.node,sequence:1,payouts:[{wallet:w.publicKey,weight:1}]};return x.run(s,[x.wire({type:'BIND_REWARD_WALLETS_V1',body:b,signature:sign(b,h.management.privateKey),consents:[sign(walletConsent(s.configHash,h.node,w.publicKey),w.privateKey)]},h.management)]);}
test('home fractions share the single century budget and collected fees, then reach consenting wallets',()=>{
 const x=homeFixture(),wallet=keys();let s=settleProgramme(x,x.s).s;assert.equal(homeHeld(s),18519n);
 for(const h of x.homes)s=accept(s,h);s=bind(x,s,x.homes[0],wallet);s=closeSubsidy(x,s);
 for(const h of x.homes){assert.equal(s.rewards.nodes[h.node].earned,'10000');assert.equal(s.centurySubsidy.homeFeesEarned[h.node],'9259');assert.equal(s.centurySubsidy.earned[h.node],'741');}
 assert.equal(owned(s,wallet),10000n);assert.equal(s.centurySubsidy.totalMintedMicro,'82962');assert.equal(s.money.supply,String(BigInt(x.s.money.supply)+82962n));assert.equal(homeHeld(s),0n);stateHash(s,x.c);
});
test('anonymous identities share an aggregate cap; extra keys cannot increase the authorised pool',()=>{
 const x=homeFixture(3,{nodeCapMicro:'15000',groupCapMicro:'15000'});let s=x.s;for(const h of x.homes)s=accept(s,h);s=closeSubsidy(x,s);
 assert.equal(s.rewards.minted,'15000');assert(x.homes.every(h=>s.rewards.nodes[h.node].earned==='5000'));stateHash(s,x.c);
});
test('wrong key, changed challenge, stale sequence and expired response cannot earn; acceptance is idempotent',()=>{
 const x=homeFixture(),h=x.homes[0],a=answer(x.s,h),before=hash(x.s);
 assert.throws(()=>applyTx(x.s,Buffer.from(JSON.stringify(x.wire(a,h.work))),x.c,x.s.money.time),/public action/);
 assert.throws(()=>completeCenturyHome(x.s,a,keys().publicKey));
 for(const k of ['challenge','result']){const bad=structuredClone(a);bad.body[k]=hash('wrong');bad.signature=sign(bad.body,h.work.privateKey);assert.throws(()=>completeCenturyHome(x.s,bad,h.work.publicKey));}
 assert.equal(hash(x.s),before);const accepted=accept(x.s,h);assert.equal(completeCenturyHome(accepted,a,h.work.publicKey),accepted);
 const expired=x.run(x.s,[],x.s.money.time+61);assert.throws(()=>completeCenturyHome(expired,a,h.work.publicKey),/expired/);
 let s=settleProgramme(x,x.s).s;s=closeSubsidy(x,s);assert.equal(s.centurySubsidy.last.home.accepted,0);assert.equal(s.centurySubsidy.last.home.returnedFeeMicro,'18519');assert.equal(s.rewards.minted,'62961');
 assert.throws(()=>completeCenturyHome(s,a,h.work.publicKey),/assigned/);stateHash(s,x.c);
});
test('home response client verifies retained history and retries the same outbox without legacy witness spam',async()=>{
 const x=homeFixture(1),h=x.homes[0],root=mkdtempSync(join(tmpdir(),'century-home-client-')),home=join(root,'wallet');mkdirSync(home);
 writeFileSync(join(root,'reward-identity.json'),JSON.stringify({version:1,network:x.c.chainId,configHash:hash(x.c),work:h.work,management:h.management}));
 const store=new WalletStore(home,x.c.chainId),sent=[];let s=x.s,invalid=true,fail=true;
 const options={home,config:x.c,store,url:'isolated',historyUrl:'isolated',snapshotReader:async(url,height)=>invalid?{...x.history.get(height),blockHash:hash('wrong')}:x.history.get(height),broadcast:async w=>{sent.push(w);if(fail)throw Error('lost response');}};
 const view=()=>({state:s,certificate:{appHash:stateHash(s,x.c),appHeight:s.height}});
 try{await assert.rejects(()=>new RewardWorker(options).tick(view()));assert.equal(sent.length,0);invalid=false;
  await assert.rejects(()=>new RewardWorker(options).tick(view()),/lost response/);fail=false;await new RewardWorker(options).tick(view());assert.equal(sent.length,2);assert.equal(hash(sent[0]),hash(sent[1]));assert.equal(sent[0].body.action.type,CENTURY_HOME_ACTION);
  s=completeCenturyHome(s,sent[0].body.action,h.work.publicKey);sent.length=0;await new RewardWorker(options).tick(view());assert.equal(sent.length,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM reward_outbox').get().n,0);
 }finally{store.close();}
});
function funds(x,s=x.s,recipient=keys()){
 const body={domain:CENTURY_FUNDS_ACTION,network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,notBefore:s.height,expires:s.height+100,manifest:centuryFundsManifest(s,recipient.publicKey),previousManifestHash:s.centuryFunds?.manifestHash??null};
 return {action:{type:CENTURY_FUNDS_ACTION,certificate:{body,approvals:x.approvals(body)},founderConsent:sign(body,x.founder.privateKey),recipientConsent:sign(body,recipient.privateKey)},recipient};
}
test('start funds prepare exact allocations, no issuance, with quorum, current custody and recipient possession',()=>{
 const x=subsidyFixture(),{action}=funds(x),s=applyCenturyFunds(x.s,action,x.c);assert.equal(s.money.supply,x.s.money.supply);assert.deepEqual(s.money,x.s.money);assert.equal(applyCenturyFunds(s,action,x.c),s);
 const m=s.centuryFunds.manifest;assert.equal(m.warmup.totalMicro,'10000000000000');assert.equal(m.development.totalMicro,'100000000000000');assert.equal(m.founder.totalMicro,'10000000000000');assert.equal(m.memorial.totalMicro,'1000000000000');
 assert.equal(m.warmup.privateKeys,false);assert.equal(m.development.benefit,'DUEBYTE_AND_SUN_PHI');assert.equal(centuryFundsReadiness(s).issuanceEnabled,false);stateHash(s,x.c);
 for(const mutate of [a=>a.certificate.approvals.pop(),a=>a.founderConsent=sign(a.certificate.body,keys().privateKey),a=>a.recipientConsent=sign(a.certificate.body,keys().privateKey),a=>a.certificate.body.manifest.warmup.totalMicro='1']){const a=structuredClone(action);mutate(a);assert.throws(()=>applyCenturyFunds(x.s,a,x.c));}
 assert.throws(()=>applyTx(x.s,Buffer.from(JSON.stringify(x.wire(action))),x.c,x.s.money.time),/public action/);
 for(const recipient of [m.development.account,m.founder.account])assert.throws(()=>checkCenturyFundsPayment(s,{sender:x.f.alice.publicKey,recipient}),/ordinary payments/);
});

test('future fund custody rejects unsolicited dust before any fund preparation',()=>{
 const x=subsidyFixture(),m=centuryFundsManifest(x.s,keys().publicKey),before=hash(x.s);
 for(const recipient of [m.development.account,m.founder.account]){
  assert.throws(()=>checkCenturyFundsPayment({configHash:x.s.configHash},{sender:x.f.alice.publicKey,recipient}),/ordinary payments/);
  assert.throws(()=>checkCenturyFundsPayment(x.s,{sender:recipient,recipient:x.f.alice.publicKey}),/ordinary payments/);
  const i={...x.intent(x.s),unitScale:'1000000',recipient};
  for(const type of ['RESERVE','SCHEDULE_PAYMENT_V1']){
   const a={type,signed:x.f.sign(i)};
   assert.throws(()=>applyTx(x.s,Buffer.from(JSON.stringify(x.wire(a))),x.c,x.s.money.time),/fund custody cannot use ordinary payments/);
  }
 }
 checkCenturyFundsPayment(x.s,{sender:x.f.alice.publicKey,recipient:x.f.bob.publicKey});assert.equal(hash(x.s),before);
});
test('fund calendar preview respects 2/5 year warmup and annual 10-year vesting without starting a clock',()=>{
 const x=subsidyFixture(),s=applyCenturyFunds(x.s,funds(x).action,x.c),start=1794000000;
 assert.equal(centuryFundAllowance(s,'warmup',{start,at:anniversary(start,2)}),'5000000000000');assert.equal(centuryFundAllowance(s,'warmup',{start,at:anniversary(start,5)}),'10000000000000');
 for(const kind of ['development','founder']){assert.equal(centuryFundAllowance(s,kind,{start,at:anniversary(start,1)-1}),'0');assert.equal(centuryFundAllowance(s,kind,{start,at:anniversary(start,1)}),s.centuryFunds.manifest[kind].annualUnlockMicro);assert.equal(centuryFundAllowance(s,kind,{start,at:anniversary(start,10)}),s.centuryFunds.manifest[kind].totalMicro);}
 assert.equal(s.centuryFunds.manifest.emissionStart,null);assert.equal(s.centuryFunds.manifest.warmupStart,null);
});
test('fund preparation survives restart; recovery marks custody stale without halting or issuing',()=>{
 const x=homeFixture(1);let s=applyCenturyFunds(x.s,funds(x).action,x.c);s=accept(s,x.homes[0]);s=closeSubsidy(x,s);
 const path=join(mkdtempSync(join(tmpdir(),'century-funds-')),'state.sqlite');let db=new Store(path,x.c);db.restore(s);db.close();db=new Store(path,x.c);assert.equal(stateHash(db.state,x.c),stateHash(s,x.c));db.close();
 const manager=keys(),a=s.networkReserves.development.access,body={domain:'DUEBYTE_RESERVE_RECOVERY_V1/ROTATE_DEVELOPMENT_MANAGER_V1',configHash:s.configHash,epoch:a.epoch,manager:manager.publicKey};
 s=x.run(s,[x.wire({type:'ROTATE_DEVELOPMENT_MANAGER_V1',managementEpoch:a.epoch,manager:manager.publicKey,newConsent:sign(body,manager.privateKey)},x.founder)]);
 assert.equal(centuryFundsReadiness(s).managementCurrent,false);stateHash(s,x.c);assert.equal(s.money.supply,String(BigInt(x.s.money.supply)+10000n));
 const previous=s.centuryFunds.manifestHash,reprepared=funds({...x,founder:manager},s).action;s=applyCenturyFunds(s,reprepared,x.c);
 assert.equal(s.centuryFunds.previousManifestHash,previous);assert.equal(centuryFundsReadiness(s).managementCurrent,true);stateHash(s,x.c);
});
test('home fee reservation and accepted response survive interrupted interval close without duplicate mint',()=>{
 const x=homeFixture(1);let s=accept(settleProgramme(x,x.s).s,x.homes[0]);const path=join(mkdtempSync(join(tmpdir(),'century-home-atomic-')),'state.sqlite');let db=new Store(path,x.c);db.restore(s);
 db.finalize({height:s.height+1,blockHash:hash('home close'),time:s.centurySubsidy.pending.to,txs:[]});assert.equal(db.state.rewards.minted,'0');assert.equal(homeHeld(db.state),18519n);db.close();
 db=new Store(path,x.c);assert.equal(db.state.centurySubsidy.pending.home.jobs[x.homes[0].node].status,'accepted');s=closeSubsidy(x,db.state);db.close();assert.equal(s.rewards.nodes[x.homes[0].node].earned,'10000');assert.equal(homeHeld(s),0n);stateHash(s,x.c);
});
test('precision migration preserves fund micro amounts and makes its earlier management epoch stale',()=>{
 const x=liabilityFixture();let s=x.s;const body={domain:'DUEBYTE_ECONOMIC_PREPARATION_V3',network:x.c.chainId,configHash:s.configHash,generation:s.authority.generation,notBefore:s.height,expires:s.height+100,version:ECONOMIC_POLICY_VERSION_V3,supplyBefore:s.money.supply,unitScale:'1',previousPlanHash:null,termsHash:economicTermsHash(makeEconomicPlanV3(s)),memorialManager:x.founder.publicKey};
 s=applyEconomicPreparation(s,{type:'PREPARE_ECONOMY_V3',certificate:{body,approvals:x.approvals(body)},founderConsent:sign(body,x.founder.privateKey)},x.c);s=applyCenturyFunds(s,funds(x,s).action,x.c);
 const manifestHash=s.centuryFunds.manifestHash,oldSupply=BigInt(s.money.supply);s=previewTokenPrecision(s).state;assert.equal(s.centuryFunds.manifestHash,manifestHash);assert.equal(BigInt(s.money.supply),oldSupply*1000000n);assert.equal(centuryFundsReadiness(s).managementCurrent,false);stateHash(s,x.c);
 s=applyCenturyFunds(s,funds(x,s).action,x.c);assert.equal(centuryFundsReadiness(s).managementCurrent,true);stateHash(s,x.c);
});
