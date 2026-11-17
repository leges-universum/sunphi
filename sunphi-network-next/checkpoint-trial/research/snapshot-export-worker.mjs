import {parentPort,workerData} from 'node:worker_threads';
import {finishSnapshotExport} from './indexed-snapshot.mjs';
if(parentPort)parentPort.postMessage(finishSnapshotExport(workerData));
