// Isolated cross-platform child, credentials only through an inherited pipe.
import fs from 'node:fs';
import {ExchangeSigningAuthority} from '../../research/exchange-signing-authority.mjs';
import {signingService} from '../../research/exchange-signing-service.mjs';
import {createBackend} from './exchange-service-backend.mjs';
const x=JSON.parse(fs.readFileSync(3,'utf8'));fs.closeSync(3);
const authority=new ExchangeSigningAuthority(x.file,{config:x.config,key:Buffer.from(x.key,'hex'),backend:await createBackend(x.backend,x.secrets)});
const server=signingService({authority,...x.tls});
server.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({port:server.address().port})+'\n'));
process.on('SIGTERM',()=>server.close(()=>{authority.close();process.exit(0);}));
