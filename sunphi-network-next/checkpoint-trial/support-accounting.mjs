import {hash} from './crypto.mjs';import {amount} from './payment-model.mjs';
export const SUPPORT_DOMAIN='DUEBYTE_COLLATERAL_SUPPORT_V1';
export const supportIssued=s=>amount(s.centuryFunds?.support?.book.issuedMicro??'0');
export const supportAccount=configHash=>Buffer.from(hash({domain:SUPPORT_DOMAIN,configHash,kind:'pool-account'}),'hex').toString('base64url');
export const supportOutput=configHash=>hash({domain:SUPPORT_DOMAIN,configHash,kind:'pool-output'});
export const lockedSupport=(s,node)=>amount(s.centuryFunds?.support?.book.grants[node]?.lockedMicro??'0');
export function guardSupportPayment(s,i){const a=supportAccount(s.configHash);if(i.sender===a||i.recipient===a)throw Error('support pool cannot use ordinary payments');}
