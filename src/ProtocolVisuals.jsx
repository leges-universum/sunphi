import { useState } from 'react';
import { ArrowRight, ArrowLeft, KeyRound, Layers, ShieldCheck, Eye, Network, Wallet, ArrowLeftRight } from 'lucide-react';

const stages = [
  ['Payment', 'Ivan chooses Anna and transfer T.', 'Ivan owns M7 / H7. No transfer is complete.', 'Owner: Ivan'],
  ['Sending time', 'Ivan signs the exact payment instruction and sending time.', 'A signed request must still be accepted as the unique reservation.', 'Signed request'],
  ['Reservation', 'The network accepts the reservation for Anna.', 'M7 / H7 stays unchanged. The separate reservation blocks another accepted spend.', 'Reserved for Anna'],
  ['Fragments', 'Anna reconstructs and checks M7 / H7.', 'Data recovered ≠ credit authorized. Assembly supplies no private key or right to spend.', 'Still reserved'],
  ['Receipt time', 'Verify the current reservation, recipient and owner; bind receipt time.', 'A newer timestamp alone does not prove the latest accepted state.', 'Receipt payload ready'],
  ['Signature', 'Anna signs the bound receipt with her private key.', 'A signed candidate must still pass unique network acceptance and durable placement.', 'Signed; awaiting acceptance'],
  ['Credit', 'Accept M8 / H8 with Anna as its owner.', 'Only this accepted outcome makes the balance spendable. Reject a conflicting cancellation or replay.', 'Owner: Anna'],
];

export function TransactionVisual() {
  const [step, setStep] = useState(0);
  return <section className="protocol-visual" aria-label="Interactive two-circuit transaction">
    <p className="eyebrow">TOKEN 123 / ILLUSTRATIVE WALKTHROUGH</p><h2>Two circuits. One accepted outcome.</h2>
    <div className="circuit-lanes">{[[0, 3, '01 / SEND & RESERVE'], [3, 7, '02 / RECEIVE & CREDIT']].map(([start, end, label]) => <div className="circuit" key={label}><h3>{label}</h3><div className="stage-row">{stages.slice(start, end).map(([name], i) => <button key={name} aria-pressed={step === start + i} onClick={() => setStep(start + i)}><span>{start + i + 1}</span>{name}</button>)}</div></div>)}</div>
    <div className="stage-detail" key={step} aria-live="polite"><span className="badge">{stages[step][3]}</span><h3>{stages[step][1]}</h3><p>{stages[step][2]}</p><div className="token-state"><span>Main <strong>{step === 6 ? 'M8 / H8' : 'M7 / H7'}</strong></span><span>Temporary part <strong>{step < 2 ? 'Not yet accepted' : step === 6 ? 'Terminal evidence retained' : 'Reservation T → Anna'}</strong></span></div></div>
    <div className="visual-controls"><button className="button" disabled={step === 0} onClick={() => setStep(step - 1)}><ArrowLeft size={16}/>Previous</button><span>{step + 1} / 7</span><button className="button" disabled={step === 6} onClick={() => setStep(step + 1)}>Next<ArrowRight size={16}/></button></div>
    <p className="subtle">Design walkthrough, not a live payment. Distributed acceptance and durability remain implementation work.</p>
    <div className="gate-strip"><span><Layers size={19}/>Recover data<small>Availability calculation</small></span><ArrowRight/><span><KeyRound size={19}/>Verify authority<small>Parties + signatures</small></span><ArrowRight/><span><ShieldCheck size={19}/>Accept one result<small>Exclusive state + durability</small></span></div>
    <a className="text-link" href="#/probability">Calculate the fragment-availability gate <ArrowRight size={15}/></a>
  </section>;
}

export function TokenVisual() {
  return <section className="protocol-visual" aria-label="Token anatomy diagram"><p className="eyebrow">TOKEN ANATOMY / PROPOSED FORMAT</p><h2>Public state. Private authority.</h2><div className="anatomy-grid"><div className="anatomy-main"><Layers/><h3>Main object</h3><dl><dt>Permanent identity</dt><dd>Token 123 + issuance evidence</dd><dt>Accepted ownership</dt><dd>Owner key + state revision</dd><dt>Last credit</dt><dd>Receipt time + recent signed history</dd></dl><div className="fragment-bars" aria-hidden="true">{Array.from({ length: 8 }, (_, i) => <span key={i} style={{ '--i': i }}/>)}</div><p>Encode → distribute n fragments → recover from k valid distinct fragments</p></div><div className="anatomy-extra"><Network/><h3>Reservation</h3><p>Only in transit</p><p>Main hash · transfer ID · sender → recipient · sending time · sender signature</p><span className="badge">Separate, unfragmented</span></div><div className="key-boundary"><KeyRound/><div><h3>Private key stays with its owner</h3><p>Never stored inside the token or its fragments. Reconstructing the main object does not recover a signing key.</p></div></div></div><a className="text-link" href="#/transaction">See how both parts work in a transfer <ArrowRight size={15}/></a></section>;
}

export function PrivacyVisual() {
  return <section className="protocol-visual" aria-label="Privacy and identity-link diagram"><p className="eyebrow">PRIVACY / POSSIBLE CORRELATIONS</p><h2>A wallet key is a pseudonym.</h2><div className="privacy-map"><div><Eye/><h3>Public records</h3><p>Keys, token ID, signed history and timestamps</p><small>Links between transfers</small></div><span className="map-connector">may correlate ↔</span><div><Network/><h3>Network observations</h3><p>Peer IPs and connection timing</p><small>Connection ≠ proven person</small></div><span className="map-connector">may correlate ↔</span><div><Wallet/><h3>External identity</h3><p>Exchange orders, bank and customer records</p><small>Known to the relevant provider</small></div></div><p className="subtle">These are possible links, not proof that every observer sees every layer. Fragmentation does not hide all three. Full anonymity is not established.</p></section>;
}

export function ConversionPanel() {
  const [amount, setAmount] = useState('1000');
  const [rate, setRate] = useState('0.000001');
  const gross = Number(amount) * Number(rate);
  const valid = amount.trim() !== '' && rate.trim() !== '' && Number.isFinite(gross) && gross > 0 && Number(amount) > 0 && Number(rate) > 0;
  const btc = value => value.toLocaleString('en-US', { maximumSignificantDigits: 12 }) + ' BTC';
  return <section className="protocol-visual conversion-panel" aria-label="Conversion planner"><div className="conversion-heading"><ArrowLeftRight/><span className="badge">Planning preview · exchange not live</span></div><h2>Convert sun(φ) to Bitcoin.</h2><p>Start with your wallet, review a funded offer, then approve settlement. Wallet connection and trading are not yet available.</p><div className="conversion-route"><a href="#/wallet"><Wallet size={22}/><strong>SunPhi wallet</strong><small>Balance & signing authority</small></a><ArrowRight/><div><strong>sun(φ) → BTC</strong><small>Offer + settlement checks</small></div><ArrowRight/><div><strong>Your BTC wallet</strong><small>Verified destination</small></div></div><div className="calculator-fields"><label className="number-field"><span>Amount to sell (sun(φ))</span><input type="number" min="0" step="any" value={amount} onChange={e => setAmount(e.target.value)}/></label><label className="number-field"><span>Assumed gross price (BTC per sun(φ))</span><input type="number" min="0" step="any" value={rate} onChange={e => setRate(e.target.value)}/></label></div><div className="calculation-result" aria-live="polite">{valid ? <><span>Illustrative seller proceeds · after inclusive 2% fee</span><strong>{btc(gross * 0.98)}</strong><p>Buyer pays {btc(gross)} · Platform {btc(gross * 0.01)} · Wallet reward funding {btc(gross * 0.01)}</p></> : <p>Enter positive finite amounts for both assumptions.</p>}</div><p className="subtle">An example, not a market quote, peg or executable order. Rounding is for display, not settlement. Network fees, liquidity, slippage and any onward conversion costs are excluded. Reward funding is used to acquire existing sun(φ) for allocation by authorized wallet time.</p><div className="doc-actions"><a className="button primary" href="#/wallet"><Wallet size={16}/>Wallet & connection</a><a className="button" href="#/economics">Fees & rewards<ArrowRight size={16}/></a></div><p>Other crypto and fiat routes require supported markets and payment providers. No provider connection or cash withdrawal is active.</p></section>;
}

export function WalletPanel() {
  return <section className="protocol-visual" aria-label="Wallet connection status"><p className="eyebrow">WALLET / CONNECTION</p><h2>Your wallet is the starting point.</h2><p>The SunPhi wallet client and connection protocol have not been released. There is no connected account, available balance or signing session on this website.</p><div className="gate-strip"><span><Wallet/>Connect wallet<small>Identify the chosen account</small></span><ArrowRight/><span><ArrowLeftRight/>Review conversion<small>Price, fee, destination</small></span><ArrowRight/><span><KeyRound/>Approve in wallet<small>Sign only the reviewed operation</small></span></div><p className="subtle">Proposed connection flow. Website access and wallet connection must not automatically authorize a spend. Never enter a private key or recovery phrase here.</p><a className="button primary" href="#/exchange">Open conversion planner <ArrowRight size={16}/></a></section>;
}
