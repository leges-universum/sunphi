import fs from 'node:fs';
import path from 'node:path';
import {writeJSON} from './update-core.mjs';

// Connection intent survives an application/update restart. Only an explicit
// Disconnect clears it; shutdown and temporary transport failure do not.
export function homeConnectionWanted(state,argv=[]){
 if(argv.includes('--connect'))return true;
 try{const saved=JSON.parse(fs.readFileSync(path.join(state,'connection-intent.json'),'utf8'));return saved.schema===1&&saved.connect===true;}catch{return false;}
}
export function saveHomeConnectionIntent(state,connect){
 if(typeof connect!=='boolean')throw Error('Connection choice must be boolean');
 writeJSON(path.join(state,'connection-intent.json'),{schema:1,connect});
}
