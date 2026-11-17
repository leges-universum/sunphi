import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {homeConnectionWanted,saveHomeConnectionIntent} from '../home-connection-intent.mjs';

test('connection survives a new process, while explicit disconnect survives relaunch',t=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'duebyte-intent-'));t.after(()=>fs.rmSync(state,{recursive:true,force:true}));
 assert.equal(homeConnectionWanted(state),false);
 const script=`import {saveHomeConnectionIntent} from ${JSON.stringify(new URL('../home-connection-intent.mjs',import.meta.url).href)};saveHomeConnectionIntent(${JSON.stringify(state)},true);process.exit(0);`;
 execFileSync(process.execPath,['--input-type=module','-e',script],{windowsHide:true});
 assert.equal(homeConnectionWanted(state),true);
 saveHomeConnectionIntent(state,false);assert.equal(homeConnectionWanted(state),false);
 assert.equal(homeConnectionWanted(state,['--connect']),true,'explicit startup connection still works');
 assert.equal(homeConnectionWanted(state,['--duebyte-managed-launch']),false);
 assert.throws(()=>saveHomeConnectionIntent(state,'true'));
});
test('malformed preferences do not enable an unsolicited connection',t=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'duebyte-intent-'));t.after(()=>fs.rmSync(state,{recursive:true,force:true}));
 for(const bytes of ['{','{"schema":2,"connect":true}','{"schema":1,"connect":"true"}']){
  fs.writeFileSync(path.join(state,'connection-intent.json'),bytes);assert.equal(homeConnectionWanted(state),false);
 }
});
