import { FlowCoordinator, type FlowDriver } from './flow-coordinator.cjs'
import type { Workspace } from './storage/workspace.cjs'
import { StorageError } from './storage/errors.cjs'
import { UUID_PATTERN } from './storage/paths.cjs'
import { FlowCommandQueue, type FlowCommandDispatch } from './flow-command-queue.cjs'

/** Independent project queues with no global project/submission capacity cap.
 * Only foreground actions share a lock; uploads and collection use owned tabs.
 * A native submit ticket/click remains one uninterrupted command turn.
 * Slow acknowledgement runs independently in the owning project's lane. */
export class FlowScheduler {
  private readonly runners = new Map<string, FlowCoordinator>()
  private readonly commands = new FlowCommandQueue()
  private stopping = false
  constructor(private readonly workspace: () => Promise<Workspace>, private readonly driver: (projectId: string, dispatch: FlowCommandDispatch) => FlowDriver, private readonly pollMs = 1000, private readonly maxWaitMs = 15 * 60_000) {}
  get busy() { return [...this.runners.values()].some(runner => runner.busy) }
  isBusy(projectId: string) { return !!this.runners.get(projectId)?.busy }
  private runner(projectId: string): FlowCoordinator {
    if (this.stopping || !UUID_PATTERN.test(projectId)) throw new StorageError('INVALID_REQUEST', 'This Flow project queue is unavailable.')
    let runner = this.runners.get(projectId)
    if (!runner) {
      const lane = new FlowCommandQueue()
      const dispatch: FlowCommandDispatch = (kind, action) => lane.dispatch(kind, () =>
        ['submit','nameProject','show'].includes(kind) ? this.commands.dispatch(kind, action) : action())
      const source = this.driver(projectId, dispatch)
      const raw: FlowDriver = source.granularQueue ? source : {
        createProject: commit => dispatch('createProject', () => source.createProject(commit)),
        nameProject: (url,name) => dispatch('nameProject', () => source.nameProject(url,name)),
        prepare: (url,request,report) => dispatch('prepare', () => source.prepare(url,request,report)),
        submit: url => dispatch('submit', () => source.submit(url)),
        results: (url,prompt,kind,baseline) => dispatch('results', () => source.results(url,prompt,kind,baseline)),
        download: (url,result,directory) => dispatch('download', () => source.download(url,result,directory)),
        close: () => source.close?.() ?? Promise.resolve(),
      }
      runner = new FlowCoordinator(this.workspace, {
        ...raw,
        // Deleting one project never disconnects or cancels another project.
        close: async () => { await raw.close?.() },
        capacityAvailable: async () => true,
        submission: async action => {
          const ws = await this.workspace()
          if (this.stopping || ws.projects.isDeleted(projectId)) throw new StorageError('INVALID_REQUEST', 'Project queue stopped before submission.')
          await action()
        },
      }, this.pollMs, this.maxWaitMs, true, projectId)
      this.runners.set(projectId, runner)
    }
    return runner
  }
  start(projectId: string, sceneId: string, outputs: number) { return this.runner(projectId).start(projectId, sceneId, outputs) }
  startPosts(projectId: string) { return this.runner(projectId).startPosts(projectId) }
  linkProject(projectId: string, url: string) { return this.runner(projectId).linkProject(projectId, url) }
  async resume(attemptId: string) { const ws = await this.workspace(); const job = ws.flow.job(attemptId); if (!job) throw new StorageError('INVALID_REQUEST', 'No submitted Flow job was found.'); return this.runner(job.projectId).resume(attemptId) }
  async retry(attemptId:string){const ws=await this.workspace(),job=ws.flow.job(attemptId);if(!job)throw new StorageError('INVALID_REQUEST','No saved request was found for this product.');return this.runner(job.projectId).retry(attemptId)}
  resumePosts(projectId: string) { return this.runner(projectId).resumePosts(projectId) }
  async collectPending() {
    if (this.stopping) return
    const ws = await this.workspace()
    const projects=new Set([...ws.flow.pendingCollection(),...ws.flow.queuedEdits()].map(job=>job.projectId))
    await Promise.allSettled([...projects].map(async id=>{const runner=this.runner(id);await runner.collectPending();await runner.drainQueuedEdits()}))
  }
  async stopDeletedProject(projectId: string) { await this.runners.get(projectId)?.stopDeletedProject(projectId) }
  async localProjectChange<T>(operation: () => Promise<T>, projectId: string): Promise<T> {
    const runner = this.runners.get(projectId)
    if (runner) { await runner.close(); this.runners.delete(projectId) }
    return operation()
  }
  async close() { this.stopping = true; await Promise.all([...this.runners.values()].map(runner => runner.close())) }
}
