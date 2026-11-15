// Cross-platform lab entry point. Production uses the non-root Linux daemon.
import fs from 'node:fs';import assert from 'node:assert/strict';import {digest} from '../../crypto.mjs';import {openSigningVault} from '../../research/exchange-signing-vault.mjs';
import {ExchangeSigningAuthority} from '../../research/exchange-signing-authority.mjs';import {signingService} from '../../research/exchange-signing-service.mjs';
import {createBackend} from './exchange-vault-backend.mjs';
import {connectSigningCoordinator} from '../../research/exchange-signing-coordination.mjs';
let authority,backend;
try{
 const p=JSON.parse(fs.readFileSync(process.argv[2])),password=fs.readFileSync(3);fs.closeSync(3);let s;
 try{const bytes=fs.readFileSync(p.vault.file);assert.equal(digest(bytes),p.vault.sha256);s=openSigningVault(JSON.parse(bytes),p,password);}finally{password.fill(0);}
 const coordinator=p.backendConfig.coordinator?await connectSigningCoordinator(p,s):undefined;
 backend=await createBackend(p.backendConfig,s.backendSecrets);const key=Buffer.from(s.inventoryKey,'hex');
 try{authority=new ExchangeSigningAuthority(p.inventory,{config:p.config,key,backend,coordinator});}finally{key.fill(0);}
 const server=signingService({authority,key:s.tlsKey,cert:s.tlsCert,ca:s.tlsCA,clients:p.clients});s=undefined;
 server.listen(p.port,'127.0.0.1',()=>process.stdout.write('READY\n'));
 process.on('SIGTERM',()=>server.close(()=>{authority.close();backend.close();process.exit(0);}));
}catch{process.stderr.write('Isolated vault signer refused startup.\n');process.exit(1);}
