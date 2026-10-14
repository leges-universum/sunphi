// Display guidance only. The core still verifies balances, eligibility and authority.
export function walletRestriction(proc){
 if(!proc?.connected)return {message:'Start the demonstration in Overview to see your assets and available services.',action:'overview'};
 if((proc.outbox||[]).some(q=>['SUBMITTING','UNKNOWN','RECOVERY_REQUIRED'].includes(q.state))||(proc.snapshot?.transactions||[]).some(t=>t.state==='RECOVERY_REQUIRED'))return {message:'An earlier transfer still needs confirmation. Check its status in History before starting another transfer.',action:'history'};
 if(proc.stale)return {message:'Balances need updating. Refresh them before preparing a transfer.',action:'refresh'};
 return null;
}
export function assetRestriction(position,recipient=false){
 if(!position)return 'Choose an asset to see its available operations.';
 if(position.profile==='Ma')return 'This guarantee is a conditional obligation. It cannot be sent or spent as payment tokens.';
 if(recipient&&!['Vi','Pi','Go','Bl','Gr'].includes(position.profile))return 'Sending this asset to another holder is not supported.';
 if(BigInt(position.available||'0')<=0n)return 'No tokens are available to transfer. Reserved and pending amounts cannot be spent.';
 return '';
}
export function availableRoutes(snapshot,sourceId){
 return (snapshot?.routes||[]).filter(r=>r.source===sourceId&&r.status==='ACTIVE'&&snapshot.positions.some(p=>p.id===r.destination)&&!policyRestriction(snapshot,{id:sourceId})&&!policyRestriction(snapshot,{id:r.destination}));
}
export function policyRestriction(snapshot,position){
 const codes=snapshot?.actionRestrictions?.[position?.id]||[];
 if(codes.includes('HOLDER_NOT_ELIGIBLE'))return 'Holder verification is missing, expired, revoked or outside this product’s scope. Ask the servicing institution to review eligibility.';
 if(codes.includes('POLICY_UNAVAILABLE'))return 'Required participation or product checks are unavailable. New operations are blocked; existing rights and income remain recorded.';
 if(codes.includes('INTERFACE_NOT_QUALIFIED'))return 'This asset interface is not qualified. Choose an admitted product; external token networks are not connected.';
 return '';
}
export function ownProductRestriction(snapshot,position){
 const limit=policyRestriction(snapshot,position)||assetRestriction(position);
 if(limit)return limit;
 if(!availableRoutes(snapshot,position.id).length)return (snapshot.routes||[]).some(r=>r.source===position.id)?'Transfers and exchanges between your products are temporarily unavailable for this asset.':'No transfer or exchange between your own products is available for this asset. You can check whether it can be sent to another wallet.';
 return '';
}
