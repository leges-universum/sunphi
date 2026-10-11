import { useEffect, useRef, useState } from 'react';
import { PanelLeftOpen, X, ChevronUp, ChevronDown } from 'lucide-react';
import { DocumentationSidebar } from './Documentation';

export default function NavigationControls({ route }) {
  const dialog = useRef(null);
  const timer = useRef(null);
  const priorOverflow = useRef('');
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [bounds, setBounds] = useState({ top: true, bottom: false });
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const close = () => {
    if (!dialog.current?.open || timer.current) return;
    if (reduced()) { dialog.current.close(); return; }
    setClosing(true);
    timer.current = setTimeout(() => { dialog.current?.close(); setClosing(false); timer.current = null; }, 220);
  };
  useEffect(() => {
    close();
    let frame;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setBounds({ top: window.scrollY < 12, bottom: window.scrollY + innerHeight >= document.documentElement.scrollHeight - 12 }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(document.body);
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('scroll', update); window.removeEventListener('resize', update); };
  }, [route]);
  useEffect(() => () => { clearTimeout(timer.current); document.body.style.overflow = priorOverflow.current; }, []);
  const scroll = bottom => window.scrollTo({ top: bottom ? document.documentElement.scrollHeight : 0, behavior: reduced() ? 'instant' : 'smooth' });
  return <>
    <button className="navigation-trigger" aria-label="Open navigation" aria-haspopup="dialog" aria-expanded={open} aria-controls="sunphi-navigation" onClick={() => { clearTimeout(timer.current); timer.current = null; setClosing(false); priorOverflow.current = document.body.style.overflow; document.body.style.overflow = 'hidden'; dialog.current.showModal(); setOpen(true); }} title="Open navigation"><PanelLeftOpen size={26}/><span>Menu</span></button>
    <dialog id="sunphi-navigation" ref={dialog} onClose={() => { document.body.style.overflow = priorOverflow.current; setOpen(false); }} className={`navigation-drawer${closing ? ' is-closing' : ''}`} aria-label="SunPhi navigation" onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target.closest('a')) close(); if (e.target === dialog.current) { const box = dialog.current.getBoundingClientRect(); if (e.clientX > box.right || e.clientY > box.bottom || e.clientX < box.left || e.clientY < box.top) close(); } }}>
      <button autoFocus className="drawer-close" aria-label="Close navigation" onClick={close}><X size={22}/></button>
      <DocumentationSidebar route={route} visible={open}/>
    </dialog>
    <div className="page-scroll-controls" aria-label="Page scroll controls"><button aria-label="Scroll to bottom" title="Scroll to bottom" disabled={bounds.bottom} onClick={() => scroll(true)}><ChevronDown size={23}/></button><button aria-label="Back to top" title="Back to top" disabled={bounds.top} onClick={() => scroll(false)}><ChevronUp size={23}/></button></div>
  </>;
}
