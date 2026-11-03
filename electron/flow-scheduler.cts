import { setTimeout as delay } from 'node:timers/promises'
import { FlowCoordinator, type FlowDriver } from './flow-coordinator.cjs'
import type { Workspace } from './storage/workspace.cjs'
import { StorageError } from './storage/errors.cjs'
import { UUID_PATTERN } from './storage/paths.cjs'
import { FlowCommandQueue, type FlowCommandDispatch } from './flow-command-queue.cjs'

/** Per-project queues, up to three reserved/submitted requests across projects.
 * Chrome commands are serialized, with collection priority between photo uploads.
 * A native submit ticket/click/ack remains one uninterrupted command turn. */
export class FlowScheduler {
  private readonly runners = new Map<string, FlowCoordinator>()
  private readonly commands = new FlowCommandQueue()
  private readonly reservations = new Set<string>()
  private stopping = false
  constructor(private readonly workspace: () => Promise<Workspace>, private readonly driver: (projectId: string, dispatch: FlowCommandDispatch) => FlowDriver, private readonly pollMs = 1000, private readonly maxWaitMs = 15 * 60_000) {}
  get busy() { return [...this.runners.values()].some(runner => runner.busy) }
  isBusy(projectId: string) { return !!this.runners.get(projectId)?.busy }
  private used(ws: Workspace) {
    return ws.generations.submittedCount() + [...this.reservations].filter(id => ws.generations.get(id).state !== 'submission-uncertain').length
  }
  private runner(projectId: string): FlowCoordinator {
    if (this.stopping || !UUID_PATTERN.test(projectId)) throw new StorageError('INVALID_REQUEST', 'This Flow project queue is unavailable.')
    let runner = this.runners.get(projectId)
    if (!runner) {
      const source = this.driver(projectId, this.commands.dispatch)
      const raw: FlowDriver = source.granularQueue ? source : {
        createProject: commit => this.commands.dispatch('createProject', () => source.createProject(commit)),
        nameProject: (url,name) => this.commands.dispatch('nameProject', () => source.nameProject(url,name)),
        prepare: (url,request,report) => this.commands.dispatch('prepare', () => source.prepare(url,request,report)),
        submit: url => this.commands.dispatch('submit', () => source.submit(url)),
        results: (url,prompt,kind,baseline) => this.commands.dispatch('results', () => source.results(url,prompt,kind,baseline)),
        download: (url,result,directory) => this.commands.dispatch('download', () => source.download(url,result,directory)),
        close: () => source.close?.() ?? Promise.resolve(),
      }
      const capacityAvailable = async () => this.used(await this.workspace()) < 3
      runner = new FlowCoordinator(this.workspace, {
        ...raw,
        // Deleting one project never disconnects or cancels another project.
        close: async () => { await raw.close?.() },
        capacityAvailable,
        submission: async (action, attemptId) => {
          for (;;) {
            const ws = await this.workspace()
            if (this.stopping || ws.projects.isDeleted(projectId)) throw new StorageError('INVALID_REQUEST', 'Project queue stopped before submission.')
            if (this.used(ws) < 3) {
              this.reservations.add(attemptId)
              try { await action() } finally { this.reservations.delete(attemptId) }
              return
            }
            await delay(this.pollMs)
          }
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
  resumePosts(projectId: string) { return this.runner(projectId).resumePosts(projectId) }
  async collectPending() {
    if (this.stopping) return
    const ws = await this.workspace()
    await Promise.allSettled([...new Set(ws.flow.pendingCollection().map(job => job.projectId))].map(id => this.runner(id).collectPending()))
  }
  async stopDeletedProject(projectId: string) { await this.runners.get(projectId)?.stopDeletedProject(projectId) }
  async localProjectChange<T>(operation: () => Promise<T>, projectId: string): Promise<T> {
    const runner = this.runners.get(projectId)
    if (runner) { await runner.close(); this.runners.delete(projectId) }
    return operation()
  }
  async close() { this.stopping = true; await Promise.all([...this.runners.values()].map(runner => runner.close())) }
}
