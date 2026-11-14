// Production issuance is restricted to the already admitted terminal pilot.
// This gate supplements controller signatures, supply pins and replay checks.
import assert from 'node:assert/strict';
import {amount} from '../payment-model.mjs';
import {auditZeroStage,guardZeroStageAction} from '../zero-stage.mjs';
import {zeroStageProposal,terminalPilot} from './zero-stage-plan.mjs';
import {ZERO_STAGE_CEILING_MICRO,ISSUE_FOUNDER_ADVANCE} from '../founder-advance-policy.mjs';

export const ZERO_STAGE_MINTS=Object.freeze([
 'ISSUE_CENTURY_WARMUP_TRANCHE_V1',ISSUE_FOUNDER_ADVANCE,'OPEN_COLLATERAL_SUPPORT_V1'
]);
export function productionIssuanceLimit(s,a){
 if(!ZERO_STAGE_MINTS.includes(a?.type))return 0n;
 const b=s.centuryFunds?.zeroStage?.body;
 assert(b&&terminalPilot(b.settings),'issuance forbidden: terminal pilot admission required');
 auditZeroStage(s);guardZeroStageAction(s,a);
 const p=zeroStageProposal({configHash:b.configHash,root:b.observedRoot,height:b.observedHeight,workers:b.workers,settings:b.settings}).body;
 assert(amount(p.totalInitialMicro)<=amount(ZERO_STAGE_CEILING_MICRO),'zero-stage issuance ceiling');
 return amount(p.totalInitialMicro);
}
