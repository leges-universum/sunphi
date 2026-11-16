import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {BoundedProcessLog,captureChildLog} from '../bounded-process-log.mjs';
test('Home diagnostic flood remains bounded across restarts while the child completes',async()=>{
 const dir=fs.mkdtempSync(join(tmpdir(),'duebyte-log-')),file=join(dir,'transport.log');fs.writeFileSync(file,Buffer.alloc(200000,120));
 for(let round=0;round<2;round++){const log=new BoundedProcessLog(file,{bytes:8192,copies:2}),child=spawn(process.execPath,['-e',"for(let i=0;i<500;i++){process.stdout.write('x'.repeat(4096));process.stderr.write('y'.repeat(1000));}process.stdout.write('FINAL MARKER');"],{windowsHide:true,stdio:['ignore','pipe','pipe']});captureChildLog(child,log);await new Promise((ok,no)=>{child.once('error',no);child.once('close',code=>{assert.equal(code,0);ok();});});for(const n of fs.readdirSync(dir))assert(fs.statSync(join(dir,n)).size<=8192);assert.equal(fs.readdirSync(dir).length,3);}
});
