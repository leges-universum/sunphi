import fs from 'node:fs';
import {BoundedNetworkInterpreter} from '../research/bounded-network-interpreter.mjs';
const input=JSON.parse(fs.readFileSync(process.argv[2])),db=BoundedNetworkInterpreter.open(input.file,input.config,input.root,{isolatedIssuance:false});
function pause(){fs.writeSync(1,'READY\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
db.commitBlock(input.request,input.root,{beforeCommit:input.phase==='before'?pause:undefined});pause();
