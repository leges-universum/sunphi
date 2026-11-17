import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configuredArchiveSources} from '../research/archive-transport.mjs';
test('archive routes preserve existing configured state-sync sources and reject ambiguous or external routes',t=>{
 const home=fs.mkdtempSync(join(tmpdir(),'duebyte-archive-routes-'));t.after(()=>fs.rmSync(home,{recursive:true}));fs.mkdirSync(join(home,'config'));
 const file=join(home,'config/config.toml'),sources=['http://127.0.0.1:26001','http://127.0.0.1:26011'];
 for(const ending of ['','\n[consensus]\ntimeout_commit = "10s"\n']){const text='[statesync]\nenable = true\nrpc_servers = "'+sources.join(',')+'"\n'+ending;fs.writeFileSync(file,text);assert.deepEqual(configuredArchiveSources(home),sources);assert.equal(fs.readFileSync(file,'utf8'),text);}
 fs.writeFileSync(file,'[statesync]\nrpc_servers = "http://example.com,http://127.0.0.1:26011"\n');assert.throws(()=>configuredArchiveSources(home),/authenticated SSH/);
 fs.writeFileSync(file,'[statesync]\nrpc_servers = "'+sources.join(',')+'"\nrpc_servers = ""\n');assert.throws(()=>configuredArchiveSources(home),/ambiguous RPC/);
 fs.writeFileSync(join(home,'run-settings.json'),JSON.stringify({archiveSources:sources}));assert.deepEqual(configuredArchiveSources(home),sources);
});
