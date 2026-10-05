import { useEffect, useMemo, useRef, useState } from 'react';
import { useBbNavigate, useRpc } from '@get-bb/plugin-sdk/app';
import type { Selection } from './connection-contract';
import type { TrafficSnapshot, trafficRpcMethods } from './traffic-contract';
import { trafficTree } from './traffic-data';
import { storefrontUrl } from './storefront-data';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import './traffic.css';

function utcWindow() {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - 30 * 86400000);
  return { from: start.toISOString().slice(0, 10), to: new Date(end.getTime() - 86400000).toISOString().slice(0, 10) };
}
export function TrafficPanel({ selection }: { selection: Selection }) {
  const rpc = useRpc<typeof trafficRpcMethods>();
  const navigate = useBbNavigate();
  const [snapshot, setSnapshot] = useState<TrafficSnapshot | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [pageError, setPageError] = useState('');
  const [rowLimit, setRowLimit] = useState(200);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'structure' | 'sessions'>('structure');
  const [onlyZero, setOnlyZero] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const generation = useRef(0);
  const initialized = useRef(false);
  function receive(next: TrafficSnapshot) {
    setSnapshot(next);
    if (!initialized.current) {
      const ids = new Set(next.pages.map(p => p.id));
      setExpanded(new Set(next.pages.filter(p => p.parentId === null || !ids.has(p.parentId)).map(p => p.id)));
      initialized.current = true;
    }
  }
  useEffect(() => {
    const current = ++generation.current;
    initialized.current = false;
    setSnapshot(null); setError(''); setPageError(''); setRowLimit(200); setBusy('Loading saved traffic'); setExpanded(new Set()); setQuery('');
    rpc.call('readPageTraffic', { selection }).then(next => {
      if (generation.current === current && next) receive(next);
    }).catch(cause => {
      if (generation.current === current) setError(cause instanceof Error ? cause.message : 'Could not load saved traffic.');
    }).finally(() => { if (generation.current === current) setBusy(''); });
    return () => { generation.current++; };
  }, [selection.profileId, selection.merchantId, selection.storefront.id, selection.storefront.host, selection.verifiedAt, rpc]);
  async function refresh() {
    const current = generation.current;
    setBusy('Refreshing traffic'); setError('');
    try {
      const next = await rpc.call('refreshPageTraffic', { selection });
      if (generation.current === current) receive(next);
    } catch (cause) {
      if (generation.current === current) setError(cause instanceof Error ? cause.message : 'Traffic refresh failed.');
    } finally { if (generation.current === current) setBusy(''); }
  }
  const rows = useMemo(() => snapshot ? trafficTree(snapshot.pages, { query, sort, onlyZero, expanded }) : [], [snapshot, query, sort, onlyZero, expanded]);
  useEffect(() => { setRowLimit(200); }, [query, sort, onlyZero]);
  const maxSessions = useMemo(() => Math.max(1, ...(snapshot?.pages.map(p => p.sessions) || [])), [snapshot]);
  const zeroPages = snapshot?.pages.filter(p => p.sessions === 0).length || 0;
  const dates = snapshot || utcWindow();
  const staleRange = !!snapshot && snapshot.to.slice(0, 10) !== utcWindow().to;
  function toggle(id: number) {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  return <section className="uc-traffic" aria-label="Page traffic">
    <header className="uc-traffic-heading"><div><p className="uc-traffic-eyebrow">STOREFRONT TRAFFIC</p><h2>Page traffic</h2><p>Last 30 completed UTC days. <strong>{dates.from.slice(0, 10)} through {dates.to.slice(0, 10)}</strong></p></div><Button variant={snapshot ? 'outline' : 'default'} disabled={!!busy} onClick={refresh}>{busy || (snapshot ? 'Refresh 30-day traffic' : 'Load 30-day traffic')}</Button></header>
    <div className="uc-traffic-source"><code>{snapshot?.host || selection.storefront.host}</code><span>{snapshot ? `Saved ${new Date(snapshot.fetchedAt).toLocaleString()}` : 'No saved snapshot'}</span>{snapshot && <span>{staleRange ? 'Earlier date range. Refresh to update.' : 'Saved snapshot. Refresh for current results.'}</span>}</div>
    {error && <div className="uc-traffic-error" role="alert"><strong>{snapshot ? 'Refresh failed. Showing the previous saved snapshot.' : 'Traffic is unavailable.'}</strong><p>{error}</p></div>}
    {pageError && <p className="uc-traffic-error" role="alert">{pageError}</p>}
    {snapshot ? <>
      <div className="uc-traffic-kpis"><div><span>Catalog pages</span><strong>{snapshot.totalPages.toLocaleString()}</strong></div><div><span>Pages with zero sessions</span><strong>{zeroPages.toLocaleString()}</strong></div><div><span>Sessions on this host</span><strong>{snapshot.hostSessions.toLocaleString()}</strong></div></div>
      {snapshot.hostSessions === 0 && <p role="status">No recorded sessions matched this host and date range. Check analytics collection and warehouse coverage before concluding that the site had no visitors.</p>}
      <div className="uc-traffic-controls"><Input aria-label="Search page traffic" placeholder="Search page title or path…" type="search" maxLength={200} value={query} onChange={e => setQuery(e.target.value)} /><label>Sort<select aria-label="Sort page traffic" value={sort} onChange={e => setSort(e.target.value as 'structure' | 'sessions')}><option value="structure">Page structure</option><option value="sessions">Sessions, highest first</option></select></label><label className="uc-traffic-zero"><input type="checkbox" checked={onlyZero} onChange={e => setOnlyZero(e.target.checked)} />Zero sessions</label><div><Button size="sm" variant="ghost" onClick={() => setExpanded(new Set(snapshot.pages.map(p => p.id)))}>Expand all</Button><Button size="sm" variant="ghost" onClick={() => setExpanded(new Set())}>Collapse all</Button></div></div>
      <p className="uc-traffic-count">{Math.min(rowLimit, rows.length).toLocaleString()} of {rows.length.toLocaleString()} rows shown. Search and zero-session filters keep ancestor pages for context. Sessions sort within each branch.</p>
      <div className="uc-traffic-table-wrap"><table><caption className="uc-traffic-sr-only">Sessions per catalog page, from {dates.from.slice(0, 10)} through {dates.to.slice(0, 10)}, UTC</caption><thead><tr><th scope="col">Page</th><th scope="col" className="uc-traffic-session-heading">Sessions</th><th scope="col">Status</th><th scope="col"><span className="uc-traffic-sr-only">Open page</span></th></tr></thead><tbody>{rows.slice(0, rowLimit).map(({ page, depth, hasChildren, forcedOpen, orphan }) => {
        let url: string | null = null;
        try { url = storefrontUrl(selection.storefront.host, page.path); } catch { /* Invalid catalog paths cannot open another host. */ }
        const open = forcedOpen || expanded.has(page.id);
        return <tr key={page.id} className={page.sessions === 0 ? 'uc-traffic-zero-row' : ''}><th scope="row"><div className="uc-traffic-page" style={{ paddingInlineStart: `${Math.min(depth, 18) * 18}px` }}>{hasChildren ? <button type="button" className="uc-traffic-tree-toggle" aria-label={`${open ? 'Collapse' : 'Expand'} ${page.title}`} aria-expanded={open} disabled={forcedOpen} title={forcedOpen ? 'Expanded to show matching descendants' : undefined} onClick={() => toggle(page.id)}>{open ? '▾' : '▸'}</button> : <span className="uc-traffic-tree-spacer" />}<div><strong>{page.title || page.path}</strong><code>{page.path}</code>{orphan && <small>Parent missing or invalid</small>}{page.catalogCopies > 1 && <small>{page.catalogCopies} catalog copies</small>}</div></div></th><td><div className="uc-traffic-sessions"><span className="uc-traffic-session-bar" aria-hidden="true"><i style={{ width: `${page.sessions / maxSessions * 100}%` }} /></span><strong>{page.sessions.toLocaleString()}</strong></div></td><td><span className="uc-traffic-status">{page.visible === null ? 'Unknown' : page.visible ? 'Visible' : 'Hidden'}</span></td><td><Button size="sm" variant="ghost" disabled={!url} aria-label={`Open ${page.title || page.path} live page`} onClick={() => { setPageError(''); if (url && !navigate.openUrl(url)) setPageError('BB could not open this page.'); }}>↗</Button></td></tr>;
      })}{!rows.length && <tr><td colSpan={4} className="uc-traffic-empty">No pages match these filters.</td></tr>}</tbody></table></div>
      {rows.length > rowLimit && <Button className="uc-traffic-more" size="sm" variant="outline" onClick={() => setRowLimit(n => n + 200)}>Show 200 more pages</Button>}
      <div className="uc-traffic-notes"><p>Sessions count distinct sessions started in this date range that viewed each page. They are not branch totals. A session that visits several pages can count on each page, so page rows do not sum to host sessions.</p><p>Only the exact selected host is included. Host aliases are excluded. Sessions flagged as bots are excluded. Visibility is the catalog setting.</p>{snapshot.unmatchedPaths > 0 && <p>{snapshot.unmatchedPaths.toLocaleString()} visited paths did not match a catalog page. They remain included in host sessions.</p>}</div>
    </> : <div className="uc-traffic-empty-state"><h3>{busy ? 'Loading saved traffic…' : 'Compare traffic across your page structure'}</h3><p>Load the 30-day report to see sessions alongside each page. Saved traffic loads automatically; warehouse queries run only when you press Load or Refresh.</p></div>}
    <p className="uc-traffic-query-note">Each refresh checks the query estimate before running, with a 1 GiB scan ceiling. {snapshot ? `Last estimate: ${(snapshot.estimatedBytes / 1048576).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB.` : ''}</p>
  </section>;
}
