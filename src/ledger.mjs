import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { LAB_NETWORK, LAB_REWARD } from './circuit.mjs';
import { canonical, digest, exact, fieldString, parseWire, VERSION, VK_SHA256 } from './protocol.mjs';
import { loadPinnedKey, verifyWire } from './verifier.mjs';

export function configCheck(c) {
  exact(c,['version','mode','network','rewardOwner','maxEpochs','verificationKeySha256']);
  if (c.mode !== 'isolated' || c.version !== VERSION || c.network !== LAB_NETWORK.toString() ||
      c.verificationKeySha256 !== VK_SHA256 || c.maxEpochs !== 100) throw new Error('unsupported laboratory config');
  fieldString(c.rewardOwner);
}
export function labConfig(rewardOwner) {
  return { version:VERSION, mode:'isolated', network:LAB_NETWORK.toString(), rewardOwner,
    maxEpochs:100, verificationKeySha256:VK_SHA256 };
}
export function empty(c) { return { epoch:0, supply:'0', fees:'0', minted:[], notes:{}, txs:{}, head:digest(c), seq:0 }; }
// Pure state transition: callers MUST verify ZK before using it for a commit.
export function applyEvent(state, event, c) {
  if (event.type === 'epoch') {
    exact(event,['type','epoch']);
    if (!Number.isSafeInteger(event.epoch) || event.epoch !== state.epoch+1 || event.epoch >= c.maxEpochs)
      throw new Error('invalid laboratory epoch');
    state.epoch=event.epoch; return;
  }
  exact(event,['type','wire']);
  if (event.type !== 'transaction') throw new Error('unknown event');
  const p = parseWire(event.wire), s=p.s;
  if (state.txs[p.txid]) throw new Error('duplicate committed transaction');
  const epoch=Number(s.epoch.toBigint()), expiry=Number(s.expiry.toBigint());
  if (epoch > state.epoch || expiry < state.epoch || expiry < epoch || expiry-epoch>10) throw new Error('expired or invalid epoch');
  if (s.kind.toBigint() === 1n) {
    if (epoch !== state.epoch || state.minted.includes(epoch)) throw new Error('emission quota already used or stale');
    if (s.rewardOwner.toString() !== c.rewardOwner || s.fee.toBigInt() !== 0n) throw new Error('wrong reward beneficiary');
    state.supply=(BigInt(state.supply)+LAB_REWARD).toString(); state.minted.push(epoch);
  } else {
    const inputs = [s.id0.toString(), ...(s.second.toBoolean() ? [s.id1.toString()] : [])];
    if (new Set(inputs).size !== inputs.length) throw new Error('duplicate input');
    for (let i=0;i<inputs.length;i++) {
      const n=state.notes[inputs[i]];
      if (!n || n.spentBy !== null) throw new Error('input missing or already spent');
      if (n.commitment !== s[`commitment${i}`].toString()) throw new Error('input commitment mismatch');
    }
    for (const id of inputs) state.notes[id].spentBy=p.txid;
    state.fees=(BigInt(state.fees)+s.fee.toBigInt()).toString();
  }
  for (let i=0;i<2;i++) {
    if (state.notes[p.ids[i]]) throw new Error('output collision');
    state.notes[p.ids[i]]={ id:p.ids[i], commitment:p.o[`commitment${i}`].toString(), createdBy:p.txid, index:i, spentBy:null };
  }
  state.txs[p.txid]=event.wire;
}

export class IsolatedLedger {
  constructor() { throw new Error('use IsolatedLedger.open with explicit isolated configuration'); }
  static async open({ mode, path, config, keyPath, anchor }) {
    if (mode !== 'isolated' || !path) throw new Error('isolated mode and database path required');
    configCheck(config);
    return LedgerInstance.openInternal({ path,config,keyPath,anchor });
  }
}

// Separate internal class prevents bypassing initialization through a public constructor.
class LedgerInstance {
  #db; #key; #config; #verified=new Set();
  static async openInternal({path,config,keyPath,anchor}) {
    const self=new LedgerInstance();
    self.#config=structuredClone(config); self.#key=loadPinnedKey(keyPath);
    mkdirSync(dirname(resolve(path)),{recursive:true});
    self.#db=new DatabaseSync(path);
    try {
      self.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      self.#db.exec('CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, body TEXT NOT NULL, prev TEXT NOT NULL, hash TEXT NOT NULL);');
      const prior=self.#db.prepare('SELECT config FROM metadata WHERE id=1').get();
      if (prior && prior.config !== canonical(config)) throw new Error('genesis configuration mismatch');
      if (!prior) self.#db.prepare('INSERT INTO metadata VALUES(1,?)').run(canonical(config));
      await self.audit();
      if (anchor) self.assertAnchor(anchor);
      return self;
    } catch(e) { self.#db.close(); throw e; }
  }
  #rows() { return this.#db.prepare('SELECT seq,body,prev,hash FROM events ORDER BY seq').all(); }
  #read() {
    const state=empty(this.#config);
    for (const row of this.#rows()) {
      if (row.seq !== state.seq+1 || row.prev !== state.head || digest({seq:row.seq,prev:row.prev,body:row.body}) !== row.hash)
        throw new Error('journal integrity failure');
      const event=JSON.parse(row.body);
      if (canonical(event) !== row.body) throw new Error('noncanonical journal');
      if (event.type==='transaction' && !this.#verified.has(digest(event.wire))) throw new Error('unverified journal record; audit required');
      applyEvent(state,event,this.#config); state.seq=row.seq; state.head=row.hash;
    }
    return state;
  }
  async audit() {
    for (const row of this.#rows()) {
      const event=JSON.parse(row.body);
      if (event.type === 'transaction') {
        await verifyWire(event.wire,this.#key); this.#verified.add(digest(event.wire));
      }
    }
    return this.checkpoint();
  }
  checkpoint() { const s=this.#read(); return {genesis:digest(this.#config),seq:s.seq,head:s.head}; }
  assertAnchor(anchor) {
    exact(anchor,['genesis','seq','head']);
    const cp=this.checkpoint();
    if (anchor.genesis !== cp.genesis || !Number.isSafeInteger(anchor.seq) || anchor.seq<0 || cp.seq<anchor.seq) throw new Error('rollback or wrong checkpoint');
    const head=anchor.seq===0 ? cp.genesis : this.#db.prepare('SELECT hash FROM events WHERE seq=?').get(anchor.seq)?.hash;
    if (head !== anchor.head) throw new Error('checkpoint fork');
  }
  #append(event, crashAt) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const s=this.#read();
      if(event.type==='transaction') {
        const {txid,ids}=parseWire(event.wire);
        if(s.txs[txid]) { this.#db.exec('ROLLBACK'); return {txid,ids,duplicate:true,checkpoint:this.checkpoint()}; }
      }
      applyEvent(s,event,this.#config);
      const body=canonical(event), seq=s.seq+1, prev=s.head, hash=digest({seq,prev,body});
      this.#db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(seq,body,prev,hash);
      if(crashAt==='before-commit') process.exit(81);
      this.#db.exec('COMMIT');
      if(crashAt==='after-commit') process.exit(82);
      const parsed=event.type==='transaction' ? parseWire(event.wire) : null;
      return { ...(parsed?{txid:parsed.txid,ids:parsed.ids}:{}),duplicate:false,checkpoint:this.checkpoint() };
    } catch(e) { try { this.#db.exec('ROLLBACK'); } catch {} throw e; }
  }
  async submit(wire, { crashAt }={}) {
    // Detach input before await so callers cannot mutate a proof after verification.
    const detached=JSON.parse(canonical(wire));
    await verifyWire(detached,this.#key);
    this.#verified.add(digest(detached));
    return this.#append({type:'transaction',wire:detached},crashAt);
  }
  advanceLabEpoch(epoch) { return this.#append({type:'epoch',epoch}); }
  status() {
    const s=this.#read();
    return {mode:'isolated',productionSupported:false,consensus:'single-local-journal',epoch:s.epoch,
      supplyBaseUnits:s.supply,feesBaseUnits:s.fees,transactions:Object.keys(s.txs).length,
      checkpoint:this.checkpoint()};
  }
  passport(id) {
    fieldString(id); const s=this.#read(), n=s.notes[id];
    if(!n) return null;
    return {version:VERSION,mode:'isolated',finality:'local-commit-only',object:n,
      creation:s.txs[n.createdBy],spend:n.spentBy?s.txs[n.spentBy]:null,checkpoint:this.checkpoint()};
  }
  listObjects() { return Object.values(this.#read().notes).map(n=>({...n})); }
  exportArchive(path) {
    const archive={config:this.#config,events:this.#rows().map(r=>JSON.parse(r.body)),checkpoint:this.checkpoint()};
    writeFileSync(path,canonical(archive),{flag:'wx'}); return archive.checkpoint;
  }
  async importArchive(path) {
    const a=JSON.parse(readFileSync(path,'utf8')); exact(a,['config','events','checkpoint']);
    if(canonical(a.config)!==canonical(this.#config) || this.checkpoint().seq!==0 || !Array.isArray(a.events)) throw new Error('archive requires empty matching ledger');
    const candidate=empty(this.#config), rows=[];
    for(const event of a.events) {
      if(event.type==='transaction') { await verifyWire(event.wire,this.#key);this.#verified.add(digest(event.wire)); }
      applyEvent(candidate,event,this.#config);
      const body=canonical(event),seq=candidate.seq+1,prev=candidate.head,hash=digest({seq,prev,body});
      rows.push({seq,body,prev,hash});candidate.seq=seq;candidate.head=hash;
    }
    const cp={genesis:digest(this.#config),seq:candidate.seq,head:candidate.head};
    if(canonical(cp)!==canonical(a.checkpoint)) throw new Error('archive head mismatch');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if(this.checkpoint().seq!==0) throw new Error('restore target changed');
      const insert=this.#db.prepare('INSERT INTO events VALUES(?,?,?,?)');
      for(const r of rows)insert.run(r.seq,r.body,r.prev,r.hash);
      this.#db.exec('COMMIT');
    } catch(e) {this.#db.exec('ROLLBACK');throw e;}
  }
  close() { this.#db.close(); }
}
