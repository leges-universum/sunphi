import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

export function validatorKey(home){
 const k=JSON.parse(readFileSync(join(home,'config/priv_validator_key.json'),'utf8'));
 assert.equal(k.priv_key.type,'tendermint/PrivKeyEd25519');
 const raw=Buffer.from(k.priv_key.value,'base64');
 const der=Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),raw.subarray(0,32)]);
 try{
  assert.equal(raw.length,64);assert.equal(raw.subarray(32).toString('base64'),k.pub_key.value);
  return {publicKey:raw.subarray(32).toString('base64url'),privateKey:der.toString('base64url')};
 }finally{raw.fill(0);der.fill(0);}
}
