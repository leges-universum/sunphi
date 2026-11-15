// Clean-genesis authority is explicit. It is never a migration certificate.
import {DatabaseSync} from 'node:sqlite';
import {sqlitePath} from '../sqlite-path.mjs';
import {verifyFreshManifest,openFreshChain} from './fresh-chain-preparation.mjs';
import {BoundedApplication} from './bounded-application.mjs';
import {verifyBoundedViewAnchor} from './bounded-root-transition.mjs';
import {BOUNDED_DOMAIN} from './bounded-network-interpreter.mjs';

export function freshRootTerms(config,{manifest,manifestHash}){
 verifyFreshManifest(config,manifest,manifestHash);
 return {kind:'fresh-genesis',manifestHash,network:manifest.network,configHash:manifest.configHash,
  targetSchema:BOUNDED_DOMAIN,sourceHeight:0,activationHeight:1,sourceRoot:manifest.stateHash,targetRoot:manifest.root,archive:null};
}
export function openFreshApplication(file,config,fresh,options={}){
 const terms=freshRootTerms(config,fresh),reader=new DatabaseSync(sqlitePath(file),{readOnly:true});let root;
 try{root=reader.prepare('SELECT rootHash FROM meta WHERE id=1').get().rootHash;}finally{reader.close();}
 const blocks=openFreshChain(file,config,fresh.manifest,fresh.manifestHash,root,options);
 try{verifyBoundedViewAnchor(blocks.handler.store.proof('meta/anchor',root).value,terms);return new BoundedApplication(blocks.handler,terms);}
 catch(e){blocks.close();throw e;}
}
