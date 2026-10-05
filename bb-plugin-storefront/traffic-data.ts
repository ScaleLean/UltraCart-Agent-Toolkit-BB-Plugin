import type { TrafficPage } from './traffic-contract';

export function completedTrafficWindow(now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { from: new Date(end.getTime() - 30 * 86400000).toISOString().slice(0, 10), to: new Date(end.getTime() - 86400000).toISOString().slice(0, 10) };
}

export function trafficTree(pages: TrafficPage[], options: { query: string; sort: 'structure' | 'sessions'; onlyZero: boolean; expanded: Set<number> }) {
  const byId = new Map(pages.map(page => [page.id, page]));
  const parent = new Map<number, number | null>();
  const orphan = new Set<number>();
  for (const page of pages) {
    const pid = page.parentId;
    if (pid === null) parent.set(page.id, null);
    else if (pid === page.id || !byId.has(pid)) { parent.set(page.id, null); orphan.add(page.id); }
    else parent.set(page.id, pid);
  }
  // Break malformed parent cycles deterministically so every page remains reachable.
  const done = new Set<number>();
  for (const page of pages) {
    const chain = new Set<number>(); let id: number | null = page.id;
    while (id !== null && !done.has(id)) {
      if (chain.has(id)) { parent.set(id, null); orphan.add(id); break; }
      chain.add(id); id = parent.get(id) ?? null;
    }
    for (const member of chain) done.add(member);
  }
  const children = new Map<number | null, TrafficPage[]>();
  for (const page of pages) { const pid = parent.get(page.id) ?? null; const list = children.get(pid) || []; list.push(page); children.set(pid, list); }
  for (const list of children.values()) list.sort((a, b) => (options.sort === 'sessions' ? b.sessions - a.sessions : 0) || (a.path === '/' ? -1 : b.path === '/' ? 1 : a.path.localeCompare(b.path)) || a.id - b.id);
  const terms = options.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const filtering = !!terms.length || options.onlyZero;
  const keep = new Set<number>();
  if (filtering) for (const page of pages) {
    if (options.onlyZero && page.sessions !== 0 || !terms.every(term => `${page.title} ${page.path}`.toLowerCase().includes(term))) continue;
    let id: number | null = page.id;
    while (id !== null && !keep.has(id)) { keep.add(id); id = parent.get(id) ?? null; }
  }
  const rows: { page: TrafficPage; depth: number; hasChildren: boolean; forcedOpen: boolean; orphan: boolean }[] = [];
  const stack = (children.get(null) || []).slice().reverse().map(page => ({ page, depth: 0 }));
  while (stack.length) {
    const { page, depth } = stack.pop()!;
    if (filtering && !keep.has(page.id)) continue;
    const nested = children.get(page.id) || [];
    rows.push({ page, depth, hasChildren: nested.length > 0, forcedOpen: filtering, orphan: orphan.has(page.id) });
    if (filtering || options.expanded.has(page.id)) for (let i = nested.length - 1; i >= 0; i--) stack.push({ page: nested[i], depth: depth + 1 });
  }
  return rows;
}
