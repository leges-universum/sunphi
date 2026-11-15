// Isolated host supervisor. Never accepts an operational inventory path.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {SigningCoordinator} from '../../research/exchange-signing-coordinator.mjs';
import {coordinatorService} from '../../research/exchange-coordinator-service.mjs';
import {recoverCoordinatorFromWitness,recoverCoordinatorPair} from '../../research/exchange-coordinator-continuity.mjs';
const [command,root,label]=process.argv.slice(2);
assert(/^\/var\/lib\/duebyte-qa-continuity56-r[1-9][0-9]*$/.test(root));assert(/^(clean|uncertain-reserve|uncertain-sign)-(primary|witness|replacement|recovery|rebuilt-primary|rebuilt-witness)$/.test(label));
const dir=path.join(root,label),profile=JSON.parse(fs.readFileSync(dir+'/profile.json'));
assert.equal(profile.file,dir+'/inventory.sqlite');assert(['primary','witness','recovery'].includes(profile.role));
assert(Number.isInteger(profile.port)&&profile.port>=29456&&profile.port<=29458);
const credentials=JSON.parse(fs.readFileSync(dir+'/credentials.json')),key=Buffer.from(credentials.key,'hex');
const save=(name,value)=>{const temp=dir+'/'+name+'.new';const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,dir+'/'+name);};
let c;
try{
 c=new SigningCoordinator(profile.file,{config:profile.config,key,create:command==='init'});key.fill(0);
 if(command==='init'){
  credentials.continuity=c.rotateContinuity(profile.role);save('credentials.json',credentials);console.log(JSON.stringify({initialized:true,role:profile.role}));c.close();
 }else if(command==='serve'){
  assert.equal(c.continuityRole(),profile.role);const server=coordinatorService({coordinator:c,key:credentials.tlsKey,cert:credentials.tlsCert,ca:credentials.tlsCA,clients:profile.clients});
  server.listen(profile.port,'127.0.0.1',()=>console.log('READY'));
  server.on('error',()=>process.exit(1));process.on('SIGTERM',()=>server.close(()=>{c.close();process.exit(0);}));
 }else if(command==='status'){
  const snapshot=c.recoverySnapshot();console.log(JSON.stringify({role:c.continuityRole(),records:snapshot.records.length,status:c.status()}));c.close();
 }else if(command==='recover'){
  const nextKey=randomBytes(32);let recovered;
  try{recovered=recoverCoordinatorFromWitness({witness:c,config:profile.config,key:nextKey,directory:dir});
   credentials.continuity=recovered.witnessCapability;save('credentials.json',credentials);
   save('recovery-private.json',{file:recovered.file,key:nextKey.toString('hex'),continuity:recovered.primaryCapability});
   console.log(JSON.stringify(recovered.report));
  }finally{nextKey.fill(0);c.close();}
 }else if(command==='recover-pair'){
  const primaryKey=randomBytes(32),witnessKey=randomBytes(32);
  try{const r=recoverCoordinatorPair({recovery:c,config:profile.config,primaryKey,witnessKey,directory:dir});
   credentials.continuity=r.recoveryCapability;save('credentials.json',credentials);
   save('pair-recovery-private.json',{primary:{file:r.primary.file,key:primaryKey.toString('hex'),continuity:r.primary.capability},witness:{file:r.witness.file,key:witnessKey.toString('hex'),continuity:r.witness.capability}});
   console.log(JSON.stringify(r.report));
  }finally{primaryKey.fill(0);witnessKey.fill(0);c.close();}
 }else throw Error('Unknown isolated supervisor command');
}catch(e){key.fill(0);try{c?.close();}catch{}
 // Do not print assertion operands: credentials must never enter a log.
 console.error(JSON.stringify({failed:true,stage:command,type:e.name,uncertain:/uncertain witness/.test(e.message)}));process.exit(1);
}
