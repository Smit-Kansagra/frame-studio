import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { FlowJob, FlowProject } from './contracts.cjs'
import type { Workspace } from './storage/workspace.cjs'
import type { FlowBrowser, FlowRequest } from './flow-browser.cjs'
import { StorageError,FlowNotSubmittedError } from './storage/errors.cjs'
import { isFlowProject } from './flow-urls.cjs'
import { interruptActivity, planPreparation, recordActivity, referenceLabels } from './flow-progress.cjs'
import type { FlowReporter } from './flow-progress.cjs'
import promptBuilder = require('./storage/prompts.cjs')
import { postPhotos } from './storage/post-plan.mjs'
const { assemblePrompt } = promptBuilder

export type FlowDriver = Pick<FlowBrowser, 'createProject' | 'submit' | 'results' | 'download'> & { nameProject: (url: string, name: string) => Promise<void>; prepare: (url: string, request: FlowRequest, report?: FlowReporter) => Promise<string[]>; close?: () => Promise<unknown>; exclusive?: <T>(action: () => Promise<T>) => Promise<T>; submission?: (action: () => Promise<void>, attemptId: string) => Promise<void>; capacityAvailable?: () => Promise<boolean>; granularQueue?: boolean }
const message = (error: unknown) => error instanceof StorageError ? error.message : 'The Flow browser action could not be verified. Check Chrome, then resume the existing job. It will not be submitted again.'
// Collection can safely observe the existing job again. Ambiguous associations,
// rejected formats and browser safety warnings still require attention.
const retryCollection = (detail: string) => !/ambiguous|multiple .*download|more matching|result set changed|redirected|outside the expected|unsupported|not a supported|does not match|association was lost|checking or blocking|browser warning|not expose|FFmpeg|FFprobe/i.test(detail)

/** One browser owner at a time; persistent uncertainty is recorded BEFORE any
 * remote submission. Resume only observes/downloads and can never submit. */
export class FlowCoordinator {
  private running?: Promise<void>
  private finishOperation?: () => void
  private owner?: string
  private stopping = false
  private currentOperation?: { projectId: string; cancelled: boolean; mapping?: FlowProject;batchId?:string }
  private readonly preparationRetries=new Set<string>()
  private sweeping = false
  private sweepDone?: Promise<void>
  private readonly processing = new Set<string>()
  constructor(private readonly workspace: () => Promise<Workspace>, private readonly browser: FlowDriver, private readonly pollMs = 2500, private readonly maxWaitMs = 15 * 60_000, private readonly parallelProjects = false, private readonly scopeProjectId?: string) {}
  get busy() { return !!this.owner }
  async collectPending(): Promise<void> {
    if (this.stopping || this.sweeping || (this.busy && (!this.parallelProjects || this.currentOperation?.projectId !== this.scopeProjectId))) return
    const ownsOperation = !this.busy
    if (ownsOperation) this.claim('result-collection')
    this.sweeping = true
    let finishSweep!: () => void
    this.sweepDone = new Promise<void>(resolve => { finishSweep = resolve })
    try {
      const ws = await this.workspace()
      // This runs in the desktop main process, including when the project page
      // is closed. It never prepares/uploads/creates a project or clicks Generate.
      const eligible:FlowJob[]=[]
      for (const job of ws.flow.pendingCollection()) {
        if (!this.currentOperation) break
        if (this.scopeProjectId && job.projectId !== this.scopeProjectId) continue
        if (this.processing.has(job.attemptId)) continue
        if (ws.generations.get(job.attemptId).state !== 'submission-uncertain') continue
        if (this.stopping || this.currentOperation?.cancelled) break
        if (job.nextCollectionAt && Date.parse(job.nextCollectionAt) > Date.now()) continue
        if (!retryCollection(job.message)) continue
        if(this.parallelProjects&&this.scopeProjectId)eligible.push(job)
        else {this.currentOperation!.projectId = job.projectId;await this.run(job, false, 'poll', Date.now() + this.maxWaitMs)}
      }
      if(eligible.length){this.currentOperation!.projectId=this.scopeProjectId!;await Promise.all(eligible.map(job=>this.run(job,false,'poll',Date.now()+this.maxWaitMs)))}
    } finally { this.sweeping = false; finishSweep(); this.sweepDone = undefined; if (ownsOperation) this.release() }
  }
  async stopDeletedProject(projectId: string) {
    if (this.currentOperation?.projectId !== projectId) return
    this.currentOperation.cancelled = true
    // End pending bridge calls immediately so the abandoned operation cannot
    // send its next upload or Generate command. An already-sent click cannot
    // be recalled; its durable remote association remains in the trashed job.
    await this.browser.close?.()
  }
  async localProjectChange<T>(operation: () => Promise<T>): Promise<T> {
    this.claim('local-project-change')
    try { return await operation() } finally { this.release() }
  }
  private claim(owner: string) {
    if (this.stopping || this.owner) throw new StorageError('BUSY', 'Another Flow operation is active. Wait for it to finish; no second job was submitted.')
    this.owner = owner
    this.currentOperation = { projectId: owner, cancelled: false }
    this.running = new Promise<void>(resolve => { this.finishOperation = resolve })
  }
  private release() {
    this.owner = undefined
    this.currentOperation = undefined
    this.finishOperation?.()
    this.finishOperation = undefined
    this.running = undefined
  }
  private launch(job: FlowJob, submit: boolean, ws: Workspace) {
    void this.run(job, submit).catch(error => {
      // Preserve a recoverable record even if an unexpected storage/read failure
      // escapes the normal runner. Never turn a background error into a retry.
      try { const previous = ws.flow.job(job.attemptId) ?? job; if (!previous.abandoned) ws.flow.saveJob({ ...previous, activity: interruptActivity(previous.activity, message(error)), stage: 'needs-attention', message: message(error) }) } catch { /* Restart recovery retains the durable submission state. */ }
    }).finally(() => this.release())
  }
  async linkProject(projectId: string, value: string): Promise<FlowProject> {
    const url = value.trim()
    if (!isFlowProject(url)) throw new StorageError('INVALID_REQUEST', 'Paste an HTTPS Google Flow project URL, not a homepage or login link.')
    this.claim(projectId)
    try {
      const ws = await this.workspace()
      await ws.projects.get(projectId)
      if (ws.generations.active(this.parallelProjects ? projectId : undefined)) throw new StorageError('BUSY', 'Resolve this project’s active generation before recovering its link.')
      const previous = ws.flow.project(projectId)
      if (!previous || previous.url) throw new StorageError('INVALID_REQUEST', 'Link recovery is only available after interrupted project creation. Existing project associations cannot be replaced.')
      if (ws.flow.linkedProject(url)) throw new StorageError('INVALID_REQUEST', 'That Flow project is already linked to a local project.')
      return ws.flow.saveProject({ ...previous, url, revision: 0, state: 'ready', message: 'Existing Flow project recovered. Click Generate to name it, prepare references and generate. No generation was submitted.' })
    } finally { this.release() }
  }
  private async ensureProject(ws: Workspace, projectId: string, report?: FlowReporter): Promise<FlowProject> {
    if (this.currentOperation?.mapping?.projectId === projectId) {
      report?.({ id:'project', label:'Google Flow project', state:'done', detail:'Reusing this batch’s already verified Flow project and name.' })
      return this.currentOperation.mapping
    }
    const project = await ws.projects.get(projectId)
    const previous = ws.flow.project(projectId)
    if (!previous?.url) {
      if (previous) throw new StorageError('INVALID_REQUEST', 'Flow project creation was interrupted. Do not create another automatically. Open Chrome and use Link existing Flow project with its URL to recover.')
      ws.flow.saveProject({ projectId, url: null, state: 'creating', revision: project.revision, message: 'Creating a new Flow project for this software project…' })
      report?.({ id: 'project', label: 'Google Flow project', state: 'running', detail: 'Creating a new Flow project for this local project; waiting for its unique URL.' })
      await this.browser.createProject(async url => {
        const owner = ws.flow.linkedProject(url)
        if (owner && owner !== projectId) throw new StorageError('INVALID_REQUEST', 'Chrome returned a Flow project already used by another software project. Nothing was uploaded or submitted.')
        ws.flow.saveProject({ projectId, url, state: 'ready', revision: 0, message: 'New Flow project linked. Setting its name…' })
      })
    }
    const mapping = ws.flow.project(projectId)!
    report?.({ id: 'project', label: 'Google Flow project', state: 'done', detail: 'This software project has its own saved Flow project. Regeneration reuses this link.' })
    report?.({ id: 'project-name', label: 'Flow project name', state: 'running', detail: `Setting the Flow project name to “${project.name}”.` })
    await this.browser.nameProject(mapping.url!, project.name)
    report?.({ id: 'project-name', label: 'Flow project name', state: 'done', detail: `Flow confirmed the project name “${project.name}”.` })
    const saved = ws.flow.saveProject({ ...mapping, message: `Flow project “${project.name}” is linked to this software project.` })
    if (this.currentOperation) this.currentOperation.mapping = saved
    return saved
  }
  async start(projectId: string, sceneId: string, outputs: number): Promise<FlowJob> {
    if (!Number.isInteger(outputs) || outputs < 1 || outputs > 4) throw new StorageError('INVALID_REQUEST', 'Choose between 1 and 4 results per generation.')
    const source = await this.workspace(), sourceProject = await source.projects.get(projectId)
    if (sourceProject.outputType === 'post' && !(await source.generations.list(projectId)).some(item => item.sceneId === sceneId && item.state === 'ready-for-review')) return this.startPosts(projectId)
    if(sourceProject.outputType==='post'&&(await source.generations.reviews(projectId)).some(review=>review.sceneId===sceneId&&review.status==='needs-changes'&&review.selectedAttemptId&&review.note.trim()))return this.queuePostRevision(source,projectId,sceneId)
    this.claim(projectId)
    const operation = this.currentOperation!
    try {
      const ws = await this.workspace()
      const attempt = await (this.parallelProjects ? ws.generations.prepareAutomatic(projectId, sceneId) : ws.generations.prepare(projectId, sceneId))
      if (operation.cancelled || ws.projects.isDeleted(projectId)) {
        await ws.generations.setState(attempt.id, 'failed')
        throw new StorageError('INVALID_REQUEST', 'Project deleted. The prepared request was abandoned before submission.')
      }
      const job = ws.flow.saveJob({ attemptId: attempt.id, projectId, stage: 'preparing', message: 'Request saved locally. Checking references before sending anything to Chrome.', projectUrl: '', baseline: [], resultIds: [], imported: {}, outputs, updatedAt: '', activity: recordActivity([], { id: 'local', label: 'Local request', state: 'done', detail: 'Saved the prompt snapshot and reference list. This does not mean anything is uploaded yet.' }) })
      this.launch(job, true, ws)
      return job
    } catch (error) { this.release(); throw error }
  }
  private async queuePostRevision(ws:Workspace,projectId:string,sceneId:string):Promise<FlowJob>{
    if(this.stopping||this.scopeProjectId&&projectId!==this.scopeProjectId)throw new StorageError('INVALID_REQUEST','This project queue is unavailable.')
    const attempt=await ws.generations.prepareDeferredRevision(projectId,sceneId)
    const saved=ws.flow.job(attempt.id)!
    if(!saved.editQueued)return saved
    const batchId=this.currentOperation?.projectId===projectId?this.currentOperation.batchId:undefined
    const job=ws.flow.saveJob({attemptId:attempt.id,projectId,stage:'preparing',editQueued:true,message:'Image changes queued with this exact image and description. Other products keep generating.',projectUrl:'',baseline:[],resultIds:[],imported:{},outputs:1,updatedAt:'',...(batchId?{postBatch:{id:batchId,index:1,total:1,productName:'Image changes'}}:{})})
    if(batchId)this.preparationRetries.add(attempt.id)
    else await this.drainQueuedEdits()
    return job
  }
  async drainQueuedEdits():Promise<void>{
    if(this.stopping||this.busy||this.sweeping)return
    const ws=await this.workspace()
    if(this.stopping||this.busy||this.sweeping)return
    const job=ws.flow.queuedEdits().find(item=>!this.scopeProjectId||item.projectId===this.scopeProjectId)
    if(!job)return
    this.claim(job.projectId)
    try{
      const active=ws.generations.active(job.projectId)
      if(active&&active.id!==job.attemptId&&!ws.flow.job(active.id)?.editQueued){this.release();return}
      await ws.generations.activateRevision(job.attemptId)
      this.launch(ws.flow.saveJob({...job,editQueued:false,message:'Applying queued image changes in this project.'}),true,ws)
    }catch(error){this.release();if(!(error instanceof StorageError&&error.code==='BUSY')){await ws.generations.setState(job.attemptId,'failed');ws.flow.saveJob({...job,editQueued:false,stage:'needs-attention',message:message(error)})}}
  }
  async startPosts(projectId: string): Promise<FlowJob> {
    this.claim(projectId)
    const operation = this.currentOperation!
    try {
      const ws = await this.workspace(), project = await ws.projects.get(projectId)
      if (project.outputType !== 'post') throw new StorageError('INVALID_REQUEST', 'Choose a Post project to generate product images.')
      if (ws.generations.active(this.parallelProjects ? projectId : undefined)) throw new StorageError('BUSY', 'Resolve this project’s active or uncertain request before generating remaining products.')
      const attempts = await ws.generations.list(projectId)
      const batchId = randomUUID()
      operation.batchId=batchId
      const pending = postPhotos(project).filter(photo => !attempts.some(attempt => attempt.sceneId === photo.id && attempt.state === 'ready-for-review'))
      if (!pending.length) throw new StorageError('INVALID_REQUEST', 'Every product already has a saved image. Select a product to regenerate only that image.')
      // Validate the complete queue before spending credits on its first item.
      for (const photo of pending) {
        const preview = assemblePrompt(project, undefined, photo.id)
        if (preview.errors.length || preview.references.some(item => !item.available)) throw new StorageError('INVALID_REQUEST', `${photo.name}: restore missing photos or fix the prompt before generating.`)
      }
      const prepare = async (index: number): Promise<FlowJob> => {
        if (this.stopping || operation.cancelled || ws.projects.isDeleted(projectId)) throw new StorageError('INVALID_REQUEST', 'Product queue stopped. Saved images are kept.')
        const current = await ws.projects.get(projectId)
        if (current.revision !== project.revision) throw new StorageError('INVALID_REQUEST', 'The project changed. Generate remaining images again using the saved project.')
        const photo = pending[index], attempt = await ws.generations.prepareBatch(projectId, photo.id, batchId, this.parallelProjects)
        return ws.flow.saveJob({ attemptId: attempt.id, projectId, stage: 'preparing', message: `Preparing product ${index + 1} of ${pending.length}: ${photo.product.originalName}.`, projectUrl: '', baseline: [], resultIds: [], imported: {}, outputs: 1, updatedAt: '', postBatch: { id: batchId, index: index + 1, total: pending.length, productName: photo.product.originalName } })
      }
      let job = await prepare(0)
      const first = job
      // Browser edits stay serialized. Google can work on up to three accepted
      // requests while the next product is prepared; approval is never a gate.
      void (async () => {
        let inFlight: string[] = [], blocked = false
        const collectRound = async () => {
          await Promise.all([...inFlight].map(async id => {
            if (this.stopping || operation.cancelled) return
            const current = ws.flow.job(id)!
            await this.run(current, false, 'poll')
            const saved = ws.flow.job(id)!
            if (saved.stage==='complete'||saved.stage==='needs-attention'&&(saved.collectionStopped||!saved.nextCollectionAt||/timed out|within 15 minutes/i.test(saved.message))) {
              inFlight = inFlight.filter(item => item !== id)
              if (saved.stage === 'needs-attention'&&!saved.submissionAcknowledged) blocked = true
            }
          }))
          if(!inFlight.length&&ws.flow.jobs(projectId).filter(item=>!item.abandoned&&ws.generations.get(item.attemptId).state==='submission-uncertain').length>=3)blocked=true
          if (inFlight.length && !this.stopping && !operation.cancelled) await delay(this.pollMs)
        }
        let index=0
        while(index<pending.length||this.preparationRetries.size||inFlight.length){
          while (inFlight.length && (inFlight.length >= 3 || (this.browser.capacityAvailable ? !await this.browser.capacityAvailable() : ws.generations.submittedCount()>=3)) && !this.stopping && !operation.cancelled) await collectRound()
          if (blocked || this.stopping || operation.cancelled) break
          if(index>=pending.length&&!this.preparationRetries.size){await collectRound();continue}
          const retryId=this.preparationRetries.values().next().value as string|undefined
          if(retryId){
            this.preparationRetries.delete(retryId)
            try{
              const queued=ws.flow.job(retryId)!
              if(queued.editQueued){await ws.generations.activateRevision(retryId,batchId);job=ws.flow.saveJob({...queued,editQueued:false,message:'Applying queued image changes in this project.'})}
              else job=await this.prepareRetry(ws,retryId,batchId)
            }catch(error){const saved=ws.flow.job(retryId);if(saved&&!saved.editQueued)ws.flow.saveJob({...saved,retryQueued:false,stage:'needs-attention',message:message(error)});continue}
          }else{
            if(index&&(await ws.generations.list(projectId)).some(a=>a.sceneId===pending[index].id&&a.state==='ready-for-review')){index++;continue}
            job=index?await prepare(index):first;index++
          }
          await this.run(job, true, 'submit-only')
          const submitted = ws.flow.job(job.attemptId)!
          if (submitted.stage === 'waiting' && submitted.submissionAcknowledged) inFlight.push(job.attemptId)
          else if(ws.generations.get(job.attemptId).state!=='failed'){ blocked = true; break }
        }
        while (inFlight.length && !this.stopping && !operation.cancelled) await collectRound()
      })().catch(error => {
        for (const previous of ws.flow.jobs(projectId)) {
          if (previous.postBatch?.id === batchId && previous.stage !== 'complete' && !previous.abandoned && !operation.cancelled) ws.flow.saveJob({ ...previous, stage: 'needs-attention', message: message(error), activity: interruptActivity(previous.activity, message(error)) })
        }
      }).finally(() => {this.clearQueuedRetries(ws);this.release()})
      return first
    } catch (error) { this.release(); throw error }
  }
  private clearQueuedRetries(ws:Workspace){
    for(const id of this.preparationRetries){const job=ws.flow.job(id);if(job&&!job.abandoned&&!job.editQueued)ws.flow.saveJob({...job,retryQueued:false,stage:'needs-attention',message:'Retry paused with this project queue. Click Retry generation to restart this product.'})}
    this.preparationRetries.clear()
  }
  private async prepareRetry(ws:Workspace,id:string,batchId?:string):Promise<FlowJob>{
    const job=ws.flow.job(id)!
    await ws.generations.retryPreparation(id,batchId,this.parallelProjects)
    return ws.flow.saveJob({...job,stage:'preparing',retryQueued:false,generationFailed:false,submissionAcknowledged:undefined,submissionRejected:undefined,submittedAt:undefined,collectionStopped:false,collectionFailures:0,nextCollectionAt:undefined,baseline:[],resultIds:[],imported:{},activity:[],...(batchId?{postBatch:{index:1,total:1,productName:'Retried product',...job.postBatch,id:batchId}}:{}),message:'Retrying this product: uploading its saved references and prompt again.'})
  }
  async retry(attemptId:string):Promise<FlowJob>{
    const ws=await this.workspace(),job=ws.flow.job(attemptId)
    if(!job||job.abandoned||ws.projects.isDeleted(job.projectId)||this.scopeProjectId&&job.projectId!==this.scopeProjectId)throw new StorageError('INVALID_REQUEST','This saved request is not available for retry.')
    const attempt=ws.generations.get(attemptId)
    if(attempt.state==='ready-for-review')return ws.flow.saveJob({...job,stage:'complete',message:'This image is already saved locally.'})
    if((await ws.generations.list(job.projectId)).some(a=>a.sceneId===attempt.sceneId&&a.state==='ready-for-review'&&a.createdAt>attempt.createdAt))throw new StorageError('INVALID_REQUEST','This product already has a newer saved image. Open that image in Clips.')
    if(attempt.state==='submission-uncertain'){
      if(this.busy){return ws.flow.saveJob({...job,stage:job.submissionAcknowledged?'waiting':'submitting',collectionStopped:false,nextCollectionAt:undefined,collectionFailures:0,message:'Checking this already submitted request again. Its photos will not be uploaded twice.'})}
      return this.resume(attemptId)
    }
    if(attempt.state!=='failed'||job.submissionAcknowledged&&!job.generationFailed||job.resultIds.length||job.submittedAt&&!job.submissionRejected&&!job.generationFailed)throw new StorageError('BUSY','This product already has an active or uncertain request. Check its existing status first.')
    if(this.busy&&this.currentOperation?.projectId===job.projectId&&this.currentOperation.batchId){
      this.preparationRetries.add(attemptId)
      return ws.flow.saveJob({...job,retryQueued:true,message:'Retry queued for this product. It starts after the current upload finishes; other products keep running.'})
    }
    if(this.sweeping)await this.sweepDone
    this.claim(job.projectId)
    try{const retried=await this.prepareRetry(ws,attemptId);this.launch(retried,true,ws);return retried}catch(error){this.release();throw error}
  }
  async resume(attemptId: string): Promise<FlowJob> {
    this.claim(attemptId)
    try {
      const ws = await this.workspace(), job = ws.flow.job(attemptId)
      if (!job || !job.projectUrl) throw new StorageError('INVALID_REQUEST', 'There is no submitted remote job to collect. Fix the preparation issue and start a new request.')
      if (job.abandoned || ws.projects.isDeleted(job.projectId)) throw new StorageError('INVALID_REQUEST', 'This request was abandoned when its project was deleted. It will not resume automatically.')
      this.currentOperation!.projectId = job.projectId
      const attempt = ws.generations.get(attemptId)
      if (attempt.state === 'ready-for-review') { const saved = ws.flow.saveJob({ ...job, stage: 'complete', message: 'All downloaded results are saved locally.' }); this.release(); return saved }
      if (attempt.state !== 'submission-uncertain') throw new StorageError('INVALID_REQUEST', 'This request was never submitted. Fix the reported issue, then generate again.')
      this.launch(ws.flow.saveJob({ ...job, collectionStopped: false, nextCollectionAt: undefined }), false, ws)
      return job
    } catch (error) { this.release(); throw error }
  }
  async resumePosts(projectId: string): Promise<FlowJob[]> {
    this.claim(projectId)
    try {
      const ws = await this.workspace(), project = await ws.projects.get(projectId)
      if (project.outputType !== 'post') throw new StorageError('INVALID_REQUEST', 'Choose a Post project.')
      const jobs = ws.flow.jobs(projectId).filter(job => !job.abandoned && job.projectUrl && ws.generations.get(job.attemptId).state === 'submission-uncertain')
      if (!jobs.length) throw new StorageError('INVALID_REQUEST', 'No submitted Post requests need collection.')
      const operation = this.currentOperation!
      const deadline = Date.now() + this.maxWaitMs
      for (const job of jobs) ws.flow.saveJob({ ...job, collectionStopped: false, nextCollectionAt: undefined })
      void (async () => {
        let pending = jobs.map(job => job.attemptId)
        while (pending.length && !this.stopping && !operation.cancelled) {
          for (const id of [...pending]) {
            if (this.stopping || operation.cancelled) return
            await this.run(ws.flow.job(id)!, false, 'poll', deadline)
            if (['complete','needs-attention'].includes(ws.flow.job(id)!.stage)) pending = pending.filter(item => item !== id)
          }
          if (pending.length) await delay(this.pollMs)
        }
      })().catch(error => {
        for (const original of jobs) {
          const saved = ws.flow.job(original.attemptId)
          if (saved && !saved.abandoned && saved.stage !== 'complete') ws.flow.saveJob({ ...saved, stage:'needs-attention', message:message(error) })
        }
      }).finally(() => this.release())
      return jobs
    } catch (error) { this.release(); throw error }
  }
  private async run(initial: FlowJob, submit: boolean, mode: 'full' | 'submit-only' | 'poll' = 'full', collectionDeadline?: number): Promise<void> {
    if (this.processing.has(initial.attemptId)) return
    this.processing.add(initial.attemptId)
    try { await this.runWork(initial, submit, mode, collectionDeadline) }
    finally { this.processing.delete(initial.attemptId) }
  }
  private async runWork(initial: FlowJob, submit: boolean, mode: 'full' | 'submit-only' | 'poll', collectionDeadline?: number): Promise<void> {
    const operation = this.currentOperation!
    const ws = await this.workspace()
    let job = initial
    let collecting = !submit
    const check = () => {
      if (operation.cancelled || ws.projects.isDeleted(job.projectId) || ws.flow.job(job.attemptId)?.abandoned) throw new StorageError('INVALID_REQUEST', 'Project deleted. Local Flow processing stopped.')
    }
    const update = (changes: Partial<FlowJob>) => { check(); job = ws.flow.saveJob({ ...job, ...changes }) }
    const report: FlowReporter = item => {
      const activity = recordActivity(job.activity, item)
      if (activity !== job.activity) update({ activity, ...(item.state !== 'pending' ? { message: item.detail } : {}) })
    }
    try {
      check()
      const attempt = ws.generations.get(job.attemptId)
      if (attempt.projectId !== job.projectId || (this.scopeProjectId && job.projectId !== this.scopeProjectId)) throw new StorageError('INVALID_REQUEST', 'Flow job association is ambiguous: project ownership does not match.')
      if (!submit && attempt.state === 'ready-for-review') { update({ stage: 'complete', message: 'All downloaded results are saved in Final Projects.' }); return }
      if (mode === 'poll' && job.nextCollectionAt && Date.parse(job.nextCollectionAt) > Date.now()) return
      if (submit) {
        const project = await ws.projects.get(job.projectId)
        const sceneIndex = project.storyboard.scenes.findIndex(item => item.id === attempt.sceneId)
        const continuation = sceneIndex > 0 && project.storyboard.scenes[sceneIndex].relationship === 'continue'
        report({ id: 'project', label: 'Google Flow project', state: 'pending', detail: 'Not opened or created yet for this request.' })
        const labels = referenceLabels(project, attempt.references)
        if (attempt.themeReference) {
          const index = attempt.references.indexOf(attempt.themeReference.assetId)
          if (index >= 0) labels[index] = `Theme reference: ${attempt.themeReference.name}`
        }
        if (attempt.revision) labels.push('Image to edit: selected saved result')
        planPreparation(labels, continuation, report)
        report({ id: 'submit', label: 'Submit generation', state: 'pending', detail: 'Generate has not been clicked for this attempt.' })
        report({ id: 'results', label: 'Flow results', state: 'pending', detail: 'No results collected for this attempt.' })
        report({ id: 'local', label: 'Local request', state: 'running', detail: 'Resolving saved reference files and any approved continuation frame.' })
        const startFrame = continuation ? await ws.exports.continuationFrame(project.id, project.storyboard.scenes[sceneIndex - 1].id) : undefined
        const files = await Promise.all(attempt.references.map(id => ws.mediaFile(id, 'original')))
        if (attempt.revision) files.push(await ws.generations.revisionFile(attempt.id))
        report({ id: 'local', label: 'Local request', state: 'done', detail: `${files.length} saved reference file(s) resolved locally. Upload confirmation is shown separately below.` })
        const submitOnce = async () => {
          check()
          if (this.browser.submission) report({ id: 'browser-queue', label: 'Project browser queue', state: 'done', detail: 'This project is working in its own tab. Other projects upload independently; completed results receive priority within this tab.' })
          if (this.stopping) throw new StorageError('BUSY', 'Frame Studio is closing. This request was not submitted.')
          const mapping = await this.ensureProject(ws, job.projectId, report)
          update({ projectUrl: mapping.url! })
          const baseline = await this.browser.prepare(job.projectUrl, { ...attempt, files, startFrame, referenceLabels: labels, outputs: job.outputs }, report)
          check()
          if (this.stopping) throw new StorageError('BUSY', 'Frame Studio is closing. This request was not submitted.')
          // A crash between this commit and the click leaves uncertainty, not a retry.
          await ws.generations.setState(attempt.id, 'submission-uncertain')
          check()
          update({ baseline, submittedAt: new Date().toISOString(), stage: 'submitting', message: 'Submitting once in Flow. A lost connection will not trigger another submission.' })
          report({ id: 'submit', label: 'Submit generation', state: 'running', detail: 'Asking Chrome to click Generate once. A lost acknowledgement leaves submission uncertain; it is never retried automatically.' })
          await this.browser.submit(job.projectUrl)
          update({ submissionAcknowledged: true })
          report({ id: 'submit', label: 'Submit generation', state: 'done', detail: 'Flow acknowledged submission through its cleared prompt, new generation card, or generation progress. Completion is confirmed only when matching results are collected.' })
        }
        if (this.browser.submission) {
          report({ id: 'browser-queue', label: 'Project browser queue', state: 'running', detail: 'Preparing this project in its own tab. Other project tabs upload and collect results independently.' })
          await this.browser.submission(submitOnce, attempt.id)
        }
        else await submitOnce()
      }
      collecting = true
      if (!job.submissionAcknowledged) report({ id: 'submit', label: 'Submit generation', state: 'uncertain', detail: 'The older click log does not confirm Flow accepted this request. Resume checks existing results only; it has not clicked Generate.' })
      update({ stage: job.submissionAcknowledged ? 'waiting' : 'submitting', message: job.submissionAcknowledged ? 'Waiting for matching Flow results. You can stay in Frame Studio.' : 'Submission is unconfirmed. Checking once for existing results; Resume does not click Generate.' })
      report({ id: 'results', label: 'Flow results', state: 'running', detail: submit ? 'Checking Flow for results matching this prompt. No new generation will be submitted automatically.' : 'Automatically collecting the existing request. No new Generate click and no repeat uploads.' })
      if (mode === 'submit-only') return
      const deadline = Date.now() + this.maxWaitMs
      while (!this.stopping && Date.now() < deadline) {
        if (this.scopeProjectId && ws.flow.project(job.projectId)?.url !== job.projectUrl) throw new StorageError('INVALID_REQUEST', 'Flow job association is ambiguous: the saved project URL changed.')
        const results = await (this.browser.exclusive ? this.browser.exclusive(() => this.browser.results(job.projectUrl, attempt.prompt, attempt.outputType, job.baseline)) : this.browser.results(job.projectUrl, attempt.prompt, attempt.outputType, job.baseline))
        check()
        if (!job.submissionAcknowledged) {
          if (results.length) update({ submissionAcknowledged: true, stage: 'waiting', message: 'Matching Flow results confirm this existing request started. Collecting without another Generate click.' })
        }
        if (results.length > job.outputs) throw new StorageError('INVALID_REQUEST', 'More matching results appeared than requested. Remote association is ambiguous; inspect Flow before collecting.')
        if (results.length === job.outputs) {
          if (job.activity?.find(item => item.id === 'submit')?.state === 'uncertain') report({ id: 'submit', label: 'Submit generation', state: 'done', detail: 'Matching new Flow results were observed during collection. No extra Generate click was made.' })
          report({ id: 'results', label: 'Flow results', state: 'done', detail: `${results.length}/${job.outputs} matching result cards confirmed in Flow.` })
          // Persist every remote ID and its local UUID before downloading any file.
          if (!job.resultIds.length) update({ resultIds: results.map(item => item.id), imported: Object.fromEntries(results.map((item, index) => [item.id, index === results.length - 1 ? attempt.id : randomUUID()])) })
          if (results.some(item => !job.resultIds.includes(item.id))) throw new StorageError('INVALID_REQUEST', 'The matching Flow result set changed. Existing downloads are preserved; inspect the remote job.')
          update({ stage: 'downloading', message: `Saving ${results.length} Flow result(s) into this project…` })
          for (const id of job.resultIds) {
            const number = job.resultIds.indexOf(id) + 1
            const downloadId = `download-${number}`, label = `Save result ${number} of ${job.outputs}`
            const localId = job.imported[id]
            const existing = (await ws.generations.list(job.projectId)).find(item => item.id === localId)
            if (existing?.state === 'ready-for-review') { report({ id: downloadId, label, state: 'done', detail: 'This result is already saved locally; no duplicate download needed.' }); continue }
            report({ id: downloadId, label, state: 'running', detail: 'Downloading from the matched Flow result and importing into this project.' })
            const result = results.find(item => item.id === id)!
            const directory = await ws.paths.directory(`temp/flow/${localId}`)
            const file = await (this.browser.exclusive ? this.browser.exclusive(() => this.browser.download(job.projectUrl, result, directory)) : this.browser.download(job.projectUrl, result, directory))
            check()
            report({ id: downloadId, label, state: 'running', detail: 'Download complete. Checking the visible Gemini logo locally before applying theme dimensions.' })
            let logoRemoved = false
            const progressId=existing?.id??attempt.id
            if(attempt.outputType==='post')ws.generations.beginLogoCleanup(progressId)
            const normalized = await ws.exports.normalizeFlowResult(attempt.preset, file, localId, (detail,removed) => {logoRemoved=removed;report({ id: downloadId, label, state: 'running', detail })},(percent,detail)=>{check();ws.generations.logoProgress(progressId,percent,detail)})
            check()
            if (localId === attempt.id) await ws.generations.importResult(attempt.id, normalized)
            else await ws.generations.importVariant(attempt.id, localId, normalized)
            if(attempt.outputType==='post')ws.generations.recordLogoCleanup(localId,logoRemoved)
            // The final project file is the same file used by the app preview.
            // Originals/normalized temporary files are no longer needed after commit.
            await ws.paths.removeFlowStage(localId).catch(() => {})
            report({ id: downloadId, label, state: 'done', detail: 'Saved locally at the theme aspect ratio. Automatic crop/resize applied where needed; ready for review.' })
          }
          update({ stage: 'complete', collectionStopped: false, nextCollectionAt: undefined, collectionFailures: 0, message: `${job.outputs} result(s) saved in Final Projects. Approve a result or Regenerate; previous versions are kept.` })
          return
        }
        report({ id: 'results', label: 'Flow results', state: 'running', detail: `${results.length}/${job.outputs} matching results found. Checking again automatically; no new generation is submitted.` })
        if (mode === 'poll') {
          const limit = collectionDeadline ?? (job.submittedAt ? Date.parse(job.submittedAt) + this.maxWaitMs : deadline)
          if (Date.now() > limit) throw new StorageError('INVALID_REQUEST', 'Flow result collection timed out. Resume pending results to check the same submitted requests without generating again.')
          return
        }
        await delay(this.pollMs)
      }
      throw new StorageError('INVALID_REQUEST', this.stopping ? 'Frame Studio closed while Flow may still be working. Resume collection after reopening; do not submit again.' : 'Flow results could not be fully matched within 15 minutes. Resume collection to check the same job without spending more credits.')
    } catch (error) {
      if (operation.cancelled || ws.projects.isDeleted(job.projectId) || ws.flow.job(job.attemptId)?.abandoned) return
      const current = ws.generations.get(job.attemptId)
      if(current.outputType==='post')ws.generations.failLogoCleanup(current.id,message(error))
      if (current.state === 'queued') await ws.generations.setState(current.id, 'failed')
      const detail = error instanceof Error ? error.message : message(error)
      const rejected=!job.submissionAcknowledged&&/^Flow rejected submission:/.test(detail)
      const generationFailed=collecting&&/^Flow generation failed:/.test(detail)
      const notSubmitted=error instanceof FlowNotSubmittedError
      if((rejected||notSubmitted||generationFailed)&&current.state==='submission-uncertain')await ws.generations.setState(current.id,'failed')
      const retry = !notSubmitted&&!rejected&&!generationFailed&&collecting && current.state === 'submission-uncertain' && retryCollection(detail) && !this.stopping
      const failures = (job.collectionFailures ?? 0) + 1
      const retryMs = /result information panel|result prompt is not available/i.test(detail) ? Math.min(2000, this.pollMs) : Math.min(60_000, this.pollMs * 2 ** Math.min(failures, 5))
      update({ stage: retry && failures < 3 && !/timed out|within 15 minutes|disconnected|connection ended|Pair the companion/i.test(detail) ? 'waiting' : 'needs-attention',generationFailed:generationFailed||job.generationFailed,...(generationFailed?{submissionAcknowledged:true}:{}),submissionRejected:rejected||job.submissionRejected,...(notSubmitted?{submittedAt:undefined}:{}), collectionStopped: collecting ? !retry : undefined, collectionFailures: failures, nextCollectionAt: retry ? new Date(Date.now() + retryMs).toISOString() : undefined, message: retry ? `Automatic collection will retry this existing result. No new generation will be submitted. ${detail}` : message(error), activity: retry ? job.activity : interruptActivity(job.activity, message(error)) })
    }
  }
  async close() { this.stopping = true; await this.running; await this.sweepDone }
}
