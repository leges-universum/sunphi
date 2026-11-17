import {readFileSync,writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {ProviderExchange} from '../../exchange-provider.mjs';
const c=JSON.parse(readFileSync(process.argv[2],'utf8'));
const adapter={identity:'payward-services-v2:sandbox',authorize:async()=>{},execute:async()=>{
  if(c.beforeDispatch)process.exit(74);
  // Simulate an external provider that durably executed, followed by immediate local process death.
  writeFileSync(c.count,'1',{flush:true});process.exit(73);
}};
const service=new ProviderExchange(new DatabaseSync(c.file),{adapter,scope:'fixture:chain-1',storageKey:Buffer.alloc(32,5),signingKey:c.signer,clock:()=>1800000000000});
await service.accept(c.id,c.owner.publicKey,c.signature);
