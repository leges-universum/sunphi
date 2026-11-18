// No keys or live ledger handles cross this worker boundary.
import {parentPort,workerData} from 'node:worker_threads';
import {IndexedSnapshotReceiver} from './indexed-snapshot.mjs';
if(parentPort)parentPort.postMessage(new IndexedSnapshotReceiver(workerData).install());
