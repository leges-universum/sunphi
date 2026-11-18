// Explicit one-time pre-emission migration. Existing signed history is immutable.
import assert from 'node:assert/strict';
import {hash,exact,integer,verify} from './crypto.mjs';import {quorum} from './authority.mjs';
import {tokenCap} from './token-units.mjs';import {developmentManager} from './reserve-recovery.mjs';
import {previewTokenPrecision} from './precision-preview.mjs';
import {memorialAware} from './economic-policy-v3.mjs';
export const PRECISION_ACTION='ACTIVATE_TOKEN_PRECISION_V1';
export function applyTokenPrecision(base,a,c){
 exact(a,['type','certificate','founderConsent']);assert.equal(a.type,PRECISION_ACTION);exact(a.certificate,['body','approvals']);const b=a.certificate.body;
 exact(b,['domain','network','configHash','generation','notBefore','expires','decimals','supplyBefore','planHash']);assert.equal(b.domain,'DUEBYTE_TOKEN_PRECISION_V1');assert.equal(b.network,c.chainId);assert.equal(b.configHash,base.configHash);assert.equal(b.generation,base.authority.generation);integer(b.notBefore,1);integer(b.expires,b.notBefore);assert(b.expires-b.notBefore<=100&&b.notBefore<=base.height&&base.height<=b.expires,'precision inclusion window');quorum(b,a.certificate.approvals,base.authority.validators,7);
 assert.equal(b.decimals,6);assert(!base.money.unitScale,'precision already activated');assert.equal(b.supplyBefore,base.money.supply,'supply changed since preparation');
 assert(memorialAware(base.economicPreparation?.plan.version),'memorial-aware economic preparation required');assert.equal(b.planHash,base.economicPreparation.planHash,'approved economic plan');
 assert(verify(b,a.founderConsent,developmentManager(base.networkReserves)),'founder precision consent');
 const {state:s}=previewTokenPrecision(base);assert(BigInt(s.money.supply)<=tokenCap(s));
 s.networkReserves.history=hash({previous:s.networkReserves.history,precision:hash(a.certificate),height:s.height});return s;
}
