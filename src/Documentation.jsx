import { useState } from 'react';
import { ArrowUpRight, ArrowLeft, ArrowRight, Download, Github } from 'lucide-react';
import { documents, DOCUMENT_VERSION, REPOSITORY_URL } from './docs-content';
import { logFragmentFailure, fragmentFailureLabel, reconstructionThreshold, attackEconomics, nodeRewardScenario, fundedTokenQuantity } from './research-math.mjs';

function DocumentCards({ compact = false }) {
  return <div className="docs-grid">{(compact ? documents.filter(d => ['network', 'specifications', 'issuance', 'rules', 'probability', 'security'].includes(d.id)) : documents).map((doc) => <a className="doc-card" key={doc.id} href={`#/${doc.id}`}><span className="eyebrow">{doc.category}</span><h3>{doc.title}<ArrowUpRight size={17}/></h3><p>{doc.summary}</p><span className="doc-status">{doc.status}</span></a>)}</div>;
}

export function DocumentationTeaser() {
  return <section id="documentation" className="section docs-teaser"><p className="eyebrow">02 / DOCUMENTATION</p><h2>Explore the design.</h2><p className="section-intro">Network architecture, token economics, operating rules, and the calculations behind the research.</p><DocumentCards compact/><a className="button" href="#/docs">All documentation <ArrowRight size={16}/></a></section>;
}

function NumberField({ label, value, onChange, min, max, step = 1 }) {
  return <label className="number-field"><span>{label}</span><input type="number" value={value} min={min} max={max} step={step} onChange={e => onChange(e.target.value)}/></label>;
}

function AvailabilityCalculator() {
  const [n, setN] = useState('5');
  const [k, setK] = useState('1');
  const [q, setQ] = useState('80');
  const [holders, setHolders] = useState('1000000');
  let result, error, threshold;
  try {
    if ([n, k, q].some(x => x.trim() === '')) throw Error('Enter all three assumptions.');
    result = fragmentFailureLabel(logFragmentFailure(Number(n), Number(k), Number(q) / 100));
  } catch (e) { error = e.message; }
  try { threshold = reconstructionThreshold(Number(holders)); } catch { threshold = null; }
  return <div className="calculator">
    <div className="calculator-heading"><span className="eyebrow">INTERACTIVE / AVAILABILITY</span><h3>Change the assumptions.</h3></div>
    <div className="calculator-fields"><NumberField label="Distinct fragment holders (n)" value={n} onChange={setN} min={1} max={10000}/><NumberField label="Required valid fragments (k)" value={k} onChange={setK} min={1} max={Number(n)}/><NumberField label="Availability per holder (q, %)" value={q} onChange={setQ} min={0} max={100} step={0.1}/></div>
    <div className="calculation-result" aria-live="polite">{error ? <p role="alert">{error}</p> : <><span>Probability of insufficient fragments</span><strong data-testid="availability-result">{result}</strong><p>One object, one snapshot. Independent holders with identical availability. This is not a probability of an accepted attack.</p></>}</div>
    <p className="subtle">Example: n=5, k=1, q=80% gives 0.00032, or 0.032%. Shared outages and malicious withholding are outside this model. Tiny positive values are shown in scientific notation rather than rounded to zero.</p>
    <div className="threshold-calculator"><h3>Any-1% reference threshold</h3><NumberField label="Holders in the defined snapshot (N)" value={holders} onChange={setHolders} min={1} max={1000000}/><p aria-live="polite">{threshold ? <>n = {Number(holders).toLocaleString('en-US')} · k = <strong>{threshold.toLocaleString('en-US')}</strong> · ideal payload expansion = {(Number(holders) / threshold).toFixed(2)}×</> : 'Enter an integer from 1 to 1,000,000.'}</p><p className="subtle">A theoretical reconstruction threshold, not a live network setting or payment quorum.</p></div>
  </div>;
}

function EconomicsCalculator() {
  const [p, setP] = useState('1'); const [gain, setGain] = useState('100000'); const [cost, setCost] = useState('1000');
  let result;
  try { if ([p, gain, cost].some(x => x.trim() === '')) throw Error(); result = attackEconomics(Number(p) / 100, Number(gain), Number(cost)); } catch { result = null; }
  return <div className="calculator"><div className="calculator-heading"><span className="eyebrow">INTERACTIVE / SENSITIVITY</span><h3>Illustrative attack economics</h3></div><div className="calculator-fields"><NumberField label="Assumed illicit acceptance (p, %)" value={p} onChange={setP} min={0} max={100} step={0.1}/><NumberField label="Realizable gain (USD)" value={gain} onChange={setGain} min={0.01} step={100}/><NumberField label="Non-recoverable cost (USD)" value={cost} onChange={setCost} min={0} step={100}/></div><div className="calculation-result" aria-live="polite">{result ? <><span>Expected net payoff under these inputs</span><strong>{result.expectedPayoff.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })}</strong><p>Break-even probability: {(result.breakEvenProbability * 100).toFixed(3)}%{result.breakEvenProbability > 1 ? ' — greater than 100%, so break-even is impossible under these fixed inputs.' : '.'}</p></> : <p role="alert">Enter p from 0 to 100%, a positive gain, and a non-negative cost.</p>}</div><p className="subtle">No input is a measured SunPhi attack probability or cost. This is a single-strategy sensitivity calculation.</p></div>;
}

function NodeRewardCalculator() {
  const [currency, setCurrency] = useState('USD');
  const [volume, setVolume] = useState('1000000');
  const [price, setPrice] = useState('1');
  const [nodes, setNodes] = useState('10000');
  const [days, setDays] = useState('30');
  const [hours, setHours] = useState('720');
  const [cost, setCost] = useState('5');
  const money = value => currency === 'BTC' ? value.toLocaleString('en-US', { minimumFractionDigits: 8, maximumFractionDigits: 8 }) + ' BTC' : value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const token = value => value.toLocaleString('en-US', { maximumFractionDigits: 8 }) + ' sun(φ)';
  let result, poolTokens, rewardTokens, error;
  try {
    if ([volume, price, nodes, days, hours, cost].some(x => x.trim() === '')) throw Error('Enter every assumption.');
    if (!Number.isFinite(Number(days)) || Number(days) <= 0 || Number(days) > 366 || Number(hours) > Number(days) * 24) throw Error('Use a period of up to 366 days; wallet hours cannot exceed its duration.');
    result = nodeRewardScenario(Number(volume), Number(nodes) * Number(days) * 24, Number(hours), Number(cost));
    poolTokens = fundedTokenQuantity(result.pool, Number(price));
    rewardTokens = fundedTokenQuantity(result.reward, Number(price));
  } catch (e) { error = e.message; }
  const changeCurrency = e => {
    setCurrency(e.target.value);
    setVolume(e.target.value === 'BTC' ? '0.01' : '1000000');
    setPrice(e.target.value === 'BTC' ? '0.000001' : '1');
    setCost(e.target.value === 'BTC' ? '0' : '5');
  };
  return <div className="calculator"><div className="calculator-heading"><span className="eyebrow">INTERACTIVE / WALLET REWARDS</span><h3>Your sun(φ) reward</h3></div><div className="calculator-fields">
    <label className="number-field"><span>Funding currency / example</span><select value={currency} onChange={changeCurrency}><option value="USD">USD scenario</option><option value="BTC">BTC scenario</option></select></label>
    <NumberField label={`Eligible sale volume (${currency})`} value={volume} onChange={setVolume} min={0} step={currency === 'BTC' ? 0.0001 : 1000}/>
    <NumberField label={`Effective acquisition cost (${currency} per sun(φ))`} value={price} onChange={setPrice} min={0.00000001} step="any"/>
    <NumberField label="Average authorized wallets, including yours" value={nodes} onChange={setNodes} min={0} step={0.1}/>
    <NumberField label="Accounting period (days)" value={days} onChange={setDays} min={1} max={366}/>
    <NumberField label="Your authorized hours" value={hours} onChange={setHours} min={0} max={Number(days) * 24}/>
    <NumberField label={`Your operating cost for this period (${currency})`} value={cost} onChange={setCost} min={0} step="any"/>
  </div><div className="calculation-result" aria-live="polite">{error ? <p role="alert">{error}</p> : <><span>Your token reward under these assumptions</span><strong data-testid="node-reward-result">{token(rewardTokens)}</strong><p>Seller proceeds: {money(result.seller)} · Platform: {money(result.platform)} · Reward funding: {money(result.pool)}</p><p>Funded token pool at the assumed cost: {token(poolTokens)} · Your authorization time share: {(result.share * 100).toFixed(6)}%</p><p>Funding equivalent: {money(result.reward)} · Less assumed operating cost: {money(result.netReward)}. These equivalents are not cash payouts or resale quotes.</p><p>{result.breakEvenVolume === null ? 'No authorization time share: cost coverage is undefined.' : `Sale volume for the funding equivalent to cover your assumed cost at this same share: ${money(result.breakEvenVolume)}.`}</p>{result.unallocatedPool > 0 && <p>No authorized wallet-hours: funding of {money(result.unallocatedPool)} remains unallocated.</p>}</>}</div><p className="subtle">Rewards are denominated in sun(φ). The acquisition cost is an assumption, not a live price or peg; it must reflect costs charged to the pool. Changing the currency loads an illustrative scenario, not an FX conversion. One pool per period; calculate daily pools separately before adding them. Total wallet-hours = average authorized wallets × days × 24. Monetary settlement, conversion and reward payments are not implemented.</p></div>;
}

function ContentSection({ section }) {
  return <section className="doc-section"><h2>{section.title}</h2>{section.formula && <div className="formula" role="math">{section.formula}</div>}{section.paragraphs?.map(p => <p key={p}>{p}</p>)}{section.bullets && <ul>{section.bullets.map(p => <li key={p}>{p}</li>)}</ul>}{section.table && <div className="table-scroll" role="region" aria-label={section.title} tabIndex={0}><table><thead><tr>{section.table.headers.map(h => <th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{section.table.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => j === 0 ? <th scope="row" key={j}>{cell}</th> : <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>}{section.links && <ul className="source-links">{section.links.map(([label, url]) => <li key={url}><a href={url} target="_blank" rel="noreferrer">{label} <ArrowUpRight size={14}/></a></li>)}</ul>}</section>;
}

export default function Documentation({ route }) {
  const doc = documents.find(d => d.id === route);
  const isIndex = route === 'docs';
  const index = documents.indexOf(doc);
  return <main id="content" tabIndex={-1} className="container documentation-page">
    <div className="doc-breadcrumb"><a href="#project">SunPhi</a><span>/</span><a href="#/docs">Documentation</a>{doc && <><span>/</span><span>{doc.title}</span></>}</div>
    <div className="documentation-layout">
      <aside className="doc-sidebar" aria-label="Documentation navigation"><label className="doc-select">Browse documentation<select value={doc?.id ?? 'docs'} onChange={e => { location.hash = `/${e.target.value}`; }}><option value="docs">All documentation</option>{documents.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label><nav><a href="#/docs" aria-current={isIndex ? 'page' : undefined}>Documentation home</a>{documents.map(d => <a key={d.id} href={`#/${d.id}`} aria-current={route === d.id ? 'page' : undefined}>{d.title}</a>)}</nav></aside>
      <article className="doc-article">
        {isIndex ? <><p className="eyebrow">SunPhi / DOCUMENTATION</p><h1>Understand the network.<br/>Inspect the design.</h1><p className="lead">A working specification for sun(φ): architecture, economics, security, operating guides, and reproducible calculations.</p><div className="doc-version"><span className="badge">Working draft</span><span>Version {DOCUMENT_VERSION}</span></div><div className="doc-actions"><a className="button primary" href="/sunphi-whitepaper-draft.txt" download><Download size={16}/> Download working whitepaper</a><a className="button" href="#/probability">Open calculations <ArrowUpRight size={16}/></a></div><DocumentCards/></> : doc ? <><p className="eyebrow">{doc.category} / DOCUMENTATION</p><h1>{doc.title}</h1><p className="lead">{doc.summary}</p><div className="doc-version"><span className="badge">{doc.status}</span><span>Version {DOCUMENT_VERSION}</span></div>{doc.id === 'network' && <div className="network-diagram" aria-label="Proposed transfer flow"><div><strong>Sender</strong><span>Owner authorization</span></div><ArrowRight/><div><strong>Peer network</strong><span>State acceptance + fragments</span></div><ArrowRight/><div><strong>Recipient</strong><span>Verification + receipt</span></div></div>}{doc.sections.map((s, i) => <div key={s.title}><ContentSection section={s}/>{doc.id === 'probability' && i === 0 && <AvailabilityCalculator/>}{doc.id === 'economics' && i === 1 && <NodeRewardCalculator/>}</div>)}{doc.id === 'economics' && <EconomicsCalculator/>}{doc.id === 'developers' && <div className="repository-box"><Github size={25}/><div><h3>SunPhi on GitHub</h3>{REPOSITORY_URL ? <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">Open the public repository <ArrowUpRight size={16}/></a> : <p>A separate public repository is being prepared. Its verified link will appear here after creation.</p>}</div></div>}{doc.id === 'overview' && <a className="button" href="/sunphi-whitepaper-draft.txt" download><Download size={16}/> Download working whitepaper</a>}<nav className="doc-pagination" aria-label="Adjacent documents">{index > 0 ? <a href={`#/${documents[index - 1].id}`}><ArrowLeft size={16}/>{documents[index - 1].title}</a> : <a href="#/docs"><ArrowLeft size={16}/>All documentation</a>}{index < documents.length - 1 && <a href={`#/${documents[index + 1].id}`}>{documents[index + 1].title}<ArrowRight size={16}/></a>}</nav></> : <><h1>Document not found</h1><p>This documentation address is not available.</p><a className="button" href="#/docs">Browse documentation</a></>}
      </article>
    </div>
  </main>;
}
