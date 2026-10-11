import { useEffect, useState } from 'react';
import { ArrowUpRight, ArrowDown, Sun, Moon, Download, FileText, Monitor, KeyRound, Network, ChevronRight } from 'lucide-react';
import Documentation, { DocumentationTeaser } from './Documentation';
import NavigationControls from './NavigationControls';
import { documents } from './docs-content';
import './documentation.css';

const sections = [['project', 'Project'], ['protocol', 'Protocol'], ['documentation', 'Docs'], ['downloads', 'Downloads'], ['development', 'Development']];
const principles = [
  ['Participate without buying tokens', 'Running a node is intended to require no purchase or staking of sun(φ) tokens. Joining the network and acquiring tokens are separate activities.'],
  ['Owners control their keys', 'A transfer must carry the current owner’s signature. The private key is kept separate from the token object and its network fragments.'],
  ['Distributed storage', 'The design uses verifiable data fragments and reconstruction from a sufficient number of them. Storage parameters will be evaluated on a test network.'],
];
function initialTheme() {
  const requested = new URLSearchParams(location.search).get('theme');
  if (requested === 'light' || requested === 'graphite') return requested;
  try { return localStorage.getItem('sunphi-theme') === 'graphite' ? 'graphite' : 'light'; } catch { return 'light'; }
}

export default function SunPhi() {
  const [theme, setTheme] = useState(initialTheme);
  const [active, setActive] = useState('project');
  const [route, setRoute] = useState(() => location.hash.startsWith('#/') ? location.hash.slice(2) : '');
  useEffect(() => {
    const onHashChange = () => setRoute(location.hash.startsWith('#/') ? location.hash.slice(2) : '');
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  useEffect(() => {
    document.title = route ? `${documents.find(d => d.id === route)?.title ?? 'Documentation'} — SunPhi` : 'SunPhi — Digital transfers';
    const frame = requestAnimationFrame(() => {
      if (route) window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      else if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
    });
    return () => cancelAnimationFrame(frame);
  }, [route]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'graphite' ? '#050609' : '#e1e4e8');
    try { localStorage.setItem('sunphi-theme', theme); } catch { /* Preferences are optional. */ }
  }, [theme]);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const marker = Math.max(280, innerHeight * 0.3);
      const current = [...sections].reverse().find(([id]) => document.getElementById(id)?.getBoundingClientRect().top <= marker);
      setActive(current?.[0] ?? 'project');
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, []);
  return <>
    <a className="skip" href="#content" onClick={event => { event.preventDefault(); const main = document.getElementById('content'); main?.focus(); main?.scrollIntoView(); }}>Skip to content</a>
    <header className="header"><div className="header-inner">
      <a className="brand" href="#project" aria-label="SunPhi — home"><span className="brand-symbol" aria-hidden="true">φ</span><strong>SunPhi</strong><span className="brand-caption">Digital transfers</span></a>
      <nav aria-label="Main navigation"><a href="#project" aria-current={!route ? 'page' : undefined}>Project</a><a className="priority-link" href="#/exchange" aria-current={route === 'exchange' ? 'page' : undefined}>Convert</a><a className="priority-link" href="#/wallet" aria-current={route === 'wallet' ? 'page' : undefined}>Wallet</a><a href="#/docs" aria-current={route && !['exchange', 'wallet'].includes(route) ? 'page' : undefined}>Docs</a></nav>
      <button className="theme-button" onClick={() => setTheme(theme === 'light' ? 'graphite' : 'light')} aria-label={theme === 'light' ? 'Switch to graphite theme' : 'Switch to light theme'} title={theme === 'light' ? 'Graphite theme' : 'Light theme'}>{theme === 'light' ? <Moon size={19}/> : <Sun size={19}/>}</button>
    </div></header>
    {route ? <Documentation key={route} route={route}/> : <main id="content" tabIndex={-1} className="container">
      <section id="project" className="hero">
        <a className="back-link" href="https://sun-phi.com/business-search?theme=graphite&mode=solution">SUN PHI · Business Search <ArrowUpRight size={15}/></a>
        <div className="eyebrow"><span className="status-dot"/> SunPhi / PROJECT OVERVIEW / OCTOBER 2026</div>
        <h1>Digital transfers.<br/>A network you can<br className="desktop-break"/> participate in.</h1>
        <p className="lead">SunPhi is a distributed network project with keys controlled by their owners and data stored on participants’ nodes. Running a node is intended to require no token purchase.</p>
        <div className="metadata"><div><span>TOKEN SYMBOL</span><strong className="token-symbol">sun(φ)</strong></div><div><span>CURRENT STAGE</span><strong>Prototype development</strong></div><div><span>FIRST APPLICATION</span><strong>Windows · planned</strong></div><div><span>UPDATED</span><time dateTime="2026-10-11">11 October 2026</time></div></div>
        <div className="actions"><a className="button primary" href="#protocol">Explore the protocol <ArrowDown size={16}/></a><a className="button" href="#downloads">Application releases <ArrowUpRight size={16}/></a></div>
      </section>
      <div className="article-layout"><div className="article-body">
        <section className="principles" aria-labelledby="principles-title"><h2 id="principles-title">Core principles</h2><ol>{principles.map(([title, text], i) => <li key={title}><span className="number">0{i+1}</span><div><h3>{title}</h3><p>{text}</p></div></li>)}</ol></section>
        <section id="protocol" className="section"><p className="eyebrow">01 / PROTOCOL</p><h2>The <span className="token-symbol">sun(φ)</span> token.<br/>A verifiable transfer.</h2><p className="section-intro">The proposed design separates token ownership, reservation during a transfer, and the storage of network fragments.</p>
          <div className="flow" aria-label="Proposed transfer stages">
            <div><KeyRound/><span>01</span><h3>Send</h3><p>The owner signs a transfer to a specific recipient.</p></div>
            <div><Network/><span>02</span><h3>Reserve</h3><p>A temporary transfer record accompanies the main token object.</p></div>
            <div><FileText/><span>03</span><h3>Receive</h3><p>The recipient checks the data and signs the receipt.</p></div>
          </div>
          <p>At rest, a token contains its main object. In transit, a reservation record accompanies it. The main object is split into network fragments, and its current version is tied to the latest completed receipt.</p>
          <div className="note"><span className="eyebrow">TO BE TESTED</span><p>Rules for accepting a single transfer outcome, recovering from failures, and handling changes in network membership are still being developed. This architecture is a protocol proposal; its security has not yet been established in a working network.</p></div>
        </section>
        <DocumentationTeaser/>
        <section id="downloads" className="section"><p className="eyebrow">03 / DOWNLOADS</p><h2>An application for your node.</h2><p className="section-intro">The first release is planned to combine a local node with a wallet dashboard. Verified installers and release notes will be published here.</p>
          <div className="release"><div className="release-heading"><Monitor size={30}/><div><h3>SunPhi for Windows</h3><p>First test release</p></div><span className="badge">In development</span></div><div className="release-bottom"><p>The installer has not been published. The test network is not yet running.</p><button className="button" disabled><Download size={16}/> Build in progress</button></div></div>
          <a className="document-link" href="/sunphi-project-note.txt" download><FileText size={21}/><span><strong>Project overview</strong><small>Principles and current stage · TXT · English</small></span><Download size={19}/></a>
          <p className="subtle"><a href="#/developers">GitHub and developer resources</a> · <a href="#/status">Network status and releases</a>. You do not need to enter wallet keys on this website.</p>
        </section>
        <section id="development" className="section"><p className="eyebrow">04 / DEVELOPMENT</p><h2>From a model to a test network.</h2><p className="section-intro">Milestones reflect actual progress. Results from a local model do not replace testing across independent nodes.</p>
          <ol className="roadmap"><li><span className="step">01</span><div><h3>Local transaction model</h3><p>A sequential model of reservation, receipt, and cancellation has been prepared. Seven local tests have passed.</p></div><span className="badge">Prepared</span></li><li><span className="step">02</span><div><h3>Network prototype</h3><p>Signatures, data exchange, storage, and multiple independent processes.</p></div><span className="badge">Next step</span></li><li><span className="step">03</span><div><h3>Failure testing</h3><p>Conflicting requests, disconnected nodes, stale fragments, and network recovery.</p></div><span className="badge">Planned</span></li></ol>
        </section>
        <section className="section faq"><p className="eyebrow">05 / QUESTIONS</p><h2>What to know today</h2>
          <details><summary>Do I need to buy tokens to run a node?<ChevronRight size={18}/></summary><p>No. The design does not require a token purchase or stake to run a node. The software will use your computer’s resources and internet connection.</p></details>
          <details><summary>Can I buy sun(φ) tokens yet?<ChevronRight size={18}/></summary><p>Sales are not open. A purchase model for the issuance fund is being developed. Token supply and sale terms have not been approved.</p></details>
          <details><summary>How is this project related to SUN PHI?<ChevronRight size={18}/></summary><p>SunPhi is being developed as a separate project. Using it to pay for SUN PHI services is a possibility for the future. The business platform does not currently require tokens.</p></details>
        </section>
      </div><aside aria-label="Project information"><div className="side-panel"><span className="eyebrow">SunPhi / NAVIGATION</span><h2>About the project</h2>{sections.map(([id, title], i) => <a key={id} href={`#${id}`}><span>0{i+1}</span>{title}<ArrowUpRight size={15}/></a>)}<div className="side-status"><span className="status-dot"/><strong>Prototype development</strong><p>The public network, installer, and token sales have not launched.</p></div></div><div className="side-caption">Open documentation.<br/>Verifiable results.<br/>Development in stages.</div></aside></div>
    </main>}
    <NavigationControls route={route}/>
    <footer><div className="container footer-inner"><a className="brand" href="#project"><span className="brand-symbol" aria-hidden="true">φ</span><strong>SunPhi</strong></a><p>A distributed digital transfers project · 2026</p><a href="https://sun-phi.com/business-search?theme=graphite&mode=solution">SUN PHI Business Search <ArrowUpRight size={15}/></a></div></footer>
  </>;
}
