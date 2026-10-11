import { useState } from 'react';
import { ArrowRight, ShieldCheck, RefreshCw } from 'lucide-react';
import { primaryQuote, reserveStress, RESERVE_PLAN } from './issuance-policy.mjs';
import { readReserveAsset } from './reserve-reader.mjs';

const usd = amount => amount.toLocaleString('en-US', {style:'currency',currency:'USD',maximumFractionDigits:2});
const cents = amount => usd(Number(amount) / 100);
export function IssuancePanel() {
  const [quantity, setQuantity] = useState('1000');
  let quote;
  try { if (!/^[1-9]\d*$/.test(quantity)) throw Error(); quote=primaryQuote(BigInt(quantity)); } catch { quote=null; }
  return <section className="protocol-visual" aria-label="Initial issuance calculator"><p className="eyebrow">PURCHASE-TIME ISSUANCE / PROJECT RULE</p><h2>100 million maximum. Issued on purchase.</h2><div className="gate-strip"><span>Confirmed payment<small>$1.02 per initial token</small></span><ArrowRight/><span>Reserve acquisition<small>Full $1 token principal</small></span><ArrowRight/><span>Issue to the buyer<small>Once, within the supply cap</small></span></div><label className="number-field"><span>Initial purchase quantity (whole sun(φ))</span><input type="number" min="1" max="100000000" step="1" value={quantity} onChange={e=>setQuantity(e.target.value)}/></label><div className="calculation-result" aria-live="polite">{quote ? <><span>Buyer payment, including the 2% surcharge</span><strong>{cents(quote.buyerCents)}</strong><p>Reserve principal: {cents(quote.reserveCents)} · Platform: {cents(quote.platformCents)} · Wallet rewards: {cents(quote.rewardCents)}</p></> : <p>Enter 1 to 100,000,000 whole tokens.</p>}</div><p className="subtle">A quote calculation, not an order. No payments, live issuance or reserve purchases are enabled. $1 is the initial token price; later reserve value is variable.</p><a className="button" href="#/reserve"><ShieldCheck size={16}/>Reserve & transparency</a></section>;
}
export function ReservePanel() {
  const [rows, setRows] = useState(RESERVE_PLAN.map(entry=>({...entry,status:'not_configured'})));
  const [loading, setLoading] = useState(false);
  const [btcChange,setBtcChange]=useState('-50');
  const [usdcChange,setUsdcChange]=useState('0');
  const [issued,setIssued]=useState('1000');
  let scenario;
  try { if([btcChange,usdcChange,issued].some(v=>!v.trim()))throw Error(); scenario=reserveStress({issued:Number(issued),btcChange:Number(btcChange),usdcChange:Number(usdcChange)}); } catch { scenario=null; }
  const refresh=async()=>{
    setLoading(true);
    const result=await Promise.allSettled(RESERVE_PLAN.map(entry=>readReserveAsset(entry)));
    setRows(result.map((row,i)=>row.status==='fulfilled'?row.value:{...RESERVE_PLAN[i],status:'unavailable'}));
    setLoading(false);
  };
  const complete=rows.every(row=>row.status==='observed'&&row.usdValue!==null);
  return <section className="protocol-visual" aria-label="Reserve transparency"><p className="eyebrow">RESERVE / PUBLIC OBSERVATIONS</p><h2>See assets. Separate facts from plans.</h2><p>No reserve addresses have been designated. Hardware custody and an institutional custody alternative are under review. No live holdings or backing ratio are asserted.</p><div className="table-scroll"><table><thead><tr><th>Asset / network</th><th>Research weight</th><th>Public address</th><th>Observed balance</th></tr></thead><tbody>{rows.map((row,i)=><tr key={row.asset+i}><th>{row.asset} / {row.network}</th><td>{row.weightBps/100}%</td><td>{row.address ? <span style={{overflowWrap:'anywhere'}}>{row.address}</span> : 'Not configured'}</td><td>{row.status==='observed' ? <>{row.amount.toLocaleString('en-US',{maximumFractionDigits:8})} {row.asset}<br/>{row.usdValue===null?'USD quote unavailable':usd(row.usdValue)}<br/><small>Retrieved {row.observedAt}</small><br/><small>{row.block}</small><br/><a href={row.explorer} target="_blank" rel="noreferrer">Explorer</a></> : row.status==='not_configured'?'Not connected':'Provider unavailable'}</td></tr>)}</tbody></table></div><button className="button" disabled={loading||!RESERVE_PLAN.some(entry=>entry.address)} onClick={refresh}><RefreshCw size={16}/>{loading?'Reading public balances…':'Refresh observed balances'}</button><p className="subtle">Observed asset value: {complete?usd(rows.reduce((sum,row)=>sum+row.usdValue,0)):'Unavailable'}. Verified issued supply and net backing: unavailable. Read-only sources: mempool.space, PublicNode and Coinbase. A refresh is a dated snapshot, not continuous monitoring or proof of ownership, unrestricted reserves or solvency.</p><div className="doc-section"><h3>Research scenario: what happens when prices change?</h3><p>Assumes a fully acquired initial 90% USDC / 10% BTC basket, $1 principal per token, no later issuance, costs or liabilities. This allocation is not a legally approved launch portfolio.</p><div className="calculator-fields">{[['Scenario issued tokens',issued,setIssued,1,100000000],['BTC price change (%)',btcChange,setBtcChange,-100,1000],['USDC price change (%)',usdcChange,setUsdcChange,-100,1000]].map(([label,value,setValue,min,max])=><label className="number-field" key={label}><span>{label}</span><input type="number" min={min} max={max} step="any" value={value} onChange={e=>setValue(e.target.value)}/></label>)}</div><div className="calculation-result" aria-live="polite">{scenario?<><span>Scenario backing per token · not a market or redemption quote</span><strong>{usd(scenario.backingPerTokenUsd)}</strong><p>Basket value: {usd(scenario.reserveUsd)} · Initial principal coverage: {scenario.coveragePercent.toFixed(2)}%</p></>:<p>Enter a positive whole-token supply and price changes between −100% and +1,000%.</p>}</div></div></section>;
}
