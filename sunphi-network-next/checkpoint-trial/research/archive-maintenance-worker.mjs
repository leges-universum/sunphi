import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {sqlitePath} from '../sqlite-path.mjs';
import {JournalStore} from './journal-store.mjs';
import {archiveJournalPrefix} from './journal-segment.mjs';
const db=new DatabaseSync(sqlitePath(workerData.file),{readOnly:true}),journal=new JournalStore(db,{file:workerData.file});
try{db.exec('PRAGMA trusted_schema=OFF; BEGIN');const store={db,journal,file:workerData.file,get meta(){return db.prepare('SELECT * FROM meta WHERE id=1').get();}};parentPort.postMessage(archiveJournalPrefix(store,{...workerData,prepareOnly:true}));}
finally{journal.close();db.close();}
