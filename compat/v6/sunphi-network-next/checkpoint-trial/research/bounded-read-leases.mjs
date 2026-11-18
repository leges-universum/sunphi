// Bounded WAL read transactions keep one authenticated root stable during writes.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {statSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
export class BoundedReadLeases{
 constructor(handler,{clock=()=>performance.now(),ttl=30000,retained=8,maxLeases=8,walLimit=64*1024*1024,rootReader=null}={}){
  assert([ttl,retained,maxLeases,walLimit].every(Number.isSafeInteger)&&ttl>0&&ttl<=60000&&retained>=1&&retained<=16&&maxLeases>=1&&maxLeases<=16&&walLimit>=1024);
  this.handler=handler;this.clock=clock;this.ttl=ttl;this.retained=retained;this.maxLeases=maxLeases;this.walLimit=walLimit;this.rootReader=rootReader;this.roots=new Map();this.leases=new Map();
  this.observe=()=>{try{this.pin();}catch{this.clear();}};this.unsubscribe=handler.store.onCommit(this.observe);this.pin();
  this.timer=setInterval(()=>{try{this.prune();}catch{this.clear();}},1000);this.timer.unref();
 }
 clear(){this.leases.clear();for(const r of this.roots.values())r.reader.close();this.roots.clear();}
 prune(){
  const now=this.clock();for(const [id,l]of this.leases)if(l.expires<=now)this.leases.delete(id);
  const pinned=new Set([...this.leases.values()].map(l=>l.root)),recent=[...this.roots.keys()].slice(-this.retained);
  const s=this.handler.networkHeader?.(),sample=s?.centurySubsidy?.pending?.home?.sample;
  if(sample?.root){const r=this.roots.get(sample.root);if(r&&now-r.created<=180000)pinned.add(sample.root);}
  for(const [root,r]of this.roots)if(!pinned.has(root)&&(!recent.includes(root)||now-r.created>this.ttl)){r.reader.close();this.roots.delete(root);}
  let bytes=0;try{bytes=statSync(this.handler.store.file+'-wal').size;}catch{}
  if(bytes>this.walLimit){this.clear();const db=this.handler.store.db;try{db.exec('PRAGMA busy_timeout=0; PRAGMA wal_checkpoint(TRUNCATE)');}catch{}finally{db.exec('PRAGMA busy_timeout=3000');}}
 }
 pin(){this.prune();const root=this.handler.root;if(!this.roots.has(root))this.roots.set(root,{reader:this.handler.store.readSnapshot(root),created:this.clock()});this.prune();}
 acquire(root){this.pin();assert(this.leases.size<this.maxLeases,'read lease capacity');if(!this.roots.has(root)&&this.rootReader){const reader=this.rootReader(root);assert.equal(reader.root,root);this.roots.set(root,{reader,created:this.clock()});}assert(this.roots.has(root),'read root unavailable');const token=randomBytes(24).toString('hex');this.leases.set(token,{root,expires:this.clock()+this.ttl});return {token,root,ttlMs:this.ttl};}
 resolve(token,root){this.prune();const lease=this.leases.get(token);assert(lease&&lease.root===root,'read lease expired or wrong root');const reader=this.roots.get(root)?.reader;assert(reader,'read root unavailable');return {store:reader,get root(){return reader.root;}};}
 release(token){this.leases.delete(token);this.prune();}
 close(){clearInterval(this.timer);this.unsubscribe();this.clear();}
}
