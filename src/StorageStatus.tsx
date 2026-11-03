import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceInfo } from '../electron/contracts.cjs'

type State = { kind: 'loading' } | { kind: 'browser' } | { kind: 'error'; message: string } | { kind: 'ready'; info: WorkspaceInfo }

export function StorageStatus() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    const request = ++generation.current
    const api = window.frameStudio
    if (!api) { setState({ kind: 'browser' }); return }
    setState({ kind: 'loading' })
    try {
      const result = await api.workspace.retry()
      if (generation.current !== request) return
      setState(result.ok ? { kind: 'ready', info: result.value } : { kind: 'error', message: result.error.message })
    } catch {
      if (generation.current === request) setState({ kind: 'error', message: 'The desktop storage service did not respond. Restart Frame Studio, then try again.' })
    }
  }, [])

  useEffect(() => { void refresh(); return () => { generation.current++ } }, [refresh])

  return <div className="storage-status">
    <div className="settings-row">
      <div><h3>Local library</h3><p>Managed storage for original photos, edits, and thumbnails.</p></div>
      <span className={`neutral-badge ${state.kind === 'ready' ? state.info.issues.length ? 'badge-warning' : 'badge-success' : ''}`}>
        {state.kind === 'loading' ? 'Checking…' : state.kind === 'ready' ? state.info.issues.length ? 'Needs attention' : 'Ready' : state.kind === 'browser' ? 'Desktop app required' : 'Unavailable'}
      </span>
    </div>
    <div className="storage-details" aria-busy={state.kind === 'loading'}>
      {state.kind === 'loading' && <p className="storage-message" role="status">Opening your local workspace…</p>}
      {state.kind === 'browser' && <p className="storage-message">Open the desktop app to use local storage. This browser preview does not access your files or database.</p>}
      {state.kind === 'error' && <div className="storage-error" role="alert"><strong>Local storage needs attention</strong><p>{state.message}</p></div>}
      {state.kind === 'ready' && <>
        <p className="storage-caption">Storage location</p><p className="storage-path">{state.info.folder}</p>
        <p className="storage-message" role="status">{state.info.assetCount === 0 ? 'No images imported yet. Start a project and add your first product there.' : `${state.info.assetCount} imported ${state.info.assetCount === 1 ? 'image' : 'images'} stored on this computer.`}</p>
        {state.info.issues.length > 0 && <div className="storage-warning" role="status"><strong>Some local files need attention</strong><ul>{state.info.issues.map((issue, index) => <li key={`${issue.code}-${issue.assetId ?? ''}-${index}`}>{issue.message}</li>)}</ul></div>}
      </>}
      {state.kind !== 'browser' && <button type="button" className="button button-secondary" disabled={state.kind === 'loading'} onClick={() => { void refresh() }}>{state.kind === 'loading' ? 'Checking storage…' : state.kind === 'error' ? 'Retry local storage' : 'Recheck storage'}</button>}
    </div>
  </div>
}
