import { useEffect, useRef, useState } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import type { Selection } from './connection-contract';
import type { Draft, DraftReview, draftRpcMethods } from './draft-contract';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import './draft.css';

export function DraftPanel({ selection, path }: { selection: Selection; path: string }) {
  const rpc = useRpc<typeof draftRpcMethods>();
  const [slot, setSlot] = useState('body');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [review, setReview] = useState<DraftReview | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const epoch = useRef(0);
  const scope = { selection, path, slot };
  function receive(value: Draft | null) {
    setDraft(value); setValues(Object.fromEntries(value?.fields.map(f => [f.pointer, f.value]) || [])); setReview(null);
  }
  useEffect(() => {
    const generation = ++epoch.current;
    receive(null); setError(''); setBusy('Loading draft');
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(slot)) { setError('Use a simple slot name such as body.'); setBusy(''); return; }
    rpc.call('readDraft', scope).then(result => { if (epoch.current === generation) receive(result); }).catch(cause => { if (epoch.current === generation) setError(cause instanceof Error ? cause.message : 'Could not load draft.'); }).finally(() => { if (epoch.current === generation) setBusy(''); });
    return () => { epoch.current++; };
  }, [selection.profileId, selection.merchantId, selection.storefront.id, selection.storefront.host, selection.verifiedAt, path, slot, rpc]);
  const edits = draft?.fields.filter(f => values[f.pointer] !== f.value).map(f => ({ pointer: f.pointer, value: values[f.pointer] })) || [];
  async function act(label: string, work: () => Promise<void>) {
    const generation = epoch.current;
    setBusy(label); setError('');
    try { await work(); }
    catch (cause) { if (epoch.current === generation) setError(cause instanceof Error ? cause.message : 'Draft request failed.'); }
    finally { if (epoch.current === generation) setBusy(''); }
  }
  async function save() {
    if (!draft) return;
    const generation = epoch.current;
    const next = await rpc.call('saveDraft', { ...scope, id: draft.id, revision: draft.revision, edits });
    if (epoch.current === generation) receive(next);
    return next;
  }
  return <section className="uc-draft" aria-label="Local page draft">
    <header><div><h3>Draft changes</h3><p>Edit existing widget fields and review changes against a saved baseline.</p></div><span>Saved on BB server</span></header>
    <div className="uc-draft-scope"><code>{path}</code><label>Container slot<Input aria-label="Container slot" value={slot} maxLength={64} disabled={!!busy || !!edits.length} onChange={e => setSlot(e.target.value)} /></label><small>Default: body. A slot must already exist on this page.</small></div>
    <p className="uc-draft-boundary">Pull reads the selected page container. Save changes stores a local draft. Review checks toolkit rules and whether live content changed since the pull.</p>
    {error && <p role="alert" className="uc-draft-error">{error}</p>}
    {!draft ? <div className="uc-draft-empty"><Button disabled={!!busy || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(slot)} onClick={() => act('Pulling page container', async () => {
      const generation = epoch.current;
      const result = await rpc.call('pullDraft', scope);
      if (epoch.current === generation) receive(result);
    })}>{busy || 'Pull page container'}</Button><p>Existing drafts reopen automatically. Missing containers cannot be created here.</p></div> : <>
      <div className="uc-draft-summary"><code>{draft.container}</code><span>Revision {draft.revision}</span><span>{draft.changedFields} saved changes</span><span>{edits.length} unsaved changes</span></div>
      <details className="uc-draft-baseline"><summary>Baseline and scope</summary><p>Page: <code>{draft.path}</code>. Storefront: {selection.storefront.host}. Merchant: {selection.merchantId}. Profile: {selection.profileId}.</p><p>Pulled {new Date(draft.createdAt).toLocaleString()}. Baseline SHA-256: <code>{draft.baselineHash}</code></p></details>
      {!draft.fields.length && <p>No supported string configuration fields were found. This editor preserves widget structure and IDs.</p>}
      {draft.skippedFields > 0 && <p>{draft.skippedFields} fields are outside this editor’s size or field-count limits.</p>}
      <div className="uc-draft-fields">{draft.fields.map((field, index) => <details key={field.pointer} open={index < 3}>
        <summary><strong>{field.widget}</strong><span>{field.key}</span>{values[field.pointer] !== field.before && <b>Changed</b>}</summary>
        <label htmlFor={`uc-draft-field-${index}`}>{field.key}<textarea id={`uc-draft-field-${index}`} spellCheck={false} maxLength={16384} disabled={!!busy} value={values[field.pointer] ?? field.value} onChange={e => { setValues(current => ({ ...current, [field.pointer]: e.target.value })); setReview(null); }} /></label>
        <details><summary>Original value</summary><pre>{field.before || '(empty)'}</pre></details>
      </details>)}</div>
      <div className="uc-draft-actions"><Button disabled={!!busy || !edits.length} onClick={() => act('Saving local draft', async () => { await save(); })}>Save changes</Button><Button variant="outline" disabled={!!busy} onClick={() => act('Reviewing changes', async () => {
        const generation = epoch.current;
        const current = edits.length ? await save() : draft;
        if (!current || epoch.current !== generation) return;
        const result = await rpc.call('reviewDraft', { ...scope, id: current.id, revision: current.revision });
        if (epoch.current === generation) setReview(result);
      })}>Save and review</Button><Button variant="ghost" disabled={!!busy || !edits.length} onClick={() => receive(draft)}>Discard unsaved edits</Button><Button variant="ghost" disabled={!!busy || !!edits.length} onClick={() => act('Reloading saved draft', async () => {
        const generation = epoch.current;
        const result = await rpc.call('readDraft', scope);
        if (epoch.current === generation) receive(result);
      })}>Reload saved draft</Button><span role="status">{busy}</span></div>
      {edits.length > 0 && <p role="status" className="uc-draft-boundary">Save before leaving this page or switching tabs. Unsaved edits are kept only in this editor.</p>}
      {review && <div className="uc-draft-review" aria-label="Change review">
        <h3>Change review. Revision {review.reviewedRevision}</h3>
        <p className={review.remoteChanged ? 'uc-draft-error' : ''}>{review.remoteChanged ? 'Live content changed since this baseline. This draft needs reconciliation before any future publishing.' : 'Live container hash matches the saved baseline.'}</p>
        <p><strong>{review.validation.valid ? 'Local toolkit validation passed.' : 'Local toolkit validation failed.'}</strong> {review.validation.errors} errors. {review.validation.warnings} warnings.</p>
        {review.validation.diagnostics.map((d, i) => <p key={i} className={d.severity === 'error' ? 'uc-draft-error' : ''}><strong>{d.severity}: {d.code}</strong> <code>{d.path}</code> {d.message}</p>)}
        {!!review.validation.omitted && <p>{review.validation.omitted} additional diagnostics were omitted.</p>}
        {review.changes.length === 0 && <p>No saved changes from baseline.</p>}
        {review.changes.map(change => <div className="uc-draft-change" key={change.pointer}><h4>{change.widget}. {change.key}</h4><div><section><h5>Baseline</h5><pre>{change.before || '(empty)'}</pre></section><section><h5>Draft</h5><pre>{change.value || '(empty)'}</pre></section></div></div>)}
        <p className="uc-draft-boundary">{review.limitation}</p>
      </div>}
    </>}
  </section>;
}
