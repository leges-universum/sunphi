import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { Bool, Field, PrivateKey, UInt32, UInt64 } from 'o1js';
import { LAB_NETWORK, Statement, Note, commitment, ownerTag } from './circuit.mjs';
import { canonical, exact } from './protocol.mjs';
// The network-facing isolated wallet must use this gate for authenticated
// note reads and transfer submission. Offline backup/statement helpers stay pure.
export { WalletNetwork } from './wallet-network.mjs';

export function statement({kind=0,epoch=0,expiry=epoch+5,inputs=[],fee=0n,rewardOwner=Field(0)}) {
  if(inputs.length>2)throw new Error('at most two inputs');
  return new Statement({network:LAB_NETWORK,kind:UInt32.from(kind),epoch:UInt32.from(epoch),expiry:UInt32.from(expiry),
    second:Bool(inputs.length===2),id0:Field(inputs[0]?.id??0),id1:Field(inputs[1]?.id??0),
    commitment0:inputs[0]?commitment(inputs[0].note):Field(0),commitment1:inputs[1]?commitment(inputs[1].note):Field(0),
    fee:UInt64.from(fee),rewardOwner,nonce:Field.random()});
}
export function mintStatement(owner,epoch=0) {return statement({kind:1,epoch,rewardOwner:ownerTag(owner)});}

// Encrypted backup for this laboratory wallet only. Viewing-key delegation and
// social recovery are intentionally not implied by this basic backup format.
export function backupWallet(key,notes,password) {
  if(typeof password!=='string'||password.length<12)throw new Error('backup password must have at least 12 characters');
  const salt=randomBytes(16),iv=randomBytes(12),derived=scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  const c=createCipheriv('aes-256-gcm',derived,iv); c.setAAD(Buffer.from('sunphi-isolated-wallet-v1'));
  const plaintext=Buffer.from(canonical({key:key.toBase58(),notes:notes.map(n=>Note.toJSON(n))}));
  const ciphertext=Buffer.concat([c.update(plaintext),c.final()]);plaintext.fill(0);derived.fill(0);
  return {version:1,salt:salt.toString('hex'),iv:iv.toString('hex'),tag:c.getAuthTag().toString('hex'),ciphertext:ciphertext.toString('hex')};
}
export function restoreWallet(b,password) {
  exact(b,['version','salt','iv','tag','ciphertext']);
  if(b.version!==1||!/^([0-9a-f]{32})$/.test(b.salt)||!/^([0-9a-f]{24})$/.test(b.iv)||!/^([0-9a-f]{32})$/.test(b.tag)||
    typeof b.ciphertext!=='string'||b.ciphertext.length>2*1024*1024||!/^([0-9a-f]{2})+$/.test(b.ciphertext))throw new Error('invalid backup');
  const derived=scryptSync(password,Buffer.from(b.salt,'hex'),32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  try {
    const d=createDecipheriv('aes-256-gcm',derived,Buffer.from(b.iv,'hex'));
    d.setAAD(Buffer.from('sunphi-isolated-wallet-v1'));d.setAuthTag(Buffer.from(b.tag,'hex'));
    const plain=Buffer.concat([d.update(Buffer.from(b.ciphertext,'hex')),d.final()]);
    const decoded=JSON.parse(plain.toString());plain.fill(0);exact(decoded,['key','notes']);
    return {key:PrivateKey.fromBase58(decoded.key),notes:decoded.notes.map(n=>Note.fromJSON(n))};
  } finally {derived.fill(0);}
}
