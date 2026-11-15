import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {archiveStaging,cleanArchiveStaging} from '../research/archive-staging.mjs';
import {cleanSnapshotCandidates} from '../research/snapshot-staging.mjs';
test('archive staging cleanup bounds restart work and preserves immutable history and resume references',t=>{
 const dir=fs.mkdtempSync(join(tmpdir(),'duebyte-archive-staging-'));t.after(()=>fs.rmSync(dir,{recursive:true}));const file=join(dir,'state.sqlite'),history=file+'.history';fs.mkdirSync(history);const staging=archiveStaging(history);
 const durable=join(history,'a'.repeat(64)+'.sqlite'),reference=join(history,'.reference-'+'b'.repeat(64)+'.json');fs.writeFileSync(durable,'retained');fs.writeFileSync(reference,'retained');
 for(let i=0;i<5;i++)fs.writeFileSync(join(staging,'.pending-'+randomUUID()+'.sqlite'),'unfinished');
 assert.equal(cleanArchiveStaging(file,{limit:2}).removed,2);assert.equal(fs.readdirSync(staging).length,3);assert.equal(cleanArchiveStaging(file).removed,3);assert.equal(fs.readFileSync(durable,'utf8'),'retained');assert.equal(fs.readFileSync(reference,'utf8'),'retained');
 fs.writeFileSync(join(staging,'unknown.sqlite'),'retained');assert.throws(()=>cleanArchiveStaging(file),/unknown/);assert(fs.existsSync(join(staging,'unknown.sqlite')));
});

test('archive staging snapshot renewal removes obsolete chunks without losing current chunks or durable objects',t=>{
 const home=fs.mkdtempSync(join(tmpdir(),'duebyte-snapshot-staging-'));t.after(()=>fs.rmSync(home,{recursive:true}));const root=join(home,'indexed-incoming'),keep='a'.repeat(64),old='b'.repeat(64);for(const name of [keep,old,'.archive-validation'])fs.mkdirSync(join(root,name),{recursive:true});
 const target=join(home,'application-indexed.sqlite'),history=target+'.history';fs.mkdirSync(history);const durable=join(history,'c'.repeat(64)+'.sqlite');fs.writeFileSync(durable,'complete canonical history');
 fs.writeFileSync(join(root,keep,'0.json'),'verified chunk');fs.writeFileSync(join(root,keep,'1.json.pending'),'incomplete chunk');fs.writeFileSync(join(root,old,'0.json'),'superseded');fs.writeFileSync(join(root,'.archive-validation','ephemeral.sqlite'),'not authority');
 const assembled='assembled-'+randomUUID()+'.sqlite';fs.writeFileSync(join(root,old,assembled),'unpublished');fs.mkdirSync(join(root,old,assembled+'.history'));fs.linkSync(durable,join(root,old,assembled+'.history',pathBase(durable)));
 cleanSnapshotCandidates(home,{keep});assert(!fs.existsSync(join(root,old)));assert.deepEqual(fs.readdirSync(join(root,keep)),['0.json']);assert.equal(fs.readFileSync(durable,'utf8'),'complete canonical history');assert(fs.existsSync(join(root,'.archive-validation','ephemeral.sqlite')));
 fs.writeFileSync(join(root,keep,'unknown'),'retain unknown');assert.throws(()=>cleanSnapshotCandidates(home,{keep}),/unknown/);assert(fs.existsSync(join(root,keep,'unknown')));fs.writeFileSync(target,'active');assert.throws(()=>cleanSnapshotCandidates(home,{keep}),/active state/);
});
const pathBase=file=>file.split(/[\\/]/).at(-1);

test('archive staging snapshot cleanup rejects directory links', {skip:process.platform==='win32'},t=>{
 const home=fs.mkdtempSync(join(tmpdir(),'duebyte-snapshot-link-'));t.after(()=>fs.rmSync(home,{recursive:true}));const outside=join(home,'retained');fs.mkdirSync(outside);fs.writeFileSync(join(outside,'0.json'),'retained');const root=join(home,'indexed-incoming');fs.mkdirSync(root);fs.symlinkSync(outside,join(root,'b'.repeat(64)));assert.throws(()=>cleanSnapshotCandidates(home,{keep:'a'.repeat(64)}),/directory type/);assert.equal(fs.readFileSync(join(outside,'0.json'),'utf8'),'retained');
});
