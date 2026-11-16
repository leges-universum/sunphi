// Isolated owner-operated laboratory deployment; no production keys or old ledgers.
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {initialize,configure} from './operator.mjs';
import {hash} from './crypto.mjs';
import {unseal} from './vault.mjs';
import {serveAttester} from './attester-service.mjs';
const [mode,dir,indexText]=process.argv.slice(2),index=Number(indexText);
const read=f=>JSON.parse(readFileSync(f));
if(mode==='init'){
 const records=[];for(let n=index;n<10;n+=2){const home=join(dir,'node'+n);assert(!existsSync(home));const secret=randomUUID();const enrollment=initialize(home,secret);writeFileSync(join(home,'attester-password'),secret,{flag:'wx',mode:0o600});records.push({slot:n,enrollment});}console.log(JSON.stringify(records));
}else if(mode==='configure'){
 const profile=join(dir,'profile');for(let n=index;n<10;n+=2){const home=join(dir,'node'+n);configure(home,profile,hash(read(join(profile,'trust-policy.json'))),{basePort:22000+n*10,listen:'127.0.0.1'});const f=join(home,'config/config.toml');let t=readFileSync(f,'utf8').replace(/^addr_book_strict = true$/m,'addr_book_strict = false').replace(/^allow_duplicate_ip = false$/m,'allow_duplicate_ip = true').replace(/^log_level = .*$/m,'log_level = "error"');writeFileSync(f,t);}console.log('configured');
}else if(mode==='attester'){
 const home=process.env.DUEBYTE_ATTESTER_HOME||join(dir,'node'+index),key=unseal(read(join(home,'checkpoint-key.encrypted.json')),readFileSync(join(home,'attester-password'),'utf8'));
 serveAttester({profile:join(dir,'profile'),home:join(home,'attester'),url:'http://127.0.0.1:'+(22001+index*10),key,port:24000+index});
}else throw Error('init/configure DIR HOST_INDEX | attester DIR SLOT');
