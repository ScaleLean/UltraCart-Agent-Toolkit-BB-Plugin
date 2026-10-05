import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { WarehouseService, boundedSql, parseWarehouseReceipt, warehouseProject } from '../warehouse-service.ts';
import { warehouseSchemaSql } from '../warehouse-contract.ts';

const selection = { profileId: 'demo', merchantId: 'DEMO', storefront: { id: 1, host: 'shop.example', themeId: null }, verifiedAt: '2026-10-02' };
const query = { sql: 'SELECT 1 AS value', rowLimit: 10, maxBytes: 1000000 };
function receipt(executed = false, overrides = {}) { return JSON.stringify({ action: 'warehouse.query', project: 'ultracart-dw-demo', estimatedBytes: 100, maxBytes: query.maxBytes, referencedTables: ['ultracart-dw-demo.ultracart_dw_streaming.uc_orders'], cacheHit: false, executed, ...(executed ? { rows: [{value:1}] } : {}), ...overrides }); }
test('bounds one SELECT and rejects statements, comments, and injected identifiers', () => {
  assert.match(boundedSql(query.sql, 10), /LIMIT 10$/);
  for (const sql of ['DELETE FROM table', 'SELECT 1; SELECT 2', 'SELECT 1 -- more', 'SELECT /* more */ 1']) assert.throws(() => boundedSql(sql, 10));
  assert.throws(() => boundedSql(query.sql, 501));
  assert.throws(() => warehouseSchemaSql("name' OR 1=1"));
  assert.match(warehouseSchemaSql('uc_orders'), /COLUMN_FIELD_PATHS/);
  assert.equal(warehouseProject('DEMO'), 'ultracart-dw-demo');
});
test('rejects receipts with foreign projects, nongranted datasets, bad scan estimates, or excess rows', () => {
  assert.equal(parseWarehouseReceipt(receipt(), 'ultracart-dw-demo', false, 10).rows.length, 0);
  for (const overrides of [{project:'foreign'}, {referencedTables:['foreign.ultracart_dw_streaming.uc_orders']}, {referencedTables:['ultracart-dw-demo.ultracart_dw_high.customers']}, {estimatedBytes:2000000}, {maxBytes:0}, {estimatedBytes:-1}]) assert.throws(() => parseWarehouseReceipt(receipt(false, overrides), 'ultracart-dw-demo', false, 10));
  assert.throws(() => parseWarehouseReceipt(receipt(true, {rows:[{a:1},{a:2}]}), 'ultracart-dw-demo', true, 1));
});
test('requires a matching reviewed ticket; native calls use profile, scan cap, bounded SQL, private audit and fresh dry runs', async () => {
  const commands: string[][] = [];
  const audits: unknown[] = [];
  const service = new WarehouseService({ verify: async () => {}, run: async args => { commands.push(args); return receipt(!args.includes('--dry-run')); } }, async entry => { audits.push(entry); });
  await assert.rejects(service.execute(selection, 'unreviewed'), /dry run/);
  const prepared = await service.prepare(selection, query);
  assert.equal(commands.length, 1);
  await assert.rejects(service.execute({...selection, merchantId:'OTHER'}, prepared.ticket), /dry run/);
  const result = await service.execute(selection, prepared.ticket);
  assert.equal(result.executed, true);
  assert.equal(commands.length, 3);
  assert.equal(commands[1].includes('--dry-run'), true);
  assert.equal(commands[2].includes('--dry-run'), false);
  for (const args of commands) {
    assert.equal(args[args.indexOf('--profile') + 1], 'demo');
    assert.equal(args[args.indexOf('--merchant') + 1], 'DEMO');
    assert.equal(args[args.indexOf('--max-bytes') + 1], '1000000');
    assert.match(args.at(-1)!, /LIMIT 10$/);
    assert.equal(existsSync(args[args.indexOf('--audit-log') + 1]), false);
  }
  assert.equal(JSON.stringify(audits).includes(query.sql), false);
  assert.equal(JSON.stringify(audits).includes('rows'), false);
  await assert.rejects(service.execute(selection, prepared.ticket), /dry run/);
});
test('verification failure blocks query and disposal revokes tickets', async () => {
  let calls = 0;
  const denied = new WarehouseService({verify:async()=>{throw new Error('identity changed');},run:async()=>{calls++;return receipt();}});
  await assert.rejects(denied.prepare(selection, query), /identity changed/);
  assert.equal(calls, 0);
  const service = new WarehouseService({verify:async()=>{},run:async()=>receipt()});
  const prepared = await service.prepare(selection, query); service.dispose();
  await assert.rejects(service.execute(selection, prepared.ticket), /dry run/);
});
test('a failed final audit does not hide a verified execution outcome', async () => {
  let audits = 0;
  const service = new WarehouseService({ verify: async () => {}, run: async args => receipt(!args.includes('--dry-run')) }, async () => { if (++audits === 6) throw new Error('storage failed'); });
  const prepared = await service.prepare(selection, query);
  const result = await service.execute(selection, prepared.ticket);
  assert.equal(result.executed, true);
  assert.match(result.auditWarning!, /audit event/);
});
