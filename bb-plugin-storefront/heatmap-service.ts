import { randomUUID } from 'node:crypto';
import type { Selection } from './connection-contract';
import { assertPagePath, storefrontUrl } from './storefront-data.ts';
import { heatmapFiltersSchema, type HeatmapFilters, type HeatmapResult, type HeatmapLocation } from './heatmap-contract.ts';
const MAX_BYTES = 1024 ** 3;
type Runner = {run(args:string[],options?:{acceptedExitCodes?:number[]}):Promise<string>;verify(selection:Selection):Promise<unknown>};
type Scope = {selection:Selection,path:string};
const identity = (s:Selection) => JSON.stringify([s.profileId,s.merchantId,s.storefront.id,s.storefront.host,s.verifiedAt]);
export function validateHeatmapFilters(input: HeatmapFilters):HeatmapFilters {
  const filters = heatmapFiltersSchema.parse(input);
  for (const value of [filters.from,filters.to]) if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) throw new Error('Choose valid calendar dates.');
  const duration = Date.parse(filters.to)-Date.parse(filters.from);
  if (duration < 0 || duration > 30 * 86400000) throw new Error('Choose a date range of at most 31 days, with the end after the start.');
  return filters;
}
export function heatmapQuery(selection:Selection,path:string,input:HeatmapFilters) {
  assertPagePath(path); const filters = validateHeatmapFilters(input);
  const url = new URL(storefrontUrl(selection.storefront.host,path));
  const sql = `WITH scoped AS (
  SELECT h.* FROM ultracart_dw.uc_screen_recording_heatmap_data h
  WHERE h.partition_date BETWEEN DATE_SUB(DATE_TRUNC(@from, WEEK(SUNDAY)), INTERVAL 7 DAY) AND @to
    AND DATE(h.heatmap_date) BETWEEN @from AND @to
    AND h.screen_size = @device
    AND LOWER(NET.HOST(h.url)) = @host
    AND REGEXP_REPLACE(REGEXP_REPLACE(h.url, r'^https?://[^/]+', ''), r'(index\\.html)?(\\?.*)?$', '') = @path
), elements AS (
  SELECT sel.selector, SUM(COALESCE(ARRAY_LENGTH(sel.clicks),0)) AS clicks, SUM(COALESCE(ARRAY_LENGTH(sel.movements),0)) AS movements
  FROM scoped h, UNNEST(h.selectors) sel WHERE sel.selector IS NOT NULL GROUP BY sel.selector
), summary AS (
  SELECT COUNT(*) AS heatmap_rows,
    APPROX_QUANTILES(scroll_percentage, 4)[OFFSET(1)] AS scroll_p25,
    APPROX_QUANTILES(scroll_percentage, 4)[OFFSET(2)] AS scroll_median,
    APPROX_QUANTILES(scroll_percentage, 4)[OFFSET(3)] AS scroll_p75 FROM scoped
)
SELECT ARRAY(SELECT AS STRUCT selector, clicks, movements FROM elements ORDER BY clicks DESC, movements DESC, selector LIMIT 40) AS elements,
  (SELECT COALESCE(SUM(clicks),0) FROM elements) AS total_clicks,
  (SELECT COALESCE(SUM(movements),0) FROM elements) AS total_movements, summary.* FROM summary`;
  return {sql,filters,parameters:[`from:DATE:${filters.from}`,`to:DATE:${filters.to}`,`device:STRING:${filters.device}`,`host:STRING:${url.hostname.toLowerCase()}`,`path:STRING:${url.pathname}`]};
}
export function parseHeatmapReceipt(text:string,merchantId:string,executed:boolean) {
  const result = JSON.parse(text);
  const project = `ultracart-dw-${merchantId.toLowerCase()}`;
  if(result.action !== 'warehouse.query' || result.project !== project || result.executed !== executed || result.maxBytes !== MAX_BYTES || !Number.isSafeInteger(result.estimatedBytes) || result.estimatedBytes < 0 || result.estimatedBytes > MAX_BYTES || !Array.isArray(result.referencedTables)) throw new Error('The warehouse returned an unexpected scope or cost receipt.');
  if (result.referencedTables.some((table:unknown) => typeof table !== 'string' || !new RegExp(`^${project.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}[.:]ultracart_dw(?:_streaming)?\\.`).test(table))) throw new Error('The warehouse resolved a table outside the selected merchant.');
  return {receipt:{project,estimatedBytes:result.estimatedBytes,maxBytes:MAX_BYTES,referencedTables:result.referencedTables as string[]},rows:result.rows as unknown};
}
const count = (value:unknown) => { const n = typeof value === 'number' || typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN; if (!Number.isSafeInteger(n) || n < 0) throw new Error('The heatmap returned an invalid count.'); return n; };
const depth = (value:unknown) => {if (value == null) return null; const n=typeof value === 'number' || typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN; if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('The heatmap returned an invalid scroll percentage.'); return n;};
export function parseHeatmapRows(rows:unknown) {
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('The heatmap returned an unexpected summary.');
  const row=rows[0]; if (!row || !Array.isArray(row.elements) || row.elements.length>40) throw new Error('The heatmap returned invalid elements.');
  return {rows:row.elements.map((r:Record<string,unknown>)=>{if(typeof r.selector!=='string' || r.selector.length>2048) throw new Error('The heatmap returned an invalid selector.');return {selector:r.selector,clicks:count(r.clicks),movements:count(r.movements)};}),clicks:count(row.total_clicks),movements:count(row.total_movements),heatmapRows:count(row.heatmap_rows),scroll:{p25:depth(row.scroll_p25),median:depth(row.scroll_median),p75:depth(row.scroll_p75)}};
}
export function createHeatmapFeature({service,selected}:{bb?:unknown,service:Runner,selected:(selection:Selection)=>Promise<Selection>}) {
  const tickets = new Map<string,{scope:string,path:string,query:ReturnType<typeof heatmapQuery>,expires:number}>();
  const args = (scope:Selection,q:ReturnType<typeof heatmapQuery>,dry:boolean) => ['--format','json','--profile',scope.profileId,'warehouse','query',q.sql,'--merchant',scope.merchantId,'--max-bytes',String(MAX_BYTES),...q.parameters.flatMap(p=>['--parameter',p]),...(dry?['--dry-run']:[])];
  return {
    previewHeatmap:async ({selection,path,filters}:Scope & {filters:HeatmapFilters}) => {
      const scope = await selected(selection); const query=heatmapQuery(scope,path,filters); await service.verify(scope);
      const {receipt}=parseHeatmapReceipt(await service.run(args(scope,query,true)),scope.merchantId,false);
      await selected(scope); const ticket=randomUUID(),expires=Date.now()+5*60000;
      for(const [key,value] of tickets) if(value.expires<Date.now()) tickets.delete(key);
      if(tickets.size>=20) tickets.delete(tickets.keys().next().value!);
      tickets.set(ticket,{scope:identity(scope),path,query,expires});
      return {ticket,sql:query.sql,parameters:query.parameters,receipt,expiresAt:new Date(expires).toISOString()};
    },
    runHeatmap:async ({selection,path,ticket}:Scope & {ticket:string}):Promise<HeatmapResult> => {
      const scope = await selected(selection); assertPagePath(path); const saved=tickets.get(ticket);
      if(!saved || saved.expires<Date.now() || saved.scope!==identity(scope) || saved.path!==path) throw new Error('Preview this page and date range again before running the heatmap.');
      tickets.delete(ticket); await service.verify(scope);
      const {receipt,rows}=parseHeatmapReceipt(await service.run(args(scope,saved.query,false)),scope.merchantId,true);
      await selected(scope);return {filters:saved.query.filters,receipt,fetchedAt:new Date().toISOString(),...parseHeatmapRows(rows)};
    },
    locateHeatmap:async ({selection,path,selector}:Scope & {selector:string}):Promise<HeatmapLocation> => {
      const scope=await selected(selection);assertPagePath(path);
      if(!selector || selector.length>2048 || /[\x00-\x1f]/.test(selector) || selector.startsWith('-')) throw new Error('Use a valid selector from the heatmap.');
      await service.verify(scope);
      const report=JSON.parse(await service.run(['--format','json','--profile',scope.profileId,'sf','locate','--storefront',String(scope.storefront.id),'--uri',path,'--',selector],{acceptedExitCodes:[0,1]}));
      await selected(scope);
      if(report.action!=='sf.locate' || report.storefrontOid!==scope.storefront.id || report.page!==path || !Array.isArray(report.results) || report.results.length!==1 || report.results[0].input!==selector) throw new Error('Unexpected widget lookup scope.');
      const result=report.results[0];
      return {status:String(result.status),reason:String(result.reason),matches:(result.matches||[]).slice(0,40).map((m:Record<string,unknown>)=>({file:String(m.file),path:String(m.path),id:String(m.id),type:typeof m.type==='string'?m.type:null,title:typeof m.title==='string'?m.title:null,excerpt:typeof m.excerpt==='string'?m.excerpt:null})),warnings:[...(report.warnings||[]),...(report.notFollowed||[])].map(String).slice(0,40)};
    },
  };
}
