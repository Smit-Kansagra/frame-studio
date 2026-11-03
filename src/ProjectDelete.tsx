import { useEffect, useState } from 'react'
import type { DeletedProjectInfo, ProjectInfo } from '../electron/contracts.cjs'
import { Dialog } from './Products'

export function DeleteProjectButton({ project, disabled = false, onBusy, onDeleted }: {
  project: ProjectInfo; disabled?: boolean; onBusy: (value: boolean) => void; onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const remove = async () => {
    if (busy) return
    setBusy(true); setError(''); onBusy(true)
    try {
      const result = await window.frameStudio!.projects.trash(project.id, project.revision)
      if (!result.ok) throw new Error(result.error.message)
      onBusy(false); onDeleted()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete this project.') }
    finally { setBusy(false); onBusy(false) }
  }
  return <>
    <button type="button" className="button button-secondary project-delete-button" disabled={disabled || busy} aria-label={`Delete project ${project.name}`} onClick={() => void remove()}>{busy ? 'Deleting…' : 'Delete project'}</button>
    {error && <p className="product-error" role="alert">{error}</p>}
  </>
}

export function DeletedProjects({ revision, onBusy, onRestored }: { revision: number; onBusy: (value: boolean) => void; onRestored: () => void }) {
  const [items, setItems] = useState<DeletedProjectInfo[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [permanent, setPermanent] = useState<DeletedProjectInfo | null>(null)
  const api = window.frameStudio?.projects
  useEffect(() => {
    let current = true
    if (api) void api.deleted().then(result => { if (!current) return; if (result.ok) { setItems(result.value); setError('') } else setError(result.error.message) }).catch(() => { if (current) setError('Could not load deleted projects.') })
    return () => { current = false }
  }, [api, revision])
  const restore = async (item: DeletedProjectInfo) => {
    if (!api || busy) return
    setBusy(true); setError(''); onBusy(true)
    try {
      const result = await api.restore(item.id, item.revision)
      if (!result.ok) throw new Error(result.error.message)
      setItems(previous => previous.filter(project => project.id !== item.id)); onRestored()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not restore this project.') }
    finally { setBusy(false); onBusy(false) }
  }
  const erase = async () => {
    if (!api || busy || !permanent) return
    setBusy(true); setError(''); onBusy(true)
    try {
      const result = await api.deletePermanently(permanent.id, permanent.revision)
      if (!result.ok) throw new Error(result.error.message)
      setItems(previous => previous.filter(item => item.id !== permanent.id)); setPermanent(null)
      if (result.value.cleanupWarnings) setError(`Project permanently deleted. ${result.value.cleanupWarnings} local file(s) could not be cleaned up.`)
      onRestored()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not permanently delete this project.') }
    finally { setBusy(false); onBusy(false) }
  }
  if (!api) return null
  return <details className="deleted-projects"><summary>Deleted projects ({items.length})</summary>
    {error && <p className="product-error" role="alert">{error}</p>}
    {!items.length ? <p className="muted">No deleted projects.</p> : <ul>{items.map(item => <li key={item.id}><div><strong>{item.name}</strong><span className="muted small">Deleted {new Date(item.deletedAt).toLocaleString()}</span></div><div className="project-card-actions"><button className="button button-secondary button-small" disabled={busy} onClick={() => void restore(item)}>Restore project</button><button className="button button-secondary button-small" disabled={busy} onClick={() => { setError(''); setPermanent(item) }}>Delete permanently</button></div></li>)}</ul>}
    {permanent && <Dialog title="Delete project permanently?" onClose={() => { if (!busy) setPermanent(null) }}><p><strong>{permanent.name}</strong> and its saved project results, reviews and history will be permanently removed. This cannot be undone.</p><p>Themes, characters, shared library photos, Google Flow projects and exported files outside the workspace are kept.</p>{error && <p role="alert">{error}</p>}<div className="dialog-actions"><button className="button button-secondary" disabled={busy} onClick={() => setPermanent(null)}>Cancel</button><button className="button button-danger" disabled={busy} onClick={() => void erase()}>{busy ? 'Deleting…' : 'Delete permanently'}</button></div></Dialog>}
  </details>
}
