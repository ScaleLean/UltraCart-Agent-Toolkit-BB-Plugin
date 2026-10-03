import { useEffect, useId, useMemo, useState } from 'react';
import { definePluginApp } from '@get-bb/plugin-sdk/app';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { capabilities, categories } from './capabilities';
import './app.css';
import { StorefrontWorkspace } from './workspace';

type Capability = (typeof capabilities)[number];
const storageKey = 'bb:storefront:explorer-brief:v1';
function loadBrief(): { ids: string[]; notes: string } {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '{}');
    return {
      ids: Array.isArray(value.ids) ? [...new Set<string>(value.ids.filter((id: unknown) => capabilities.some(c => c.id === id)))] : [],
      notes: typeof value.notes === 'string' ? value.notes.slice(0, 4000) : '',
    };
  } catch { return { ids: [], notes: '' }; }
}

function Glyph({ kind }: { kind: string }) {
  const paths: Record<string, string> = {
    map: 'M4 4h6v5H4z M14 15h6v5h-6z M4 15h6v5H4z M7 9v3h10v3 M7 12v3',
    spark: 'm12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z',
    target: 'M12 3v4 M12 17v4 M3 12h4 M17 12h4 M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8',
    layout: 'M3 4h18v16H3z M3 9h18 M12 9v11',
    page: 'M5 3h9l5 5v13H5z M14 3v6h5 M8 13h8 M8 17h5',
    blocks: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M17.5 14v7 M14 17.5h7',
    browser: 'M3 4h18v16H3z M3 9h18 M6 6.5h1 M9 6.5h1',
    history: 'M4 10a8 8 0 1 1 0 5 M4 4v6h6 M12 7v5l3 2',
    split: 'M12 21V10 M12 10 6 4 M12 10l6-6 M3 4h5 M4 4v5 M16 4h5 M20 4v5',
    play: 'M3 4h18v16H3z m7 4 6 4-6 4z',
  };
  return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind] || paths.page} /></svg>;
}

function Explorer() {
  const uid = useId();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [selectedId, setSelectedId] = useState('explore');
  const [brief, setBrief] = useState(loadBrief);
  const [showBrief, setShowBrief] = useState(false);
  const [notice, setNotice] = useState('');
  const [storageError, setStorageError] = useState(false);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(brief)); setStorageError(false); }
    catch { setStorageError(true); }
  }, [brief]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  const filtered = useMemo(() => capabilities.filter(c =>
    (category === 'All' || c.category === category) &&
    query.trim().toLowerCase().split(/\s+/).every(term => `${c.title} ${c.description} ${c.tags} ${c.category}`.toLowerCase().includes(term))
  ), [category, query]);
  const selected = filtered.find(c => c.id === selectedId) || filtered[0];
  const chosen = brief.ids.map(id => capabilities.find(c => c.id === id)!);
  const briefText = [
    'Help me plan this UltraCart storefront work using the storefront-agent-toolchain.',
    brief.notes.trim() ? `Goal: ${brief.notes.trim()}` : 'First, help me define the goal and target page.',
    ...chosen.map((c, index) => `${index + 1}. ${c.title}\n   Desired result: ${c.outcome}\n   Requirements: ${c.needs}\n   Limit: ${c.limit}\n   Reference: ${c.source}`),
    'Before acting, verify the installed toolkit version, its current help, and the intended merchant/storefront. Start with discovery. Explain the proposed scope and affected resources before making any live changes. This brief requests planning, not execution.',
  ].join('\n\n');
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNotice('Copied to clipboard'); }
    catch { setNotice('Copy unavailable. Select and copy the text below.'); }
  }
  function toggle(capability: Capability) {
    setBrief(b => ({ ...b, ids: b.ids.includes(capability.id) ? b.ids.filter(id => id !== capability.id) : [...b.ids, capability.id] }));
  }
  return <div className="uc-explorer">
    <div className="uc-body">
      <div className="uc-intro-row"><div><p className="uc-eyebrow">ULTRACART · CAPABILITY EXPLORER</p><h1>What would you like to do?</h1><p className="uc-lede">Start with an idea. See what the toolkit makes possible.</p></div><Button variant="outline" onClick={() => setShowBrief(v => !v)} aria-pressed={showBrief}>My brief <span className="uc-count">{brief.ids.length}</span></Button></div>
      <div className="uc-prototype"><span className="uc-dot" />Explore & plan<span className="uc-separator">/</span>Capability guide · Plan your next change</div>
      <div className="uc-search"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><Input value={query} onChange={e => setQuery(e.target.value)} aria-label="Search toolkit capabilities" placeholder="Try ‘landing page’, ‘mobile’, or ‘preview’" type="search" /></div>
      <div className="uc-filters" role="group" aria-label="Filter capabilities">{categories.map(name => <button key={name} type="button" aria-pressed={category === name} onClick={() => setCategory(name)}>{name}</button>)}</div>
      <div className="uc-results"><h2>{category === 'All' ? 'Explore the possibilities' : category}</h2><span aria-live="polite">{filtered.length} {filtered.length === 1 ? 'capability' : 'capabilities'}</span></div>
      <div className="uc-columns">
        <div className="uc-cards">{filtered.map(c => <button key={c.id} type="button" className="uc-card" aria-pressed={!showBrief && selected?.id === c.id} onClick={() => { setSelectedId(c.id); setShowBrief(false); }}><span className="uc-card-top"><span className="uc-glyph"><Glyph kind={c.icon}/></span><span className="uc-category">{c.category}</span></span><h3>{c.title}</h3><p>{c.description}</p><span className="uc-card-bottom"><span>{brief.ids.includes(c.id) ? '✓ In your brief' : c.access}</span><span aria-hidden="true">↗</span></span></button>)}{filtered.length === 0 && <div className="uc-empty"><h3>No matching capabilities</h3><p>Try a broader term or reset the filters.</p><Button variant="outline" onClick={() => {setQuery(''); setCategory('All');}}>Reset search</Button></div>}</div>
        <aside className="uc-detail" aria-label={showBrief ? 'Your brief' : 'Selected capability'}>
          {showBrief ? <>
            <p className="uc-eyebrow">YOUR NEXT STEPS</p><h2>My storefront brief</h2><p className="uc-detail-lede">Collect a few actions, add your goal, and take the brief to your agent.</p>
            <div className="uc-brief-items">{chosen.length ? chosen.map(c => <div key={c.id}><span>{c.title}</span><button type="button" onClick={() => toggle(c)} aria-label={`Remove ${c.title}`}>×</button></div>) : <p>No actions yet. Choose a capability and add it to your brief.</p>}</div>
            <label className="uc-label" htmlFor={`${uid}-notes`}>What do you want to achieve?</label><textarea id={`${uid}-notes`} maxLength={4000} rows={3} value={brief.notes} onChange={e => setBrief(b => ({...b, notes: e.target.value}))} placeholder="Describe the page and the change you have in mind."/>
            <Button className="uc-primary" onClick={() => copy(briefText)} disabled={!chosen.length}>Copy agent brief</Button><p className="uc-caption">Copying does not start an agent or change your store. Saved in this browser.{storageError ? ' Local saving is unavailable; keep a copy before leaving.' : ''}</p>
            <details className="uc-commands"><summary>Read the full brief</summary><pre>{briefText}</pre></details>
          </> : selected ? <>
            <div className="uc-detail-top"><span className="uc-glyph"><Glyph kind={selected.icon}/></span><span className="uc-pill">{selected.access}</span></div><h2>{selected.title}</h2><p className="uc-detail-lede">{selected.outcome}</p>
            <h3 className="uc-label">WHAT YOU CAN DO</h3><ol className="uc-steps">{selected.steps.map((step, index) => <li key={step}><span>{String(index + 1).padStart(2, '0')}</span>{step}</li>)}</ol>
            <h3 className="uc-label">WHAT YOU NEED</h3><p className="uc-detail-copy">{selected.needs}</p>
            <div className="uc-boundary"><h3>Know the boundary</h3><p>{selected.limit}</p></div>
            <Button className="uc-primary" variant={brief.ids.includes(selected.id) ? 'outline' : 'default'} onClick={() => toggle(selected)}>{brief.ids.includes(selected.id) ? 'Remove from brief' : 'Add to my brief'}<span aria-hidden="true">{brief.ids.includes(selected.id) ? '−' : '+'}</span></Button>
            <details className="uc-commands" key={selected.id}><summary>See toolkit commands</summary><p>Reference examples. Replace placeholders before use.</p><pre>{selected.commands.join('\n\n')}</pre><Button size="sm" variant="outline" onClick={() => copy(selected.commands.join('\n'))}>Copy examples</Button></details>
            <a className="uc-source" href={selected.source} target="_blank" rel="noreferrer">Read toolkit documentation ↗</a>
          </> : <p>Select a capability to see its workflow and limits.</p>}
        </aside>
      </div>
      <footer className="uc-footer">A curated first set from the toolkit documentation, reviewed October 2, 2026. Availability depends on your installed version and store access. Source links require repository access.</footer>
      <div className="uc-notice" role="status" aria-live="polite">{notice}</div>
    </div>
  </div>;
}

function StorefrontApp() {
  const [view, setView] = useState<'workspace' | 'guide'>('workspace');
  return <div className="uc-explorer uc-app-shell">
    <nav className="uc-workspace-nav" aria-label="Storefront sections"><span className="uc-workspace-brand"><Glyph kind="layout"/> Storefront</span><div><button aria-pressed={view === 'workspace'} onClick={() => setView('workspace')}>Workspace</button><button aria-pressed={view === 'guide'} onClick={() => setView('guide')}>Capability guide</button></div><span className="uc-nav-caption">Built for UltraCart</span></nav>
    <div hidden={view !== 'workspace'}><StorefrontWorkspace /></div>
    {view === 'guide' && <Explorer />}
  </div>;
}

export default definePluginApp(app => {
  app.slots.navPanel({ id: 'explore', title: 'Storefront', icon: 'Layout', path: 'explore', component: StorefrontApp });
  app.slots.threadPanelAction({ id: 'explore', title: 'Storefront workspace', icon: 'Layout', component: StorefrontApp, layout: 'flush' });
});
