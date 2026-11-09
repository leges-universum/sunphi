import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

// consumer-setup persists a client-options envelope, not the bounded options
// themselves. Never silently fall back to the legacy reader on a malformed file.
export function readWalletProfile(home){
 const file=join(home,'indexed-wallet.json');if(!existsSync(file))return null;
 const envelope=JSON.parse(readFileSync(file));
 assert(envelope&&Object.keys(envelope).length===1&&Object.hasOwn(envelope,'bounded'),'invalid indexed wallet profile envelope');
 const bounded=envelope.bounded;
 assert(bounded&&typeof bounded==='object'&&!Array.isArray(bounded),'invalid bounded wallet profile');
 assert(typeof bounded.url==='string','missing bounded wallet endpoint');
 assert(bounded.fresh?!(bounded.source||bounded.certificate):(bounded.source&&bounded.certificate),'ambiguous or missing bounded wallet authority');
 return bounded;
}
