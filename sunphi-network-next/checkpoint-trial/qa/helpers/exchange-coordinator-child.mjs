// Isolated coordinator process. Its credential is never in a signer backup.
import fs from 'node:fs';import {SigningCoordinator} from '../../research/exchange-signing-coordinator.mjs';import {coordinatorService} from '../../research/exchange-coordinator-service.mjs';
try{
 const p=JSON.parse(fs.readFileSync(process.argv[2])),raw=fs.readFileSync(3);fs.closeSync(3);let s;try{s=JSON.parse(raw);}finally{raw.fill(0);}
 const key=Buffer.from(s.key,'hex');let c;try{c=new SigningCoordinator(p.file,{config:p.config,key,create:!fs.existsSync(p.file)});}finally{key.fill(0);}
 const server=coordinatorService({coordinator:c,key:s.tlsKey,cert:s.tlsCert,ca:s.tlsCA,clients:p.clients});s=undefined;
 server.listen(p.port,'127.0.0.1',()=>process.stdout.write('READY\n'));
 process.on('SIGTERM',()=>server.close(()=>{c.close();process.exit(0);}));
}catch{process.stderr.write('Isolated coordinator refused startup.\n');process.exit(1);}
