import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Store} from '../store.mjs';
const [dir,point]=process.argv.slice(2),c=JSON.parse(readFileSync(join(dir,'config.json'))),s=new Store(join(dir,'state.sqlite'),c);
const request=JSON.parse(readFileSync(join(dir,'request.json')));request.txs=request.txs.map(b=>Buffer.from(b,'base64'));s.finalize(request);s.commit(point);
