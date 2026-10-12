// Token quantity is independent of valuation. No live price feed is implied.
export const TOKEN_MODEL='sunphi-token-quantity-v1';
export const BASKET='XDR-2022';
const fixtures={
 'a-pi':['Pi','USD',2,'20','27'], 'a-pi-service':['Pi','USD',2,'20','27'],
 'b-pi':['Pi','USD',2,'20','27'], 'a-vi':['Vi','XDR reference',4,'1','1'],
 'a-go':['Go','USD',2,'20','27'], 'b-bl':['Bl','fund units',4,'500','27'],
 'b-gr':['Gr','USD face',2,'20','27'], 'a-ma':['Ma','USD maximum',2,'20','27']
};
export function tokenUnit(position){return position?.token?.model===TOKEN_MODEL?'sun(φ) '+position.profile:position?.denomination||'';}
export function validateToken(position){
 const t=position?.token;
 if(!t||t.model!==TOKEN_MODEL||t.symbol!=='sun(φ) '+position.profile||t.precision!==position.precision||t.underlyingUnit!==position.denomination||t.underlyingUnitsPerToken!=='1'||t.definition!=='laboratory-unit-definition-1')throw Error('Missing or invalid token unit definition');
}
export function tokenisePosition(position){
 const p=structuredClone(position),f=fixtures[p.id];
 if(!f||p.profile!==f[0]||p.denomination!==f[1]||p.precision!==f[2]||p.termsVersion!=='test-terms-1')throw Error('Unsupported legacy instrument: an explicit token unit definition is required');
 if(p.token){validateToken(p);return p;}
 p.token={model:TOKEN_MODEL,symbol:'sun(φ) '+p.profile,precision:p.precision,underlyingUnit:p.denomination,underlyingUnitsPerToken:'1',definition:'laboratory-unit-definition-1'};
 p.basketValuation={basket:BASKET,unit:'XDR',numerator:f[3],denominator:f[4],asOf:Date.UTC(2026,9,12),source:'SunPhi fixed demonstration fixture',quoteId:'demo-xdr-20261012-'+p.id,demonstration:true,
  basis:p.profile==='Ma'?'Contingent face reference — not spendable value':p.profile==='Gr'?'Face reference — not a market price':p.profile==='Bl'?'Fixed test fund-unit price':'Fixed test reference'};
 return p;
}
export function validateValuation(p){
 const v=p.basketValuation;
 if(!v||v.basket!==BASKET||v.unit!=='XDR'||!/^\d{1,24}$/.test(v.numerator)||!/^\d{1,24}$/.test(v.denominator)||BigInt(v.denominator)<=0n||!Number.isSafeInteger(v.asOf)||!v.source||!v.quoteId||v.demonstration!==true)throw Error('Invalid laboratory basket valuation');
}
// Half-up rounding for DISPLAY ONLY. Signed payment quantities are never rounded.
export function basketEstimate(p,quantity){
 try{validateToken(p);validateValuation(p);}catch{return null;}
 if(!/^\d{1,25}$/.test(String(quantity))||!Number.isInteger(p.precision)||p.precision<0||p.precision>12)return null;
 const v=p.basketValuation,n=BigInt(quantity)*BigInt(v.numerator)*10000n,d=10n**BigInt(p.precision)*BigInt(v.denominator);
 const value=((n*2n+d)/(d*2n)).toString().padStart(5,'0');
 return value.slice(0,-4).replace(/\B(?=(\d{3})+(?!\d))/g,',')+'.'+value.slice(-4);
}
export function quoteTokenValue(p,decimal){
 if(typeof decimal!=='string'||!/^\d{1,24}(?:\.\d{1,12})?$/.test(decimal))return null;
 const [whole,fraction='']=decimal.split('.');
 if(fraction.length>p.precision)return null;
 return basketEstimate(p,(BigInt(whole)*10n**BigInt(p.precision)+BigInt(fraction.padEnd(p.precision,'0')||'0')).toString());
}
