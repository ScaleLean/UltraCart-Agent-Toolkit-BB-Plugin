import { useEffect, useMemo, useRef, useState } from 'react';
import { ThreadChat, experimental_NewThreadComposer as NewThreadComposer, experimental_useProviders, useBbContext, useBbNavigate, useRpc, useSdk } from '@get-bb/plugin-sdk/app';
import type { NewThreadRequest } from '@get-bb/plugin-sdk/app';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { ConnectionPanel } from './connection-panel';
import type { rpcContract, Selection } from './connection-contract';
import type { StorePage, TemplateResult } from './storefront-data';
import { storefrontUrl } from './storefront-data';
import { conversationRequest } from './conversation';
import { DraftPanel } from './draft-panel';
import { WarehousePanel } from './warehouse-panel';
import { HeatmapPanel } from './heatmap-panel';
import { TrafficPanel } from './traffic-panel';

export function StorefrontWorkspace() {
  const [selection, setSelection] = useState<Selection | null>(null);
  return <div className="uc-workspace-body">
    <ConnectionPanel onSelection={setSelection} />
    {selection ? <ConnectedWorkspace key={`${selection.profileId}:${selection.storefront.id}:${selection.verifiedAt}`} selection={selection} /> :
      <section className="uc-workspace-welcome"><p className="uc-eyebrow">A WORKSPACE FOR YOUR STORE</p><h1>Start with a real page.</h1><p>Connect UltraCart and choose a storefront. Then browse your pages, inspect their templates, and bring the right context into an agent conversation.</p><div className="uc-workspace-steps"><span>01 · Choose store</span><span>02 · Explore pages</span><span>03 · Work with your agent</span></div></section>}
  </div>;
}

function ConnectedWorkspace({ selection }: { selection: Selection }) {
  const [view, setView] = useState<'pages' | 'traffic' | 'warehouse'>('pages');
  const [trafficOpened, setTrafficOpened] = useState(false);
  return <>
    <nav className="uc-store-views" aria-label="Store workspace">
      <button type="button" aria-pressed={view === 'pages'} onClick={() => setView('pages')}>Pages & changes</button>
      <button type="button" aria-pressed={view === 'traffic'} onClick={() => { setTrafficOpened(true); setView('traffic'); }}>Page traffic</button>
      <button type="button" aria-pressed={view === 'warehouse'} onClick={() => setView('warehouse')}>Data warehouse</button>
    </nav>
    <div hidden={view !== 'pages'}><PageWorkspace selection={selection} /></div>
    {trafficOpened && <div hidden={view !== 'traffic'}><TrafficPanel selection={selection} /></div>}
    {view === 'warehouse' && <WarehousePanel selection={selection} />}
  </>;
}

function PageWorkspace({ selection }: { selection: Selection }) {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const context = useBbContext();
  const { providers } = experimental_useProviders();
  const alive = useRef(true);
  const [pages, setPages] = useState<StorePage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [fetchedAt, setFetchedAt] = useState('');
  const [query, setQuery] = useState('');
  const [branch, setBranch] = useState<string | null>('/');
  const [filter, setFilter] = useState('all');
  const [limit, setLimit] = useState(60);
  const [page, setPage] = useState<StorePage | null>(null);
  const [pageFresh, setPageFresh] = useState(false);
  const [templates, setTemplates] = useState<TemplateResult | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'page' | 'draft' | 'heatmap' | 'agent'>('page');
  const [intent, setIntent] = useState('Help me understand this page and suggest useful improvements. Inspect first.');
  const [sessions, setSessions] = useState<Record<string, string>>({});
  const loadedRef = useRef(false);

  async function act(label: string, work: () => Promise<void>) {
    setBusy(label); setError('');
    try { await work(); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'The request failed.'); }
    finally { if (alive.current) setBusy(''); }
  }
  async function loadPages() {
    await act('Loading pages', async () => {
      const result = await rpc.call('listPages', { selection });
      if (!alive.current) return;
      setPages(result.pages); setFetchedAt(result.fetchedAt); setLoaded(true);
      setPage(current => result.pages.find(p => p.path === current?.path) || result.pages.find(p => p.path === '/') || result.pages[0] || null);
      setPageFresh(false); setTemplates(null);
    });
  }
  useEffect(() => {
    alive.current = true;
    if (!loadedRef.current) { loadedRef.current = true; void loadPages(); }
    return () => { alive.current = false; };
  }, []);
  useEffect(() => { setLimit(60); }, [query, branch, filter]);

  const shown = useMemo(() => {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return pages.filter(p => (branch === null || p.parent === branch || p.path === branch) &&
      (filter === 'all' || filter === 'hidden' && p.visible === false || filter === 'noindex' && p.search === 'noindex') &&
      terms.every(term => `${p.path} ${p.title} ${p.template || ''} ${p.itemTemplate || ''}`.toLowerCase().includes(term)));
  }, [pages, query, branch, filter]);
  const parent = pages.find(p => p.path === branch)?.parent;
  const shared = page?.template ? pages.filter(p => p.template === page.template || p.itemTemplate === page.template).length : 0;
  const threadId = page ? sessions[page.path] : undefined;
  const url = useMemo(() => {
    if (!page) return null;
    try { return storefrontUrl(selection.storefront.host, page.path); } catch { return null; }
  }, [selection, page]);

  async function selectPage(next: StorePage) {
    setPage(next); setTemplates(null); setPageFresh(false); setMode('page');
    await act('Reading page', async () => {
      const result = await rpc.call('readPage', { selection, path: next.path });
      if (alive.current) { setPage(result.page); setPageFresh(true); }
    });
  }
  function ask(prompt: string) { setIntent(prompt); setMode('agent'); setError(''); }
  async function startConversation(request: NewThreadRequest) {
    if (!page) throw new Error('Select a page first.');
    setBusy('Preparing conversation'); setError('');
    try {
      const prepared = await rpc.call('prepareConversation', { selection, path: page.path });
      if (!alive.current) throw new Error('The workspace changed. Submit from the current page.');
      const created = await sdk.threads.spawn(conversationRequest(request, prepared));
      if (alive.current) setSessions(current => ({ ...current, [page.path]: created.id }));
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not start the conversation.');
      throw cause;
    } finally { if (alive.current) setBusy(''); }
  }

  return <section className="uc-page-workspace" aria-label="Live storefront workspace">
    <div className="uc-store-stats"><span><strong>{loaded ? pages.length.toLocaleString() : '—'}</strong> catalog pages</span><span><strong>{loaded ? new Set(pages.map(p => p.template).filter(Boolean)).size : '—'}</strong> page templates</span><span><strong>{loaded ? pages.filter(p => p.visible === null).length : '—'}</strong> visibility unreported</span><span className="uc-read-time">{fetchedAt ? `Read at ${new Date(fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Read-only discovery'}</span><Button size="sm" variant="outline" disabled={!!busy} onClick={loadPages}>{busy === 'Loading pages' ? 'Loading…' : loaded ? 'Refresh pages' : 'Load pages'}</Button></div>
    {error && <p className="uc-workspace-error" role="alert">{error}</p>}
    {pages.some(p => p.catalogCopies > 1) && <p className="uc-catalog-warning">The catalog has duplicate records for {pages.filter(p => p.catalogCopies > 1).length} page path. Duplicate entries are marked below. Select one to read its current settings directly.</p>}
    <div className="uc-live-layout">
      <aside className="uc-page-library" aria-label="Store pages">
        <div className="uc-library-controls"><Input aria-label="Search store pages" placeholder="Search all pages or templates…" type="search" value={query} onChange={e => {setQuery(e.target.value); setBranch(null);}} />
          <div className="uc-library-filters"><label>Show<select aria-label="Filter store pages" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All pages</option><option value="hidden">Hidden pages</option><option value="noindex">Excluded from search</option></select></label><Button size="sm" variant="ghost" onClick={() => { setBranch(branch === null ? '/' : null); setQuery(''); }}> {branch === null ? 'Browse structure' : 'All pages'} </Button></div>
          {branch !== null && <div className="uc-branch"><Button size="sm" variant="ghost" onClick={() => setBranch(branch === '/' ? null : parent || '/')}>↑</Button><code>{branch}</code></div>}
          <p className="uc-result-count" aria-live="polite">{loaded ? `${shown.length.toLocaleString()} matching pages` : busy ? 'Reading your store…' : 'Pages have not loaded yet.'}</p></div>
        <div className="uc-page-list">{shown.slice(0, limit).map(p => <div className={`uc-page-row ${page?.path === p.path ? 'uc-page-selected' : ''}`} key={p.path}>
          <button type="button" disabled={!!busy} aria-pressed={page?.path === p.path} onClick={() => selectPage(p)}><span>{p.path === '/' ? '⌂ ' : ''}{p.title}</span><code>{p.path}</code><small>{p.catalogCopies > 1 ? 'Duplicate catalog records · ' : ''}{p.visible === false ? 'Hidden · ' : ''}{p.search === 'noindex' ? 'Noindex · ' : ''}{p.template || 'Template not reported'}</small></button>
          {p.children > 0 && <button type="button" className="uc-branch-button" aria-label={`Browse ${p.path} children`} onClick={() => { setBranch(p.path); setQuery(''); }}>{p.children} ›</button>}
        </div>)}{loaded && !shown.length && <div className="uc-list-empty"><p>No matching pages.</p><Button size="sm" variant="outline" onClick={() => {setQuery(''); setFilter('all'); setBranch(null);}}>Clear filters</Button></div>}
        {shown.length > limit && <Button variant="ghost" className="uc-more-pages" onClick={() => setLimit(n => n + 60)}>Show 60 more</Button>}</div>
        <p className="uc-library-note">Catalog pages only. Newly created pages can take time to appear in the toolkit’s catalog cache.</p>
      </aside>
      <div className="uc-page-main">{page ? <>
        <header className="uc-page-header"><div><p className="uc-eyebrow">{page.path === '/' ? 'HOME PAGE' : 'SELECTED PAGE'}</p><h2>{page.title}</h2><code>{page.path}</code></div><Button variant="outline" disabled={!url} onClick={() => {if (url && !navigate.openUrl(url)) setError('BB could not open this page.');}}>Open live page ↗</Button></header>
        <div className="uc-page-tabs" role="group" aria-label="Page view"><button aria-pressed={mode === 'page'} onClick={() => setMode('page')}>Page details</button><button aria-pressed={mode === 'draft'} onClick={() => setMode('draft')}>Draft & review</button><button aria-pressed={mode === 'heatmap'} onClick={() => setMode('heatmap')}>Heatmaps</button><button aria-pressed={mode === 'agent'} onClick={() => setMode('agent')}>Work with agent{threadId ? ' · Active chat' : ''}</button><span role="status">{busy || (pageFresh ? 'Fresh page settings' : 'From catalog listing')}</span></div>
        {mode === 'page' ? <div className="uc-page-details">
          <div className="uc-page-flags"><span>{page.visible === null ? 'Visibility not reported' : page.visible ? 'Visibility setting: visible' : 'Visibility setting: hidden'}</span><span>{page.search === 'indexable' ? 'Search indexable' : page.search === 'noindex' ? 'Excluded from search' : 'Search status unknown'}</span><span>{page.children} subpages</span><span>{page.items} items</span></div>
          <div className="uc-page-description"><h3>Page description</h3><p>{page.description || 'No description is reported for this page.'}</p></div>
          <div className="uc-template-card"><div className="uc-template-heading"><h3>What renders this page</h3><Button size="sm" variant="outline" disabled={!!busy} onClick={() => act('Resolving templates', async () => { const result = await rpc.call('resolveTemplate', { selection, path: page.path }); if (alive.current) setTemplates(result); })}>Resolve template files</Button></div>
            <dl><dt>Page template</dt><dd>{page.template || 'Not reported'}</dd><dt>Item template</dt><dd>{page.itemTemplate || 'Not reported'}</dd></dl>
            {shared > 1 && <p className="uc-template-impact">{shared} catalog pages reference this page template. A shared template change can affect more than this page.</p>}
            {templates && <div className="uc-resolved"><p className="uc-eyebrow">RESOLVED BY ULTRACART</p><code>{templates.group.path}</code>{templates.item && <code>{templates.item.path}{templates.item.exists ? '' : ' (missing)'}</code>}{templates.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</div>}
          </div>
          <h3 className="uc-next-title">Start with a question</h3><div className="uc-page-prompts">
            <button disabled={!!busy} onClick={() => ask('Inspect this page and explain how it is built. Identify its templates and shared dependencies. Read-only discovery.')}><strong>Understand this page</strong><span>Find its structure and dependencies.</span><b>↗</b></button>
            <button disabled={!!busy} onClick={() => ask('Inspect this page’s current metadata and templates. Suggest concrete improvements and explain what the toolkit can support. Do not make changes yet.')}><strong>Find improvements</strong><span>Explore useful changes with your agent.</span><b>↗</b></button>
            <button disabled={!!busy} onClick={() => ask('Help me plan a change to this page. First inspect its current settings and template, then ask what I want to change. Do not publish or edit store content yet.')}><strong>Plan a change</strong><span>Define the scope before editing.</span><b>↗</b></button>
          </div><p className="uc-page-boundary">These controls read your store. Page settings do not confirm public availability. Use Draft & review to edit supported container fields locally and check the changes.</p>
        </div> : mode === 'draft' ? <DraftPanel key={page.path} selection={selection} path={page.path} /> : mode === 'heatmap' ? <HeatmapPanel key={page.path} selection={selection} path={page.path} /> : <div className="uc-agent-work"><div className="uc-agent-scope"><span className="uc-dot uc-connected-dot"/><span>Context: <strong>{selection.merchantId}</strong> · {selection.storefront.host} · <code>{page.path}</code></span>{threadId && <Button size="sm" variant="ghost" onClick={() => navigate.toThread(threadId)}>Open chat ↗</Button>}</div>
          {threadId ? <div className="uc-embedded-chat"><ThreadChat threadId={threadId} variant="compact" permissionPolicy="editable" /></div> : <>
            <div className="uc-agent-readiness"><strong>Choose your agent below</strong><p>UltraCart is connected. Your agent needs its own sign-in on the selected execution machine. A listed provider is not proof that it is signed in.</p>{providers.filter(p => p.id === 'codex' || p.id === 'claude-code').map(p => <p key={p.id}><b>{p.displayName}:</b> {p.strings?.signInHint || 'Use BB’s provider setup if authentication is requested.'}</p>)}</div>
            <div className="uc-native-composer"><NewThreadComposer key={`${page.path}:${intent}`} defaultProjectId={context.projectId || undefined} initialPrompt={intent} placeholder="What would you like to do with this page?" layout="document" draftKey={`storefront:${selection.profileId}:${selection.storefront.id}:${page.path}`} onSubmit={startConversation} /></div>
            <p className="uc-page-boundary">Sending starts a BB conversation with this merchant, storefront, and page pinned as context. The agent receives live discovery and local draft tools. Local drafts can be reviewed in Draft & review. Later store switches do not retarget that conversation.</p>
          </>}
        </div>}
      </> : <div className="uc-no-page"><p className="uc-eyebrow">YOUR STORE, IN CONTEXT</p><h2>{busy ? 'Reading your pages…' : loaded ? 'Choose a page to begin' : 'Load your storefront pages'}</h2><p>Page settings, template dependencies, and agent actions will appear here.</p></div>}</div>
    </div>
  </section>;
}
