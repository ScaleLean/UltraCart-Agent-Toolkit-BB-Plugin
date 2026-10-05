import { useEffect, useId, useRef, useState } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import type { Selection } from './connection-contract';
import { warehouseTablesSql, warehouseSchemaSql, type warehouseRpcContract, type WarehouseReceipt } from './warehouse-contract';
import './warehouse.css';

function bytes(value: number) { return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` : `${(value / 1024 ** 2).toFixed(2)} MiB`; }
function cell(value: unknown) { const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''; return text.length > 2000 ? `${text.slice(0, 2000)}…` : text; }
export function WarehousePanel({ selection }: { selection: Selection }) {
  const rpc = useRpc<typeof warehouseRpcContract>();
  const uid = useId();
  const generation = useRef(0);
  const [sql, setSql] = useState(warehouseTablesSql);
  const [maxMiB, setMaxMiB] = useState('1024');
  const [rowLimit, setRowLimit] = useState('100');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<WarehouseReceipt | null>(null);
  const [ticket, setTicket] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    generation.current++;
    setReceipt(null); setTicket(null); setChecked(false); setError(''); setBusy(false); setSql(warehouseTablesSql);
    return () => { generation.current++; };
  }, [selection.profileId, selection.merchantId, selection.storefront.id, selection.verifiedAt]);
  async function act(work: () => Promise<void>) {
    const current = generation.current;
    setBusy(true); setError('');
    try { await work(); } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : 'The warehouse request failed.'); }
    finally { if (current === generation.current) setBusy(false); }
  }
  function edit(next: string) { setSql(next); setTicket(null); setReceipt(null); setError(''); }
  const valid = Number.isInteger(Number(maxMiB) * 1024 ** 2) && Number(maxMiB) > 0 && Number(maxMiB) <= 20480 && Number.isInteger(Number(rowLimit)) && Number(rowLimit) >= 1 && Number(rowLimit) <= 100 && sql.trim().length > 0;
  const rows = receipt?.executed ? receipt.rows : [];
  const columns = Array.from(new Set(rows.flatMap(row => Object.keys(row)))).slice(0, 30);
  return <section className="uc-warehouse" aria-labelledby={`${uid}-title`}>
    <div className="uc-warehouse-heading"><div><p className="uc-eyebrow">MERCHANT ANALYTICS</p><h2 id={`${uid}-title`}>Data warehouse</h2><p>Merchant {selection.merchantId}. Queries cover the merchant warehouse. Selecting {selection.storefront.host} does not add a storefront filter.</p></div><Button variant="outline" disabled={busy} onClick={() => act(async () => {
      const current = generation.current;
      const result = await rpc.call('warehouseCheck', { selection });
      if (current !== generation.current) return;
      setChecked(true); setReceipt(result); setTicket(null);
    })}>{busy ? 'Working…' : 'Check setup'}</Button></div>
    <p className="uc-warehouse-note">Warehouse reads require Google Cloud SDK <code>bq</code> and an authorized Google principal on the BB server. UltraCart sign-in alone does not grant warehouse access. Grant both <code>ultracart_dw</code> and <code>ultracart_dw_streaming</code>.</p>
    {checked && <p role="status">Metadata dry run succeeded. This confirms metadata access. Run a dry run against a discovered view to check its streaming grant.</p>}
    <div className="uc-warehouse-presets"><Button size="sm" variant="outline" disabled={busy} onClick={() => edit(warehouseTablesSql)}>Discover tables</Button><span>Prepares a metadata query. Dry-run and run it below to load table names.</span></div>
    <label htmlFor={`${uid}-sql`}>Read-only SQL</label><textarea id={`${uid}-sql`} value={sql} maxLength={20000} spellCheck={false} disabled={busy} onChange={e => edit(e.target.value)} />
    <p className="uc-warehouse-note">Use one SELECT or WITH query without comments or semicolons. Discover the schema before writing a report. Event queries need both a weekly partition filter and a timestamp filter. The row limit bounds output; the scan ceiling bounds bytes scanned. The toolkit uses the local bq display limit, which can truncate the result further.</p>
    <div className="uc-warehouse-limits"><div><label htmlFor={`${uid}-bytes`}>Scan ceiling (MiB, max 20,480)</label><Input id={`${uid}-bytes`} type="number" min="1" max="20480" value={maxMiB} disabled={busy} onChange={e => { setMaxMiB(e.target.value); setTicket(null); setReceipt(null); }} /></div><div><label htmlFor={`${uid}-rows`}>Maximum rows (1–100)</label><Input id={`${uid}-rows`} type="number" min="1" max="100" value={rowLimit} disabled={busy} onChange={e => { setRowLimit(e.target.value); setTicket(null); setReceipt(null); }} /></div></div>
    <div className="uc-warehouse-actions"><Button disabled={busy || !valid} variant="outline" onClick={() => act(async () => {
      const current = generation.current;
      setTicket(null); setReceipt(null);
      const result = await rpc.call('warehousePrepare', { selection, query: { sql, maxBytes: Number(maxMiB) * 1024 ** 2, rowLimit: Number(rowLimit) } });
      if (current !== generation.current) return;
      setReceipt(result.receipt); setTicket(result.ticket);
    })}>Dry run</Button><Button disabled={busy || !ticket} onClick={() => act(async () => {
      const current = generation.current;
      const prepared = ticket!; setTicket(null);
      const result = await rpc.call('warehouseExecute', { selection, ticket: prepared });
      if (current === generation.current) setReceipt(result);
    })}>Run reviewed query</Button><span>Execution can incur BigQuery charges. Dry run tickets expire after five minutes.</span></div>
    {error && <p className="uc-connect-error" role="alert">{error} Check <code>bq</code> installation, Google authorization, and both dataset grants on the BB server.</p>}
    {receipt && <div className="uc-warehouse-receipt" role="status"><strong>{receipt.executed ? 'Query completed' : 'Dry run completed'}</strong><span>Estimated scan {bytes(receipt.estimatedBytes)} · ceiling {bytes(receipt.maxBytes)} · {receipt.project}</span><p>Resolved tables: {receipt.referencedTables.join(', ') || 'No referenced tables reported'}</p>{receipt.auditWarning && <p role="alert">{receipt.auditWarning}</p>}<small>Audit metadata is kept locally for the last 50 events. Query text and rows are not stored in the persistent audit.</small></div>}
    {receipt?.executed && <><p>{rows.length} rows returned. {rows.length === Number(rowLimit) ? 'The result reached the row limit; more rows may exist.' : ''}</p>{rows.length === 0 ? <p>No rows matched.</p> : <div className="uc-warehouse-table"><table><thead><tr>{columns.map(column => <th key={column}>{column}</th>)}{columns.includes('table_name') && <th>Schema</th>}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{columns.map(column => <td key={column}>{cell(row[column])}</td>)}{columns.includes('table_name') && <td>{typeof row.table_name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.table_name) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => edit(warehouseSchemaSql(row.table_name as string))}>Inspect fields</Button>}</td>}</tr>)}</tbody></table></div>}</>}
  </section>;
}
