import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Selection } from './connection-contract';
import { assertPagePath } from './storefront-data.ts';
import { draftScopeSchema, draftSaveSchema, fieldEditSchema, type Draft, type DraftScope, type DraftReview } from './draft-contract.ts';

const MAX_BYTES = 512 * 1024;
const MAX_FIELDS = 100;
const MAX_FIELD_LENGTH = 16384;
const LIMITATION = 'Local validation checks toolkit tree and schema rules. It does not prove storefront rendering or publish readiness. Authored-key checks can be stricter during a future push. This workflow saves locally and never publishes or stages a remote preview.';
type Node = Record<string, unknown>;
type Stored = { id: string; scope: DraftScope; container: string; baseline: string; baselineState: string; content: string; baselineHash: string; revision: number; createdAt: string; updatedAt: string };
type Db = ReturnType<BbPluginApi['storage']['database']>;
export type DraftToolkit = { run(args: string[]): Promise<string>; verify(selection: Selection): Promise<unknown>; validateLocal(file: string): Promise<string> };
export function draftHash(text: string) { return createHash('sha256').update(text).digest('hex'); }
export function containerPath(path: string, slot: string) {
  assertPagePath(path);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(slot)) throw new Error('Use a simple container slot name.');
  if (/^\/themes(?:\/|$)/i.test(decodeURIComponent(path))) throw new Error('Choose a page body. Shared theme containers are outside this workflow.');
  if (decodeURIComponent(path).includes('%')) throw new Error('Ambiguous encoded page path.');
  return `${path.replace(/\/$/, '')}/${slot}.cjson`;
}
function scopeKey(scope: DraftScope) { return draftHash(JSON.stringify([scope.selection.profileId, scope.selection.merchantId, scope.selection.storefront.id, scope.selection.storefront.host, scope.path, scope.slot])); }
function document(text: string): Node {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('This container exceeds the 512 KiB draft limit.');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('The container is not valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The container must be a CJSON object.');
  return parsed as Node;
}
function pointerPart(value: string) { return value.replace(/~/g, '~0').replace(/\//g, '~1'); }
function fields(text: string) {
  const result: { pointer: string; widget: string; key: string; value: string }[] = [];
  let skipped = 0, visited = 0;
  const visit = (node: Node, path: string, depth: number) => {
    if (++visited > 10000 || depth > 80) throw new Error('The container tree exceeds the draft inspection limit.');
    if (node.config && typeof node.config === 'object' && !Array.isArray(node.config)) {
      const inspectConfig = (value: unknown, pointer: string, label: string, nesting: number) => {
        if (++visited > 10000) throw new Error('The container configuration exceeds the draft inspection limit.');
        if (typeof value === 'string') {
          if (value.length > MAX_FIELD_LENGTH || result.length >= MAX_FIELDS || pointer.length > 4096) { skipped++; return; }
          result.push({ pointer, widget: `${String(node.type || 'Widget').slice(0, 100)}${typeof node.id === 'string' ? ` #${node.id.slice(0, 100)}` : ''}`, key: label, value });
        } else if (value && typeof value === 'object') {
          if (nesting >= 8) { skipped++; return; }
          for (const [key, child] of Object.entries(value)) {
            if (['__proto__', 'prototype', 'constructor'].includes(key)) { skipped++; continue; }
            inspectConfig(child, `${pointer}/${pointerPart(key)}`, label ? `${label}.${key}` : key, nesting + 1);
          }
        }
      };
      // Include existing translated and responsive string leaves without changing their shape.
      inspectConfig(node.config, `${path}/config`, '', 0);
    }
    if (Array.isArray(node.childWidgets)) node.childWidgets.forEach((child, i) => {
      if (child && typeof child === 'object' && !Array.isArray(child)) visit(child as Node, `${path}/childWidgets/${i}`, depth + 1);
    });
  };
  visit(document(text), '', 0);
  return { fields: result, skipped };
}
export function editDraftContent(content: string, edits: { pointer: string; value: string }[]) {
  const available = new Set(fields(content).fields.map(f => f.pointer));
  const parsed = document(content);
  const seen = new Set<string>();
  for (const item of edits) {
    const { pointer, value } = fieldEditSchema.parse(item);
    if (!available.has(pointer) || seen.has(pointer)) throw new Error('Choose an existing editable widget field once.');
    seen.add(pointer);
    const parts = pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    let target: any = parsed;
    for (const part of parts.slice(0, -1)) target = target[part];
    target[parts.at(-1)!] = value;
  }
  const text = JSON.stringify(parsed, null, 2) + '\n';
  document(text);
  return text;
}
export function draftChanges(baseline: string, content: string) {
  const before = new Map(fields(baseline).fields.map(f => [f.pointer, f.value]));
  return fields(content).fields.map(f => ({ ...f, before: before.get(f.pointer) ?? '' })).filter(f => f.before !== f.value);
}
function view(record: Stored): Draft {
  const original = new Map(fields(record.baseline).fields.map(f => [f.pointer, f.value]));
  const current = fields(record.content);
  const output = current.fields.map(f => ({ ...f, before: original.get(f.pointer) ?? '' }));
  return { id: record.id, path: record.scope.path, slot: record.scope.slot, container: record.container, revision: record.revision, baselineHash: record.baselineHash, createdAt: record.createdAt, updatedAt: record.updatedAt, fields: output, skippedFields: current.skipped, changedFields: output.filter(f => f.before !== f.value).length };
}
export function parseDraftValidation(text: string): DraftReview['validation'] {
  const data = JSON.parse(text);
  if (typeof data.valid !== 'boolean' || !Number.isSafeInteger(data.errors) || data.errors < 0 || !Number.isSafeInteger(data.warnings) || data.warnings < 0 || !Array.isArray(data.diagnostics)) throw new Error('The toolkit returned an invalid validation report.');
  const diagnostics = data.diagnostics.slice(0, 100).map((d: any) => {
    if (!d || typeof d.message !== 'string' || typeof d.code !== 'string' || typeof d.path !== 'string' || !['error', 'warning', 'info'].includes(d.severity)) throw new Error('The toolkit returned an invalid diagnostic.');
    return { severity: d.severity, code: d.code.slice(0, 200), path: d.path.slice(0, 4096), message: d.message.slice(0, 4000) };
  });
  return { valid: data.valid, errors: data.errors, warnings: data.warnings, diagnostics, omitted: (Number.isSafeInteger(data.diagnosticsOmitted) && data.diagnosticsOmitted >= 0 ? data.diagnosticsOmitted : 0) + Math.max(0, data.diagnostics.length - 100) };
}
export class DraftService {
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private db: Db;
  private toolkit: DraftToolkit;
  constructor(db: Db, toolkit: DraftToolkit) { this.db = db; this.toolkit = toolkit; }
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    if (this.pending >= 8) return Promise.reject(new Error('Draft operations are busy. Wait for the current request.'));
    this.pending++;
    const next = this.queue.catch(() => undefined).then(work).finally(() => { this.pending--; });
    this.queue = next;
    return next;
  }
  private load(scope: DraftScope): Stored | null {
    const row = this.db.prepare('SELECT record FROM storefront_drafts WHERE scope_key = ?').get(scopeKey(scope)) as { record: string } | undefined;
    if (!row) return null;
    const stored = JSON.parse(row.record) as Stored;
    if (scopeKey(stored.scope) !== scopeKey(scope) || stored.container !== containerPath(scope.path, scope.slot) || draftHash(stored.baseline) !== stored.baselineHash) throw new Error('Saved draft scope or baseline is invalid.');
    document(stored.content); document(stored.baseline);
    return stored;
  }
  private save(record: Stored) {
    this.db.prepare('INSERT INTO storefront_drafts (scope_key, record) VALUES (?, ?) ON CONFLICT(scope_key) DO UPDATE SET record = excluded.record').run(scopeKey(record.scope), JSON.stringify(record));
  }
  private async temporary<T>(action: (file: string) => Promise<T>) {
    const dir = await mkdtemp(join(tmpdir(), 'storefront-draft-'));
    try { return await action(join(dir, 'body.cjson')); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
  private async remote(scope: DraftScope) {
    await this.toolkit.verify(scope.selection);
    return this.temporary(async file => {
      await this.toolkit.run(['--format', 'json', '--profile', scope.selection.profileId, 'sf', 'pull', containerPath(scope.path, scope.slot), '--storefront', String(scope.selection.storefront.id), '--out', file]);
      if ((await stat(file)).size > MAX_BYTES || (await stat(file + '.sf.json')).size > MAX_BYTES * 2 + 8192) throw new Error('This container exceeds the 512 KiB draft limit.');
      const baseline = await readFile(file, 'utf8');
      const baselineState = await readFile(file + '.sf.json', 'utf8');
      const state = JSON.parse(baselineState);
      const hash = draftHash(baseline);
      if (state.version !== 1 || state.merchant !== scope.selection.merchantId || state.storefront !== scope.selection.storefront.id || state.to !== containerPath(scope.path, scope.slot) || state.hash !== hash || state.content !== baseline) throw new Error('The toolkit baseline does not match the selected merchant, storefront, page, or content.');
      fields(baseline);
      return { baseline, baselineState, hash };
    });
  }
  read(raw: DraftScope) {
    const scope = draftScopeSchema.parse(raw);
    containerPath(scope.path, scope.slot);
    const record = this.load(scope);
    return record ? view(record) : null;
  }
  pull(raw: DraftScope): Promise<Draft> {
    const scope = draftScopeSchema.parse(raw);
    containerPath(scope.path, scope.slot);
    return this.serialized(async () => {
      const existing = this.load(scope);
      if (existing) return view(existing);
      const remote = await this.remote(scope);
      const now = new Date().toISOString();
      const record: Stored = { id: randomUUID(), scope, container: containerPath(scope.path, scope.slot), baseline: remote.baseline, baselineState: remote.baselineState, content: remote.baseline, baselineHash: remote.hash, revision: 1, createdAt: now, updatedAt: now };
      this.save(record);
      return view(record);
    });
  }
  update(raw: unknown): Promise<Draft> {
    const input = draftSaveSchema.parse(raw);
    return this.serialized(async () => {
      const record = this.load(input);
      if (!record || record.id !== input.id) throw new Error('This draft does not belong to this page and store.');
      if (record.revision !== input.revision) throw new Error('This draft changed in another window. Reload it before saving.');
      const content = editDraftContent(record.content, input.edits);
      if (draftChanges(record.content, content).length) {
        record.content = content; record.revision++; record.updatedAt = new Date().toISOString(); this.save(record);
      }
      return view(record);
    });
  }
  review(raw: DraftScope & { id: string; revision: number }): Promise<DraftReview> {
    const scope = draftScopeSchema.parse({ selection: raw.selection, path: raw.path, slot: raw.slot });
    return this.serialized(async () => {
      const record = this.load(scope);
      if (!record || record.id !== raw.id) throw new Error('This draft does not belong to this page and store.');
      if (record.revision !== raw.revision) throw new Error('This draft changed. Reload and review the current revision.');
      const validation = await this.temporary(async file => {
        await writeFile(file, record.content, { mode: 0o600, flag: 'wx' });
        return parseDraftValidation(await this.toolkit.validateLocal(file));
      });
      const remote = await this.remote(scope);
      return { draft: view(record), changes: draftChanges(record.baseline, record.content), validation, remoteChanged: remote.hash !== record.baselineHash, remoteHash: remote.hash, reviewedRevision: record.revision, checkedAt: new Date().toISOString(), limitation: LIMITATION };
    });
  }
}
export function createDraftFeature({ bb, service, selected }: { bb: BbPluginApi; service: DraftToolkit; selected(expected: Selection): Promise<Selection> }) {
  const db = bb.storage.database();
  // One namespaced table; avoid sharing migration indices with other features.
  db.exec('CREATE TABLE IF NOT EXISTS storefront_drafts (scope_key TEXT PRIMARY KEY, record TEXT NOT NULL)');
  const drafts = new DraftService(db, service);
  async function scope<T extends DraftScope>(input: T): Promise<T> { return { ...input, selection: await selected(input.selection) }; }
  return {
    handlers: {
      readDraft: async (input: DraftScope) => drafts.read(await scope(input)),
      pullDraft: async (input: DraftScope) => drafts.pull(await scope(input)),
      saveDraft: async (input: DraftScope & { id: string; revision: number; edits: { pointer: string; value: string }[] }) => drafts.update(await scope(input)),
      reviewDraft: async (input: DraftScope & { id: string; revision: number }) => drafts.review(await scope(input)),
    },
    drafts,
  };
}
