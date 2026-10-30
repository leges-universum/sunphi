import { randomBytes, scrypt, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { canonical, exact, decode64, newKey, importSecret, identity, addressOf, NETWORK } from './crypto.mjs';

const derive = promisify(scrypt);
export const KDF = Object.freeze({name:'scrypt',N:131072,r:8,p:1});
function passwordBytes(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw Error('Use a password of 12 to 1024 characters');
  return Buffer.from(password,'utf8');
}
async function keyFor(password, salt) {
  const bytes = passwordBytes(password);
  try { return await derive(bytes,decode64(salt,32),32,{N:KDF.N,r:KDF.r,p:KDF.p,maxmem:256*1024*1024}); }
  finally { bytes.fill(0); }
}
export function validateVault(vault) {
  exact(vault,['header','ciphertext','tag']);
  const h=vault.header;
  exact(h,['format','network','publicKey','address','kdf','salt','cipher','iv']);
  exact(h.kdf,['name','N','r','p']);
  if(h.format!=='sunphi-encrypted-wallet-v1'||h.network!==NETWORK||h.cipher!=='aes-256-gcm'||
     canonical(h.kdf)!==canonical(KDF)||h.address!==addressOf(h.publicKey)) throw Error('Unsupported wallet format');
  decode64(h.salt,32);decode64(h.iv,12);decode64(vault.tag,16);decode64(vault.ciphertext,48);
  return h;
}
export async function seal(key,password) {
  // Password check before generation/derivation; fixed parameters prevent hostile KDF amplification.
  passwordBytes(password).fill(0);
  const header={format:'sunphi-encrypted-wallet-v1',network:NETWORK,...identity(key),
    kdf:{...KDF},salt:randomBytes(32).toString('base64'),cipher:'aes-256-gcm',iv:randomBytes(12).toString('base64')};
  const derived=await keyFor(password,header.salt);
  const secret=key.export({type:'pkcs8',format:'der'});
  try {
    const cipher=createCipheriv('aes-256-gcm',derived,decode64(header.iv,12));
    cipher.setAAD(Buffer.from(canonical(header)));
    const ciphertext=Buffer.concat([cipher.update(secret),cipher.final()]).toString('base64');
    return {header,ciphertext,tag:cipher.getAuthTag().toString('base64')};
  } finally { derived.fill(0);secret.fill(0); }
}
export async function createVault(password) {
  passwordBytes(password).fill(0);
  return seal(newKey(),password);
}
export async function unlock(vault,password) {
  validateVault(vault);
  const derived=await keyFor(password,vault.header.salt);
  let first,secret;
  try {
    const decipher=createDecipheriv('aes-256-gcm',derived,decode64(vault.header.iv,12));
    decipher.setAAD(Buffer.from(canonical(vault.header)));decipher.setAuthTag(decode64(vault.tag,16));
    first=decipher.update(decode64(vault.ciphertext,48));
    secret=Buffer.concat([first,decipher.final()]);
    const key=importSecret(secret);
    if(identity(key).publicKey!==vault.header.publicKey)throw Error();
    return key;
  } catch { throw Error('Wrong password or damaged wallet'); }
  finally { derived.fill(0);first?.fill(0);secret?.fill(0); }
}
