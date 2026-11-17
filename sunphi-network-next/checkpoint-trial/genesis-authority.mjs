// Bind consensus genesis to the application authority, before trusting any peer.
import assert from 'node:assert/strict';
import {validatorSet} from './validator-authority.mjs';
export function validateGenesisAuthority(genesis,config){
 const version=config.control?.version??1, members=config.control?.validators;
 assert(version===1||version===2,'unsupported genesis authority');
 assert(Array.isArray(genesis.validators),'genesis validators');
 if(members)assert.equal(validatorSet(members).version,version,'genesis authority version');
 assert(version===2?!!members:genesis.validators.length===10,'genesis authority required');
 const expected=members&&new Map(members.map(m=>[m.key,version===2?m.power:10]));
 if(expected)assert.equal(genesis.validators.length,expected.size,'genesis authority count');
 const seen=new Set();
 for(const v of genesis.validators){
  assert.equal(v.pub_key?.type,'tendermint/PubKeyEd25519');
  const key=Buffer.from(v.pub_key.value,'base64');
  assert.equal(key.length,32);assert.equal(key.toString('base64'),v.pub_key.value,'canonical genesis key');
  const id=key.toString('base64url');assert(!seen.has(id),'duplicate genesis validator');seen.add(id);
  if(expected)assert(expected.has(id),'genesis authority key mismatch');
  assert.equal(String(v.power),String(expected?expected.get(id):10),'genesis authority key or power mismatch');
 }
 return version;
}
