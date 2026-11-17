import {fields} from './canonical.mjs';
import {isSecurity,securityState} from './security.mjs';
const require=(v,m)=>{if(!v)throw Error(m);};
export const isAdmission=i=>i?.action==='ADMIT_VALIDATOR';
export const isRegistration=i=>i?.action==='REGISTER_DEVICE';
export const isReconfiguration=i=>i?.action==='RECONFIGURE_CONTROLLERS';
export const isMembership=i=>isAdmission(i)||isRegistration(i)||isReconfiguration(i)||isSecurity(i);
export const registryEpoch=s=>s?.registry?.epoch??0;
export const quorumFor=n=>Math.floor(2*n/3)+1;
export const voterIds=g=>g.voterIds??g.nodes.map(n=>n.id);
export const isVoter=(g,id)=>voterIds(g).includes(id);
export const voters=g=>voterIds(g).map(id=>g.nodes[id]);
export function networkAt(g,s){
  g=s?.security?{...g,security:s.security}:g;
  const nodes=s?.registry?.nodes??g.nodes,a=s?.active;
  if(!a)return s?.registry?{...g,nodes,quorum:quorumFor(nodes.length)}:g;
  const placements=new Map(a.members.map(n=>[n.id,n]));
  return {...g,nodes:nodes.map(n=>({...n,...placements.get(n.id)})),voterIds:a.members.map(n=>n.id),quorum:quorumFor(a.members.length),activePolicy:a.policy};
}
export function stateCommitment(s){return {tokens:s.tokens,accounts:s.accounts,treasury:s.treasury,...(s.registry?{registry:s.registry}:{}),...(s.active?{active:s.active}:{}),...(s.security?{security:s.security}:{})};}
export function admissionBody(i){const {signature,...body}=i;return body;}
export function admissionState(s,i,g,genesisHash){
  require(!s.active,'Legacy voter admission disabled after pool separation');
  fields(i,['action','domain','genesis','network','parent','registryEpoch','node','signature']);
  require(g.protocol===2&&!g.placement,'Admission requires the supported certificate registry policy');
  require(i.domain==='WANDER_ADMISSION_V1'&&i.genesis===genesisHash&&i.network===g.network&&i.parent===s.head,'Admission context changed');
  require(i.registryEpoch===registryEpoch(s)+1&&Number.isSafeInteger(i.registryEpoch),'Admission epoch mismatch');
  const cfg=networkAt(g,s),n=i.node;fields(n,['id','publicKey','url','operator','failureDomain']);
  require(n.id===cfg.nodes.length&&cfg.nodes.length<10000,'Admission must append exactly one validator');
  require(/^[A-Za-z0-9_-]{43}$/.test(n.publicKey)&&!cfg.nodes.some(x=>x.publicKey===n.publicKey),'Invalid or duplicate validator key');
  require(typeof n.operator==='string'&&typeof n.failureDomain==='string'&&/^[a-zA-Z0-9-]{1,64}$/.test(n.operator)&&/^[a-zA-Z0-9-]{1,64}$/.test(n.failureDomain),'Operator and physical failure domain required');
  // Logical routes remain explicit; transport maps them to authenticated private paths.
  const u=new URL(n.url);require(u.origin===n.url&&u.protocol==='http:'&&u.hostname==='127.0.0.1'&&Number(u.port)>=1024&&!cfg.nodes.some(x=>x.url===n.url),'Invalid or duplicate logical route');
  const next=structuredClone(s);next.registry={epoch:i.registryEpoch,nodes:[...cfg.nodes,structuredClone(n)]};return next;
}

// Registering a device never silently grants consensus weight. Historical
// ADMIT_VALIDATOR blocks remain replayable, but cannot bypass the new boundary.
export function membershipState(s,i,g,genesisHash){
  if(isSecurity(i))return securityState(s,i,g,genesisHash,networkAt(g,s));
  if(isAdmission(i))return admissionState(s,i,g,genesisHash);
  require(g.protocol===2&&!g.placement,'Unsupported membership policy');
  const cfg=networkAt(g,s),next=structuredClone(s);
  if(isRegistration(i)){
    fields(i,['action','domain','genesis','network','parent','registryEpoch','node','signature']);
    require(i.domain==='WANDER_DEVICE_V1','Wrong registration domain');
    // Reuse the exact legacy descriptor validation without its voter semantics.
    const legacy={...i,action:'ADMIT_VALIDATOR',domain:'WANDER_ADMISSION_V1'};
    const base={...s};delete base.active;
    next.registry=admissionState(base,legacy,g,genesisHash).registry;
    next.active??={epoch:0,policy:'bootstrap-v1',members:voters(cfg).map(n=>({id:n.id,operator:n.operator??'unverified-bootstrap',failureDomain:n.failureDomain??'unverified-bootstrap'}))};
    return next;
  }
  fields(i,['action','domain','genesis','network','parent','registryEpoch','activeEpoch','policy','members','proposer','signature']);
  require(isReconfiguration(i)&&i.domain==='WANDER_ACTIVE_V1','Wrong reconfiguration domain');
  require(i.genesis===genesisHash&&i.network===g.network&&i.parent===s.head,'Reconfiguration context changed');
  require(i.registryEpoch===registryEpoch(s),'Registry changed');
  require(Number.isSafeInteger(i.activeEpoch)&&i.activeEpoch===(s.active?.epoch??0)+1,'Active epoch mismatch');
  require(Number.isSafeInteger(i.proposer)&&isVoter(cfg,i.proposer),'Proposer is not an active controller');
  require(['bootstrap-v1','balanced-v1','owner-four-hosts-v1'].includes(i.policy),'Unknown active policy');
  require(s.active?.policy!=='balanced-v1'||i.policy==='balanced-v1','Balanced policy cannot be downgraded');
  require(s.active?.policy!=='owner-four-hosts-v1'||i.policy!=='bootstrap-v1','Host placement policy cannot be downgraded');
  require(Array.isArray(i.members)&&i.members.length>=31&&i.members.length<=100,'Active set requires31 to100 controllers');
  let previous=-1;const domains=new Map(),operators=new Map();
  for(const n of i.members){
    fields(n,['id','operator','failureDomain']);require(Number.isSafeInteger(n.id)&&n.id>previous&&!!cfg.nodes[n.id],'Active members must be unique sorted registered IDs');previous=n.id;
    require(typeof n.operator==='string'&&typeof n.failureDomain==='string'&&/^[a-zA-Z0-9-]{1,64}$/.test(n.operator)&&/^[a-zA-Z0-9-]{1,64}$/.test(n.failureDomain),'Invalid active placement');
    domains.set(n.failureDomain,(domains.get(n.failureDomain)??0)+1);operators.set(n.operator,(operators.get(n.operator)??0)+1);
  }
  if(i.policy==='balanced-v1'){
    const limit=Math.floor((i.members.length-1)/3);
    require([...domains.values(),...operators.values()].every(n=>n<=limit),'Active set concentrated in one host or operator');
  }
  // Explicit owner-operated launch policy. Hosts are independent failure
  // domains, NOT independent operators. The existing balanced-v1 policy
  // retains its stronger operator constraint and cannot downgrade into this.
  if(i.policy==='owner-four-hosts-v1'){
    require(i.members.length%4===0&&domains.size===4&&[...domains.values()].every(n=>n===i.members.length/4),'Four equal active host groups required');
    require(operators.size===1,'Owner-operated policy requires one declared operator');
  }
  next.active={epoch:i.activeEpoch,policy:i.policy,members:structuredClone(i.members)};
  return next;
}
export const membershipRoles=i=>isSecurity(i)?['APPROVE_SECURITY','READY_SECURITY']:isRegistration(i)?['APPROVE_DEVICE','READY_DEVICE']:isReconfiguration(i)?['APPROVE_ACTIVE','READY_ACTIVE']:['APPROVE_REGISTRY','READY_REGISTRY'];
export function membershipRoleNetwork(role,p,g,s){
  const cfg=networkAt(g,s);
  if(!role.startsWith('READY_'))return cfg;
  if(isRegistration(p.intent))return {...cfg,nodes:[...cfg.nodes,p.intent.node],voterIds:[p.intent.node.id],quorum:1};
  return networkAt(g,membershipState(s,p.intent,g,p.intent.genesis));
}
export const joiningReadyId=i=>isRegistration(i)||isAdmission(i)?i.node.id:null;
export const membershipSigner=(i,g,s)=>isReconfiguration(i)||isSecurity(i)?networkAt(g,s).nodes[i.proposer]?.publicKey:i.node?.publicKey;
