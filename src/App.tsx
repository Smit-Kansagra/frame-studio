import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './icons'
import {version} from '../package.json'
import type { IconName } from './icons'
import { StorageStatus } from './StorageStatus'
import { Themes } from './Themes'
import { Characters } from './Characters'
import { ProductFind } from './ProductFind'
import { ProductFindAdvanced } from './ProductFindAdvanced'
import { Studio as ProjectStudio } from './Studio'
import type { FlowConnection } from '../electron/contracts.cjs'

type Page = 'studio' | 'themes' | 'characters' | 'product-find' | 'settings'
type LibraryPage = 'themes' | 'characters'

const pages: Record<Page, { title: string; description: string; icon: IconName }> = {
  studio: { title: 'Studio', description: 'A little space for your next big idea.', icon: 'studio' },
  themes: { title: 'Themes', description: 'A creative direction you can come back to.', icon: 'theme' },
  characters: { title: 'Characters', description: 'Familiar faces for a consistent story.', icon: 'character' },
  'product-find': { title: 'Product Find', description: 'Discover products for your Instagram pages. Download photos and copy original links.', icon: 'product' },
  settings: { title: 'Settings', description: 'Make yourself at home.', icon: 'settings' },
}

const library: Record<LibraryPage, { singular: string }> = {
  themes: { singular: 'theme' }, characters: { singular: 'character' },
}

function currentPage(): Page {
  const value = window.location.hash.slice(1).split('/')[0]
  return Object.hasOwn(pages, value) ? value as Page : 'studio'
}

function ConnectionStatus() {
  const [connection, setConnection] = useState<FlowConnection>({ state: 'not-connected', message: 'Flow not connected.', pageTitle: null, checkedAt: null })
  const [offline, setOffline] = useState(!navigator.onLine)
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  useEffect(() => {
    const api = window.frameStudio?.flow
    if (!api) return
    let active = true
    const refresh = () => { void api.status().then(status => { if (active) setConnection(status) }) }
    refresh()
    const timer = window.setInterval(refresh, 2500)
    return () => { active = false; window.clearInterval(timer) }
  }, [])
  const label = offline ? 'Flow not connected' : connection.state === 'connected' ? 'Connected' : connection.state === 'needs-attention' ? 'Needs attention' : connection.state === 'opening' ? 'Flow opening' : 'Flow not connected'
  return <div className="connection-status" aria-live="polite">
    {offline && <span className="offline-badge"><Icon name="wifi-off" size={14} />Offline</span>}
    <span className={`connection-badge ${connection.state === 'connected' && !offline ? 'is-connected' : connection.state === 'needs-attention' ? 'needs-attention' : ''}`} title={connection.message}><span className="status-dot" />{label}</span>
  </div>
}

function Settings() {
  const [productAdvanced, setProductAdvanced] = useState(false)
  return <div className="settings-content">
    <section className="settings-card" aria-labelledby="flow-title">
      <div className="settings-card-heading"><span className="settings-icon"><Icon name="link" size={22} /></span><div><h2 id="flow-title">Google Flow</h2><p>Connect your signed-in Chrome workspace.</p></div><span className="neutral-badge">Chrome companion</span></div>
      <FlowControls />
      <div className="settings-card-body"><p>Use the companion extension with your already-signed-in normal Chrome tab. Then Generate or Regenerate in Clips; matching results are collected for approval. Google verification requires your attention. </p><div className="info-note"><Icon name="lock" size={16} /><span>Google connection is optional. Your local libraries and approved media remain available offline.</span></div></div>
    </section>
    <section className="settings-card" aria-labelledby="folders-title">
      <div className="settings-card-heading"><span className="settings-icon"><Icon name="folder" size={22} /></span><div><h2 id="folders-title">Workspace & storage</h2><p>A home for your photos, projects, and finished work.</p></div></div>
      <div className="settings-rows"><StorageStatus /><div className="settings-row"><div><h3>Export folder</h3><p>Choose where your finished posts and reels will go.</p></div><span className="neutral-badge">Choose during export</span></div></div>
    </section>
    <section className="settings-card" aria-labelledby="tools-title">
      <div className="settings-card-heading"><span className="settings-icon"><Icon name="film" size={22} /></span><div><h2 id="tools-title">Video tools</h2><p>The finishing touches, right on your computer.</p></div><span className="neutral-badge">Checked during export</span></div>
      <div className="settings-card-body"><p>Reel exports use FFmpeg and FFprobe installed locally and available on PATH. Frame Studio detects them before export; approved Post images export offline without FFmpeg.</p></div>
    </section>
    <section className="settings-card find-setup"><h2>Product Find / Advanced</h2><button className="button button-secondary" onClick={() => setProductAdvanced(open => !open)}>{productAdvanced ? 'Close advanced controls' : 'Open advanced controls'}</button>{productAdvanced && <ProductFindAdvanced />}</section>
    <div className="about-studio"><span className="brand-symbol brand-symbol-small"><i /><i /></span><div><strong>Frame Studio <span className="muted">{version}</span></strong><p>Your creative workspace</p></div></div>
  </div>
}

function FlowControls() {
  const api = window.frameStudio?.flow
  const [flow, setFlow] = useState<FlowConnection>({ state: 'not-connected', message: 'Connect to check Flow workspace access.', pageTitle: null, checkedAt: null })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!api) return
    let active = true
    const refresh = () => { void api.status().then(value => { if (active) setFlow(value) }) }
    refresh()
    const timer = window.setInterval(refresh, 2500)
    return () => { active = false; window.clearInterval(timer) }
  }, [api])
  const action = (name: 'connect' | 'open' | 'show' | 'check' | 'disconnect' | 'openManual') => {
    if (!api || busy) return
    setBusy(true); setError('')
    if (name === 'connect') {
      void api.pairCompanion().then(result => { if (!result.ok) throw new Error(result.error.message); setPairing(result.value); setCopied(false); return api.status() }).then(setFlow).catch(reason => setError(reason instanceof Error ? reason.message : 'Could not start pairing.')).finally(() => setBusy(false))
      return
    }
    if (name === 'disconnect') setPairing(null)
    void api[name]().then(setFlow).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'The Flow action failed.')).finally(() => setBusy(false))
  }
  const label = flow.state === 'connected' ? 'Connected' : flow.state === 'needs-attention' ? 'Needs attention' : flow.state === 'opening' ? 'Browser open' : flow.state === 'offline' ? 'Offline' : api ? 'Not connected' : 'Desktop app required'
  return <div className="flow-panel">
    <span className={`neutral-badge flow-state-${flow.state}`}>{label}</span>
    <p>Connect your signed-in Flow tab to generate and review images here.</p>
    <ol><li>Install the Frame Studio companion extension in Chrome.</li><li>Open your signed-in Flow workspace in normal Chrome.</li><li>Click Connect Flow below, copy the pairing code, then open the extension on that Flow tab and paste it.</li><li>Keep the selected tab open. Generate, review and regenerate from this app.</li></ol>
    <button className="button button-secondary" disabled={!api || busy} onClick={() => void api?.openExtensionFolder().then(result => { if (!result.ok) setError(result.error.message) })}>Open companion extension folder</button>
    {pairing && flow.state !== 'connected' && <div className="companion-pairing"><label>Temporary pairing code<input aria-label="Companion pairing code" type="password" readOnly value={pairing.code} autoComplete="off" /></label><button className="button button-secondary" onClick={() => { setError(''); void api!.copyPairingCode().then(result => { if (!result.ok) throw new Error(result.error.message); setCopied(true) }).catch(reason => setError(reason instanceof Error ? reason.message : 'Could not copy pairing code.')) }}>{copied ? 'Copied' : 'Copy pairing code'}</button><small>Expires at {new Date(pairing.expiresAt).toLocaleTimeString()}. Paste only into your Frame Studio extension; never share in chat or a website.</small></div>}
    <div className="flow-connection-message" role="status">{flow.message}</div>
    {flow.pageTitle && <p className="flow-page-title">Current page: {flow.pageTitle}{flow.checkedAt ? ` · checked ${new Date(flow.checkedAt).toLocaleTimeString()}` : ''}</p>}
    {error && <p className="prompt-validation-error" role="alert">{error}</p>}
    <div className="settings-action flow-actions">
      {!api || flow.state === 'not-connected' || flow.state === 'offline' ? <button className="button button-primary" disabled={!api || busy || flow.state === 'offline'} onClick={() => action('connect')}>{busy ? 'Opening…' : 'Connect Flow'}</button> : <>
        <button className="button button-primary" disabled={busy} onClick={() => action('check')}>{busy ? 'Checking…' : 'Recheck connection'}</button>
        <button className="button button-secondary" disabled={busy} onClick={() => action('connect')}>New pairing code</button>
        <button className="button button-secondary" disabled={busy} onClick={() => action('open')}>Open Flow</button>
        <button className="button button-secondary" disabled={busy} onClick={() => action('openManual')}>Open in system browser (fallback)</button>
        <button className="button button-secondary" disabled={busy} onClick={() => action('show')}>Show browser</button>
        <button className="button button-secondary" disabled={busy} onClick={() => action('disconnect')}>Disconnect</button>
      </>}
    </div>
    
  </div>
}

export function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
  const [page, setPage] = useState<Page>(currentPage)
  const [route, setRoute] = useState(window.location.hash || '#studio')
  const lastRoute = useRef(window.location.hash || '#studio')
  const dirty = useRef(false)
  const busy = useRef(false)
  const onDirty = useCallback((value: boolean) => { dirty.current = value }, [])
  const onBusy = useCallback((value: boolean) => { busy.current = value }, [])
  const heading = useRef<HTMLHeadingElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light'
    document.documentElement.dataset.theme = next
    setTheme(next)
    try { window.localStorage.setItem('frame-studio-theme', next) } catch { /* The in-session choice still works. */ }
  }

  useEffect(() => {
    const update = () => {
      const next = window.location.hash || '#studio'
      if (next !== lastRoute.current && (busy.current || (dirty.current && !window.confirm('Discard unsaved changes? Saved drafts and imported images remain in the local workspace.')))) {
        window.history.replaceState(null, '', lastRoute.current)
        return
      }
      dirty.current = false
      lastRoute.current = next
      setRoute(next)
      setPage(currentPage())
      content.current?.scrollTo({ top: 0 })
    }
    window.addEventListener('hashchange', update)
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty.current || busy.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', beforeUnload)
    return () => { window.removeEventListener('hashchange', update); window.removeEventListener('beforeunload', beforeUnload) }
  }, [])
  const previousPage = useRef(route)
  useEffect(() => {
    document.title = `${pages[page].title} — Frame Studio`
    if (previousPage.current !== route) heading.current?.focus({ preventScroll: true })
    previousPage.current = route
  }, [page, route])

  return <div className="app-shell">
    <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); heading.current?.focus() }}>Skip to content</a>
    <aside className="sidebar" aria-label="Workspace sidebar">
      <a className="brand" href="#studio" aria-label="Frame Studio home"><span className="brand-symbol"><i /><i /></span><span>frame<span className="brand-studio">studio</span></span></a>
      <div className="sidebar-label">WORKSPACE</div>
      <nav aria-label="Main navigation"><ul>{(['studio', 'themes', 'characters', 'product-find'] as const).map((item) => <li key={item}><a className={`nav-link ${page === item ? 'is-active' : ''}`} href={`#${item}`} aria-current={page === item ? 'page' : undefined}><Icon name={pages[item].icon} size={19} /><span>{pages[item].title}</span>{page === item && <span className="nav-active-dot" />}</a></li>)}</ul></nav>
      <div className="sidebar-bottom"><a className={`nav-link settings-nav ${page === 'settings' ? 'is-active' : ''}`} href="#settings" aria-current={page === 'settings' ? 'page' : undefined}><Icon name="settings" size={19} /><span>Settings</span>{page === 'settings' && <span className="nav-active-dot" />}</a><div className="sidebar-footer"><span className="avatar">ME</span><div><strong>My workspace</strong><span>Personal edition</span></div><Icon name="lock" size={14} /></div></div>
    </aside>
    <div className="main-column">
      <header className="topbar"><div className="page-heading"><h1 id="main-content" tabIndex={-1} ref={heading}>{pages[page].title}</h1><p>{pages[page].description}</p></div><div className="topbar-actions">{page !== 'product-find' && <ConnectionStatus />}<button className="theme-toggle" type="button" onClick={toggleTheme} aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'} title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}><Icon name={theme === 'light' ? 'moon' : 'sun'} size={17} /><span>{theme === 'light' ? 'Dark mode' : 'Light mode'}</span></button>{page === 'studio' ? route.split('/')[1] ? <a className="button button-secondary" href="#studio">All projects</a> : window.frameStudio?.projects ? <a className="button button-primary button-small" href="#studio/new"><Icon name="plus" size={18} />New project</a> : <button className="button button-secondary" disabled>New project · Desktop app required</button> : (page === 'themes' || page === 'characters') ? route.split('/')[1] ? <a className="button button-secondary" href={`#${page}`}>Back to {page}</a> : window.frameStudio?.[page] ? <a className="button button-primary" href={`#${page}/new`}><Icon name="plus" size={18} />Add {library[page].singular}</a> : <button className="button button-secondary" disabled title="Open the desktop app to manage your library.">Add {library[page].singular} · Desktop app required</button> : null}</div></header>
      <main className="page-scroll" ref={content} aria-labelledby="main-content"><div className={`page-content page-${page}`}>{page === 'studio' ? <ProjectStudio route={route.startsWith('#studio') ? route : '#studio'} onDirty={onDirty} onBusy={onBusy} /> : page === 'product-find' ? <ProductFind /> : page === 'settings' ? <Settings /> : page === 'themes' ? <Themes route={route} onDirty={onDirty} onBusy={onBusy} /> : <Characters route={route} onDirty={onDirty} onBusy={onBusy} />}</div></main>
    </div>
  </div>
}
