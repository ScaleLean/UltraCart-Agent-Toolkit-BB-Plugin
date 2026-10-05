import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useRpc, UrlLink } from '@get-bb/plugin-sdk/app';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import type { rpcContract, Login, Selection, Storefront, Profile } from './connection-contract';

type Status = { ready: boolean; version: string | null; machine: string; profiles: Profile[]; selection: Selection | null; verified: boolean; message: string };
export function ConnectionPanel({ onSelection }: { onSelection?: (selection: Selection | null) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const uid = useId();
  const [status, setStatus] = useState<Status | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [profile, setProfile] = useState('');
  const [newName, setNewName] = useState('my-store');
  const [login, setLogin] = useState<Login | null>(null);
  const [stores, setStores] = useState<{ merchantId: string; storefronts: Storefront[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const activeLogin = useRef<string | null>(null);
  const waiting = login?.phase === 'starting' || login?.phase === 'waiting';
  useEffect(() => { if (status) onSelection?.(status.selection); }, [status?.selection, onSelection]);
  const loadStatus = useCallback(async () => {
    const next = await rpc.call('connectionStatus');
    if (mounted.current) {
      setStatus(next);
      setProfile(current => current || next.selection?.profileId || next.profiles[0]?.id || '');
      if (!next.selection) setExpanded(true);
    }
    return next;
  }, [rpc]);
  useEffect(() => {
    mounted.current = true;
    loadStatus().catch(e => { if (mounted.current) setError(e instanceof Error ? e.message : 'Unable to load connection status.'); });
    return () => {
      mounted.current = false;
      if (activeLogin.current) void rpc.call('cancelLogin', { id: activeLogin.current }).catch(() => {});
    };
  }, [loadStatus, rpc]);
  useEffect(() => {
    if (!login || !waiting) return;
    const id = login.id;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await rpc.call('loginStatus', { id });
        if (stopped) return;
        if (next.phase === 'starting' || next.phase === 'waiting') {
          setLogin(next);
          timer = setTimeout(poll, 2000);
        } else {
          activeLogin.current = null;
          if (next.phase === 'succeeded') {
            const fresh = await loadStatus();
            const selected = fresh.profiles.find(p => p.name === next.profile || p.id === next.profile)?.id || '';
            if (!stopped) {
              setProfile(selected);
              if (selected) {
                try { const available = await rpc.call('listStorefronts', { profile: selected }); if (!stopped) setStores(available); }
                catch (cause) { if (!stopped) setError(cause instanceof Error ? cause.message : 'Could not load storefronts.'); }
              }
            }
          }
          if (!stopped) setLogin(next);
        }
      } catch (cause) {
        if (stopped) return;
        activeLogin.current = null;
        setError(cause instanceof Error ? cause.message : 'Sign-in status could not be checked.');
        setLogin(null);
      }
    }
    timer = setTimeout(poll, 1500);
    return () => { stopped = true; clearTimeout(timer); };
  }, [login?.id, waiting, rpc, loadStatus]);

  async function act(work: () => Promise<void>) {
    setBusy(true); setError('');
    try { await work(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'The request failed. Please retry.'); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function begin() {
    const selected = profile || newName.trim();
    await act(async () => {
      setStores(null);
      const next = await rpc.call('beginLogin', { profile: selected });
      activeLogin.current = next.id;
      if (mounted.current) setLogin(next);
      else { activeLogin.current = null; await rpc.call('cancelLogin', { id: next.id }); }
    });
  }
  const connection = status?.selection;
  return <section className={`uc-connect${connection ? ' uc-connect-connected' : ''}${connection && !expanded ? ' uc-connect-collapsed' : ''}`} aria-labelledby={`${uid}-title`}>
    <div className="uc-connect-heading"><div className={connection ? 'uc-connected-identity' : undefined}>
      {connection ? <span className={`uc-dot ${status?.verified ? 'uc-connected-dot' : ''}`} aria-hidden="true" /> : <p className="uc-eyebrow">YOUR STOREFRONT</p>}
      <h2 id={`${uid}-title`}>{connection ? connection.storefront.host : 'Connect your store'}</h2>
      <p>{connection ? connection.merchantId : 'Sign in to UltraCart, then choose the storefront you want to work on.'}</p>
      {connection && !status.ready && <span className="uc-connection-attention">Setup needed</span>}
    </div>
      <Button size={connection ? 'sm' : 'default'} variant={connection ? 'ghost' : 'default'} onClick={() => setExpanded(v => !v)} aria-expanded={expanded} aria-controls={`${uid}-controls`} disabled={busy || waiting}>{expanded ? connection ? 'Minimize' : 'Close' : connection ? 'Manage connection' : 'Connect storefront'}</Button>
    </div>
    {(!connection || expanded) && <div className="uc-connect-meta"><span className={`uc-dot ${status?.verified ? 'uc-connected-dot' : ''}`} /><span>{status === null ? 'Checking toolkit…' : !status.ready ? 'Setup needed' : connection ? status.verified ? 'Connection verified this session' : 'Saved store · access checked when pages load' : status.profiles.some(p => p.merchantId) ? 'Profile saved · choose a storefront below' : 'Ready to sign in'}</span>{connection && <span>Storefront {connection.storefront.id}</span>}{status?.version && <span>Toolkit {status.version}</span>}</div>}
    {error && <p className="uc-connect-error" role="alert">{error}</p>}
    {expanded && <div id={`${uid}-controls`} className="uc-connect-content">
      {(!status || !status.ready) ? <><p>{status?.message || 'Checking the local toolkit installation…'}</p><Button variant="outline" disabled={busy} onClick={() => act(async () => { await loadStatus(); })}>Check again</Button></> : <>
        {connection && <div className="uc-saved-connection"><p>Last verified: {new Date(connection.verifiedAt).toLocaleString()}. Disconnecting clears this BB selection; your toolkit login stays in the OS keychain.</p><div className="uc-connect-actions"><Button variant="outline" size="sm" disabled={busy || waiting} onClick={() => act(async () => {
          setStatus(s => s ? {...s, verified:false} : s);
          const verified = await rpc.call('selectStorefront', { profile: connection.profileId, merchantId: connection.merchantId, storefrontId: connection.storefront.id });
          setStatus(s => s ? {...s, selection:verified, verified:true} : s);
        })}>Verify connection</Button><Button variant="ghost" size="sm" disabled={busy || waiting} onClick={() => act(async () => { await rpc.call('disconnectStorefront'); setStatus(s => s ? {...s, selection:null, verified:false} : s); setStores(null); })}>Disconnect storefront</Button></div></div>}
        <div className="uc-connect-grid">
          <div><h3><span>01</span> Sign in to UltraCart</h3><p>Authorization happens on UltraCart. Credentials stay in the keychain on {status.machine}, where this BB server runs.</p>
            {status.profiles.length > 0 && <><label htmlFor={`${uid}-profile`}>Merchant profile</label><select id={`${uid}-profile`} value={profile} disabled={busy || waiting} onChange={e => {setProfile(e.target.value); setStores(null); setLogin(null); setError('');}}><option value="">Sign in with a new profile</option>{status.profiles.map(p => <option key={p.id} value={p.id}>{p.name}{p.merchantId ? ` · ${p.merchantId}` : ' · not yet signed in'}</option>)}</select></>}
            {!profile && <><label htmlFor={`${uid}-name`}>Name this connection</label><Input id={`${uid}-name`} value={newName} maxLength={64} disabled={busy || waiting} onChange={e => setNewName(e.target.value)} placeholder="my-store" /></>}
            {!waiting && <div className="uc-connect-actions"><Button disabled={busy || (!profile && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(newName.trim()))} onClick={begin}>{profile ? 'Sign in again' : 'Sign in with UltraCart'}</Button><Button variant="ghost" disabled={busy} onClick={() => act(async () => { await loadStatus(); })}>Refresh profiles</Button></div>}
            {waiting && login && <div className="uc-auth-challenge" role="status"><p>{login.message}</p>{login.url && <><label>Authorization code</label><code>{login.code}</code><UrlLink href={login.url} target="_blank" rel="noreferrer" className="uc-login-link">Open UltraCart sign-in ↗</UrlLink><p>Keep this panel open while you authorize.</p></>}<Button size="sm" variant="outline" disabled={busy} onClick={() => act(async () => { const next = await rpc.call('cancelLogin', {id:login.id}); activeLogin.current = null; setLogin(next); })}>Cancel sign-in</Button></div>}
            {login && !waiting && <p role="status" className={login.phase === 'failed' ? 'uc-connect-error' : 'uc-login-result'}>{login.message}</p>}
            <p className="uc-connect-footnote">The toolkit makes a successful login its current profile. Storefront actions here always use your explicit selection.</p>
          </div>
          <div><h3><span>02</span> Choose your storefront</h3><p>Fetch the storefronts available to the selected merchant profile. This reads your account; it does not change store content.</p><Button variant="outline" disabled={busy || waiting || !profile} onClick={() => act(async () => { setStores(null); setStatus(s => s ? {...s,verified:false} : s); setStores(await rpc.call('listStorefronts', {profile})); })}>{busy ? 'Working…' : 'Load storefronts'}</Button>
            {stores && <div className="uc-store-options"><p>Merchant <strong>{stores.merchantId}</strong> · {stores.storefronts.length} storefronts</p>{stores.storefronts.length === 0 && <p>No storefronts are available to this profile.</p>}{stores.storefronts.map(store => <div key={store.id}><div><strong>{store.host}</strong><small>Storefront {store.id}{store.themeId ? ` · Theme ${store.themeId}` : ''}</small></div><Button variant="outline" size="sm" disabled={busy || waiting} onClick={() => act(async () => {
              const selection = await rpc.call('selectStorefront', {profile, merchantId:stores.merchantId, storefrontId:store.id});
              setStatus(s => s ? {...s, selection, verified:true} : s); setExpanded(false); setStores(null);
            })}>Use storefront</Button></div>)}</div>}
          </div>
        </div>
      </>}
    </div>}
  </section>;
}
