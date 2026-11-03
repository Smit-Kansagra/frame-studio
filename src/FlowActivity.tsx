import type { FlowActivity as Activity, FlowActiveRequest, FlowJob, FlowProject } from '../electron/contracts.cjs'

const labels: Record<Activity['state'], string> = { pending: 'Not started', running: 'In progress', done: 'Confirmed', error: 'Stopped', uncertain: 'Unconfirmed' }

export function FlowActivityPanel({ job, mapping, checking, requestError, blocked, projectId, connected }: {
  job: FlowJob | null; mapping: FlowProject | null; checking: boolean; requestError: string;
  blocked: FlowActiveRequest | null; projectId: string; connected: boolean;
}) {
  const otherProject = blocked && blocked.projectId !== projectId
  const legacy = blocked && blocked.projectId === projectId && !blocked.automatic
  const activity = requestError || checking || otherProject || legacy ? [] : job ? job.activity ?? [] : mapping?.activity ?? []
  const references = activity.filter(item => item.id.startsWith('reference-') || item.id === 'start-frame')
  const attached = references.filter(item => item.state === 'done').length
  const current = activity.find(item => item.state === 'running')
  const stopped = activity.find(item => item.state === 'error' || item.state === 'uncertain')
  const latest = activity.reduce((value, item) => item.updatedAt > value ? item.updatedAt : value, '')
  return <section className="flow-activity" aria-labelledby="flow-activity-title">
    <div className="flow-activity-heading"><h4 id="flow-activity-title">Google Flow activity</h4><span className="neutral-badge">{connected ? 'Companion connected' : 'Companion not connected'}</span></div>
    <div className="flow-activity-current" role="status" aria-live="polite">
      {checking ? 'Checking this request locally. Waiting for the app to accept it; uploads are not confirmed yet.' : requestError ? 'New request could not start. See the reason below.' : otherProject ? 'A request in another project is blocking this project.' : legacy ? 'An older manual request needs reconciliation. Its upload status is unknown.' : job?.stage === 'complete' ? job.message : current ? `${current.label}: ${current.detail}` : stopped ? `${stopped.label}: ${stopped.detail}` : job?.message ?? mapping?.message ?? (connected ? 'Ready for your request. No upload activity recorded yet.' : 'Connect the Chrome companion in Settings before generating. No upload is confirmed.')}
    </div>
    {requestError && <p className="flow-activity-error" role="alert">{requestError}</p>}
    {otherProject && <div className="flow-activity-blocker"><strong>Blocked by: {blocked.projectName}</strong><p>Status: {blocked.state.replaceAll('-', ' ')}. Resolve the existing request first. This new request will not upload photos or click Generate.</p><a className="button button-secondary button-small" href={`#studio/${blocked.projectId}`}>Open blocking project</a></div>}
    {legacy && <p className="flow-activity-error">This old request has no automatic upload log. Open “Manual fallback / reconcile an old request” below. Confirm its actual Flow status before clearing it; do not assume nothing was submitted.</p>}
    {!!references.length && <p className="flow-activity-count"><strong>{attached} / {references.length}</strong> photo attachments confirmed in Flow{requestError ? '' : job ? ' for this attempt' : ' during the last sync'}.</p>}
    {!!activity.length && <ol className="flow-activity-list" aria-label="Flow steps and upload status">
      {activity.map(item => <li key={item.id} className={`flow-activity-step activity-${item.state}`}>
        <span className="flow-activity-marker" aria-hidden="true">{item.state === 'done' ? '✓' : item.state === 'error' || item.state === 'uncertain' ? '!' : item.state === 'running' ? '…' : '○'}</span>
        <div><div className="flow-activity-row"><strong>{item.label}</strong><span>{item.id.startsWith('reference-') && item.state === 'done' ? 'Attached in Flow' : labels[item.state]}</span></div><p>{item.detail}</p></div>
      </li>)}
    </ol>}
    {!activity.length && !checking && !requestError && !otherProject && !legacy && job && <p>No detailed upload history exists for this older attempt. Its photos must not be treated as confirmed uploads.</p>}
    {latest && <p className="muted small">Last recorded activity: <time dateTime={latest}>{new Date(latest).toLocaleString()}</time></p>}
    
  </section>
}
