import { useEffect, useState } from 'react'
import type { MerchantCatalogue, PackAction, PackSettings, PackStore } from '../electron/ready-packs-types.cjs'
import './product-find.css'

export function ProductFindAdvanced() {
  const api = window.frameStudio?.readyPacks
  const [state, setState] = useState<PackStore | null>(null)
  const [settings, setSettings] = useState<PackSettings | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [keys, setKeys] = useState({ flipkartId: '', flipkartToken: '', imagePermission: '' })
  const [licence, setLicence] = useState(''), [imports, setImports] = useState('')
  const [ranks, setRanks] = useState<Record<string, string>>({})
  const [catalogue, setCatalogue] = useState<MerchantCatalogue>({ id: 'catalogue:my-store', name: '', kind: 'woocommerce', origin: '', enabled: true, permission: { reference: '', grantedAt: '', expiresAt: null } })
  useEffect(() => {
    if (!api) return
    let alive = true
    void api.status().then(s => { if (alive) { setState(s); setSettings(s.settings); setRanks(Object.fromEntries(Object.entries(s.settings.storeRanks ?? {}).map(([id, rank]) => [id, String(rank)]))) } }).catch(e => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [api])
  async function act(action: PackAction) {
    if (!api) return
    setBusy(true); setError(''); setNotice('')
    try { await api.action(action); const next = await api.status(); setState(next); if (action.type === 'settings' || action.type === 'store-ranks') setSettings(next.settings); setNotice('Saved.'); if (action.type === 'review') window.location.hash = '#product-find'; if (action.type === 'credentials') setKeys({ flipkartId: '', flipkartToken: '', imagePermission: '' }) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const locked = busy || state?.job.state === 'running'
  return <div className="product-find">
    <p>Product Find runs when you click Find. Old YouTube and pack schedules are paused. Saved credentials, products and history remain intact.</p>
    {error && <p role="alert" className="prompt-validation-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <details><summary>Platform priority</summary>
      <p>Set your own numbers: 1 first, 2 next, up to 99. Blank stores come after numbered stores; equal numbers share a priority. These are your preferences, not measured commission rates. No EarnKaro login or automatic affiliate-link conversion is required.</p>
      <p>Each collection keeps one clothing theme and budget. Take eligible products from the first usable store, then fill remaining places from the next stores. Existing partial results keep their products and numbering. Priority changes apply to new collections.</p>
      <form onSubmit={e => { e.preventDefault(); void act({ type: 'store-ranks', value: Object.fromEntries(Object.entries(ranks).filter(([, rank]) => rank.trim() !== '').map(([id, rank]) => [id, Number(rank)])) }) }}>
        <fieldset className="discovery-fields" disabled={locked || !state}>
          {state?.providers.map(p => <label key={p.id}>{p.name ?? p.id}<input aria-label={(p.name ?? p.id) + ' priority'} type="number" min={1} max={99} step={1} placeholder="Unranked" value={ranks[p.id] ?? ''} onChange={e => setRanks(old => ({ ...old, [p.id]: e.target.value }))} /><small>{p.readiness === 'unsupported' || p.readiness === 'needs-access' ? 'Source access unavailable; ranking does not connect this store.' : p.readiness === 'paused' ? 'Source paused; ranking does not bypass the restriction.' : 'Configured source; live access must still succeed.'}</small></label>)}
          <button className="button button-secondary" type="submit">Save platform priority</button>
        </fieldset>
      </form>
    </details>
    <details><summary>Store access</summary>
      <p>Auto excludes unconfigured or paused sources. Configuration is separate from confirmed access. No source connection is inferred from a browser login or a saved URL. No purchase is required or suggested.</p>
      {state?.providers.map(p => <div key={p.id}><p><strong>{p.name ?? p.id}</strong>: {p.readiness ?? 'unverified'} · {p.route}<br/>{p.status}<br/>{p.setupAction}</p>{(state?.sourceHealth?.[p.id] || state?.products.some(product => product.retailer === p.id && product.photoFailure)) && <button className="button button-secondary" disabled={locked} onClick={() => void act({ type: 'source-recheck', productId: p.id })}>Allow next explicit search to recheck {p.name ?? p.id}</button>}</div>)}
      <details><summary>Optional existing authorized WooCommerce store</summary>
        <p>Implemented keyless search and exact product details through the documented public Store API. No account, API key, billing or subscription is needed by this protocol. A store's public endpoint does not grant commercial research or image rights. Use only merchant access you already have; this is not a mandatory setup or a connected marketplace claim.</p>
        {(state?.catalogues ?? []).map(c => <button key={c.id} className="button button-secondary" disabled={locked} onClick={() => setCatalogue(structuredClone(c))}>Edit {c.name}</button>)}
        <fieldset className="discovery-fields" disabled={locked}>
          <label>Source ID<input value={catalogue.id} onChange={e => setCatalogue({ ...catalogue, id: e.target.value })} placeholder="catalogue:store-name" /></label>
          <label>Store name<input value={catalogue.name} onChange={e => setCatalogue({ ...catalogue, name: e.target.value })} /></label>
          <label>Authorized HTTPS origin<input value={catalogue.origin} onChange={e => setCatalogue({ ...catalogue, origin: e.target.value })} placeholder="https://your-authorized-store.example" /></label>
          <label>Actual merchant research permission reference<input value={catalogue.permission.reference} onChange={e => setCatalogue({ ...catalogue, permission: { ...catalogue.permission, reference: e.target.value } })} /></label>
          <label>Actual grant date<input type="date" value={catalogue.permission.grantedAt.slice(0,10)} onChange={e => setCatalogue({ ...catalogue, permission: { ...catalogue.permission, grantedAt: e.target.value } })} /></label>
          <label>Expiry (blank only if the actual grant has no fixed expiry)<input type="date" value={catalogue.permission.expiresAt?.slice(0,10) ?? ''} onChange={e => setCatalogue({ ...catalogue, permission: { ...catalogue.permission, expiresAt: e.target.value || null } })} /></label>
          <label><input type="checkbox" checked={catalogue.enabled} onChange={e => setCatalogue({ ...catalogue, enabled: e.target.checked })} />Enable this recorded source</label>
          <button className="button button-secondary" onClick={() => void act({ type: 'catalogue', value: catalogue })}>Save source without making a request</button>
        </fieldset>
        <p>New source access remains unverified until a user-initiated search succeeds. Variable products with unproven colour/photo assignments remain excluded. Image export still requires a separate scoped grant.</p>
      </details>
      <fieldset className="discovery-fields" disabled={locked}>
        <legend>Optional existing approved Flipkart Affiliate API account</legend>
        <p>Use this only if you already have approved tracking ID/token access. It is excluded from Auto otherwise. New-account approval has not been verified. No purchase, billing or paid fallback.</p>
        <label>Tracking ID<input autoComplete="off" value={keys.flipkartId} onChange={e => setKeys({ ...keys, flipkartId: e.target.value })} /></label>
        <label>API token (blank keeps saved access)<input type="password" autoComplete="off" value={keys.flipkartToken} onChange={e => setKeys({ ...keys, flipkartToken: e.target.value })} /></label>
        <button className="button button-secondary" onClick={() => void act({ type: 'credentials', value: keys })}>Save encrypted access</button>
      </fieldset>
    </details>
    <details><summary>Account reasoning</summary>
      <p>{state?.aiStatus?.message ?? 'Connection not tested.'}</p>
      <p>CLI: {state?.aiStatus?.cliVersion ?? 'not checked'}. Model: {state?.aiStatus?.selectedModel ?? 'not checked'}. Last success: {state?.aiStatus?.lastSuccessfulCall ?? 'none'}. Remaining quota: unknown.</p>
      <p>Existing no-overage session checks remain required before every call. Text evidence only; no photo inspection or paid fallback.</p>
      {settings && <fieldset className="discovery-fields" disabled={locked}>
        <label>Provider<select value={settings.ai?.provider ?? 'antigravity'} onChange={e => setSettings({ ...settings, ai: { provider: e.target.value as 'antigravity' | 'none', model: settings.ai?.model ?? '', effort: settings.ai?.effort ?? 'medium' } })}><option value="antigravity">Authenticated Antigravity account</option><option value="none">Code only</option></select></label>
        <label>Model<select value={settings.ai?.model ?? ''} onChange={e => setSettings({ ...settings, ai: { provider: settings.ai?.provider ?? 'antigravity', model: e.target.value, effort: settings.ai?.effort ?? 'medium' } })}><option value="">Automatic: listed moderate-effort model</option>{settings.ai?.model && !state?.aiStatus?.models.some(m => m.id === settings.ai?.model) && <option value={settings.ai.model}>{settings.ai.model} (saved; availability unverified)</option>}{state?.aiStatus?.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
        <label>Effort<select value={settings.ai?.effort ?? 'medium'} onChange={e => setSettings({ ...settings, ai: { provider: settings.ai?.provider ?? 'antigravity', model: settings.ai?.model ?? '', effort: e.target.value as 'medium' | 'high' } })}><option value="medium">Moderate</option><option value="high">High (more account quota)</option></select></label>
        <button className="button button-secondary" onClick={() => void act({ type: 'settings', value: settings })}>Save account settings</button>
      </fieldset>}
      <button className="button button-secondary" disabled={locked} onClick={() => void act({ type: 'ai-test' })}>Test account (one bounded call)</button>
    </details>
    <details><summary>Photo permission administration</summary>
      <p>Record only real provider/account grants covering the intended use. Public visibility alone is not commercial reuse permission. A valid scoped grant is inherited without per-image confirmation. Expired or unknown rights block photos, not product review or link copying.</p>
      <p>Licence schema and scope are documented in PRODUCT-FIND.md.</p>
      <textarea aria-label="Scoped provider licence JSON" rows={6} value={licence} onChange={e => setLicence(e.target.value)} />
      <button className="button button-secondary" disabled={locked} onClick={() => { try { void act({ type: 'licence', value: JSON.parse(licence) }) } catch { setError('Enter valid JSON for an actual scoped licence.') } }}>Record permission</button>
      {state?.licences?.map(l => <p key={l.id}>{l.provider}: {l.reference}. Uses: {l.uses.join(', ')}. Expiry: {l.expiresAt ?? 'No fixed expiry recorded'}.</p>)}
    </details>
    <details><summary>Optional authorized feed / URL import</summary>
      <p>Fallback only. Imported unknown facts remain unknown. Imports do not establish automatic store access.</p>
      <button className="button button-secondary" disabled={locked} onClick={() => void act({ type: 'import' })}>Import CSV / JSON / URLs</button>
      <textarea aria-label="Product URLs or feed text" rows={4} value={imports} onChange={e => setImports(e.target.value)} />
      <button className="button button-secondary" disabled={locked} onClick={() => void act({ type: 'import-text', value: imports })}>Import text</button>
    </details>
    <details><summary>Coverage preferences</summary>
      <p>The budget selected on Product Find always wins. Planned variations never reduce that range. Plus-size, petite and tall are cross-category attributes.</p>
      {settings && <fieldset className="discovery-fields" disabled={locked}>
        <label>Cooldown days<input type="number" min={0} max={365} value={settings.cooldownDays} onChange={e => setSettings({ ...settings, cooldownDays: Number(e.target.value) })} /></label>
        {(['season', 'occasion', 'attributes'] as const).map(key => <label key={key}>{key}<input value={settings[key]} onChange={e => setSettings({ ...settings, [key]: e.target.value })} /></label>)}
        {settings.categories.map((c, index) => <details key={c.id}><summary>{c.name}{c.specialist ? ' (optional specialist)' : ''}</summary><label><input type="checkbox" checked={c.autoEnabled !== false && (!c.specialist || c.autoEnabled === true)} onChange={e => setSettings({ ...settings, categories: settings.categories.map((row, i) => i === index ? { ...row, autoEnabled: e.target.checked } : row) })} />Include in Auto rotation</label><label>Name<input value={c.name} onChange={e => setSettings({ ...settings, categories: settings.categories.map((row, i) => i === index ? { ...row, name: e.target.value } : row) })} /></label><label>Subcategories (one per line)<textarea value={c.subcategories.join('\n')} onChange={e => setSettings({ ...settings, categories: settings.categories.map((row, i) => i === index ? { ...row, subcategories: e.target.value.split('\n') } : row) })} /></label><label>Defer reason (blank enables category)<input value={c.deferred} onChange={e => setSettings({ ...settings, categories: settings.categories.map((row, i) => i === index ? { ...row, deferred: e.target.value } : row) })} /></label></details>)}
        <button className="button button-secondary" onClick={() => void act({ type: 'settings', value: settings })}>Save coverage preferences</button>
      </fieldset>}
    </details>
    <details><summary>Saved history and diagnostics</summary>
      <p>{state?.products.length ?? 0} retained products. {state?.packs.length ?? 0} historical results. No history is removed by Done or Skip.</p>
      {state?.packs.map(p => <p key={p.id}>{p.theme}: {p.productIds.length}/{p.requested}, {p.state} <button className="button button-secondary" disabled={locked} onClick={() => void act({ type: 'review', packId: p.id })}>Review saved result</button></p>)}
      {state?.diagnostics?.map((d, i) => <details key={i}><summary>{d.query}</summary><pre className="find-path">{JSON.stringify(d, null, 2)}</pre></details>)}
    </details>
  </div>
}
