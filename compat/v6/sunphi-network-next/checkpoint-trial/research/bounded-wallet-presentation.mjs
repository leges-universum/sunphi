import {isBoundedWalletView} from './bounded-wallet-view.mjs';
import {monetaryAnalytics,displayAmounts} from '../wallet-amounts.mjs';
import {unitScale} from '../token-units.mjs';
export function walletAnalytics(v){
 const m=v.state.money,requests=Object.values(m.requests),nodes=Object.values(m.nodes),indexed=isBoundedWalletView(v.state),scale=String(unitScale(v.state));
 return {scope:indexed?'owner':'retained-network',height:v.certificate.height,appHeight:v.state.height,blockHash:v.certificate.blockHash,checkpoint:v.checkpointId,
  ...(indexed?{unitScale:scale,supply:m.supply,volume:null,display:displayAmounts({supply:m.supply,volume:null},scale)}:monetaryAnalytics(v.state)),
  outputs:Object.keys(m.outputs).length,workerSeats:nodes.length,operatorGroups:new Set(nodes.map(n=>n.operator)).size,
  settled:indexed?null:requests.filter(r=>r.status==='SETTLED').length,reserved:requests.filter(r=>r.status==='RESERVED').length,expired:indexed?null:requests.filter(r=>r.status==='EXPIRED').length};
}
