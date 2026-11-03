import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, open, link, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { FlowJob, GenerationAttempt, GenerationState, LogoReview, LogoRepairArea, ProjectInfo, ProjectPreset, SceneReview } from '../contracts.cjs'
import {logoQueue} from '../media/logo-queue.cjs'
import {validateRepairArea} from '../media/logo-inpaint.cjs'
import promptBuilder = require('./prompts.cjs')
import { transaction } from './database.cjs'
import { StorageError } from './errors.cjs'
const { assemblePrompt } = promptBuilder
import { ManagedPaths, UUID_PATTERN } from './paths.cjs'
import { postPhotos } from './post-plan.mjs'
import { resultFolder, validResultPath } from './result-paths.cjs'
import { reviewRevisionPrompt } from './review-revision.mjs'

type Row = { id: string; project_id: string; scene_id: string; output_type: 'reel' | 'post'; prompt: string; references_json: string; preset: ProjectPreset; source_duration: number | null; state: GenerationState; result_path: string | null; error: string | null; created_at: string; updated_at: string; revision_json: string | null; theme_reference_json: string | null }
const activeStates = ['queued', 'paused', 'submission-uncertain']
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const videoExtensions = new Set(['.mp4', '.mov', '.webm'])
function invalid(message: string): never { throw new StorageError('INVALID_REQUEST', message) }
function fromRow(row: Row): GenerationAttempt { return { id: row.id, projectId: row.project_id, sceneId: row.scene_id, outputType: row.output_type, prompt: row.prompt, references: JSON.parse(row.references_json) as string[], preset: row.preset, sourceDuration: row.source_duration, state: row.state, resultPath: row.result_path, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at, ...(row.revision_json ? { revision: JSON.parse(row.revision_json) as NonNullable<GenerationAttempt['revision']> } : {}), ...(row.theme_reference_json ? { themeReference: JSON.parse(row.theme_reference_json) as NonNullable<GenerationAttempt['themeReference']> } : {}) } }
async function sameFile(first: string, second: string): Promise<boolean> {
  const info = await lstat(second)
  if (!info.isFile() || info.isSymbolicLink() || info.size !== (await lstat(first)).size) return false
  const hash = async (file: string) => { const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest('hex') }
  return await hash(first) === await hash(second)
}

export class Generations {
  private readonly cleaning = new Set<string>()
  private readonly logoListeners=new Set<(value:LogoReview)=>void>()
  onLogoProgress(listener:(value:LogoReview)=>void){this.logoListeners.add(listener);return()=>this.logoListeners.delete(listener)}
  recoverLogoCleanup(){
    for(const row of this.db.prepare('SELECT content FROM logo_reviews').all() as {content:string}[]){const value=JSON.parse(row.content) as LogoReview;if(value.status==='processing')this.saveLogo({...value,status:'needs-changes',phase:'failed',message:'Local cleanup was interrupted. Retry cleanup or resume the existing result in Clips.'})}
  }
  constructor(private readonly db: DatabaseSync, private readonly paths: ManagedPaths, private readonly project: (id: string) => Promise<ProjectInfo>) {}
  private row(id: string): Row {
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) invalid('The generation attempt identifier is invalid.')
    const row = this.db.prepare('SELECT * FROM generation_attempts WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new StorageError('INVALID_REQUEST', 'This generation attempt is no longer in the local workspace.')
    return row
  }
  get(id: string): GenerationAttempt { return fromRow(this.row(id)) }
  private logoInfo(attempt: GenerationAttempt): LogoReview {
    const row = this.db.prepare('SELECT content FROM logo_reviews WHERE attempt_id=?').get(attempt.id) as {content:string} | undefined
    return row ? JSON.parse(row.content) as LogoReview : {projectId:attempt.projectId,attemptId:attempt.id,status:'pending',cleanup:'not-checked',message:'Inspect this saved image, or run logo cleanup locally before approving.',checkedAt:null,updatedAt:attempt.updatedAt}
  }
  private saveLogo(value: LogoReview) {
    const saved={...value,updatedAt:new Date().toISOString()}
    this.db.prepare('INSERT INTO logo_reviews(attempt_id,project_id,content) VALUES(?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET content=excluded.content').run(saved.attemptId,saved.projectId,JSON.stringify(saved))
    for(const listener of this.logoListeners){try{listener(saved)}catch{/* A closed window does not stop local processing. */}}
    return saved
  }
  async logoReviews(projectId: string): Promise<LogoReview[]> {
    return (await this.list(projectId)).filter(a=>a.outputType==='post').map(a=>({a,logo:this.logoInfo(a)})).filter(({a,logo})=>a.state==='ready-for-review'||logo.phase!==undefined&&logo.phase!=='complete').map(({logo})=>logo)
  }
  beginLogoCleanup(id:string){const a=this.get(id);if(a.outputType!=='post')invalid('Choose a Post image.');return this.saveLogo({...this.logoInfo(a),status:'processing',phase:'queued',percent:0,runId:randomUUID(),startedAt:new Date().toISOString(),durationMs:undefined,parallelLimit:logoQueue.concurrency,checkedAt:null,message:'Queued for local logo cleanup.'})}
  logoProgress(id:string,percent:number,message:string){const a=this.get(id),previous=this.logoInfo(a);if(previous.status!=='processing')return;return this.saveLogo({...previous,percent:Math.max(previous.percent??0,Math.min(99,percent)),phase:percent===0?'queued':percent>=90?'saving':'cleaning',message})}
  failLogoCleanup(id:string,message:string){const a=this.get(id),previous=this.logoInfo(a);if(previous.status==='processing')return this.saveLogo({...previous,status:'needs-changes',phase:'failed',message})}
  recordLogoCleanup(id: string, removed: boolean): LogoReview {
    const a=this.get(id)
    if(a.outputType!=='post'||a.state!=='ready-for-review')invalid('Choose a saved Post image for logo review.')
    const previous=this.logoInfo(a),now=new Date().toISOString()
    return this.saveLogo({...previous,status:'pending',phase:'complete',percent:100,cleanupVersion:4,durationMs:previous.startedAt?Math.max(0,Date.now()-Date.parse(previous.startedAt)):undefined,cleanup:removed?'removed':'not-detected',checkedAt:now,message:removed?'Logo area cleaned locally. Inspect and approve this image.':'No matching logo detected. If one remains, click Need change in logo and select its area.'})
  }
  async reviewLogo(id: string, status: 'approved'|'needs-changes'): Promise<LogoReview> {
    const a=this.get(id);await this.project(a.projectId);await this.resultFile(id)
    const previous=this.logoInfo(a)
    if(a.outputType!=='post'||!['approved','needs-changes'].includes(status)||this.cleaning.has(id)||previous.status==='processing'||status==='approved'&&previous.phase==='failed')invalid('Wait for logo cleanup to finish before reviewing this Post image.')
    return this.saveLogo({...this.logoInfo(a),status,message:status==='approved'?'Logo result approved for this exact image version.':'Logo result needs changes. Retry logo cleanup locally, then inspect and approve.'})
  }
  async approvePost(id:string,note:string):Promise<{review:SceneReview;logo:LogoReview}>{
    if(typeof note!=='string'||note.length>2000||note.includes('\0'))invalid('Keep the description to 2,000 characters or fewer.')
    const attempt=this.get(id)
    await this.project(attempt.projectId);await this.resultFile(id)
    const current=this.get(id),logo=this.logoInfo(current)
    if(current.outputType!=='post'||current.state!=='ready-for-review'||this.cleaning.has(id)||logo.status==='processing'||logo.phase==='failed'||logo.cleanup==='not-checked'||!logo.checkedAt)invalid('Wait for local cleanup to finish before approving this image.')
    const active=this.db.prepare("SELECT id FROM generation_attempts WHERE project_id=? AND scene_id=? AND state IN ('queued','paused','submission-uncertain') LIMIT 1").get(current.projectId,current.sceneId)
    if(active)invalid('Wait for this product’s current request to finish before approving it.')
    const review:SceneReview={projectId:current.projectId,sceneId:current.sceneId,selectedAttemptId:id,status:'approved',note:note.trim(),updatedAt:new Date().toISOString()}
    let saved!:LogoReview
    transaction(this.db,()=>{
      this.db.prepare(`INSERT INTO scene_reviews(project_id,scene_id,selected_attempt_id,status,note,updated_at) VALUES(?,?,?,'approved',?,?) ON CONFLICT(project_id,scene_id) DO UPDATE SET selected_attempt_id=excluded.selected_attempt_id,status=excluded.status,note=excluded.note,updated_at=excluded.updated_at`).run(review.projectId,review.sceneId,id,review.note,review.updatedAt)
      saved=this.saveLogo({...logo,status:'approved',message:'Image approved for export.'})
    })
    return {review,logo:saved}
  }
  async retryLogo(id: string, area?:LogoRepairArea): Promise<LogoReview> {
    if(area!==undefined)try{area=validateRepairArea(area)}catch(error){invalid(error instanceof Error?error.message:'Invalid logo selection.')}
    const a=this.get(id);await this.project(a.projectId)
    if(a.outputType!=='post'||this.cleaning.has(id)||this.logoInfo(a).status==='processing')invalid('Choose a saved Post image that is not already being cleaned.')
    const source=(await this.resultFile(id)).path,target=path.join(path.dirname(source),`${id}.png`),partial=path.join(path.dirname(source),`.logo-${id}.partial`)
    if(this.cleaning.has(id)||this.logoInfo(a).status==='processing')invalid('This image is already being cleaned.')
    const active=this.db.prepare("SELECT revision_json FROM generation_attempts WHERE project_id=? AND state IN ('queued','paused','submission-uncertain') AND revision_json IS NOT NULL").all(a.projectId) as {revision_json:string}[]
    if(active.some(row=>JSON.parse(row.revision_json).sourceAttemptId===id))invalid('This image is being used by an active Flow edit. Wait for that request before changing its logo.')
    this.cleaning.add(id)
    this.beginLogoCleanup(id)
    let newTarget=false
    try {
      const cleaned=await logoQueue.run(id,{source,target:partial,retry:true,area},(percent,message)=>this.logoProgress(id,percent,message))
      if(cleaned.removed){
        this.logoProgress(id,98,'Saving the cleaned project image')
        await this.project(a.projectId)
        if(target===source)await rename(partial,target)
        else {await link(partial,target);newTarget=true;await rm(partial);this.db.prepare('UPDATE generation_attempts SET result_path=? WHERE id=?').run(path.relative(this.paths.root,target).replaceAll('\\','/'),id);newTarget=false;await rm(source).catch(()=>{})}
      }
      return this.recordLogoCleanup(id,cleaned.removed)
    } catch(error) {
      if(newTarget)await rm(target,{force:true}).catch(()=>{})
      this.failLogoCleanup(id,'Logo cleanup did not finish. The saved image is preserved; retry cleanup.')
      throw error
    } finally {this.cleaning.delete(id);await rm(partial,{force:true}).catch(()=>{})}
  }
  async revisionFile(id: string): Promise<string> {
    const attempt = this.get(id), revision = attempt.revision
    if (!revision || attempt.outputType !== 'post') invalid('This request has no image edit reference.')
    const source = this.get(revision.sourceAttemptId)
    if(this.cleaning.has(source.id)||this.logoInfo(source).status==='processing')invalid('Wait for this image logo cleanup to finish before sending it for a Flow edit.')
    if (source.projectId !== attempt.projectId || source.sceneId !== attempt.sceneId || source.outputType !== 'post' || source.state !== 'ready-for-review') invalid('The image edit reference belongs to another project/product or is unavailable.')
    return (await this.resultFile(source.id)).path
  }
  async folder(projectId: string): Promise<string> {
    const project = await this.project(projectId)
    const saved = this.db.prepare('SELECT id, result_path FROM generation_attempts WHERE project_id = ? AND result_path IS NOT NULL ORDER BY created_at LIMIT 1').get(projectId) as { id: string; result_path: string } | undefined
    const relative = saved?.result_path.startsWith('Final Projects/') && validResultPath(projectId, saved.id, saved.result_path) ? saved.result_path.split('/').slice(0, 2).join('/') : resultFolder(projectId, project.name)
    return this.paths.directory(relative)
  }
  async organizeResults(): Promise<void> {
    // Existing previews and approvals keep their IDs. Move only exact managed
    // result files; shared references and manually imported source files stay put.
    const rows = this.db.prepare("SELECT a.* FROM generation_attempts a JOIN projects p ON p.id=a.project_id WHERE a.state='ready-for-review' AND p.trashed_at IS NULL").all() as Row[]
    for (const row of rows) {
      if (!row.result_path || !validResultPath(row.project_id, row.id, row.result_path)) continue
      if (row.result_path.startsWith('projects/attempts/')) {
        const source = await this.paths.regularFile(row.result_path)
        const target = path.join(await this.folder(row.project_id), path.basename(source))
        try { await link(source, target) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !await sameFile(source, target)) throw error }
        this.db.prepare('UPDATE generation_attempts SET result_path=? WHERE id=? AND result_path=?').run(path.relative(this.paths.root, target).replaceAll('\\', '/'), row.id, row.result_path)
        await rm(source)
      } else {
        // Finish a previous move if the app closed between its DB commit and
        // unlink. Remove only an identical legacy file for this exact attempt.
        const legacy = `projects/attempts/${path.basename(row.result_path)}`
        try {
          const source = await this.paths.regularFile(legacy), target = await this.paths.regularFile(row.result_path)
          if (await sameFile(source, target)) await rm(source)
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      await this.paths.removeFlowStage(row.id)
    }
  }
  active(projectId?: string): GenerationAttempt | null {
    if (projectId !== undefined && !UUID_PATTERN.test(projectId)) invalid('Invalid project identifier.')
    const row = (projectId ? this.db.prepare("SELECT * FROM generation_attempts WHERE project_id=? AND state IN ('queued','paused','submission-uncertain') LIMIT 1").get(projectId) : this.db.prepare("SELECT * FROM generation_attempts WHERE state IN ('queued','paused','submission-uncertain') LIMIT 1").get()) as Row | undefined
    return row ? fromRow(row) : null
  }
  submittedCount(): number { return Number((this.db.prepare("SELECT COUNT(*) AS count FROM generation_attempts WHERE state='submission-uncertain'").get() as { count: number }).count) }
  // A single remote request may return several variants. Each gets its own local
  // reviewable attempt, but the root stays active until all downloads commit.
  async importVariant(parentId: string, id: string, source: string): Promise<GenerationAttempt> {
    const parent = this.row(parentId)
    if (parent.state !== 'submission-uncertain' || !UUID_PATTERN.test(id) || id === parentId) invalid('Invalid remote result association.')
    const existing = this.db.prepare('SELECT * FROM generation_attempts WHERE id = ?').get(id) as Row | undefined
    if (existing) {
      if (existing.project_id !== parent.project_id || existing.scene_id !== parent.scene_id) invalid('Result belongs to another scene.')
      if (existing.state === 'ready-for-review') return fromRow(existing)
    } else {
      const now = new Date().toISOString()
      this.db.prepare(`INSERT INTO generation_attempts(id, project_id, scene_id, output_type, prompt, references_json, preset, source_duration, state, created_at, updated_at, revision_json, theme_reference_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?)`).run(id, parent.project_id, parent.scene_id, parent.output_type, parent.prompt, parent.references_json, parent.preset, parent.source_duration, now, now, parent.revision_json, parent.theme_reference_json)
    }
    return this.copyResult(id, source, 'failed')
  }
  async list(projectId: string): Promise<GenerationAttempt[]> {
    if (!UUID_PATTERN.test(projectId)) invalid('The project identifier is invalid.')
    await this.project(projectId)
    return (this.db.prepare('SELECT * FROM generation_attempts WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Row[]).map(fromRow)
  }
  async prepare(projectId: string, sceneId: string): Promise<GenerationAttempt> {
    return this.prepareRequest(projectId, sceneId)
  }
  // Trusted coordinator only; never exposed through the renderer bridge.
  async prepareBatch(projectId: string, sceneId: string, batchId: string, parallel = false): Promise<GenerationAttempt> {
    if (!UUID_PATTERN.test(batchId)) invalid('Invalid product batch.')
    return this.prepareRequest(projectId, sceneId, batchId, parallel)
  }
  async prepareAutomatic(projectId: string, sceneId: string): Promise<GenerationAttempt> { return this.prepareRequest(projectId, sceneId, undefined, true) }
  private checkActive(projectId: string, sceneId: string, batchId?: string, parallel = false) {
    const rows = this.db.prepare(`SELECT a.project_id, a.scene_id, a.state, a.automation_scope, j.content FROM generation_attempts a LEFT JOIN flow_jobs j ON j.attempt_id = a.id WHERE a.state IN (${activeStates.map(() => '?').join(',')})`).all(...activeStates) as {project_id:string; scene_id:string; state:string; automation_scope: string | null; content:string | null}[]
    for (const row of rows) {
      if (parallel && row.project_id !== projectId && row.automation_scope === row.project_id) continue
      const job = row.content ? JSON.parse(row.content) as FlowJob : null
      if (!batchId || row.project_id !== projectId || row.scene_id === sceneId || row.state !== 'submission-uncertain' || job?.postBatch?.id !== batchId || !job.submissionAcknowledged || job.abandoned) throw new StorageError('BUSY', 'Another generation attempt is active or uncertain. Reconcile it before preparing another request.')
    }
  }
  private async prepareRequest(projectId: string, sceneId: string, batchId?: string, parallel = false): Promise<GenerationAttempt> {
    if (!UUID_PATTERN.test(projectId)) invalid('The project identifier is invalid.')
    this.checkActive(projectId, sceneId, batchId, parallel)
    const project = await this.project(projectId)
    if (batchId && project.outputType !== 'post') invalid('Only product Post requests may overlap.')
    const scene = project.outputType === 'reel' ? project.storyboard.scenes.find(item => item.id === sceneId) : undefined
    if (project.outputType === 'reel' && (!scene || !UUID_PATTERN.test(sceneId))) invalid('Choose a scene from this saved project.')
    if (scene) {
      const index = project.storyboard.scenes.findIndex(item => item.id === scene.id)
      if (index > 0 && scene.relationship === 'continue') {
        const previous = project.storyboard.scenes[index - 1]
        const review = this.db.prepare("SELECT status, selected_attempt_id FROM scene_reviews WHERE project_id = ? AND scene_id = ?").get(projectId, previous.id) as { status: string; selected_attempt_id: string | null } | undefined
        const approved = review?.status === 'approved' && !!review.selected_attempt_id && this.row(review.selected_attempt_id).state === 'ready-for-review'
        if (!approved) throw new StorageError('INVALID_REQUEST', `Approve a result for the previous scene (${previous.name}) before preparing this continuation.`)
      }
    }
    if (project.outputType === 'post' && !postPhotos(project).some(item => item.id === sceneId)) invalid('Choose a product photo from this saved project.')
    const preview = assemblePrompt(project, scene, sceneId)
    if (preview.errors.length) invalid(`Resolve the prompt before preparing this request: ${preview.errors.join(' ')}`)
    const unavailable = preview.references.filter(reference => !reference.available)
    if (unavailable.length) invalid(`Replace or restore unavailable references before preparing: ${unavailable.map(item => item.name).join(', ')}.`)
    let revision: GenerationAttempt['revision']
    if (project.outputType === 'post') {
      const review = this.db.prepare("SELECT selected_attempt_id, note FROM scene_reviews WHERE project_id=? AND scene_id=? AND status='needs-changes'").get(projectId, sceneId) as { selected_attempt_id: string | null; note: string } | undefined
      if (review?.selected_attempt_id && review.note.trim()) {
        const source = this.get(review.selected_attempt_id)
        if (source.projectId !== projectId || source.sceneId !== sceneId || source.outputType !== 'post' || source.state !== 'ready-for-review') invalid('Select a saved image from this product before applying changes.')
        await this.resultFile(source.id)
        revision = { sourceAttemptId: source.id, note: review.note.trim() }
      }
    }
    const prompt = revision ? reviewRevisionPrompt(preview.text, revision.note, revision.sourceAttemptId) : preview.text
    const id = randomUUID(), now = new Date().toISOString()
    try {
      transaction(this.db, () => {
        if(revision&&this.logoInfo(this.get(revision.sourceAttemptId)).status==='processing')invalid('Wait for logo cleanup to finish before applying image changes in Flow.')
        this.checkActive(projectId, sceneId, batchId, parallel)
        this.db.prepare(`INSERT INTO generation_attempts(id, project_id, scene_id, output_type, prompt, references_json, preset, source_duration, state, result_path, error, created_at, updated_at, automation_scope, revision_json, theme_reference_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, ?, ?, ?, ?)`).run(id, projectId, sceneId, project.outputType, prompt, JSON.stringify(preview.references.map(item => item.id)), project.preset, scene?.sourceDuration ?? null, now, now, parallel ? projectId : null, revision ? JSON.stringify(revision) : null, preview.selectedReference ? JSON.stringify(preview.selectedReference) : null)
      })
    } catch (error) {
      if (error instanceof Error && /UNIQUE/.test(error.message)) throw new StorageError('BUSY', 'Another generation attempt is active or uncertain. Reconcile it before preparing another request.')
      throw error
    }
    return this.get(id)
  }
  async reviews(projectId: string): Promise<SceneReview[]> {
    const project = await this.project(projectId)
    const rows = this.db.prepare('SELECT * FROM scene_reviews WHERE project_id = ?').all(projectId) as { project_id: string; scene_id: string; selected_attempt_id: string | null; status: SceneReview['status']; note: string; updated_at: string }[]
    const sceneIds = project.outputType === 'post' ? postPhotos(project).map(item => item.id) : project.storyboard.scenes.map(scene => scene.id)
    return rows.filter(row => sceneIds.includes(row.scene_id)).map(row => ({ projectId: row.project_id, sceneId: row.scene_id, selectedAttemptId: row.selected_attempt_id, status: row.status, note: row.note, updatedAt: row.updated_at }))
  }
  async review(projectId: string, sceneId: string, attemptId: string, status: 'pending' | 'approved' | 'needs-changes', note: string): Promise<SceneReview> {
    if (!UUID_PATTERN.test(projectId) || (sceneId !== 'post' && !UUID_PATTERN.test(sceneId)) || !UUID_PATTERN.test(attemptId) || !['pending', 'approved', 'needs-changes'].includes(status) || typeof note !== 'string' || note.length > 2000 || note.includes('\0')) invalid('The scene review is invalid.')
    const project = await this.project(projectId)
    const sceneIndex = project.storyboard.scenes.findIndex(item => item.id === sceneId)
    if (sceneIndex < 0 && !(project.outputType === 'post' && postPhotos(project).some(item => item.id === sceneId))) invalid('Choose a scene or product photo from this saved project.')
    const attempt = this.row(attemptId)
    if (attempt.project_id !== projectId || attempt.scene_id !== sceneId || attempt.state !== 'ready-for-review') invalid('Choose an imported result for this scene before reviewing it.')
    const previous = this.db.prepare('SELECT selected_attempt_id, status FROM scene_reviews WHERE project_id = ? AND scene_id = ?').get(projectId, sceneId) as { selected_attempt_id: string | null; status: string } | undefined
    const now = new Date().toISOString()
    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO scene_reviews(project_id, scene_id, selected_attempt_id, status, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, scene_id) DO UPDATE SET selected_attempt_id = excluded.selected_attempt_id, status = excluded.status, note = excluded.note, updated_at = excluded.updated_at`).run(projectId, sceneId, attemptId, status, note.trim(), now)
      const changed = previous?.selected_attempt_id !== attemptId || (previous?.status === 'approved' && status !== 'approved')
      if (changed && sceneIndex >= 0) {
        for (let index = sceneIndex + 1; index < project.storyboard.scenes.length; index++) {
          const dependent = project.storyboard.scenes[index]
          if (dependent.relationship === 'new-shot') break
          this.db.prepare(`UPDATE scene_reviews SET status = 'needs-recheck', updated_at = ? WHERE project_id = ? AND scene_id = ? AND status = 'approved'`).run(now, projectId, dependent.id)
        }
      }
    })
    return (await this.reviews(projectId)).find(item => item.sceneId === sceneId)!
  }
  async setState(id: string, state: 'paused' | 'queued' | 'submission-uncertain' | 'failed'): Promise<GenerationAttempt> {
    const current = this.row(id)
    const transitions: Record<string, string[]> = { queued: ['paused', 'submission-uncertain', 'failed'], paused: ['queued', 'failed'], 'submission-uncertain': ['failed'] }
    if (!transitions[current.state]?.includes(state)) invalid(`Cannot move an attempt from ${current.state} to ${state}.`)
    const now = new Date().toISOString()
    transaction(this.db, () => this.db.prepare('UPDATE generation_attempts SET state = ?, updated_at = ? WHERE id = ?').run(state, now, id))
    return this.get(id)
  }
  async importResult(id: string, source: string): Promise<GenerationAttempt> {
    return this.copyResult(id, source, 'submission-uncertain')
  }
  private async copyResult(id: string, source: string, expectedState: 'submission-uncertain' | 'failed'): Promise<GenerationAttempt> {
    const row = this.row(id)
    if (row.state !== expectedState) invalid('Only a submitted attempt can accept a Flow result. Reconcile the existing job before importing.')
    const extension = path.extname(source).toLowerCase()
    if (!(row.output_type === 'post' ? imageExtensions : videoExtensions).has(extension)) invalid(row.output_type === 'post' ? 'Choose a JPG, PNG, or WebP Flow image.' : 'Choose an MP4, MOV, or WebM Flow video.')
    const sourceInfo = await lstat(source)
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size < 16 || sourceInfo.size > 2_000_000_000) invalid('The result must be a regular local file under 2 GB.')
    const file = await open(source, 'r')
    const header = Buffer.alloc(16)
    try { await file.read(header, 0, header.length, 0) } finally { await file.close() }
    const validImage = extension === '.jpg' || extension === '.jpeg' ? header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff : extension === '.png' ? header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : extension === '.webp' ? header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP' : false
    const validVideo = extension === '.webm' ? header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) : ['.mp4', '.mov'].includes(extension) && header.toString('ascii', 4, 8) === 'ftyp'
    if (!(row.output_type === 'post' ? validImage : validVideo)) invalid('The selected file does not match a supported image/video container.')
    const directory = await this.folder(row.project_id)
    const target = path.join(directory, `${id}${extension}`), relative = path.relative(this.paths.root, target).replaceAll('\\', '/')
    const staging = path.join(directory, `${randomUUID()}.importing`)
    let stageCreated = false, targetCreated = false
    try {
      const stageHandle = await open(staging, 'wx')
      stageCreated = true
      await stageHandle.close()
      await copyFile(source, staging)
      try { await link(staging, target); targetCreated = true }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !await sameFile(staging, target)) throw error }
      await rm(staging)
      stageCreated = false
      const now = new Date().toISOString()
      transaction(this.db, () => {
        const project = this.db.prepare('SELECT trashed_at FROM projects WHERE id = ?').get(row.project_id) as { trashed_at: string | null } | undefined
        if (!project || project.trashed_at) invalid('Project deleted. Result import stopped.')
        const result = this.db.prepare(`UPDATE generation_attempts SET state = 'ready-for-review', result_path = ?, error = NULL, updated_at = ? WHERE id = ? AND state = ?`).run(relative, now, id, expectedState)
        if (Number(result.changes) !== 1) invalid('This request changed or was abandoned. Result import stopped.')
        if (row.revision_json) {
          const revision = JSON.parse(row.revision_json) as NonNullable<GenerationAttempt['revision']>
          // Show the revised version for review unless the user changed their
          // selection/approval/comment while this edit was in progress.
          this.db.prepare("UPDATE scene_reviews SET selected_attempt_id=?, status='pending', note='', updated_at=? WHERE project_id=? AND scene_id=? AND status='needs-changes' AND selected_attempt_id=? AND note=?").run(id, now, row.project_id, row.scene_id, revision.sourceAttemptId, revision.note)
        }
      })
    } catch (error) {
      if (stageCreated) await rm(staging, { force: true }).catch(() => undefined)
      if (targetCreated) await rm(target, { force: true }).catch(() => undefined)
      throw error
    }
    return this.get(id)
  }
  async resultFile(id: string): Promise<{ path: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4' | 'video/quicktime' | 'video/webm' }> {
    const row = this.row(id)
    if (row.state !== 'ready-for-review' || !row.result_path || !validResultPath(row.project_id, id, row.result_path)) invalid('This attempt has no playable local result.')
    const extension = path.extname(row.result_path).toLowerCase()
    const mediaType = ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' } as const)[extension]
    if (!mediaType) invalid('This attempt has an unsupported local result.')
    return { path: await this.paths.regularFile(row.result_path), mediaType }
  }
}
