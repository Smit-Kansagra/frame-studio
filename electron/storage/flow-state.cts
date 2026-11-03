import type { DatabaseSync } from 'node:sqlite'
import type { FlowJob, FlowProject } from '../contracts.cjs'
import { UUID_PATTERN } from './paths.cjs'
import { StorageError } from './errors.cjs'
import { interruptActivity } from '../flow-progress.cjs'

// Only the trusted main-process coordinator writes remote associations.
export class FlowState {
  constructor(private readonly db: DatabaseSync) {}
  recover() {
    for (const row of this.db.prepare('SELECT content FROM flow_projects').all() as { content: string }[]) {
      const project = JSON.parse(row.content) as FlowProject
      if (project.activity?.some(item => item.state === 'running')) this.saveProject({ ...project, state: 'needs-attention', activity: interruptActivity(project.activity, 'Project sync was interrupted. This step was not confirmed complete.'), message: 'Project sync was interrupted. Review the saved steps before syncing again; no generation was submitted by sync.' })
    }
    for (const row of this.db.prepare('SELECT content FROM flow_jobs').all() as { content: string }[]) {
      const job = JSON.parse(row.content) as FlowJob
      if (['complete', 'needs-attention'].includes(job.stage)) continue
      const attempt = this.db.prepare('SELECT state FROM generation_attempts WHERE id = ?').get(job.attemptId) as { state: string }
      if (attempt.state === 'ready-for-review') this.saveJob({ ...job, stage: 'complete', message: 'Downloaded results recovered after restart.' })
      else {
        if (attempt.state === 'queued') this.db.prepare("UPDATE generation_attempts SET state = 'failed' WHERE id = ?").run(job.attemptId)
        this.saveJob({ ...job, activity: interruptActivity(job.activity, 'Interrupted while Frame Studio was closing. Completion of this step was not confirmed.'), stage: 'needs-attention', message: attempt.state === 'queued' ? 'Preparation was interrupted before submission. Generate again when ready; no automatic retry was made.' : 'Interrupted Flow request. Resume result collection to inspect the same job; no automatic resubmission.' })
      }
    }
  }
  private valid(id: string) { if (!UUID_PATTERN.test(id)) throw new StorageError('INVALID_REQUEST', 'Invalid Flow association.') }
  project(id: string): FlowProject | null {
    this.valid(id)
    const row = this.db.prepare('SELECT content FROM flow_projects WHERE project_id = ?').get(id) as { content: string } | undefined
    return row ? JSON.parse(row.content) as FlowProject : null
  }
  saveProject(value: FlowProject): FlowProject {
    this.valid(value.projectId)
    if (value.url) { const owner = this.linkedProject(value.url); if (owner && owner !== value.projectId) throw new StorageError('INVALID_REQUEST', 'Flow project association is ambiguous: this URL belongs to another software project.') }
    this.db.prepare('INSERT INTO flow_projects(project_id, content) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET content = excluded.content').run(value.projectId, JSON.stringify(value))
    return value
  }
  linkedProject(url: string): string | null {
    const target = new URL(url)
    for (const row of this.db.prepare('SELECT project_id, content FROM flow_projects').all() as { project_id: string; content: string }[]) {
      const saved = JSON.parse(row.content) as FlowProject
      if (!saved.url) continue
      const linked = new URL(saved.url)
      if (linked.origin === target.origin && linked.pathname.replace(/\/$/, '') === target.pathname.replace(/\/$/, '')) return row.project_id
    }
    return null
  }
  job(id: string): FlowJob | null {
    this.valid(id)
    const row = this.db.prepare('SELECT content FROM flow_jobs WHERE attempt_id = ?').get(id) as { content: string } | undefined
    return row ? JSON.parse(row.content) as FlowJob : null
  }
  latest(projectId: string): FlowJob | null {
    this.valid(projectId)
    const row = this.db.prepare('SELECT content FROM flow_jobs WHERE project_id = ? ORDER BY rowid DESC LIMIT 1').get(projectId) as { content: string } | undefined
    return row ? JSON.parse(row.content) as FlowJob : null
  }
  jobs(projectId: string): FlowJob[] {
    this.valid(projectId)
    return (this.db.prepare('SELECT content FROM flow_jobs WHERE project_id = ? ORDER BY rowid DESC').all(projectId) as {content:string}[]).map(row => JSON.parse(row.content) as FlowJob)
  }
  pendingCollection(): FlowJob[] {
    return (this.db.prepare("SELECT j.content FROM flow_jobs j JOIN generation_attempts a ON a.id=j.attempt_id JOIN projects p ON p.id=j.project_id WHERE a.state='submission-uncertain' AND p.trashed_at IS NULL ORDER BY j.rowid").all() as { content: string }[]).map(row => JSON.parse(row.content) as FlowJob).filter(job => !!job.projectUrl && !job.abandoned && !job.collectionStopped)
  }
  saveJob(value: FlowJob): FlowJob {
    this.valid(value.attemptId); this.valid(value.projectId)
    const attempt = this.db.prepare('SELECT project_id FROM generation_attempts WHERE id=?').get(value.attemptId) as { project_id: string } | undefined
    if (attempt?.project_id !== value.projectId) throw new StorageError('INVALID_REQUEST', 'Flow job association is ambiguous: attempt and project ownership differ.')
    if (value.resultIds.length) {
      for (const row of this.db.prepare('SELECT content FROM flow_jobs WHERE attempt_id<>?').all(value.attemptId) as { content: string }[]) {
        const other = JSON.parse(row.content) as FlowJob
        if (other.resultIds.some(id => value.resultIds.includes(id))) throw new StorageError('INVALID_REQUEST', 'Flow result association is ambiguous: this result is already assigned to another request. No cross-project import is allowed.')
      }
    }
    const saved = { ...value, updatedAt: new Date().toISOString() }
    this.db.prepare('INSERT INTO flow_jobs(attempt_id, project_id, content) VALUES (?, ?, ?) ON CONFLICT(attempt_id) DO UPDATE SET content = excluded.content').run(saved.attemptId, saved.projectId, JSON.stringify(saved))
    return saved
  }
}
