import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {nodeLogOffsets,nodeFailureMessage} from '../consumer-errors.mjs';
test('only current-attempt diagnostics are shown and raw secret content never escapes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'duebyte-errors-'));fs.mkdirSync(dir+'/node');const file=dir+'/node/application.log';fs.writeFileSync(file,'EACCES old run\n');const offsets=nodeLogOffsets(dir);
 fs.appendFileSync(file,'PRIVATE_SECRET_SHOULD_NOT_ESCAPE\nEADDRINUSE 127.0.0.1:30303\n');const result=nodeFailureMessage(dir,offsets,1,null);
 assert.match(result,/port is already in use/);assert.match(result,/Exit code: 1/);assert(!result.includes('PRIVATE_SECRET')&&!result.includes('30303')&&!result.includes('blocked access'));
 const later=nodeFailureMessage(dir,nodeLogOffsets(dir),2,null);assert(!later.includes('port is already in use'));assert.match(later,/node-supervisor.log/);
});
test('known local failures have actionable categories and retain data instructions',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'duebyte-errors-'));fs.mkdirSync(dir+'/node');
 for(const [error,match] of [['supervisor already running or PID reused',/retained process lock/],['ENOSPC',/disk.*full/],['EPERM',/blocked access/],['old header has expired',/bootstrap checkpoint has expired/],['stored state integrity',/integrity check/],['database is locked',/holding the node data/],['ENOENT',/file is missing/]]){
  fs.writeFileSync(dir+'/node-supervisor.log',error);assert.match(nodeFailureMessage(dir,{},1,null),match);
 }
});
