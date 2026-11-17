// Isolated contract simulator. Invented routes and rates, never real money or partner sandbox.
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
export function changeNowSimulator({file=':memory:',clock=Date.now,payinAddress}) {
  const db=new DatabaseSync(file);db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS swaps(id TEXT PRIMARY KEY, body TEXT NOT NULL)');
  const control={lostCreate:false,badCreate:false,statusCode:0,posts:0,gets:0,estimateOverride:null};
  const get=id=>JSON.parse(db.prepare('SELECT body FROM swaps WHERE id=?').get(id).body);
  const set=(id,fields)=>{const value={...get(id),...fields};db.prepare('UPDATE swaps SET body=? WHERE id=?').run(JSON.stringify(value),id);return value;};
  const server=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');const u=new URL(req.url,'http://127.0.0.1');
    const reply=v=>res.end(JSON.stringify(v));
    try {
      if(req.headers['x-changenow-api-key']!=='simulation-only'){res.statusCode=401;return reply({});}
      if(req.method==='GET')control.gets++;
      if(u.pathname==='/v2/validate/address')return reply({result:!!u.searchParams.get('address'),isActivated:null,message:null});
      if(u.pathname==='/v2/exchange/estimated-amount')return reply({...Object.fromEntries(u.searchParams),toAmount:'0.75',depositFee:'0',withdrawalFee:'0.01',rateId:'simulated-rate',validUntil:new Date(clock()+120000).toISOString(),warningMessage:'LOCAL SIMULATION — no real funds',...control.estimateOverride});
      if(req.method==='POST'&&u.pathname==='/v2/exchange') {
        let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>16384)throw Error();}
        const b=JSON.parse(raw),id=randomUUID();control.posts++;
        const row={id,status:'waiting',...b,payinAddress,payinExtraId:'',payoutAddress:b.address,payoutExtraId:b.extraId,
          expectedAmountFrom:b.fromAmount,expectedAmountTo:'0.75',toAmount:'0.75',amountFrom:null,amountTo:null,
          updatedAt:new Date(clock()).toISOString(),validUntil:new Date(clock()+120000).toISOString()};
        db.prepare('INSERT INTO swaps VALUES(?,?)').run(id,JSON.stringify(row));
        if(control.lostCreate){req.socket.destroy();return;}
        return reply(control.badCreate?{...row,payoutAddress:'malformed-create'}:row);
      }
      if(u.pathname==='/v2/exchange/by-id'){
        if(control.statusCode){res.statusCode=control.statusCode;res.setHeader('Retry-After','60');return reply({message:'simulated error'});}
        return reply(get(u.searchParams.get('id')));
      }
      res.statusCode=404;reply({});
    }catch{res.statusCode=400;reply({});}
  });
  return {server,db,control,get,set,close:async()=>{await new Promise(r=>server.close(r));db.close();}};
}
