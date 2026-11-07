import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {versionedMoniker,advertiseConsumerVersion} from '../consumer-version.mjs';
test('public application label replaces only its own version and remains byte bounded',()=>{
 assert.equal(versionedMoniker('DESKTOP-EXAMPLE','0.3.34'),'DESKTOP-EXAMPLE [DueByte/0.3.34]');
 assert.equal(versionedMoniker('DESKTOP-EXAMPLE [DueByte/0.3.33]','0.3.34'),'DESKTOP-EXAMPLE [DueByte/0.3.34]');
 const label=versionedMoniker('\u4e2d'.repeat(100),'0.3.34');assert(Buffer.byteLength(label)<=128);assert(!label.includes('\ufffd'));
 assert.throws(()=>versionedMoniker('host','bad\nversion'));
});
test('version announcement preserves all non-moniker settings and retained files',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'duebyte-version-'));fs.mkdirSync(dir+'/config');
 const old='moniker = "DESKTOP-EXAMPLE"\nlog_level = "info"\n[rpc]\nladdr = "tcp://127.0.0.1:28001"\n';fs.writeFileSync(dir+'/config/config.toml',old);fs.writeFileSync(dir+'/config/node_key.json','retained fixture');
 advertiseConsumerVersion(dir,'0.3.34');const next=fs.readFileSync(dir+'/config/config.toml','utf8');assert.equal(next,old.replace('DESKTOP-EXAMPLE','DESKTOP-EXAMPLE [DueByte/0.3.34]'));
 advertiseConsumerVersion(dir,'0.3.34');assert.equal(fs.readFileSync(dir+'/config/config.toml','utf8'),next);assert.equal(fs.readFileSync(dir+'/config/node_key.json','utf8'),'retained fixture');
});
