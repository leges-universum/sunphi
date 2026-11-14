// Pure validation shared by native and browser replay. Signature adapters are external.
import {fields} from './canonical.mjs';
const need=(x,m)=>{if(!x)throw Error(m);};
export const isAutomaticRecovery=i=>i?.action==='AUTO_RECOVER_CONTROLLERS';
export const isSecurity=i=>['SET_SECURITY_POLICY','ROTATE_GUARDS','AUTO_RECOVER_CONTROLLERS'].includes(i?.action);
export const isGuardRecovery=i=>i?.action==='ROTATE_GUARDS'||isAutomaticRecovery(i);
// A separate certified seed changes assignments, never wallet authority epochs.
export const accountSeed=(g,a,epoch)=>({kind:'ACCOUNT',address:a,epoch,seed:g.selectionSeed,...(g.security?.controllerEpoch?{controllerEpoch:g.security.controllerEpoch}:{})});
export function validateAutomaticRecovery(a){
  fields(a,['version','probeIntervalMs','timeoutMs','stallMs','failures','leaderSlotMs']);
  need(a.version===1||a.version===2,'Unsupported automatic recovery');
  for(const [k,min,max] of [['probeIntervalMs',1000,60000],['timeoutMs',500,10000],['stallMs',5000,300000],['failures',3,20],['leaderSlotMs',5000,120000]])need(Number.isSafeInteger(a[k])&&a[k]>=min&&a[k]<=max,'Invalid recovery bound: '+k);
  need(a.stallMs>=a.probeIntervalMs*(a.failures-1),'Recovery observation window too short');
}
export const releaseBody=r=>{const {signatures,...body}=r;return body;};
export function validateRelease(r){
  fields(r,['domain','sequence','version','runtime','files','signatures']);
  need(r.domain==='WANDER_RELEASE_V1'&&Number.isSafeInteger(r.sequence)&&r.sequence>0,'Invalid release sequence');
  need(/^\d+\.\d+\.\d+$/.test(r.version),'Invalid release version');
  need(Array.isArray(r.runtime)&&r.runtime.length>0&&r.runtime.length<=8&&r.runtime.every(v=>/^v\d+\.\d+\.\d+$/.test(v)),'Exact supported Node runtimes required');
  need(r.files&&typeof r.files==='object'&&!Array.isArray(r.files),'Release file map required');
  const names=Object.keys(r.files);need(names.length>=8&&names.length<=256,'Release file bounds');
  for(const name of names)need(/^(src|shared)\/[a-zA-Z0-9_-]+\.mjs$/.test(name)&&/^[a-f0-9]{64}$/.test(r.files[name]),'Unsafe release path or hash');
  for(const f of ['src/node.mjs','src/model.mjs','src/coordinator.mjs','src/crypto.mjs','src/store.mjs','src/release.mjs','shared/core.mjs','shared/membership.mjs','shared/security.mjs','shared/guards.mjs'])need(names.includes(f),'Missing security-critical release file');
  need(Array.isArray(r.signatures)&&r.signatures.length<=16,'Invalid release signatures');
  const seen=new Set();for(const sig of r.signatures){fields(sig,['key','signature']);need(!seen.has(sig.key),'Duplicate release signer');seen.add(sig.key);}
}
export function securityState(s,i,g,genesisHash,cfg){
  const recovery=isGuardRecovery(i),automatic=isAutomaticRecovery(i);
  fields(i,recovery?['action','domain','network','genesis','parent','epoch','proposer','signature',...(automatic?['trigger']:[])]:['action','domain','network','genesis','parent','epoch','proposer','policy','signature']);
  need(g.protocol===2&&i.domain==='WANDER_SECURITY_V1'&&i.network===g.network&&i.genesis===genesisHash&&i.parent===s.head,'Security context mismatch');
  need(Number.isSafeInteger(i.proposer)&&(cfg.voterIds??cfg.nodes.map(n=>n.id)).includes(i.proposer),'Security proposer not active');
  need(Number.isSafeInteger(i.epoch)&&i.epoch===(s.security?.epoch??0)+1,'Security epoch mismatch');
  const next=structuredClone(s);
  if(recovery){need(s.security,'Four-level policy not active');if(automatic){need(s.security.policy.automaticRecovery,'Automatic recovery not enabled');need(i.trigger===null||(i.trigger&&typeof i.trigger==='object'&&!Array.isArray(i.trigger)&&!isSecurity(i.trigger)),'Invalid recovery trigger');next.security.controllerEpoch=(s.security.controllerEpoch??0)+1;need(Number.isSafeInteger(next.security.controllerEpoch),'Controller epoch overflow');}next.security.epoch=i.epoch;return next;}
  const p=i.policy;fields(p,['protocol','publishers','threshold','releases',...(p.automaticRecovery?['automaticRecovery']:[])]);
  if(p.automaticRecovery)validateAutomaticRecovery(p.automaticRecovery);
  need(p.protocol===4,'Unsupported layered protocol');
  need(Array.isArray(p.publishers)&&p.publishers.length>=3&&p.publishers.length<=16&&new Set(p.publishers).size===p.publishers.length&&p.publishers.every(k=>/^[A-Za-z0-9_-]{43}$/.test(k)),'Invalid publisher keys');
  need(Number.isSafeInteger(p.threshold)&&p.threshold>=Math.floor(2*p.publishers.length/3)+1&&p.threshold<=p.publishers.length,'Publisher approval threshold too low');
  need(Array.isArray(p.releases)&&p.releases.length>0&&p.releases.length<=4,'Release allowlist bounds');
  p.releases.forEach(validateRelease);
  const sequences=p.releases.map(r=>r.sequence);need(new Set(sequences).size===sequences.length,'Duplicate release sequence');
  if(s.security){const old=s.security.policy;need(JSON.stringify(p.publishers)===JSON.stringify(old.publishers)&&p.threshold===old.threshold,'Publisher root replacement requires a separate migration');
    const floor=Math.max(...old.releases.map(r=>r.sequence));need(Math.max(...sequences)>=floor,'Release rollback');
    for(const r of p.releases)if(r.sequence<=floor)need(old.releases.some(x=>JSON.stringify(releaseBody(x))===JSON.stringify(releaseBody(r))),'Release sequence cannot be rewritten or reintroduced');
  }
  next.security={epoch:i.epoch,policy:structuredClone(p),...(s.security?.controllerEpoch?{controllerEpoch:s.security.controllerEpoch}:{})};return next;
}
