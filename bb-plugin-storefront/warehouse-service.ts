import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { Selection } from './connection-contract';
import { warehouseInputSchema, warehouseReceiptSchema, warehouseTablesSql, type WarehouseQuery, type WarehouseReceipt } from './warehouse-contract.ts';

type Runner = { run(args: string[]): Promise<string>; verify(selection: Selection): Promise<unknown> };
type Audit = (entry: { at: string; queryHash: string; project: string; estimatedBytes: number | null; maxBytes: number; executed: boolean; outcome: string }) => Promise<void>;
export function warehouseProject(merchant: string) {
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/i.test(merchant)) throw new Error('This merchant id cannot resolve to a conventional warehouse project.');
  const id = merchant.toLowerCase();
  return id.startsWith('ultracart-dw-') ? id : `ultracart-dw-${id}`;
}
export function boundedSql(sql: string, rowLimit: number) {
  if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 100) throw new Error('Use a row limit from 1 to 100.');
  const query = sql.trim();
  if (query.length > 20000 || !/^(SELECT|WITH)\b/i.test(query) || /[;\u0000]/.test(query) || /--|\/\*|\*\//.test(query)) throw new Error('Use one SELECT or WITH query without comments or semicolons.');
  return `SELECT * FROM (\n${query}\n) AS uc_bounded\nLIMIT ${rowLimit}`;
}
export function parseWarehouseReceipt(text: string, expectedProject: string, expectedExecuted: boolean, rowLimit: number): WarehouseReceipt {
  let result: any;
  try { result = JSON.parse(text); } catch { throw new Error('The warehouse returned an unreadable response.'); }
  if (result?.action !== 'warehouse.query' || result.project !== expectedProject || result.executed !== expectedExecuted || !Number.isSafeInteger(result.estimatedBytes) || result.estimatedBytes < 0 || !Number.isSafeInteger(result.maxBytes) || result.maxBytes < 1 || result.estimatedBytes > result.maxBytes || !Array.isArray(result.referencedTables)) throw new Error('The warehouse receipt could not be verified.');
  for (const ref of result.referencedTables) {
    if (typeof ref !== 'string' || !ref.replace(':', '.').startsWith(`${expectedProject}.`) || !/^ultracart_dw(?:_streaming)?(?:\.|$)/.test(ref.replace(':', '.').slice(expectedProject.length + 1))) throw new Error('The query resolves outside this merchant warehouse.');
  }
  const rows = expectedExecuted ? result.rows : [];
  if (!Array.isArray(rows) || rows.length > rowLimit || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('The warehouse returned an unexpected or oversized row set.');
  return warehouseReceiptSchema.parse({ project: result.project, estimatedBytes: result.estimatedBytes, maxBytes: result.maxBytes, referencedTables: result.referencedTables, cacheHit: result.cacheHit === true, executed: result.executed, rows, fetchedAt: new Date().toISOString() });
}
export class WarehouseService {
  private prepared = new Map<string, { selection: string; query: WarehouseQuery; expires: number }>();
  private service: Runner;
  private audit: Audit;
  constructor(service: Runner, audit: Audit = async () => {}) { this.service = service; this.audit = audit; }
  private key(selection: Selection) { return JSON.stringify([selection.profileId, selection.merchantId, selection.storefront.id, selection.storefront.host, selection.verifiedAt]); }
  private async query(selection: Selection, input: WarehouseQuery, dryRun: boolean) {
    const query = warehouseInputSchema.parse(input);
    const sql = boundedSql(query.sql, query.rowLimit);
    const project = warehouseProject(selection.merchantId);
    await this.service.verify(selection);
    const queryHash = createHash('sha256').update(sql).digest('hex');
    const auditDirectory = await mkdtemp(join(tmpdir(), 'uc-warehouse-'));
    let receipt: WarehouseReceipt;
    try {
      await this.audit({ at: new Date().toISOString(), queryHash, project, estimatedBytes: null, maxBytes: query.maxBytes, executed: false, outcome: dryRun ? 'dry run requested' : 'execution requested' });
      receipt = parseWarehouseReceipt(await this.service.run(['--format', 'json', '--profile', selection.profileId, 'warehouse', 'query', '--merchant', selection.merchantId, '--max-bytes', String(query.maxBytes), '--audit-log', join(auditDirectory, 'query.jsonl'), ...(dryRun ? ['--dry-run'] : []), sql]), project, !dryRun, query.rowLimit);
      if (receipt.maxBytes !== query.maxBytes) throw new Error('The warehouse scan ceiling did not match this request.');
    } catch (error) {
      await this.audit({ at: new Date().toISOString(), queryHash, project, estimatedBytes: null, maxBytes: query.maxBytes, executed: false, outcome: dryRun ? 'dry run failed or receipt rejected' : 'execution outcome unverified' });
      throw error;
    } finally { await rm(auditDirectory, { recursive: true, force: true }); }
    try {
      await this.audit({ at: receipt.fetchedAt, queryHash, project, estimatedBytes: receipt.estimatedBytes, maxBytes: receipt.maxBytes, executed: receipt.executed, outcome: dryRun ? 'dry run' : 'executed' });
    } catch {
      receipt.auditWarning = 'The query receipt is verified, but its final local audit event could not be saved.';
    }
    return receipt;
  }
  async check(selection: Selection) { return this.query(selection, { sql: warehouseTablesSql, maxBytes: 1024 ** 3, rowLimit: 100 }, true); }
  async prepare(selection: Selection, query: WarehouseQuery) {
    const receipt = await this.query(selection, query, true);
    for (const [id, item] of this.prepared) if (item.expires <= Date.now()) this.prepared.delete(id);
    if (this.prepared.size >= 20) this.prepared.delete(this.prepared.keys().next().value!);
    const ticket = randomUUID();
    this.prepared.set(ticket, { selection: this.key(selection), query: warehouseInputSchema.parse(query), expires: Date.now() + 5 * 60 * 1000 });
    return { receipt, ticket };
  }
  async execute(selection: Selection, ticket: string) {
    const prepared = this.prepared.get(ticket);
    if (!prepared || prepared.expires <= Date.now() || prepared.selection !== this.key(selection)) throw new Error('Run a new dry run for this merchant before execution.');
    this.prepared.delete(ticket);
    // Recheck through the CLI immediately before execution, including its native byte ceiling.
    await this.query(selection, prepared.query, true);
    return this.query(selection, prepared.query, false);
  }
  dispose() { this.prepared.clear(); }
}
export function createWarehouseFeature({ bb, service, selected }: { bb: BbPluginApi; service: Runner; selected: (expected: Selection) => Promise<Selection> }) {
  let auditQueue: Promise<void> = Promise.resolve();
  const warehouse = new WarehouseService(service, entry => {
    const next = auditQueue.then(async () => {
      const saved = await bb.storage.kv.get('warehouse-audit');
      const entries = Array.isArray(saved) ? saved.slice(-49) : [];
      await bb.storage.kv.set('warehouse-audit', [...entries, entry]);
    });
    auditQueue = next.catch(() => {});
    return next;
  });
  bb.onDispose(() => warehouse.dispose());
  return {
    warehouseCheck: async ({ selection }: { selection: Selection }) => warehouse.check(await selected(selection)),
    warehousePrepare: async ({ selection, query }: { selection: Selection; query: WarehouseQuery }) => warehouse.prepare(await selected(selection), query),
    warehouseExecute: async ({ selection, ticket }: { selection: Selection; ticket: string }) => warehouse.execute(await selected(selection), ticket),
  };
}
