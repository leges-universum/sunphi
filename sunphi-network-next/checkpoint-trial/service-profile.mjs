// Services use the same pinned clean-genesis terms as their local application.
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {freshRootTerms} from './research/fresh-application.mjs';
import {indexedSchemaRootTerms} from './research/indexed-schema-upgrade.mjs';
export function serviceBoundedProfile(profile,config){
 const read=p=>JSON.parse(readFileSync(p)),file=join(profile,'indexed-checkpoint-operator.json');
 if(!existsSync(file))return undefined;
 const {applicationHome}=read(file);assert(typeof applicationHome==='string'&&applicationHome);
 const schemaFile=join(applicationHome,'indexed-schema-activation.json');
 if(existsSync(schemaFile)){
  assert(!existsSync(join(applicationHome,'fresh-activation.json'))&&!existsSync(join(applicationHome,'indexed-activation.json')),'ambiguous service authority');
  const {certificate,trustedBoundary,readPort}=read(schemaFile),schemaUpgrade={certificate,trustedBoundary};indexedSchemaRootTerms(config,schemaUpgrade);
  assert(Number.isInteger(readPort)&&readPort>=1024&&readPort<=65535);return {url:'http://127.0.0.1:'+readPort,schemaUpgrade};
 }
 const {manifest,manifestHash,readPort}=read(join(applicationHome,'fresh-activation.json'));
 assert(Number.isInteger(readPort)&&readPort>=1024&&readPort<=65535);const fresh={manifest,manifestHash};freshRootTerms(config,fresh);
 return {url:'http://127.0.0.1:'+readPort,fresh};
}
