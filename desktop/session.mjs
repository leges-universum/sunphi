import { readFileSync,writeFileSync,mkdirSync,statSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { RenewalBook } from '../src/renewing-history.mjs';
import { WalletNetwork } from '../src/wallet-network.mjs';
import { PrivateWallet } from '../src/private-wallet.mjs';
import { ProverSession } from '../src/prover-session.mjs';
import { verifyInvoice } from '../src/payment-invoice.mjs';

export function readJson(path,max=3*1024*1024){if(statSync(path).size>max)throw Error('File is too large');return JSON.parse(readFileSync(path,'utf8'));}
export function amountUnits(text){
 if(typeof text!=='string'||! /^(0|[1-9][0-9]{0,6})(\.[0-9]{1,8})?$/.test(text))throw Error('Use a positive SUN amount with at most 8 decimal places');
 const [a,b='']=text.split('.'),n=BigInt(a)*100000000n+BigInt(b.padEnd(8,'0'));
 if(n<=0n||n>281474976710655n)throw Error('Amount is outside the supported range');return n.toString();
}
export function formatUnits(text){const n=BigInt(text);return `${n/100000000n}.${(n%100000000n).toString().padStart(8,'0')}`;}
// Only public, user-selected trust files may supply network parameters. Executable
// paths and mutable databases always come from the installed app and wallet folder.
export async function openProfile({profile,state,verifier,keyPath}){
 const data=readJson(join(profile,'certificates.json')),genesis=join(profile,'genesis.json');
 if(!Array.isArray(data.certificates)||data.certificates.length>1024)throw Error('Checkpoint limit');
 mkdirSync(state,{recursive:true,mode:0o700});
 const cfg={mode:'isolated',policy:data.policy,book:join(state,'history.db'),database:join(state,'public.db'),verifier,genesis,temporary:join(state,'verify'),keyPath,rpcs:['http://127.0.0.1:25400'],witnesses:Array.from({length:10},(_,i)=>`http://127.0.0.1:${25100+i}`),archives:[0,1,2].map(i=>`http://127.0.0.1:${25000+i}`),ttlMs:15000,stallMs:30000,maxLagBlocks:64};
 // Optional endpoints only, never an arbitrary executable or file path.
 try{const endpoints=readJson(join(profile,'endpoints.json'),16384);if(Object.keys(endpoints).some(k=>!['rpcs','witnesses','archives'].includes(k)))throw Error('Unexpected endpoint setting');Object.assign(cfg,endpoints);}catch(e){if(e.code!=='ENOENT')throw e;}
 const book=await RenewalBook.open(cfg.book,data.policy,{bin:verifier,genesis,temporary:cfg.temporary});
 try{for(const c of data.certificates){if(!Number.isSafeInteger(c.body.epoch)||c.body.epoch<0)throw Error('Invalid epoch');if(c.body.epoch<=(book.context.last?.body.epoch??-1))continue;const path=join(profile,`epoch-${c.body.epoch}.json`);if(statSync(path).size>24*1024*1024)throw Error('Archive size limit');await book.accept(c,readFileSync(path));}}finally{book.close();}
 return WalletNetwork.open(cfg);
}
export class DesktopSession{
 constructor({root,profile}){this.root=root;this.profile=profile;this.wallet=null;this.network=null;this.prover=null;this.busy=false;this.results=new Map();}
 view(){return {locked:!this.wallet,network:this.network?.status??{ready:false},address:this.wallet?.address??null,inventory:this.wallet?.inventory??null,prepared:(this.wallet?.prepared??[]).map(p=>({...p,verifiedResult:this.results.get(p.txid)??null})),profile:this.profile};}
 async execute(action,args={}){
  if(this.busy)throw Error('Another operation is still running');this.busy=true;
  try{
   if(['create','open','restore'].includes(action)){
    if(this.wallet)throw Error('Lock the current wallet first');
    if(typeof args.password!=='string'||args.password.length<12||args.password.length>1024)throw Error('Use a password of 12–1024 characters');
    const path=resolve(args.path),state=path+'.network';
    this.network=await openProfile({profile:this.profile,state,verifier:join(this.root,'runtime',process.platform==='win32'?'sunphi-receipt-verifier.exe':'sunphi-abci'),keyPath:join(this.root,'profile','verification-key.json')});
    try{const options={mode:'isolated',network:this.network,path,password:args.password};
     this.wallet=action==='restore'?await PrivateWallet.restore({...options,backup:readJson(args.backup,33*1024*1024),backupPassword:args.backupPassword}):await PrivateWallet[action](options);
    }catch(e){this.network.close();this.network=null;throw e;}
    return this.view();
   }
   if(action==='status')return this.view();
   if(action==='lock'){await this.close();return this.view();}
   if(!this.wallet)throw Error('Open a wallet first');
   if(action==='invoice'){const invoice=this.wallet.invoice(amountUnits(args.amount));writeFileSync(args.path,JSON.stringify(invoice,null,2),{flag:'wx',mode:0o600});return {id:verifyInvoice(invoice).id,amount:formatUnits(invoice.amount)};}
   if(action==='import'){return await this.wallet.importReceipt(readJson(args.path));}
   if(action==='backup'){writeFileSync(args.path,JSON.stringify(this.wallet.backup(args.password)),{flag:'wx',mode:0o600});return {saved:true};}
   if(action==='review-invoice'){const invoice=readJson(args.path,16384);const {id}=verifyInvoice(invoice);this.invoice=invoice;return {id,recipient:invoice.recipient,amount:formatUnits(invoice.amount),expiresAt:invoice.expiresAt};}
   if(action==='refresh'){await this.fresh();return this.view();}
   if(action==='inspect'){await this.fresh();return await this.wallet.inspectNotes(args.ids);}
   if(action==='prepare'){
    if(!this.invoice)throw Error('Choose and review a signed invoice first');
    if(!Array.isArray(args.ids)||args.ids.length<1||args.ids.length>2||!args.ids.every(x=>typeof x==='string'))throw Error('Select one or two received notes');
    if(typeof args.fee!=='string'||! /^(0|[1-9][0-9]{0,14})$/.test(args.fee))throw Error('Fee must be an integer in base units');
    await this.fresh();this.prover??=new ProverSession({mode:'isolated',cachePath:join(this.root,'cache'),workers:4});await this.prover.ready();
    return await this.wallet.preparePayment(this.invoice,args.ids,{fee:BigInt(args.fee),prover:this.prover});
   }
   if(action==='send'||action==='recover'){
    if(!/^[0-9a-f]{64}$/.test(args.txid))throw Error('Invalid payment identifier');
    const known=await this.wallet.preparedResult(args.txid);if(!known?.final)await this.fresh();
    const result=await (action==='send'?this.wallet.sendPrepared(args.txid):this.wallet.recoverPrepared(args.txid));this.results.set(args.txid,result);return result;
   }
   if(action==='export-receipt'){const receipt=await this.wallet.paymentReceipt(args.txid);writeFileSync(args.path,JSON.stringify(receipt),{flag:'wx',mode:0o600});return {saved:true};}
   throw Error('Unknown operation');
  }finally{this.busy=false;}
 }
 async fresh(){const until=Date.now()+20000;while(true){try{await this.network.refresh();return;}catch(e){if(!e.message.includes('waiting for fresh chain progress')||Date.now()>=until)throw Error('Fresh network evidence is unavailable. No new payment was sent.');await new Promise(r=>setTimeout(r,1000));}}}
 async close(){await this.prover?.close();this.prover=null;this.wallet?.close();this.wallet=null;this.network?.close();this.network=null;this.invoice=null;this.results.clear();}
}
