export type FlowCommandDispatch = <T>(kind: string, action: () => Promise<T>) => Promise<T>
/** One Chrome command at a time. A ready result takes the next turn before the
 * next photo upload; an in-progress command/native submit is never interrupted. */
export class FlowCommandQueue {
  private running = false
  private consecutiveCollections = 0
  private waiting: { priority: number; action: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (cause: unknown) => void }[] = []
  readonly dispatch: FlowCommandDispatch = (kind, action) => new Promise((resolve, reject) => {
    const priority = ['results','download'].includes(kind) ? 0 : kind === 'submit' ? 1 : 2
    this.waiting.push({ priority, action, resolve: value => resolve(value as Awaited<ReturnType<typeof action>>), reject })
    this.drain()
  })
  private drain() {
    if (this.running || !this.waiting.length) return
    const normal = this.waiting.filter(item => item.priority > 0)
    const priority = Math.min(...(this.consecutiveCollections >= 4 && normal.length ? normal : this.waiting).map(item => item.priority))
    const index = this.waiting.findIndex(item => item.priority === priority)
    const item = this.waiting.splice(index, 1)[0]
    this.consecutiveCollections = item.priority === 0 ? this.consecutiveCollections + 1 : 0
    this.running = true
    void Promise.resolve().then(item.action).then(item.resolve, item.reject).finally(() => { this.running = false; this.drain() })
  }
}
