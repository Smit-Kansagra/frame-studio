import { useEffect, useRef, useState } from 'react'
import type { FindSelection, PackAction, PackProduct, PackStore } from '../electron/ready-packs-types.cjs'
import './product-find.css'

const storeNames: Record<string, string> = { meesho: 'Meesho', flipkart: 'Flipkart', amazon: 'Amazon', myntra: 'Myntra', ajio: 'AJIO', libas: 'Libas' }
const defaults: FindSelection = { category: 'auto', min: 200, max: 1000, extraBudgetInr: 100, size: 5, stores: [], mode: 'auto', storeMode: 'auto' }
export function ProductFind() {
  const api = window.frameStudio?.readyPacks
  const [state, setState] = useState<PackStore | null>(null)
  const [selection, setSelection] = useState<FindSelection | null>(null)
  const [customize, setCustomize] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [brokenPhotos, setBrokenPhotos] = useState<Record<string, string>>({})
  const [historyOpen, setHistoryOpen] = useState(false), [historyId, setHistoryId] = useState<string|null>(null)
  const refreshed = useRef('')
  useEffect(() => {
    if (!api) return
    let alive = true, pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const next = await api.status()
        if (alive) { setState(next); setSelection(old => old ?? { ...defaults, ...next.preferences, extraBudgetInr: next.preferences?.extraBudgetInr ?? 100, maxStorePriority: next.preferences?.maxStorePriority ?? (Object.keys(next.settings.storeRanks ?? {}).length ? 4 : 100) }) }
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : String(e)) }
      finally { pending = false }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [api])
  const running = state?.job.state === 'running', locked = busy || running
  const pack = state?.searchSession ? state.packs.find(p => p.id === state.searchSession?.packId)
    : state?.packs.filter(p => p.productIds.length && ['drafted', 'exported'].includes(p.state)).at(-1)
  async function act(action: PackAction, success = '') {
    if (!api) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await api.action(action)
      setState(await api.status())
      if(action.type==='studio'&&result&&typeof result==='object'&&'productId' in result&&typeof result.productId==='string')window.location.hash='#studio/new?product='+encodeURIComponent(result.productId)
      if (success) setNotice(success)
      else if (action.type === 'export' && typeof result === 'string') setNotice('Saved: ' + result)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  // Opening saved results refreshes stale facts through authorized provider capabilities.
  useEffect(() => {
    if (!api || !pack || running || refreshed.current === pack.id) return
    refreshed.current = pack.id
    void act({ type: 'refresh', packId: pack.id })
  }, [api, pack?.id, running])
  const products = pack?.productIds.flatMap((id, index) => {
    const p = state?.products.find(p => p.id === id)
    return p && state?.reviewableIds?.[pack.id]?.includes(id) ? [{ p, number: index + 1 }] : []
  }) ?? []
  const permitted = (p: PackProduct) => p.images.length > 0 && p.images.every(i => i.variant === p.variant && i.permission === 'permitted' && !!i.permissionNote.trim())
  const exportReady = !!pack && products.length === pack.productIds.length && products.length > 0 && products.every(({ p }) => permitted(p) && !p.images.some(i => brokenPhotos[p.id] === i.url))
  const studioReady=!!pack&&products.length===pack.productIds.length&&products.length>0&&products.every(({p})=>p.images[0]?.permission==='permitted'&&!!p.images[0].permissionNote.trim())
  const history=[...(state?.packs??[])].filter(pack=>pack.productIds.length).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))
  const incomplete = !!state?.searchSession && !!pack && products.length > 0 && ['drafted', 'exported'].includes(pack.state) && products.length < pack.requested
  const shownStores = state?.providers ?? []
  const setupRequired = state?.actionableError?.code === 'source-setup' || state?.actionableError?.code === 'source-blocked'
  const categoryName = selection?.category === 'auto' ? 'Auto theme' : state?.settings.categories.find(c => c.id === selection?.category)?.name ?? 'Saved category'
  return <div className="product-find">
    <section className="find-setup">
      <div className="find-heading"><h2>Your next clothing post</h2><a href="#settings">Settings</a></div>
      <div className="find-actions"><button className="button button-primary" disabled={!api || locked || !selection} onClick={() => void act({ type: 'next', value: selection })}>Find my next post</button>
        {running && <button className="button button-secondary" disabled={busy} onClick={() => void act({ type: 'cancel' })}>{busy ? 'Stopping…' : 'Cancel'}</button>}
      </div>
      <button className="find-preference-summary" aria-expanded={customize} aria-controls="find-customize" onClick={() => setCustomize(open => !open)}>Women’s fashion · ₹{selection?.min ?? 200}–₹{selection?.max ?? 1000} · {selection?.size ?? 5} products · {selection?.storeMode === 'manual' ? 'Store override' : 'Auto stores'} · {categoryName}</button>
      <details id="find-customize" open={customize} onToggle={e => setCustomize(e.currentTarget.open)}><summary>Customize</summary>
        <form onSubmit={e => { e.preventDefault(); if (selection) void act({ type: 'preferences', value: selection }, 'Preferences saved for future searches.') }}>
          <fieldset className="find-controls" disabled={locked || !selection}>
            <label>Clothing choice<select value={selection?.category ?? 'auto'} onChange={e => setSelection(s => s ? { ...s, category: e.target.value, mode: e.target.value === 'auto' && s.storeMode === 'auto' ? 'auto' : 'custom' } : s)}><option value="auto">Auto: coverage and available inventory</option>{state?.settings.categories.map(c => <option key={c.id} value={c.id} disabled={!!c.deferred}>{c.name} (manual override){c.deferred ? ' — deferred' : ''}</option>)}</select></label>
            <label>Minimum INR<input type="number" min="0" max="10000000" step="1" required value={selection && Number.isFinite(selection.min) ? selection.min : ''} onChange={e => setSelection(s => s ? { ...s, min: e.target.valueAsNumber } : s)} /></label>
            <label>Maximum INR<input type="number" min={selection && Number.isFinite(selection.min) ? selection.min : 0} max="10000000" step="1" required value={selection && Number.isFinite(selection.max) ? selection.max : ''} onChange={e => setSelection(s => s ? { ...s, max: e.target.valueAsNumber } : s)} /></label>
            <label>Products<select value={selection?.size ?? 5} onChange={e => setSelection(s => s ? { ...s, size: Number(e.target.value) } : s)}>{[4, 5, 6].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
            <label>Extra price allowance (INR)<input type="number" min="0" max="1000" step="1" required value={selection?.extraBudgetInr ?? 100} onChange={e => setSelection(s => s ? { ...s, extraBudgetInr: e.target.valueAsNumber } : s)} /></label>
            <label>Lowest allowed store priority<input type="number" min="1" max="100" step="1" required value={selection?.maxStorePriority ?? 100} onChange={e => setSelection(s => s ? { ...s, maxStorePriority: e.target.valueAsNumber } : s)} /><small>4 uses priorities 1–4 only. 100 allows all stores, including unranked stores. Missing access gives a partial/empty result instead of exceeding this cutoff.</small></label>
            <label className="find-auto-toggle"><input type="checkbox" checked={selection?.storeMode !== 'manual'} onChange={e => setSelection(s => s ? { ...s, storeMode: e.target.checked ? 'auto' : 'manual', stores: e.target.checked ? [] : shownStores.filter(p => ['configured-unverified', 'accessible'].includes(p.readiness ?? '')).map(p => p.id), mode: e.target.checked && s.category === 'auto' ? 'auto' : 'custom' } : s)} />Auto stores</label>
            {selection?.storeMode === 'manual' && <div className="find-marketplaces">{shownStores.map(p => <label key={p.id} title={p.status}><input type="checkbox" checked={selection.stores.includes(p.id)} disabled={p.readiness === 'needs-access' || p.readiness === 'unsupported'} onChange={e => setSelection(s => s ? { ...s, stores: e.target.checked ? [...s.stores, p.id] : s.stores.filter(id => id !== p.id) } : s)} />{p.name ?? storeNames[p.id] ?? p.id}</label>)}</div>}
          </fieldset>
          <p>Store priority is applied before price variety: qualifying products from preferred stores come first, including the extra allowance. The final limit is INR {(selection?.max ?? 1000) + (selection?.extraBudgetInr ?? 100)}. Set extra allowance to 0 for a strict budget. Manual clothing overrides never change automatically.</p>
          <button className="button button-secondary" type="submit" disabled={locked || !selection}>Save preferences</button>
        </form>
      </details>
      <p>Extra price allowance: INR {selection?.extraBudgetInr ?? 100}. Final maximum: INR {(selection?.max ?? 1000) + (selection?.extraBudgetInr ?? 100)}. Lowest allowed store priority: {selection?.maxStorePriority ?? 100}. Stores beyond this cutoff are excluded even if the result is incomplete.</p>
      <p role="status" aria-live="polite">{state?.job.message ?? (api ? 'Loading your saved defaults…' : 'Open Frame Studio desktop to find products.')}</p>
      {running && <progress aria-label="Finding and verifying products" />}
      {error && <p role="alert" className="prompt-validation-error">{error}</p>}{notice && <p role="status">{notice}</p>}
      {state?.actionableError && <div className="find-access-notice" role="status"><strong>{setupRequired ? 'Product source setup required' : 'Collection needs attention'}</strong><p>{state.actionableError.message}</p><a href="#settings">{setupRequired ? 'Review available source options in Settings' : state.actionableError.action}</a></div>}
    </section>
    {pack && <section className="find-setup">
      <div className="find-heading"><h2>{pack.subcategory} · INR {pack.min}–{pack.max}</h2><span>{products.length}/{pack.requested} products found{products.length < pack.requested ? ' · Partial results' : ''}</span></div>
      {state?.searchSession?.themeReason && <p>{state.searchSession.themeReason}</p>}
      {!!state?.searchSession?.messages.length && !setupRequired && <p>Some source requests could not qualify products. Verified results are kept; source details are in Settings.</p>}
      <p>{exportReady ? 'Photo export ready.' : 'Photo permission required or listing refresh needed. You can review products and copy their links.'}</p>
      {products.length < pack.productIds.length && <><p>Some saved products need fresh listing facts or a matching photo. They are hidden until verified.</p>{pack.productIds.map((id, index) => !state?.reviewableIds?.[pack.id]?.includes(id) && <button key={id} className="button button-secondary" disabled={locked || !['drafted', 'exported'].includes(pack.state)} onClick={() => void act({ type: 'replace', packId: pack.id, productId: id })}>Replace unverified item #{index + 1}</button>)}</>}
      <div className="find-actions">
        <button className="button button-primary" disabled={locked||!studioReady} onClick={()=>void act({type:'studio',packId:pack.id})}>{busy?'Working...':'Start project'}</button>
        <button className="button button-secondary" disabled={locked || !products.length || products.length !== pack.productIds.length} onClick={() => void act({ type: 'copy', packId: pack.id }, 'Numbered original product links copied.')}>Copy all product links</button>
        <button className="button button-primary" disabled={locked || !exportReady} onClick={() => void act({ type: 'export', packId: pack.id })}>Download photos + links</button>
        {incomplete && <button className="button button-secondary" disabled={locked} onClick={() => void act({ type: 'more', packId: pack.id })}>Find more matching products</button>}
        <button className="button button-secondary" disabled={locked || !['drafted', 'exported'].includes(pack.state)} onClick={() => void act({ type: 'done', packId: pack.id })}>Done</button>
        <button className="button button-secondary" disabled={locked || !['drafted', 'exported'].includes(pack.state)} onClick={() => void act({ type: 'next', packId: pack.id, value: selection })}>Done / Next collection</button>
      </div>
      <p>Start project sends the numbered primary photos to Studio. Choose a project name and Post/Reel there. Photo permission is required for transfer.</p>
      <div className="find-grid">{products.map(({ p, number }) => {
        const photo = p.images.find(i => i.variant === p.variant && i.source === p.url) ?? p.images.find(i => i.variant === p.variant)
        return <article className="find-card" key={p.id}>
          <div className="find-photo">{photo && brokenPhotos[p.id] !== photo.url ? <img src={photo.url} alt={p.title} loading="lazy" referrerPolicy="no-referrer" onError={() => setBrokenPhotos(old => ({ ...old, [p.id]: photo.url }))} /> : <p>Photo could not load. Open the original listing or replace this product.</p>}</div>
          <div className="find-heading"><strong>#{number}</strong><span className="neutral-badge">{state?.providers.find(source => source.id === p.retailer)?.name ?? storeNames[p.retailer] ?? p.retailer}</span></div>
          <h3>{p.title}</h3><p className="find-price">₹{p.price?.toLocaleString('en-IN')}</p><p>{p.variant}</p>
          <p className="find-observed">Observed {p.observedAt ? new Date(p.observedAt).toLocaleString() : 'unknown'}. Stock: {p.stock}. Sizes: {p.sizes.join(', ') || 'unknown'}.</p>
          <a className="find-product-link" href={p.url} title={p.url} onClick={e => { e.preventDefault(); void act({ type: 'open', packId: pack.id, productId: p.id }) }}>{p.url}</a>
          <input className="find-selectable-link" aria-label={'Full original product URL ' + number} readOnly value={p.url} onFocus={e => e.target.select()} />
          {p.affiliateStatus === 'account-api' && p.affiliateUrl ? <><span>Account affiliate link</span>
            <a className="find-product-link" href={p.affiliateUrl} title={p.affiliateUrl} onClick={e => { e.preventDefault(); void act({ type: 'open-affiliate', packId: pack.id, productId: p.id }) }}>{p.affiliateUrl}</a>
            <button className="button button-secondary" disabled={locked} onClick={() => void act({ type: 'copy-affiliate', packId: pack.id, productId: p.id }, 'Affiliate link copied.')}>Copy affiliate link</button>
          </> : <p>Original link — convert in EarnKaro</p>}
          <p>{permitted(p) ? 'Photo permission recorded' : 'Photo permission required for download'}</p>
          <div className="find-actions">
            <button className="button button-secondary" disabled={locked} onClick={() => void act({ type: 'open', packId: pack.id, productId: p.id })}>Open product</button>
            <button className="button button-secondary" disabled={locked} onClick={() => void act({ type: 'copy-product', packId: pack.id, productId: p.id }, 'Original product link copied.')}>Copy original link</button>
            <button className="button button-secondary" disabled={locked || !['drafted', 'exported'].includes(pack.state)} onClick={() => void act({ type: 'replace', packId: pack.id, productId: p.id })}>Replace</button>
          </div>
        </article>
      })}</div>
    </section>}
    {!pack && state?.searchSession && !running && !setupRequired && <section className="find-empty"><p>No collection qualifies yet. Your saved budget and manual overrides remain unchanged. No coverage was consumed.</p></section>}
    <section className="find-setup find-history"><button className="find-preference-summary" aria-expanded={historyOpen} onClick={()=>setHistoryOpen(open=>!open)}>History ({history.length})</button>
      {historyOpen&&(!history.length?<p>Your generated collections will appear here automatically.</p>:<div>{history.map(entry=>{
        const savedProducts=entry.productIds.flatMap(id=>{const p=(entry.snapshot??state?.products??[]).find(p=>p.id===id);return p?[p]:[]})
        return <article key={entry.id} className="find-history-entry"><button className="find-history-summary" aria-expanded={historyId===entry.id} onClick={()=>setHistoryId(current=>current===entry.id?null:entry.id)}><strong>{entry.subcategory}</strong><span>{new Date(entry.createdAt).toLocaleString()} · {entry.productIds.length} products · {entry.state}</span><small>{savedProducts.slice(0,3).map(p=>p.title).join(' · ')}</small></button>
          {historyId===entry.id&&<><p>Saved collection: INR {entry.min}–{entry.max}. Prices and photos below are historical observations.</p><div className="find-grid">{savedProducts.map((p,index)=><article className="find-card" key={p.id}>{p.images[0]&&<div className="find-photo"><img src={p.images[0].url} alt={p.title} loading="lazy" referrerPolicy="no-referrer"/></div>}<strong>#{index+1} · {p.title}</strong><p>INR {p.price??'unknown'} · {storeNames[p.retailer]??p.retailer} · {p.variant}</p><p>Observed: {p.observedAt?new Date(p.observedAt).toLocaleString():'unknown'}</p><input className="find-selectable-link" aria-label={'Saved product link '+(index+1)} readOnly value={p.url} onFocus={e=>e.target.select()}/><div className="find-actions"><button className="button button-secondary" disabled={busy} onClick={()=>void act({type:'history-open',packId:entry.id,productId:p.id})}>Open product</button><button className="button button-secondary" disabled={busy} onClick={()=>void act({type:'history-copy',packId:entry.id,productId:p.id},'Original product link copied.')}>Copy link</button></div></article>)}</div><button className="button button-primary" disabled={locked} onClick={()=>void act({type:'studio',packId:entry.id})}>Start project from this collection</button><p>Studio transfer checks current listing facts and photo permission first.</p></>}
        </article>
      })}</div>)}
    </section>
  </div>
}
