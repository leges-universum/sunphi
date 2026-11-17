// Exercise the actual presentation functions with already verified payment data.
// No wallet keys, signing, network mutations or personal session access.
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const out=process.argv[3]??'F:/DueByteWork/wallet-sender';fs.mkdirSync(out,{recursive:true});
const saved=JSON.parse(fs.readFileSync('F:/DueByteWork/wallet86/post-install-1794843752309/verified-view.json'));
const entries=Object.entries(saved.state.money.requests).filter(([,r])=>r.intent?.recipient==='8NPs9FAr2XxzkUEz1vtbKgP8DWoTBHT8UTqmWULljYQ'&&r.status==='SETTLED');assert(entries.length>0);
const results=[];
for(const [pid,r]of entries){
 const source=fs.readFileSync(process.argv[2]?process.argv[2]+'/wallet-server.mjs':new URL('../wallet-server.mjs',import.meta.url),'utf8'),start=source.indexOf('function historyRecord('),end=source.indexOf('function userError(',start);assert(start>0&&end>start);
 const ctx={owner:r.intent.recipient,bounded:true,view:{state:{money:{requests:{[pid]:r},time:saved.state.money.time}},history:{items:[{id:pid,value:r}],total:1}},wallet:{db:{prepare:()=>({get:()=>undefined,all:()=>[]})},terminalRecords:()=>({[pid]:r})},paymentFee:()=>r.intent.fee,paymentAmounts:()=>({}),scheduled:()=>false,outgoingStatus:()=>r.status,spendPolicy:()=>null};
 vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
 const check=(row,direction)=>{assert.equal(row.direction,direction);assert.equal(row.sender,r.intent.sender);assert.equal(row.recipient,r.intent.recipient);assert.equal(row.pid,pid);};
 check(vm.runInContext('indexedHistory().rows[0]',ctx),'Received');
 check(vm.runInContext('records()[0]',ctx),'Received');
 ctx.bounded=false;ctx.view.state.money.requests={};check(vm.runInContext('records()[0]',ctx),'Received');
 ctx.owner=r.intent.sender;check(vm.runInContext('records()[0]',ctx),'Sent');
 results.push({pid,sender:r.intent.sender,recipient:r.intent.recipient,status:r.status,indexed:true,current:true,savedTerminal:true,outgoing:true});
}
fs.writeFileSync(out+'/data-report.json',JSON.stringify({passed:true,verifiedSnapshot:saved.certificate,results,readOnly:true},null,2));console.log(JSON.stringify({passed:true,records:results.length,paths:['indexed','current','savedTerminal','outgoing']}));
