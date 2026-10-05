import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { Selection } from './connection-contract';
import { WarehouseService } from './warehouse-service.ts';
import { storefrontUrl, assertPagePath } from './storefront-data.ts';
import { completedTrafficWindow } from './traffic-data.ts';
import { trafficSnapshotSchema, type TrafficSnapshot, type TrafficPage } from './traffic-contract.ts';

const MAX_PAGES = 10000;
export const TRAFFIC_MAX_BYTES = 1024 ** 3;
type Runner = { run(args: string[]): Promise<string>; verify(selection: Selection): Promise<unknown> };
export function pageTrafficSql(selection: Selection, window: { from: string; to: string }) {
  const host = new URL(storefrontUrl(selection.storefront.host, '/')).hostname.toLowerCase();
  if (!Number.isSafeInteger(selection.storefront.id) || selection.storefront.id <= 0 || ![window.from, window.to].every(date => /^\d{4}-\d{2}-\d{2}$/.test(date))) throw new Error('Invalid page traffic scope.');
  const normalize = (value: string) => `COALESCE(NULLIF(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(${value}, r'[?#].*$', ''), r'(^|/)index\\.html$', '/'), r'/+$', ''), ''), '/')`;
  return `WITH pages AS (
  SELECT storefront_page_oid AS id, parent_storefront_page_oid AS parent_id, path,
    COALESCE(title, path) AS title, visible, ${normalize('path')} AS normalized_path
  FROM ultracart_dw.uc_storefront_pages
  WHERE storefront_oid = ${selection.storefront.id}
), visits AS (
  SELECT s.client_session_oid, ${normalize("REGEXP_REPLACE(h.page_view.url, r'^https?://[^/]+', '')")} AS path
  FROM ultracart_dw.uc_analytics_sessions s, UNNEST(s.hits) h
  WHERE s.partition_date BETWEEN DATE_SUB(DATE_TRUNC(DATE '${window.from}', WEEK(SUNDAY)), INTERVAL 7 DAY) AND DATE '${window.to}'
    AND DATE(s.session_dts) BETWEEN DATE '${window.from}' AND DATE '${window.to}'
    AND h.type = 'pageview'
    AND LOWER(NET.HOST(h.page_view.url)) = '${host}'
    AND s.client_session_oid IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM UNNEST(s.hits) b WHERE b.session_start.bot OR b.session_start.fake_bot)
), traffic AS (
  SELECT path, COUNT(DISTINCT client_session_oid) AS sessions FROM visits GROUP BY path
), joined AS (
  SELECT p.id, p.parent_id, p.path, p.title, p.visible, COALESCE(t.sessions, 0) AS sessions,
    COUNT(*) OVER (PARTITION BY p.normalized_path) AS catalog_copies
  FROM pages p LEFT JOIN traffic t ON t.path = p.normalized_path
)
SELECT ARRAY(SELECT AS STRUCT * FROM joined ORDER BY path, id LIMIT ${MAX_PAGES}) AS pages,
  (SELECT COUNT(*) FROM pages) AS total_pages,
  (SELECT COUNT(DISTINCT client_session_oid) FROM visits) AS host_sessions,
  (SELECT COUNT(*) FROM traffic t WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.normalized_path = t.path)) AS unmatched_paths`;
}
function integer(value: unknown, label: string) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) throw new Error(`Invalid ${label} in warehouse result.`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid ${label} in warehouse result.`);
  return n;
}
export function parsePageTraffic(rows: unknown, selection: Selection, window: { from: string; to: string }, estimatedBytes: number): TrafficSnapshot {
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || !Array.isArray(rows[0].pages)) throw new Error('The warehouse did not return a complete page traffic result.');
  const result = rows[0];
  const totalPages = integer(result.total_pages, 'page count');
  if (totalPages > MAX_PAGES || result.pages.length !== totalPages) throw new Error('This report exceeds the 10,000-page limit or returned incomplete data. No partial snapshot was saved.');
  const ids = new Set<number>();
  const pages: TrafficPage[] = result.pages.map((page: Record<string, unknown>) => {
    const id = integer(page.id, 'page ID');
    if (id === 0 || ids.has(id) || typeof page.path !== 'string' || typeof page.title !== 'string' || ![null, true, false].includes(page.visible as null | boolean)) throw new Error('The warehouse page identity is invalid or duplicated.');
    ids.add(id); assertPagePath(page.path);
    const parentId = page.parent_id === null ? null : integer(page.parent_id, 'parent ID') || null;
    return { id, parentId, path: page.path, title: page.title.slice(0, 500), visible: page.visible as boolean | null, sessions: integer(page.sessions, 'session count'), catalogCopies: integer(page.catalog_copies, 'path copies') };
  });
  const hostSessions = integer(result.host_sessions, 'host sessions');
  if (pages.some(page => page.sessions > hostSessions)) throw new Error('Page sessions exceed the distinct host session total.');
  return trafficSnapshotSchema.parse({ ...window, fetchedAt: new Date().toISOString(), host: selection.storefront.host, estimatedBytes, pages, totalPages, hostSessions, unmatchedPaths: integer(result.unmatched_paths, 'unmatched paths') });
}
export function createPageTrafficFeature({ bb, service, selected }: { bb: BbPluginApi; service: Runner; selected(expected: Selection): Promise<Selection> }) {
  const db = bb.storage.database();
  db.exec('CREATE TABLE IF NOT EXISTS storefront_page_traffic (scope TEXT PRIMARY KEY, snapshot TEXT NOT NULL)');
  const warehouse = new WarehouseService(service, entry => bb.storage.kv.set('page-traffic-last-query', entry));
  const pending = new Map<string, Promise<TrafficSnapshot>>();
  const key = (s: Selection) => JSON.stringify(['v1', s.profileId, s.merchantId, s.storefront.id, s.storefront.host]);
  bb.onDispose(() => { warehouse.dispose(); pending.clear(); });
  return {
    readPageTraffic: async ({ selection }: { selection: Selection }) => {
      const scope = await selected(selection);
      const row = db.prepare('SELECT snapshot FROM storefront_page_traffic WHERE scope = ?').get(key(scope)) as { snapshot: string } | undefined;
      return row ? trafficSnapshotSchema.parse(JSON.parse(row.snapshot)) : null;
    },
    refreshPageTraffic: async ({ selection }: { selection: Selection }) => {
      const scope = await selected(selection);
      const cacheKey = key(scope), requestKey = `${cacheKey}:${scope.verifiedAt}`;
      const existing = pending.get(requestKey);
      if (existing) return existing;
      const work = (async () => {
        const window = completedTrafficWindow();
        const prepared = await warehouse.prepare(scope, { sql: pageTrafficSql(scope, window), maxBytes: TRAFFIC_MAX_BYTES, rowLimit: 1 });
        await selected(scope);
        const receipt = await warehouse.execute(scope, prepared.ticket);
        await selected(scope);
        const snapshot = parsePageTraffic(receipt.rows, scope, window, receipt.estimatedBytes);
        db.prepare('INSERT INTO storefront_page_traffic (scope, snapshot) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET snapshot = excluded.snapshot').run(cacheKey, JSON.stringify(snapshot));
        return snapshot;
      })();
      pending.set(requestKey, work);
      try { return await work; } finally { pending.delete(requestKey); }
    },
  };
}
