import {createHash,generateKeyPairSync,createPrivateKey,createPublicKey,sign as cryptoSign,verify as cryptoVerify} from 'node:crypto';
import {canonical} from '../shared/canonical.mjs';
import {isVoter} from '../shared/membership.mjs';
import {strictSignatureShape} from '../shared/ed25519-shape.mjs';
import {releaseBody} from '../shared/security.mjs';
export {canonical};
export const hash=x=>createHash('sha256').update(canonical(x)).digest('hex');
const prefix=Buffer.from('302a300506032b6570032100','hex');
const publicKeys=new Map();
const verified=new Map();
export const verificationStats={checks:0,hits:0};
export function publicKey(raw){
  if(typeof raw!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(raw)||Buffer.from(raw,'base64url').toString('base64url')!==raw)throw Error('Invalid public key');
  if(!publicKeys.has(raw))publicKeys.set(raw,createPublicKey({key:Buffer.concat([prefix,Buffer.from(raw,'base64url')]),format:'der',type:'spki'}));
  return publicKeys.get(raw);
}
export function keys(){const k=generateKeyPairSync('ed25519');return {publicKey:k.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64url'),privateKey:k.privateKey.export({format:'der',type:'pkcs8'}).toString('base64url')};}
export const address=raw=>{publicKey(raw);return 'swl1_'+raw;};
export const rawKey=addr=>{if(typeof addr!=='string'||!addr.startsWith('swl1_'))throw Error('Invalid Wander address');const raw=addr.slice(5);publicKey(raw);return raw;};
export function sign(payload,privateKey){return cryptoSign(null,Buffer.from(canonical(payload)),createPrivateKey({key:Buffer.from(privateKey,'base64url'),format:'der',type:'pkcs8'})).toString('base64url');}
export function verifyRaw(message,signature,raw){try{
  if(typeof signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(signature))return false;
  const key=publicKey(raw),s=Buffer.from(signature,'base64url'),bytes=Buffer.from(message);
  // Exact bytes, not object identity or a remote verification assertion. Bound
  // both entry count and message size; failed checks are never cached.
  const cacheKey=bytes.length<=4096?'Ed25519:'+raw+':'+signature+':'+bytes.toString('base64'):null;
  if(cacheKey&&verified.has(cacheKey)){verificationStats.hits++;return true;}
  verificationStats.checks++;
  const ok=s.toString('base64url')===signature&&strictSignatureShape(Buffer.from(raw,'base64url'),s)&&cryptoVerify(null,bytes,key,s);
  if(ok&&cacheKey){if(verified.size>=8192)verified.delete(verified.keys().next().value);verified.set(cacheKey,true);}
  return ok;
}catch{return false;}}
export function verify(payload,signature,raw){try{return verifyRaw(Buffer.from(canonical(payload)),signature,raw);}catch{return false;}}
export function vote(domain,network,height,round,value,node,key,extra={}){const message={domain,network,height,round,value,node,...extra};return {...message,signature:sign(message,key)};}
export function verifyVote(v,genesis,domain,height,round,value){
  if(!v||v.domain!==domain||v.network!==genesis.network||v.height!==height||v.round!==round||v.value!==value||!Number.isInteger(v.node))return false;
  if(genesis.security&&!genesis.security.policy.releases.some(r=>hash(releaseBody(r))===v.release))return false;
  const {signature,...message}=v;return !!genesis.nodes[v.node]&&isVoter(genesis,v.node)&&verify(message,signature,genesis.nodes[v.node].publicKey);
}
