// A delivered candidate is not active until checkpoint verification and setup
// commit the one-way installation binding. Recovery never falls back to V6.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {hash} from './crypto.mjs';
import {readJSON,loadRelease,sha256} from './update-core.mjs';
import {randomUUID} from 'node:crypto';
import {validateTransitionDelivery,verifiedTransitionDelivery} from './profile-delivery.mjs';

export function homeLaunchProfile(root,state){
 const original=readJSON(path.join(root,'connection-profile.json')),pin=readJSON(path.join(root,'connection-pin.json')).sha256;
 assert.equal(hash(original),pin);assert.equal(loadRelease(root).networkPin,pin);
 const bindingFile=path.join(state,'installation.json');
 if(!fs.existsSync(bindingFile)||readJSON(bindingFile).profileHash===pin)return {profile:original,pin};
 const binding=readJSON(bindingFile);assert.equal(binding.network,original.config.chainId);
 const selected=readJSON(path.join(state,'updates/profiles/selected.json'));
 assert(/^[a-f0-9]{64}$/.test(selected.sha256),'invalid selected delivery digest');
 const bytes=fs.readFileSync(path.join(state,'updates/profiles',selected.sha256+'.json'));
 assert.equal(sha256(bytes),selected.sha256,'selected profile damaged');const body=JSON.parse(bytes);
 assert.equal(body.toProfileHash,binding.profileHash,'selected profile differs from installed binding');
 // Expiration gates NEW activation; an already committed installation must
 // remain recoverable offline. Its exact profile hash is pinned by setup.
 validateTransitionDelivery(body,loadRelease(root),original,body.issuedAt);
 return {profile:body.profile,pin:body.toProfileHash};
}
export function rememberHomeTransition(root,state,receipt){
 const body=verifiedTransitionDelivery(receipt),original=readJSON(path.join(root,'connection-profile.json'));
 validateTransitionDelivery(body,loadRelease(root),original);
 assert.equal(sha256(fs.readFileSync(receipt.file)),receipt.sha256,'verified delivery changed before selection');
 assert.equal(path.resolve(receipt.file),path.resolve(state,'updates/profiles',receipt.sha256+'.json'));
 const file=path.join(state,'updates/profiles/selected.json'),temp=file+'.'+randomUUID(),fd=fs.openSync(temp,'wx',0o600);
 try{fs.writeFileSync(fd,JSON.stringify({sha256:receipt.sha256}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);
 if(process.platform!=='win32'){const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
 return {profile:body.profile,pin:body.toProfileHash};
}
