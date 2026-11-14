import {AuthenticatedRecordStore} from '../research/authenticated-record-store.mjs';
import {archiveJournalPrefix} from '../research/journal-segment.mjs';
const [file,root,phase]=process.argv.slice(2),store=new AuthenticatedRecordStore(file,root);
archiveJournalPrefix(store,{through:16,rows:16,afterPhase:at=>{if(at===phase){process.stdout.write('READY\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}});
throw Error('crash phase not reached');
