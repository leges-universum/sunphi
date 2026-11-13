// Public peer label only. This reports the application version, not an
// attestation of the software binary or independent ownership.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
export function versionedMoniker(name,version){
 assert(typeof name==='string');assert(/^0\.3\.[0-9]{1,4}$/.test(version),'application version');
 let base=name.replace(/ \[DueByte\/0\.3\.[0-9]{1,4}\]$/,'');
 const suffix=' [DueByte/'+version+']';
 while(Buffer.byteLength(base+suffix)>128)base=Array.from(base).slice(0,-1).join('');
 return base+suffix;
}
export function advertiseConsumerVersion(home,version){
 const file=join(home,'config/config.toml'),text=readFileSync(file,'utf8');
 const match=/^moniker = ("(?:[^"\\]|\\.)*")[ \t]*\r?$/m.exec(text);assert(match,'node moniker');
 const label=versionedMoniker(JSON.parse(match[1]),version),next=text.replace(match[0],'moniker = '+JSON.stringify(label));
 if(next!==text){const pending=file+'.version.tmp';writeFileSync(pending,next,{mode:0o600});renameSync(pending,file);}
 return label;
}
