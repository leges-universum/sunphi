import test from 'node:test';import assert from 'node:assert/strict';
import {recoveryObservation,recoveryPresentation} from '../home-recovery.mjs';
import {consumerDashboard} from '../consumer-view.mjs';
import {BOUNDED_HOME} from '../home-verification.mjs';
const now=Date.now(),p={phase:'headers',height:100,target:140,startedAt:now-10000,updatedAt:now};
test('recovery presents checked progress and distinct state/retry stages without asserting readiness',()=>{
 assert.match(recoveryPresentation(p,now).detail,/40 remaining/);
 assert.match(recoveryPresentation({...p,phase:'state'},now).title,/balances/);
 assert.match(recoveryPresentation(p,now+46000).title,/Reconnecting/);
 assert.equal(recoveryPresentation({...p,phase:'complete'},now),null);
 for(const bad of [{height:-1},{target:50},{height:1.5},{updatedAt:now+60000},{phase:'verified'}])assert.equal(recoveryObservation({...p,...bad},now),null);
 assert(!consumerDashboard({network:'test',homeVerification:BOUNDED_HOME,progress:'checking-history',recoveryProgress:{...p,height:140}},now).connected);
});
