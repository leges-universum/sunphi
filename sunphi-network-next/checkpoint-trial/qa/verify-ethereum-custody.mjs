// Offline verifier. Password arrives on stdin; no original journal key or RPC.
// The caller supplies an independently retained envelope hash and checkpoint.
import fs from 'node:fs';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
import {digest,exact,hex} from '../crypto.mjs';import {restoreExternalCustody} from '../research/exchange-custody.mjs';
const [file,expectedHash,expectedCheckpoint,destination]=process.argv.slice(2);hex(expectedHash);hex(expectedCheckpoint);assert(destination&&!fs.existsSync(destination));
assert(fs.statSync(file).size<70*1024*1024);const raw=fs.readFileSync(file);assert.equal(digest(raw),expectedHash);const kit=JSON.parse(raw);exact(kit,['config','profile','bundle']);
let password=fs.readFileSync(0,'utf8'),restored;
try{
 restored=restoreExternalCustody(kit.bundle,{config:kit.config,profile:kit.profile,password,expectedCheckpoint,file:destination,journalKey:randomBytes(32)});
 assert.equal(restored.signingEnabled,false);assert.equal(restored.worker.restored,true);
 console.log(JSON.stringify({verified:true,signingEnabled:false,seller:kit.profile.seller,publicKeys:restored.publicKeys,checkpoint:expectedCheckpoint}));
}catch{console.error('Encrypted custody verification failed; no signing enabled.');process.exitCode=1;}
finally{password='';restored?.worker.close();}
