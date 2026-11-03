import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { AppResult, AssetInfo, CharacterContent, CharacterDraft, CharacterInfo, CharacterTrashInfo, ProductPhoto } from '../electron/contracts.cjs'
import { Dialog, Photo, Preview } from './Products'
import { ImageEditor } from './Themes'
import { Icon } from './icons'

type Guards = { onDirty: (value: boolean) => void; onBusy: (value: boolean) => void }
type Notice = { message: string; token?: string }
const bridge = () => window.frameStudio?.characters ? window.frameStudio : undefined
const empty = (): CharacterContent => ({ name: '', category: null, assetIds: [], primaryAssetId: '' })
const photo = (asset: AssetInfo): ProductPhoto => ({ ...asset, available: true, thumbnailAvailable: true })
const unwrap = <T,>(result: AppResult<T>): T => { if (!result.ok) throw new Error(result.error.message); return result.value }
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : 'This operation could not be completed. Please retry.'
const categoryName = (value: CharacterContent['category']) => value ? value[0].toUpperCase() + value.slice(1) : 'No category'
function contentOf(character: CharacterInfo): CharacterContent { const { name, category, assetIds, primaryAssetId } = character; return { name, category, assetIds, primaryAssetId } }

export function Characters({ route, onDirty, onBusy }: { route: string } & Guards) {
  const [notice, setNotice] = useState<Notice | null>(null), segment = route.replace(/^#/, '').split('/')[1]
  const exit = (notice: Notice) => { setNotice(notice); window.location.hash = '#characters' }
  return segment ? <CharacterEditor key={segment} id={segment === 'new' ? undefined : segment} onDirty={onDirty} onBusy={onBusy} onSaved={character => exit({ message: `“${character.name}” saved · revision ${character.revision}.` })} onRemoved={(token, name) => exit({ message: `“${name}” moved to local trash.`, token })} /> : <CharacterLibrary notice={notice} onNotice={setNotice} onBusy={onBusy} />
}

function CharacterLibrary({ notice, onNotice, onBusy }: { notice: Notice | null; onNotice: (notice: Notice | null) => void; onBusy: Guards['onBusy'] }) {
  const api = bridge(), [items, setItems] = useState<CharacterInfo[]>([]), [trash, setTrash] = useState<CharacterTrashInfo[]>([])
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [search, setSearch] = useState(''), [filter, setFilter] = useState('all')
  const [preview, setPreview] = useState<CharacterInfo | null>(null), [removing, setRemoving] = useState<CharacterInfo | null>(null)
  const generation = useRef(0), operation = useRef(false)
  const load = useCallback(async () => {
    const request = ++generation.current, api = bridge()
    if (!api) { setLoading(false); return }
    setLoading(true); setError('')
    try { const [characters, removed] = await Promise.all([api.characters.list(), api.characters.trash()]); if (request !== generation.current) return; setItems(unwrap(characters)); setTrash(unwrap(removed)) }
    catch (cause) { if (request === generation.current) setError(errorText(cause)) }
    finally { if (request === generation.current) setLoading(false) }
  }, [])
  useEffect(() => { void load(); return () => { generation.current++ } }, [load])
  useEffect(() => { onBusy(busy); return () => onBusy(false) }, [busy, onBusy])
  const shown = useMemo(() => items.filter(item => (filter === 'all' || (item.category ?? 'none') === filter) && item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())), [items, search, filter])
  async function mutate(action: () => Promise<Notice>) {
    if (operation.current) return
    operation.current = true; setBusy(true); setError('')
    try { onNotice(await action()); setRemoving(null); await load() } catch (cause) { setError(errorText(cause)); setRemoving(null) }
    finally { operation.current = false; setBusy(false) }
  }
  const undo = (token: string) => mutate(async () => { const restored = unwrap(await api!.characters.undo(token)); return { message: `Restored to “${restored.name}”.` } })
  return <>
    {notice && <div className="product-notice" role="status"><span>{notice.message}</span>{notice.token && <button className="button button-secondary" disabled={busy} onClick={() => { void undo(notice.token!) }}>Undo</button>}<button className="notice-dismiss" aria-label="Dismiss notification" onClick={() => onNotice(null)}>×</button></div>}
    <div className="section-heading character-library-heading"><div className="heading-with-count"><h2>Your characters</h2>{api && !loading && !error && <span className="count">{items.length}</span>}</div>{items.length > 0 && <div className="character-filters"><label><span className="sr-only">Filter characters by category</span><select value={filter} disabled={busy} onChange={event => setFilter(event.target.value)}><option value="all">All categories</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option><option value="none">No category</option></select></label><label className="product-search"><span className="sr-only">Search characters</span><input type="search" maxLength={200} placeholder="Search characters" value={search} disabled={busy} onChange={event => setSearch(event.target.value)} /></label></div>}</div>
    {!api ? <section className="empty-panel product-empty"><span className="feature-icon"><Icon name="character" size={36} /></span><h2>Familiar faces, in one place</h2><p>Open the desktop app to add character photos and keep your visual references together.</p><span className="neutral-badge">Desktop app required</span></section> : loading ? <div className="product-message" role="status">Loading your character library…</div> : error ? <><div className="product-message product-error" role="alert">{error}</div><button className="button button-secondary" disabled={busy} onClick={() => { void load() }}>Retry library</button></> : !items.length ? <section className="empty-panel product-empty"><span className="product-empty-icon"><Icon name="character" size={38} /></span><span className="eyebrow">FAMILIAR FACES, CONSISTENT STORIES</span><h2>Meet the faces of your stories</h2><p>Bring your own reference photos to guide the character’s appearance.</p><a className="button button-primary" href="#characters/new"><Icon name="plus" size={18} />Add your first character</a><span className="availability">Your photos only · no AI photo generation</span></section> : !shown.length ? <section className="empty-panel product-empty search-empty"><h2>No matching characters</h2><p>Try another name or category.</p><button className="button button-secondary" onClick={() => { setSearch(''); setFilter('all') }}>Clear filters</button></section> : <div className="product-grid character-grid">{shown.map(character => {
      const primary = character.photos.find(photo => photo.id === character.primaryAssetId) ?? character.photos[0]
      return <article className="product-card character-card" key={character.id}><button type="button" className="character-card-image" aria-label={`Preview ${character.name}`} onClick={() => setPreview(character)}><Photo key={primary.id} photo={primary} name={`${character.name} primary portrait`} /><span className="photo-count">{character.photos.length} {character.photos.length === 1 ? 'reference' : 'references'}</span></button><div className="product-card-copy"><h3>{character.name}</h3><p>{categoryName(character.category)} · Revision {character.revision}<br />Photo references saved for visual consistency.</p>{!primary.available && <span className="missing-label">Primary photo unavailable · replace in editor</span>}<div className="product-card-actions"><a className="button button-secondary" href={`#characters/${character.id}`}>Edit character</a><details className="product-overflow"><summary aria-label={`More options for ${character.name}`}>•••</summary><div><button type="button" disabled={busy} onClick={() => { void mutate(async () => { const copy = unwrap(await api.characters.duplicate(character.id, character.revision)); return { message: `Created independent character “${copy.name}”.` } }) }}>Duplicate character</button><button type="button" disabled={busy} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setRemoving(character) }}>Move to trash</button></div></details></div></div></article>
    })}</div>}
    {api && !loading && trash.length > 0 && <details className="product-trash"><summary>Local character trash <span className="count">{trash.length}</span></summary><p>Removed characters and references stay recoverable. Original source files and saved revisions are preserved.</p><ul>{trash.map(entry => <li key={entry.token}><div><strong>{entry.kind === 'character' ? entry.characterName : entry.photoName}</strong><span>{entry.kind === 'character' ? 'Character' : `Photo from ${entry.characterName}`} · {new Date(entry.removedAt).toLocaleDateString()}{!entry.canUndo && ' · Restore the character first'}</span></div><button className="button button-secondary" disabled={busy || !entry.canUndo} aria-label={`Restore ${entry.kind === 'character' ? entry.characterName : entry.photoName}`} onClick={() => { void undo(entry.token) }}>Restore</button></li>)}</ul></details>}
    {preview && <Preview photos={preview.photos} initial={preview.primaryAssetId} title={preview.name} onClose={() => setPreview(null)} />}
    {removing && <Dialog title="Move character to local trash?" onClose={() => { if (!busy) setRemoving(null) }}><p>“{removing.name}” and its {removing.photos.length} reference photos will leave this library. You can Undo after restarting. Original photos and saved revisions remain intact; no Flow-side asset is removed.</p><div className="dialog-actions"><button className="button button-secondary" disabled={busy} onClick={() => setRemoving(null)}>Keep character</button><button className="button button-danger" disabled={busy} onClick={() => { void mutate(async () => { const result = unwrap(await api!.characters.remove(removing.id, removing.revision)); return { message: `“${removing.name}” moved to local trash.`, token: result.token } }) }}>{busy ? 'Moving…' : 'Move to trash'}</button></div></Dialog>}
  </>
}

function CharacterEditor({ id, onDirty, onBusy, onSaved, onRemoved }: { id?: string; onSaved: (character: CharacterInfo) => void; onRemoved: (token: string, name: string) => void } & Guards) {
  const api = bridge(), [form, setForm] = useState<CharacterContent>(empty), [photos, setPhotos] = useState<ProductPhoto[]>([]), [saved, setSaved] = useState<CharacterInfo | null>(null)
  const [loading, setLoading] = useState(!!id), [loadError, setLoadError] = useState(''), [loadVersion, setLoadVersion] = useState(0), [busy, setBusy] = useState(''), [error, setError] = useState(''), [info, setInfo] = useState('')
  const [selected, setSelected] = useState(''), [editing, setEditing] = useState<ProductPhoto | null>(null), [preview, setPreview] = useState(false), [removing, setRemoving] = useState(false), [removed, setRemoved] = useState<CharacterContent | null>(null)
  const baseline = useRef(JSON.stringify(empty())), operation = useRef(false), errorRef = useRef<HTMLDivElement>(null)
  const dirty = JSON.stringify(form) !== baseline.current
  useEffect(() => { onDirty(dirty || !!editing); return () => onDirty(false) }, [dirty, editing, onDirty])
  useEffect(() => { onBusy(!!busy); return () => onBusy(false) }, [busy, onBusy])
  useEffect(() => { if (error) errorRef.current?.focus() }, [error])
  useEffect(() => {
    if (!id || !api) { setLoading(false); return }
    let active = true
    setLoading(true); setLoadError('')
    void api.characters.get(id).then(result => { if (!active) return; const character = unwrap(result), content = contentOf(character); baseline.current = JSON.stringify(content); setForm(content); setPhotos(character.photos); setSaved(character); setSelected(character.primaryAssetId) }).catch(cause => { if (active) setLoadError(errorText(cause)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [id, api, loadVersion])
  const visiblePhotos = form.assetIds.map(id => photos.find(photo => photo.id === id)).filter((photo): photo is ProductPhoto => !!photo)
  const active = visiblePhotos.find(photo => photo.id === selected) ?? visiblePhotos.find(photo => photo.id === form.primaryAssetId) ?? visiblePhotos[0]
  const change = <K extends keyof CharacterContent>(key: K, value: CharacterContent[K]) => setForm(current => ({ ...current, [key]: value }))
  const retain = (assets: AssetInfo[]) => setPhotos(current => [...current.filter(photo => !assets.some(asset => asset.id === photo.id)), ...assets.map(photo)])
  async function perform(label: string, action: () => Promise<void>) {
    if (operation.current) return
    operation.current = true; setBusy(label); onBusy(true); setError(''); setInfo('')
    try { await action() } catch (cause) { setError(errorText(cause)) }
    finally { operation.current = false; setBusy(''); onBusy(false) }
  }
  function useImage(asset: AssetInfo, replace: string) {
    retain([asset]); setSelected(asset.id)
    setForm(current => ({ ...current, assetIds: [...new Set(current.assetIds.map(id => id === replace ? asset.id : id))], primaryAssetId: current.primaryAssetId === replace ? asset.id : current.primaryAssetId }))
  }
  async function choose(replace?: string) {
    await perform('Importing reference photos…', async () => {
      const selection = unwrap(await api!.images.chooseManyAndImport(replace ? 1 : 20 - form.assetIds.length))
      if (!selection) return
      if (selection.assets.length) {
        retain(selection.assets)
        if (replace) useImage(selection.assets[0], replace)
        else setForm(current => ({ ...current, name: current.name || selection.assets[0].originalName.replace(/\.[^.]+$/, ''), assetIds: [...current.assetIds, ...selection.assets.map(asset => asset.id)], primaryAssetId: current.primaryAssetId || selection.assets[0].id }))
        setSelected(selection.assets[0].id)
      }
      if (selection.failures.length) setError(selection.failures.map(item => `${item.filename}: ${item.message}`).join('\n'))
    })
  }
  function removePhoto(id: string) {
    if (form.assetIds.length === 1) { setError('Keep at least one reference photo. Replace the last photo, or remove the character instead.'); return }
    setRemoved(structuredClone(form))
    const next = form.assetIds.filter(assetId => assetId !== id)
    setForm(current => ({ ...current, assetIds: next, primaryAssetId: current.primaryAssetId === id ? visiblePhotos.find(photo => photo.id !== id && photo.available)?.id ?? next[0] : current.primaryAssetId }))
    setInfo('Photo removed from this draft. Undo is available; the original file is preserved.')
  }
  function finish() { baseline.current = JSON.stringify(form); onDirty(false); onBusy(false) }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (editing || preview || removing) return
    await perform('Saving character…', async () => { const draft: CharacterDraft = { ...form, ...(saved ? { id: saved.id, expectedRevision: saved.revision } : {}) }; const character = unwrap(await api!.characters.save(draft)); finish(); onSaved(character) })
  }
  if (!api) return <div className="product-message">The desktop app is required to manage character photos. <a href="#characters">Back to characters</a></div>
  if (loading) return <div className="product-message" role="status">Opening character and reference photos…</div>
  if (loadError) return <><div className="product-message product-error" role="alert">{loadError}</div><div className="editor-recovery"><button className="button button-secondary" onClick={() => setLoadVersion(value => value + 1)}>Retry character</button><a className="button button-secondary" href="#characters">Back to characters</a></div></>
  return <form className="character-editor" onSubmit={event => { void submit(event) }} noValidate><div className="editor-intro theme-intro"><div><span className="eyebrow">{saved ? `CHARACTER EDITOR · REVISION ${saved.revision}` : 'YOUR REFERENCE, YOUR CHARACTER'}</span><h2>{saved ? form.name || 'Edit character' : 'A familiar face for your next story'}</h2><p>Keep the appearance, outfit, and small details that make a character recognisable.</p></div><span className="neutral-badge">Originals preserved</span></div>
    {error && <div ref={errorRef} tabIndex={-1} className="product-message product-error theme-feedback" role="alert">{error}</div>}{info && <div className="product-message" role="status">{info}</div>}
    <fieldset disabled={!!busy} className="theme-fieldset"><div className="product-edit-columns character-edit-columns"><section className="photo-editor"><div className="editor-section-heading"><h3>Reference photos <span>{form.assetIds.length}/20</span></h3><button type="button" className="button button-secondary" disabled={form.assetIds.length >= 20} onClick={() => { void choose() }}><Icon name="plus" size={15} />Add photos</button></div><div className={`editor-photo-preview character-photo-preview ${!active ? 'is-empty' : ''}`}>{active ? <><Photo key={active.id} photo={active} original name="Selected character reference" /><button type="button" className="button button-secondary preview-open" onClick={() => setPreview(true)}>View full size</button></> : <><Icon name="character" size={48} /><strong>Start with a photo you provide</strong><p>JPG, PNG or WebP · no generated placeholder portraits</p><button type="button" className="button button-secondary" onClick={() => { void choose() }}>Choose reference photos</button></>}</div>{active && <><div className="theme-image-tools"><button type="button" className="button button-secondary" onClick={() => setEditing(active)}>Crop & rotate photo</button><button type="button" className="button button-secondary" onClick={() => { void choose(active.id) }}>Replace selected photo</button>{active.edit && <button type="button" className="button button-secondary" onClick={() => { void perform('Restoring original…', async () => { useImage(unwrap(await api.images.get(active.edit!.sourceAssetId)), active.id); setInfo('Original restored in this draft. Edited copies remain intact.') }) }}>Reset selected photo</button>}</div><p className="photo-help">{active.originalName} · {active.width} × {active.height}{!active.available && ' · Original unavailable; replace or reset this reference.'}</p></>}<p className="photo-help">Choose one primary portrait, then add other views if useful. Up to 20 MB / 40 million pixels per photo. Your original files are never overwritten.</p>
    {visiblePhotos.length > 0 && <div className="editor-photo-grid">{visiblePhotos.map((image, index) => <article className={`editor-photo-tile ${form.primaryAssetId === image.id ? 'is-primary' : ''}`} key={image.id}><button type="button" className="photo-tile-image" aria-label={`Select reference ${index + 1}`} aria-pressed={active?.id === image.id} onClick={() => setSelected(image.id)}><Photo key={image.id} photo={image} />{form.primaryAssetId === image.id && <span className="primary-marker"><Icon name="check" size={12} />Primary</span>}</button><div className="photo-tile-actions"><label><input type="radio" name="character-primary" checked={form.primaryAssetId === image.id} disabled={!image.available} onChange={() => change('primaryAssetId', image.id)} aria-label={`Use reference ${index + 1} as primary`} />Primary</label><button type="button" aria-label={`Remove reference ${index + 1}`} onClick={() => removePhoto(image.id)}>Remove</button></div>{!image.available && <span className="missing-label">Unavailable</span>}</article>)}</div>}
    <div className="character-photo-note"><Icon name="lock" size={16} /><p>These are local references, not automatically native Flow Characters. No Flow mapping or photo generation is claimed.</p></div></section>
    <section className="product-fields character-fields"><div className="editor-section-heading"><h3>Character details</h3><span className="neutral-badge">Photo references only</span></div><label className="field-label" htmlFor="character-name">Character name <span>Required</span></label><input id="character-name" maxLength={120} value={form.name} autoComplete="off" placeholder="A name you will recognise" onChange={event => change('name', event.target.value)} /><label className="field-label" htmlFor="character-category">Category <span>Optional</span></label><select id="character-category" value={form.category ?? ''} onChange={event => change('category', (event.target.value || null) as CharacterContent['category'])}><option value="">No category</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select><p className="field-help">For your own organisation. Only the supplied photos are used as character references; the app does not send a character prompt.</p></section></div></fieldset>
    {removed && <div className="theme-draft-undo"><span>Last draft photo removal</span><button type="button" className="button button-secondary" disabled={!!busy} onClick={() => { if (!window.confirm('Restore the draft before the last photo removal? Any changes made since that action will be replaced.')) return; setForm(removed); setRemoved(null); setInfo('Previous draft restored.') }}>Undo draft removal</button></div>}
    {saved && <div className="theme-record-actions"><button type="button" className="button button-secondary" disabled={!!busy} onClick={() => { if (dirty && !window.confirm('Duplicate the last saved character and discard this unsaved draft? Save first to include your latest changes.')) return; void perform('Duplicating saved character…', async () => { const copy = unwrap(await api.characters.duplicate(saved.id, saved.revision)); finish(); onSaved(copy) }) }}>Duplicate saved character</button><button type="button" className="theme-text-button danger" disabled={!!busy} onClick={() => setRemoving(true)}>Remove character</button></div>}
    <div className="product-save-bar"><span>{busy || (dirty ? 'Unsaved changes · imported copies remain local if cancelled' : saved ? `Saved revision ${saved.revision} · originals preserved` : 'One reference photo to get started')}</span><div><a className={`button button-secondary ${busy ? 'link-disabled' : ''}`} href="#characters" aria-disabled={!!busy} onClick={event => { if (busy) event.preventDefault() }}>Cancel</a><button type="submit" className="button button-primary" disabled={!!busy}>{busy === 'Saving character…' ? 'Saving…' : saved ? 'Save changes' : 'Save character'}</button></div></div>
    {editing && <ImageEditor image={editing} onBusy={onBusy} onClose={() => setEditing(null)} onApply={asset => { useImage(asset, editing.id); setEditing(null); setInfo('Photo edit applied to this draft. Save to update the character; the original is preserved.') }} />}
    {preview && active && <Preview photos={visiblePhotos} initial={active.id} title={form.name || 'Character references'} onClose={() => setPreview(false)} />}
    {removing && saved && <Dialog title="Move character to local trash?" onClose={() => { if (!busy) setRemoving(false) }}><p>Remove “{saved.name}” and its {saved.assetIds.length} reference photos from the library? Undo restores the saved version. Originals and revision history remain intact. {dirty && 'Unsaved draft changes will be discarded.'}</p><div className="dialog-actions"><button type="button" className="button button-secondary" disabled={!!busy} onClick={() => setRemoving(false)}>Keep character</button><button type="button" className="button button-danger" disabled={!!busy} onClick={() => { void perform('Moving character…', async () => { const result = unwrap(await api.characters.remove(saved.id, saved.revision)); finish(); onRemoved(result.token, saved.name) }) }}>{busy ? 'Moving…' : 'Move to trash'}</button></div></Dialog>}
  </form>
}
