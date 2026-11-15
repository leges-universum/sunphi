import fs from 'node:fs';
import {AuthenticatedRecordStore} from '../research/authenticated-record-store.mjs';
import {compactJournalBatch} from '../research/journal-codec.mjs';
const [file,root,phase]=process.argv.slice(2),store=new AuthenticatedRecordStore(file,root);
function pause(){fs.writeSync(1,'READY\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
compactJournalBatch(store.db,{beforeCommit:phase==='before'?pause:()=>{}});pause();
