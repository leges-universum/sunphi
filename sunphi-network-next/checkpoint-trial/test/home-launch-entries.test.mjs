import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {launchEntryAllowed,acceptedHomeInstall,reconcileShortcuts,managedLaunch,shortcutFiles} from '../home-launch-entries.mjs';
const current={edition:'home',platform:'windows-x64',version:'0.3.71',rootSha256:'trusted'};
const release=()=>current;
test('only standard DueByte Home entries from the same trusted publisher qualify',()=>{
 for(const user of ['Test User','Олена'])assert(launchEntryAllowed({target:`C:\\Users\\${user}\\Old\\DueByte.exe`,args:'--connect'},current,{readRelease:()=>({...current,version:'0.3.39'})}));
 for(const args of ['--user-data-dir=C:\\Other','--inspect','--connect --user-data-dir=C:\\Other'])assert(!launchEntryAllowed({target:'C:\\Old\\DueByte.exe',args},current,{readRelease:release}));
 for(const changes of [{version:'0.3.72'},{edition:'server'},{rootSha256:'other'}])assert(!launchEntryAllowed({target:'C:\\Old\\DueByte.exe',args:''},current,{readRelease:()=>({...current,...changes})}));
});
test('only an accepted matching install can change launch entries; staging and rollback cannot',()=>{
 const state=path.resolve('qa-state'),top=path.join(state,'updates/releases/71'),root=path.join(top,'resources/app');let receipt={passed:true,version:'0.3.71'},installed={top,descriptor:{folder:'71',version:'0.3.71'}};
 const opts={release,read:file=>file.endsWith('last-install.json')?receipt:installed,verify:()=>({config:current})};
 assert(acceptedHomeInstall(root,state,opts));receipt={passed:false,version:'0.3.71'};assert(!acceptedHomeInstall(root,state,opts));receipt={passed:true,version:'0.3.70'};assert(!acceptedHomeInstall(root,state,opts));receipt={passed:true,version:'0.3.71'};installed={...installed,top:path.resolve('outside')};assert(!acceptedHomeInstall(root,state,opts));
});
test('shortcut repair preserves custom entries, backs up originals and is idempotent',()=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'duebyte-launch-test-')),files=['home.lnk','custom.lnk'].map(n=>path.join(state,n));for(const f of files)fs.writeFileSync(f,'original');
 const entries=new Map(files.map((f,i)=>[f,{target:'C:\\Old\\DueByte.exe',args:i?'--user-data-dir=C:\\Isolated':'',description:'My node'}]));const writes=[];
 const shell={readShortcutLink:f=>({...entries.get(f)}),writeShortcutLink:(f,op,value)=>{assert.equal(op,'update');writes.push(f);entries.set(f,{...entries.get(f),...value});return true;}};
 const opts={files,shell,exe:'C:\\New\\DueByte.exe',current,state,readRelease:release};
 assert.deepEqual(reconcileShortcuts(opts),{updated:1,unchanged:0,skipped:1,failed:0});assert.equal(entries.get(files[0]).args,managedLaunch);assert.equal(entries.get(files[0]).description,'My node');assert.equal(fs.readFileSync(path.join(state,'updates/shortcut-backups',fs.readdirSync(path.join(state,'updates/shortcut-backups'))[0]),'utf8'),'original');
 assert.equal(reconcileShortcuts(opts).unchanged,1);assert.equal(writes.length,1);assert.equal(shortcutFiles([state,state]).filter(f=>files.includes(f)).length,2);
});
test('a shortcut edited while being inspected is not overwritten',()=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'duebyte-launch-race-')),file=path.join(state,'home.lnk');fs.writeFileSync(file,'original');let reads=0,writes=0;
 const shell={readShortcutLink:()=>({target:'C:\\Old\\DueByte.exe',args:reads++?'--user-data-dir=custom':''}),writeShortcutLink:()=>{writes++;return true;}};
 assert.equal(reconcileShortcuts({files:[file],shell,exe:'C:\\New\\DueByte.exe',current,state,readRelease:release}).failed,1);assert.equal(writes,0);
});
