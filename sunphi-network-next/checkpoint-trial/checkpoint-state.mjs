import assert from 'node:assert/strict';
import {hash} from './crypto.mjs';
import {stateHash} from './core.mjs';
import {verifyCheckpoint,checkpointPolicy} from './checkpoint.mjs';
import {policyFields} from './authority.mjs';
export function checkPolicyState(doc,state,config,root){
 if(!config.control){assert.equal((doc.renewals??[]).length,0,'legacy genesis cannot renew policy');return;}
 assert.equal(hash(config.control.policy),hash(policyFields(root)),'original policy must match genesis');
 const renewals=doc.renewals??[];assert.equal(hash(state.authority.renewals),hash(renewals),'policy chain must match certified state');
 assert.equal(hash(state.authority.policy),hash(policyFields(checkpointPolicy(doc,root,hash(config)))),'certified policy fields');
}
export function checkCheckpointState(doc,state,config,root){
 verifyCheckpoint(doc,root,{configHash:hash(config)});assert.equal(state.height,doc.body.appHeight);
 assert.equal(stateHash(state,config),doc.body.appHash);assert.equal(hash(state),doc.body.snapshotHash);checkPolicyState(doc,state,config,root);
}
