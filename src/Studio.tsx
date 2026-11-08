import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { AppResult, CharacterInfo, ProductInfo, ProductTrashInfo, ProjectDraft, ProjectInfo, ProjectPreset, ProjectScene, ProjectStoryboard, ThemeInfo } from '../electron/contracts.cjs'
import { Dialog, Photo } from './Products'
import { Icon } from './icons'
import { FlowActivityPanel } from './FlowActivity'
import { DeleteProjectButton, DeletedProjects } from './ProjectDelete'
import { assemblePrompt } from '../electron/storage/prompt-core.mjs'
import { presetForTheme } from '../electron/storage/output-policy.mjs'
import { postPhotos } from '../electron/storage/post-plan.mjs'
import { reviewRevisionPrompt } from '../electron/storage/review-revision.mjs'
import { ReferencePromptPreview } from './ReferenceInstructions'
import {useLogoCleanup} from './useLogoCleanup'
import {LogoRepairDialog} from './LogoRepairDialog'

type Guards = { onDirty: (value: boolean) => void; onBusy: (value: boolean) => void }
type Step = 'Setup' | 'Storyboard' | 'Clips' | 'Export'
const presets: { id: ProjectPreset; label: string; size: string; type: 'post' | 'reel' }[] = [
  { id: 'reel-vertical', label: 'Vertical reel', size: '1080 × 1920', type: 'reel' },
  { id: 'reel-landscape', label: 'Landscape video', size: '1920 × 1080', type: 'reel' },
  { id: 'post-square', label: 'Square post', size: '1080 × 1080', type: 'post' },
  { id: 'post-portrait', label: 'Portrait post', size: '1080 × 1350', type: 'post' },
  { id: 'post-tall', label: 'Tall post', size: '1080 × 1440', type: 'post' },
  { id: 'post-landscape', label: 'Landscape post', size: '1080 × 566', type: 'post' },
  { id: 'post-story', label: 'Story image', size: '1080 × 1920', type: 'post' },
]
const empty = (): ProjectDraft => ({ name: '', productId: '', themeId: '', characterId: null, outputType: 'reel', preset: 'reel-vertical', duration: 20 })
const unwrap = <T,>(result: AppResult<T>): T => { if (!result.ok) throw new Error(result.error.message); return result.value }
const message = (cause: unknown) => cause instanceof Error ? cause.message : 'The project could not be loaded. Please retry.'
const primary = (item: ProductInfo | CharacterInfo) => item.photos.find(photo => photo.id === item.primaryAssetId) ?? item.photos[0]
const copyStoryboard = (theme: ThemeInfo): ProjectStoryboard => ({ scenes: theme.scenes.map(({ duration, ...scene }) => ({ ...scene, sourceDuration: duration, editDuration: duration })), compositionPrompt: theme.compositionPrompt })
const draftOf = (project: ProjectInfo): ProjectDraft => ({ name: project.name, productId: project.productId, themeId: project.themeId, characterId: project.characterId, outputType: project.outputType, preset: project.preset, duration: project.duration, storyboard: project.storyboard })
const placeholders = ['product_name', 'product_description', 'product_notes', 'scene_number', 'scene_prompt', 'aspect_ratio', 'target_duration']

export function Studio({ route, onDirty, onBusy }: { route: string } & Guards) {
  const segment = route.replace(/^#/, '').split('/')[1]
  return segment ? <ProjectEditor key={segment} id={segment === 'new' ? undefined : segment} onDirty={onDirty} onBusy={onBusy} /> : <StudioHome onBusy={onBusy} />
}

function StudioHome({ onBusy }: { onBusy: Guards['onBusy'] }) {
  const api = window.frameStudio?.projects ? window.frameStudio : undefined
  const [items, setItems] = useState<ProjectInfo[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [projectJobs, setProjectJobs] = useState<Record<string, import('../electron/contracts.cjs').FlowJob[]>>({})
  const [retry, setRetry] = useState(0)
  useEffect(() => { onBusy(false); let active = true; if (!api) { setLoading(false); return }
    setLoading(true); setError('')
    void api.projects.list().then(result => { if (active) setItems(unwrap(result)) }).catch(cause => { if (active) setError(message(cause)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [api, retry, onBusy])
  const projectIds = items.map(item => item.id).join(',')
  useEffect(() => {
    if (!api?.flow || !projectIds) return
    let current = true
    const refresh = () => void Promise.all(projectIds.split(',').map(async id => { const result = await api.flow.jobs(id); return [id, result.ok ? result.value : []] as const })).then(entries => { if (current) setProjectJobs(Object.fromEntries(entries)) }).catch(() => {})
    refresh(); const timer = window.setInterval(refresh, 2000)
    return () => { current = false; window.clearInterval(timer) }
  }, [api, projectIds])
  return <>
    <section className="projects-section" aria-labelledby="projects-title"><div className="section-heading"><div className="heading-with-count"><h2 id="projects-title">Your projects</h2>{!loading && !error && <span className="count">{items.length}</span>}</div><span className="muted small">Local drafts</span></div>
      {!api ? <div className="empty-panel project-empty"><h3>Projects live in the desktop app</h3><p>Open Frame Studio to create and resume local projects.</p><span className="neutral-badge">Desktop app required</span></div> : loading ? <div className="product-message" role="status">Loading projects…</div> : error ? <div className="product-message product-error" role="alert">{error}<button className="button button-secondary" onClick={() => setRetry(n => n + 1)}>Retry</button></div> : !items.length ? <div className="project-empty empty-panel"><span className="project-empty-symbol"><Icon name="studio" size={42} /></span><h3>Your next story starts here</h3><p>Bring together a saved product, a compatible theme, and an optional character.</p><a className="button button-primary" href="#studio/new"><Icon name="plus" size={18} />New project</a></div> : <div className="project-grid">
        {items.map(project => { const photo = primary(project.snapshot.product), jobs = projectJobs[project.id] ?? [], pending = jobs.filter(job => !job.abandoned && job.stage !== 'complete'), savedCount = jobs.filter(job => job.stage === 'complete').length; return <article className="project-card" key={project.id}>
          <a className="project-card-photo" href={`#studio/${project.id}`} aria-label={`Resume ${project.name}`}>{photo && <Photo photo={photo} name={project.snapshot.product.name} />}</a>
          <div className="project-card-body"><span className="eyebrow">{project.outputType.toUpperCase()} · DRAFT</span><h3>{project.name}</h3><p>{project.snapshot.product.name} · {project.snapshot.theme.name}</p>{!!jobs.length && <p role="status">{savedCount} saved request{savedCount === 1 ? '' : 's'} · {pending.length ? `${pending.length} pending — ${pending[0].stage.replaceAll('-', ' ')}` : 'Results saved'}</p>}<div className="project-card-meta"><span>{presets.find(item => item.id === project.preset)?.size}</span><span>Edited {new Date(project.updatedAt).toLocaleDateString()}</span></div><div className="project-card-actions"><a className="button button-secondary" href={`#studio/${project.id}`}>Resume draft <Icon name="arrow" size={15} /></a><DeleteProjectButton project={project} onBusy={onBusy} onDeleted={() => setRetry(n => n + 1)} /></div></div>
        </article> })}
        <a className="project-new-tile" href="#studio/new"><Icon name="plus" size={24} /><strong>New project</strong><span>Start another story</span></a>
      </div>}
      <DeletedProjects revision={retry} onBusy={onBusy} onRestored={() => setRetry(n => n + 1)} />
    </section>
    <section className="library-section" aria-labelledby="library-title"><div className="section-heading"><h2 id="library-title">Make room for your ideas</h2><span className="muted small">Your creative library</span></div><div className="library-links">{(['themes', 'characters'] as const).map(page => <a className="library-link" href={`#${page}`} key={page}><span className={`library-icon library-icon-${page}`}><Icon name={page === 'themes' ? 'theme' : 'character'} size={23} /></span><span className="library-link-copy"><strong>{page[0].toUpperCase() + page.slice(1)}</strong><span>{page === 'themes' ? 'Your reusable creative directions' : 'Your familiar faces and references'}</span></span><Icon name="chevron" size={16} /></a>)}</div></section>
  </>
}

function PromptField({ label, value, onChange, rows = 4 }: { label: string; value: string; onChange: (value: string) => void; rows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  function insert(token: string) {
    const field = ref.current
    if (!field) return
    const start = field.selectionStart, end = field.selectionEnd, next = `${value.slice(0, start)}{{${token}}}${value.slice(end)}`
    onChange(next)
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(start + token.length + 4, start + token.length + 4) })
  }
  return <div className="story-prompt-field"><label>{label}<textarea ref={ref} rows={rows} maxLength={20000} value={value} onChange={event => onChange(event.target.value)} /></label><details className="placeholder-menu"><summary><Icon name="plus" size={14} /> Insert placeholder</summary><div>{placeholders.map(token => <button type="button" key={token} onClick={() => insert(token)}><code>{`{{${token}}}`}</code><span>{token.replaceAll('_', ' ')}</span></button>)}</div></details></div>
}

function GenerationPanel({ project: initialProject, scene: initialScene, prompt: _prompt, onGoExport }: { project: ProjectInfo; scene?: ProjectScene; prompt: string; onGoExport: () => void }) {
  const api = window.frameStudio
  const [project, setProject] = useState(initialProject)
  const [attempts, setAttempts] = useState<import('../electron/contracts.cjs').GenerationAttempt[]>([])
  const [reviews, setReviews] = useState<import('../electron/contracts.cjs').SceneReview[]>([])
  const [exportPlan, setExportPlan] = useState<import('../electron/contracts.cjs').ExportPlan | null>(null)
  const [selectedSceneId, setSelectedSceneId] = useState(initialScene?.id ?? (project.outputType === 'post' ? 'post' : project.storyboard.scenes[0]?.id ?? ''))
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [flowState, setFlowState] = useState('not-connected')
  const [flowJob, setFlowJob] = useState<import('../electron/contracts.cjs').FlowJob | null>(null)
  const [flowJobs, setFlowJobs] = useState<import('../electron/contracts.cjs').FlowJob[]>([])
  const [flowProject, setFlowProject] = useState<import('../electron/contracts.cjs').FlowProject | null>(null)
  const [blockingRequest, setBlockingRequest] = useState<import('../electron/contracts.cjs').FlowActiveRequest | null>(null)
  const [requestChecking, setRequestChecking] = useState(false), [requestError, setRequestError] = useState('')
  const [outputs, setOutputs] = useState(1)
  const [recoveryUrl, setRecoveryUrl] = useState('')
  const [promptPreviewOpen,setPromptPreviewOpen]=useState(false)
  const submitting=useRef(false)
  const [correctedPrompt, setCorrectedPrompt] = useState(initialScene?.prompt ?? '')
  const [compareAttemptId, setCompareAttemptId] = useState('')
  const [selectedVersionId, setSelectedVersionId] = useState('')
  const [markAttempt,setMarkAttempt]=useState<string>()
  const [changingProducts,setChangingProducts]=useState(new Set<string>())
  const [retrying,setRetrying]=useState(new Set<string>())
  const retryLocks=useRef(new Set<string>())
  const approvingAll=useRef(false)
  const cleanup=useLogoCleanup(project.id,project.outputType==='post',attempts,selectedVersionId)
  const [reviewDrafts,setReviewDrafts] = useState(()=>new Map<string,string>())
  const swipeStart = useRef<number | null>(null)
  const playerRef = useRef<HTMLVideoElement>(null)
  const scene = project.outputType === 'reel' ? project.storyboard.scenes.find(item => item.id === selectedSceneId) : undefined
  const postPlan = postPhotos(project)
  const selectedPost = postPlan.find(item => item.id === selectedSceneId) ?? postPlan[0]
  const sceneId = scene?.id ?? selectedPost?.id ?? 'post'
  const basePreview = assemblePrompt(project, scene, sceneId)
  const pendingPosts = postPlan.filter(photo => !attempts.some(attempt => attempt.sceneId === photo.id && attempt.state === 'ready-for-review'))
  const flowApi = api?.flow
  const active = attempts.find(item => ['queued', 'paused', 'submission-uncertain'].includes(item.state))
  const sceneActive = attempts.find(item => item.sceneId === sceneId && ['queued','paused','submission-uncertain'].includes(item.state))
  const selectedFlowJob = flowJobs.find(job => attempts.find(item => item.id === job.attemptId)?.sceneId === sceneId) ?? flowJob
  const collecting = flowJobs.filter(job => !job.abandoned && attempts.some(item => item.id === job.attemptId && item.state === 'submission-uncertain'))
  const sceneAttempts = attempts.filter(item => item.sceneId === sceneId && item.state === 'ready-for-review')
  const sceneReview = reviews.find(item => item.sceneId === sceneId)
  const reviewedAttempt=sceneAttempts.find(item=>item.id===sceneReview?.selectedAttemptId)
  const preferredAttempt=sceneReview&&sceneAttempts[0]&&sceneReview.updatedAt>=sceneAttempts[0].createdAt?reviewedAttempt??sceneAttempts[0]:sceneAttempts[0]
  const selectedAttempt = sceneAttempts.find(item => item.id === selectedVersionId) ?? preferredAttempt
  const currentAttemptId=useRef<string|undefined>(undefined)
  currentAttemptId.current=selectedAttempt?.id
  const selectedLogo=cleanup.logos.find(l=>l.attemptId===selectedAttempt?.id)
  const imageReady=project.outputType==='reel'||cleanup.ready(selectedAttempt)
  const reviewDraftKey = `${sceneId}:${selectedAttempt?.id ?? ''}`
  const reviewNote=reviewDrafts.get(reviewDraftKey) ?? (sceneReview?.selectedAttemptId===selectedAttempt?.id?sceneReview?.note??'':'')
  const setReviewNote=(value:string)=>setReviewDrafts(previous=>new Map(previous).set(reviewDraftKey,value))
  const reviewableProducts = postPlan.filter(photo => attempts.some(attempt => attempt.sceneId === photo.id && attempt.state === 'ready-for-review'))
  const bulkApprovals=postPlan.flatMap(photo=>{
    const latest=attempts.find(a=>a.sceneId===photo.id),review=reviews.find(r=>r.sceneId===photo.id)
    if(!latest||latest.state!=='ready-for-review'||attempts.some(a=>a.sceneId===photo.id&&['queued','paused','submission-uncertain'].includes(a.state)))return []
    const chosen=review&&review.updatedAt>=latest.createdAt?attempts.find(a=>a.id===review.selectedAttemptId)??latest:latest
    const logo=cleanup.logos.find(l=>l.attemptId===chosen.id)
    if(!cleanup.ready(chosen)||logo?.phase==='failed'||review?.selectedAttemptId===chosen.id&&review.status==='approved'&&logo?.status==='approved')return []
    return [{attemptId:chosen.id,note:reviewDrafts.get(`${photo.id}:${chosen.id}`)??(review?.selectedAttemptId===chosen.id?review.note:'')}]
  })
  const reviewProductIndex = reviewableProducts.findIndex(photo => photo.id === sceneId)
  const editNote = reviewNote.trim()
  const editSelectedImage = project.outputType === 'post' && !!selectedAttempt && !!editNote && (sceneReview?.status === 'needs-changes' || editNote !== (sceneReview?.note ?? '').trim())
  const preview = editSelectedImage ? { ...basePreview, text: reviewRevisionPrompt(basePreview.text, editNote, selectedAttempt!.id), references: [...basePreview.references, { id: selectedAttempt!.id, name: 'Selected generated image to edit', thumbnailUrl: `frame-media://attempt/${selectedAttempt!.id}`, available: true }] } : basePreview
  const comparisonAttempt = sceneAttempts.find(item => item.id === compareAttemptId && item.id !== selectedAttempt?.id&&(project.outputType==='reel'||cleanup.ready(item)))
  const attemptReferences = sceneActive ? sceneActive.references.map(id => {
    const photo = [...project.snapshot.product.photos, ...project.snapshot.theme.images, ...(project.snapshot.character?.photos ?? [])].find(item => item.id === id)
    return photo ? { id, name: photo.originalName } : { id, name: 'Missing saved reference' }
  }).concat(sceneActive.revision ? [{ id: sceneActive.revision.sourceAttemptId, name: 'Selected generated image to edit' }] : []) : preview.references.map(item => ({ id: item.id, name: item.name }))
  const refresh = () => {
    if (!api?.generations) return
    void Promise.all([api.generations.list(project.id), api.generations.reviews(project.id)]).then(([result, reviewResult]) => { if (result.ok) setAttempts(result.value); else setError(result.error.message); if (reviewResult.ok) setReviews(reviewResult.value); else setError(reviewResult.error.message) }).catch(() => setError('Could not refresh local generation attempts.'))
    void flowApi?.status().then(status => setFlowState(status.state)).catch(() => setFlowState('needs-attention'))
    void flowApi?.job(project.id).then(result => { if (result.ok) setFlowJob(result.value) }).catch(() => setError('Could not refresh Flow activity. Displayed confirmations may be out of date.'))
    void flowApi?.jobs(project.id).then(result => { if (result.ok) setFlowJobs(result.value) }).catch(() => setError('Could not refresh product request statuses.'))
    void flowApi?.project(project.id).then(result => { if (result.ok) setFlowProject(result.value) }).catch(() => setError('Could not refresh Flow project sync status.'))
    void flowApi?.activeRequest(project.id).then(result => { if (result.ok) setBlockingRequest(result.value) }).catch(() => setError('Could not check for a blocking request.'))
  }
  useEffect(() => { refresh(); const timer = window.setInterval(refresh, 1000); return () => window.clearInterval(timer) }, [project.id])
  useEffect(() => { setSelectedVersionId('') }, [sceneId, sceneReview?.selectedAttemptId])
  const exportSignature = `${attempts.map(item => `${item.id}:${item.state}`).join(',')}|${reviews.map(item => `${item.sceneId}:${item.selectedAttemptId}:${item.status}`).join(',')}`
  useEffect(() => { void window.frameStudio?.exports?.inspect(project.id).then(result => { if (result.ok) setExportPlan(result.value) }) }, [project.id, exportSignature])
  const run = async <T,>(operation: () => Promise<import('../electron/contracts.cjs').AppResult<T>>, successMessage?: string): Promise<T | null> => {
    setBusy(true); setError(''); setNotice(''); setRequestError('')
    try { const result = await operation(); if (!result.ok) throw new Error(result.error.message); if (successMessage) setNotice(successMessage); else if (result.value && typeof result.value === 'object' && 'state' in result.value) setNotice(`Attempt ${String(result.value.state).replaceAll('-', ' ')} and saved locally.`); refresh(); return result.value }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The generation action failed.'); return null }
    finally { setBusy(false) }
  }
  const setState = (id: string, state: 'paused' | 'queued' | 'submission-uncertain' | 'failed') => run(() => api!.generations.setState(id, state))
  const importResult = () => run(() => api!.generations.importResult(sceneActive!.id))
  const retryGeneration=async(id:string)=>{
    if(!flowApi||retryLocks.current.has(id))return
    retryLocks.current.add(id);setRetrying(previous=>new Set(previous).add(id))
    try{const value=await run(()=>flowApi.retry(id));if(value)setFlowJobs(previous=>[value,...previous.filter(job=>job.attemptId!==id)])}
    finally{retryLocks.current.delete(id);setRetrying(previous=>{const next=new Set(previous);next.delete(id);return next})}
  }
  const saveReview = (status: 'pending' | 'approved' | 'needs-changes') => selectedAttempt && run(async () => {
    const result=await api!.generations.review(project.id,selectedAttempt.sceneId,selectedAttempt.id,status,reviewNote)
    if(result.ok){setReviews(previous=>[...previous.filter(item=>item.sceneId!==result.value.sceneId),result.value]);setReviewDrafts(previous=>{if(previous.get(reviewDraftKey)!==reviewNote)return previous;const next=new Map(previous);next.delete(reviewDraftKey);return next})}
    return result
  })
  const selectProduct = (id: string) => { setSelectedSceneId(id); setSelectedVersionId(''); setCompareAttemptId('') }
  const navigateReview = (offset: number) => { const next = reviewableProducts[reviewProductIndex + offset]; if(next)selectProduct(next.id) }
  const automaticRunning = !!active && flowJobs.some(job => !['complete','needs-attention'].includes(job.stage))
  const persistChanges = async (force=false) => {
    if (project.outputType === 'post' && selectedAttempt && (force||editSelectedImage || sceneReview?.status === 'needs-changes')) {
      const review=unwrap(await api!.generations.review(project.id, sceneId, selectedAttempt.id, 'needs-changes', editNote))
      setReviews(previous=>[...previous.filter(item=>item.sceneId!==review.sceneId),review])
    }
  }
  const generate = (kind:'posts'|'single'|'changes'='single') => {
    if(submitting.current)return
    const forceEdit=kind==='changes'
    if(forceEdit&&!editNote){setError('Describe the image changes first.');return}
    const batch = kind === 'posts'
    submitting.current=true
    if(forceEdit)setChangingProducts(previous=>new Set(previous).add(sceneId))
    setRequestChecking(true); setRequestError('')
    void run(async () => {
      try {
        if (!batch) await persistChanges(forceEdit)
        const result = batch ? await flowApi!.generatePosts(project.id) : await flowApi!.generate(project.id, sceneId, project.outputType === 'post' ? 1 : outputs)
        if (!result.ok) setRequestError(result.error.message)
        return result
      } catch (cause) {
        setRequestError('The app did not confirm whether this request started. Refresh its saved status before retrying; do not submit twice.')
        throw cause
      }
    }, 'Request accepted.').then(value => { if (value) {setFlowJob(value);if(value.editQueued)setNotice('Image changes queued. Other products keep generating.')} refresh() }).finally(() => {submitting.current=false;setRequestChecking(false);setChangingProducts(previous=>{const next=new Set(previous);next.delete(sceneId);return next})})
  }
  const approveImage=()=>{
    if(!selectedAttempt)return
    void run(async()=>{
      const result=await api!.generations.approvePost(selectedAttempt.id,reviewNote)
      if(result.ok){cleanup.merge([result.value.logo]);setReviews(previous=>[...previous.filter(r=>r.sceneId!==result.value.review.sceneId),result.value.review]);setReviewDrafts(previous=>{if(previous.get(reviewDraftKey)!==reviewNote)return previous;const next=new Map(previous);next.delete(reviewDraftKey);return next})}
      return result
    },'Image approved.')
  }
  const approveAll=async()=>{
    if(approvingAll.current||!bulkApprovals.length)return
    approvingAll.current=true
    try{
      const result=await run(()=>api!.generations.approveAll(project.id,bulkApprovals))
      if(result){
        cleanup.merge(result.logos)
        setReviews(previous=>[...previous.filter(r=>!result.reviews.some(item=>item.sceneId===r.sceneId)),...result.reviews])
        setReviewDrafts(previous=>{const next=new Map(previous);for(const review of result.reviews){const key=`${review.sceneId}:${review.selectedAttemptId}`;if(next.get(key)===review.note)next.delete(key)}return next})
        setNotice(`${result.approved} image${result.approved===1?'':'s'} approved.${result.skipped?` ${result.skipped} changed or unfinished image${result.skipped===1?'':'s'} skipped.`:''}`)
      }
    }finally{approvingAll.current=false}
  }
  const repairLogo=async(id:string)=>{
    if(cleanup.logos.find(l=>l.attemptId===id)?.cleanup==='not-detected'){setMarkAttempt(id);return}
    try{const result=await cleanup.retry(id);if(result?.cleanup==='not-detected'&&currentAttemptId.current===id)setMarkAttempt(id)}catch{/* The cleanup hook displays the saved error. */}
  }
  const extractFrame = () => {
    const video = playerRef.current
    if (!video || !video.videoWidth || !video.videoHeight) { setError('Load and pause the selected clip on a frame before extracting it.'); return }
    try {
      const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight
      canvas.getContext('2d')!.drawImage(video, 0, 0)
      canvas.toBlob(blob => { if (!blob) { setError('This frame could not be extracted.'); return }; const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = `frame-studio-${selectedAttempt?.id ?? 'frame'}-frame.png`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 30000); setNotice('Frame saved as a PNG. Attach it manually only if Flow exposes a suitable reference control.') }, 'image/png')
    } catch { setError('Frame extraction is unavailable for this media source. The original clip remains unchanged.') }
  }
  const saveCorrection = () => {
    if (!scene || correctedPrompt.trim() === scene.prompt) return
    const storyboard = { ...project.storyboard, scenes: project.storyboard.scenes.map(item => item.id === scene.id ? { ...item, prompt: correctedPrompt } : item) }
    void run(() => api!.projects.save({ id: project.id, expectedRevision: project.revision, name: project.name, productId: project.productId, themeId: project.themeId, characterId: project.characterId, outputType: project.outputType, preset: project.preset, duration: project.duration, storyboard }), 'Prompt correction saved. The previous attempts are preserved; prepare a new attempt when ready.')
      .then(value => { if (value && typeof value === 'object' && 'storyboard' in value) { setProject(value as ProjectInfo); setCorrectedPrompt((value as ProjectInfo).storyboard.scenes.find(item => item.id === scene.id)?.prompt ?? correctedPrompt) } })
  }
  const statusLabel = (state: string, attemptId?: string) => {
    const job = flowJobs.find(item => item.attemptId === attemptId)
    if (state === 'submission-uncertain' && job?.submissionAcknowledged) {
      if (job.stage === 'needs-attention') return 'Result needs attention'
      if (job.stage === 'downloading') return 'Saving result'
      return 'Collecting Flow result'
    }
    return state === 'submission-uncertain' ? 'Submission uncertain' : state === 'ready-for-review' ? 'Ready for review' : state === 'needs-changes' ? 'Needs changes' : state === 'needs-recheck' ? 'Needs recheck' : state[0].toUpperCase() + state.slice(1)
  }
  return <section className="generation-panel">
    <section className="flow-automation-panel" aria-label="Automatic Flow generation">
      <div className="scene-preview-heading"><h4>{project.outputType === 'post' ? 'Generate Post images' : 'Generate this Reel scene'}</h4><span className="neutral-badge">{flowState === 'connected' ? 'Chrome connected' : 'Chrome needs connection'}</span></div>


      {flowProject && !flowProject.url && <div className="flow-link-recovery">
        <label>Existing Flow project URL<input type="url" value={recoveryUrl} maxLength={2048} onChange={event => setRecoveryUrl(event.target.value)} placeholder="Paste the project link from Chrome" /></label>
        <p className="muted small">Use only if project creation was interrupted. Linking recovers the existing project without creating or generating another one.</p>
        <button className="button button-secondary" disabled={busy || automaticRunning || !!active || !recoveryUrl.trim()} onClick={() => void run(() => flowApi!.linkProject(project.id, recoveryUrl)).then(value => { if (value) { setFlowProject(value); setRecoveryUrl('') } })}>Link existing Flow project</button>
      </div>}
      <div className="generation-controls">
        {flowState!=='connected'&&<button className="button button-secondary" disabled={busy || automaticRunning} onClick={() => { window.location.hash = '#settings' }}>Connect Flow companion</button>}
        <button className="button button-secondary" onClick={() => void run(() => flowApi!.openResultsFolder(project.id))}>Open final project folder</button>
        {project.outputType==='post'&&<button type="button" className="button button-secondary" disabled={busy||!bulkApprovals.length} onClick={()=>void approveAll()}>Approve all{bulkApprovals.length?` (${bulkApprovals.length})`:''}</button>}
        {project.outputType === 'reel' && <label>Results per generation<select aria-label="Results per generation" value={outputs} disabled={busy || !!active} onChange={event => setOutputs(Number(event.target.value))}>{[1, 2, 3, 4].map(value => <option value={value} key={value}>{value}</option>)}</select></label>}
        {project.outputType === 'post' && pendingPosts.length > 0 && <button className="button button-primary" disabled={busy || !!active || automaticRunning} onClick={()=>generate('posts')}>Generate {pendingPosts.length} {pendingPosts.length === postPlan.length ? 'product' : 'remaining'} image{pendingPosts.length === 1 ? '' : 's'}</button>}
        {project.outputType === 'reel' && <button className="button button-primary" disabled={busy||!!active||automaticRunning||!!preview.errors.length||preview.references.some(reference=>!reference.available)||!scene} onClick={()=>generate('single')}>{sceneAttempts.length?'Regenerate':'Generate scene'}</button>}
      </div>
      {project.outputType === 'post' && <p>{postPlan.length - pendingPosts.length} / {postPlan.length} products have saved images · {collecting.length} requests pending. </p>}

      {flowJob?.postBatch && <p role="status"><strong>Product {flowJob.postBatch.index} of {flowJob.postBatch.total}</strong> · {flowJob.postBatch.productName}</p>}
      {project.outputType === 'post' && collecting.length > 0 && !automaticRunning && <button className="button button-secondary" disabled={busy} onClick={() => void run(() => flowApi!.resumePosts(project.id), 'Collecting existing requests only; no new generation submitted.')}>Resume all pending results</button>}
      <details className="clip-prompt-details" onToggle={event=>setPromptPreviewOpen(event.currentTarget.open)}><summary>References and prompts</summary>{promptPreviewOpen&&(project.outputType==='post'&&pendingPosts.length?pendingPosts.map(item=>{const mapped=assemblePrompt(project,undefined,item.id);return <ReferencePromptPreview key={item.id} selected={mapped.selectedReference} images={project.snapshot.theme.images} prompt={mapped.text} productName={item.name}/>}):<ReferencePromptPreview selected={preview.selectedReference} images={project.snapshot.theme.images} prompt={preview.text} productName={selectedPost?.name}/>)}</details>
      <details className="clip-flow-details" open={!!requestError}><summary>Flow activity</summary><FlowActivityPanel job={selectedFlowJob} mapping={flowProject} checking={requestChecking} requestError={requestError} blocked={blockingRequest} projectId={project.id} connected={flowState === 'connected'} /></details>
      {selectedFlowJob && <div className={`flow-job-status state-${selectedFlowJob.stage}`} role="status"><strong>{selectedFlowJob.stage.replaceAll('-', ' ')}</strong><p>{selectedFlowJob.message}</p>{selectedFlowJob.stage==='needs-attention'&&<button className="button button-primary" disabled={retrying.has(selectedFlowJob.attemptId)||selectedFlowJob.retryQueued} onClick={()=>void retryGeneration(selectedFlowJob.attemptId)}>{selectedFlowJob.retryQueued?'Retry queued':attempts.find(a=>a.id===selectedFlowJob.attemptId)?.state==='failed'?'Retry generation':'Check existing result'}</button>}</div>}
      
    </section>
    {project.outputType === 'post' && <div className="review-scene-strip post-photo-strip" aria-label="Product image review">{postPlan.map(item => {
      const versions=attempts.filter(a=>a.sceneId===item.id&&a.state==='ready-for-review'),review=reviews.find(r=>r.sceneId===item.id)
      const latest=versions[0],chosen=review&&latest&&review.updatedAt>=latest.createdAt?versions.find(a=>a.id===review.selectedAttemptId)??latest:latest
      const logo=cleanup.logos.find(l=>l.attemptId===chosen?.id)
      const running=changingProducts.has(item.id)||attempts.some(a=>a.sceneId===item.id&&(['queued','paused','submission-uncertain'].includes(a.state)||cleanup.processing(a.id)))
      const latestAttempt=attempts.find(a=>a.sceneId===item.id)
      const failedJob=flowJobs.find(job=>!job.abandoned&&job.stage==='needs-attention'&&job.attemptId===latestAttempt?.id)
      const changes=running||!!failedJob||logo?.phase==='failed'||logo?.status==='needs-changes'||review?.selectedAttemptId===chosen?.id&&review?.status==='needs-changes'
      const approved=!changes&&review?.status==='approved'&&review.selectedAttemptId===chosen?.id&&logo?.status==='approved'&&cleanup.ready(chosen)
      const status=changes?'changing':approved?'approved':'pending',label=changes?'Changes in progress':approved?'Approved':'Awaiting review'
      return <div key={item.id} className="product-review-item"><button type="button" className={`review-scene-card product-review-card status-${status} ${sceneId===item.id?'selected':''}`} aria-label={`Product ${item.index+1}, ${label}`} aria-pressed={sceneId===item.id} onClick={()=>selectProduct(item.id)}><strong>Product {item.index+1}</strong><span className="product-review-line" aria-hidden="true"/></button>{failedJob&&<button type="button" className="product-retry-button" aria-label={`Retry Product ${item.index+1}`} title={failedJob.retryQueued?'Retry queued':attempts.find(a=>a.id===failedJob.attemptId)?.state==='failed'?'Retry generation':'Check existing result'} disabled={retrying.has(failedJob.attemptId)||failedJob.retryQueued} onClick={()=>void retryGeneration(failedJob.attemptId)}><Icon name="refresh" size={15}/></button>}</div>
    })}</div>}
    {project.outputType === 'reel' && <div className="review-scene-strip" aria-label="Scene review strip">{project.storyboard.scenes.map((item, index) => { const count = attempts.filter(attempt => attempt.sceneId === item.id).length, state = reviews.find(review => review.sceneId === item.id)?.status ?? (count ? 'pending' : 'not-started'); return <button type="button" key={item.id} className={`review-scene-card ${selectedSceneId === item.id ? 'selected' : ''}`} aria-pressed={selectedSceneId === item.id} onClick={() => { setSelectedSceneId(item.id); setCorrectedPrompt(item.prompt) }}><span>Scene {index + 1}</span><strong>{item.name}</strong><small>{count} attempt{count === 1 ? '' : 's'} · {state.replaceAll('-', ' ')}</small></button> })}</div>}
    {project.outputType === 'reel' && <label className="generation-scene-select">Scene to prepare<select value={selectedSceneId} onChange={event => { const next = project.storyboard.scenes.find(item => item.id === event.target.value); setSelectedSceneId(event.target.value); setCorrectedPrompt(next?.prompt ?? '') }}>{project.storyboard.scenes.map((item, index) => <option key={item.id} value={item.id}>Scene {index + 1}: {item.name} · source {item.sourceDuration}s</option>)}</select></label>}
    {selectedAttempt && <section className="clip-review-player">
      <div className="scene-preview-heading"><h4>{project.outputType === 'post' ? `Product ${(selectedPost?.index ?? 0) + 1}` : 'Selected clip'} · attempt {sceneAttempts.findIndex(item => item.id === selectedAttempt.id) + 1}</h4>{sceneAttempts.length > 1 && <label>Compare attempt<select value={compareAttemptId} onChange={event => setCompareAttemptId(event.target.value)}><option value="">Choose another attempt</option>{sceneAttempts.filter(item => item.id !== selectedAttempt.id).map(item => <option value={item.id} key={item.id}>Attempt {sceneAttempts.indexOf(item) + 1}</option>)}</select></label>}</div>
      {sceneAttempts.length > 1 && <label className="review-version-select">Review version<select aria-label="Review version" value={selectedAttempt.id} onChange={event => { setSelectedVersionId(event.target.value); setCompareAttemptId('') }}>{sceneAttempts.map((item,index) => <option value={item.id} key={item.id}>Version {sceneAttempts.length-index}{item.id === sceneReview?.selectedAttemptId ? ' · selected' : ''}</option>)}</select></label>}
      {imageReady?<><div className={project.outputType === 'post' ? 'review-media-carousel' : undefined} tabIndex={project.outputType === 'post' ? 0 : undefined} role={project.outputType === 'post' ? 'group' : undefined} aria-label={project.outputType === 'post' ? 'Product image viewer' : undefined} onKeyDown={event => { if(project.outputType !== 'post')return; if(event.key === 'ArrowLeft'){event.preventDefault();navigateReview(-1)} if(event.key === 'ArrowRight'){event.preventDefault();navigateReview(1)} }} onTouchStart={event => { swipeStart.current = event.touches.length === 1 ? event.touches[0].clientX : null }} onTouchEnd={event => { if(project.outputType === 'post' && swipeStart.current !== null && event.changedTouches.length){const distance=event.changedTouches[0].clientX-swipeStart.current;if(Math.abs(distance)>50)navigateReview(distance<0?1:-1)}swipeStart.current=null }}>
      {project.outputType === 'post' && <button type="button" className="review-nav-arrow review-nav-previous" aria-label="Previous product image" disabled={reviewProductIndex<=0} onClick={() => navigateReview(-1)}><Icon name="chevron" size={26} /></button>}
      <div className={comparisonAttempt ? 'clip-comparison' : 'clip-primary-player'}>
        {project.outputType === 'post' ? <img key={`${selectedAttempt.id}:${selectedLogo?.updatedAt??''}`} src={`frame-media://attempt/${selectedAttempt.id}`} alt="Selected imported Flow image" /> : <video ref={playerRef} src={`frame-media://attempt/${selectedAttempt.id}`} controls preload="metadata" aria-label="Selected imported Flow clip" />}
        {comparisonAttempt && (comparisonAttempt.outputType === 'post' ? <img src={`frame-media://attempt/${comparisonAttempt.id}`} alt="Comparison imported Flow image" /> : <video src={`frame-media://attempt/${comparisonAttempt.id}`} controls preload="metadata" aria-label="Comparison imported Flow clip" />)}
      </div>
      {project.outputType === 'post' && <button type="button" className="review-nav-arrow" aria-label="Next product image" disabled={reviewProductIndex<0 || reviewProductIndex>=reviewableProducts.length-1} onClick={() => navigateReview(1)}><Icon name="chevron" size={26} /></button>}
      </div>
      {project.outputType === 'post' && <p className="review-position" aria-live="polite">{reviewProductIndex+1} / {reviewableProducts.length} generated products</p>}
      {project.outputType === 'reel' && <button type="button" className="button button-secondary button-small" onClick={extractFrame}>Extract paused frame as PNG</button>}
      <div className="review-actions clip-review-actions"><label className="clip-description">Description<textarea aria-label="Review notes" maxLength={2000} placeholder="Describe the changes you want" value={reviewNote} onChange={event=>setReviewNote(event.target.value)}/></label><div className="clip-review-buttons">{project.outputType==='post'?<>
        <button type="button" className="button button-primary" disabled={busy||!!sceneActive} onClick={approveImage}>Approve</button>
        <button type="button" className="button button-secondary" disabled={busy||!!sceneActive||!editNote} onClick={()=>generate('changes')}>{selectedFlowJob?.editQueued?'Changes queued':'Change image'}</button>
        <button type="button" className="button button-secondary" disabled={busy||!!sceneActive} onClick={()=>void repairLogo(selectedAttempt.id)}>Need change in logo</button>
      </>:<><button type="button" className="button button-primary" disabled={busy} onClick={()=>void saveReview('approved')}>Approve selected attempt</button><button type="button" className="button button-secondary" disabled={busy} onClick={()=>void saveReview('needs-changes')}>Needs changes</button></>}</div></div>
      {project.outputType==='reel'&&sceneReview?.selectedAttemptId === selectedAttempt.id && <span className={`generation-state state-${sceneReview.status}`}>{sceneReview.status.replaceAll('-', ' ')}</span>}
      {scene && <><label className="review-correction">Prompt correction for the next attempt<textarea maxLength={20000} value={correctedPrompt} onChange={event => setCorrectedPrompt(event.target.value)} /></label><button type="button" className="button button-secondary button-small" disabled={busy || correctedPrompt.trim() === scene.prompt} onClick={saveCorrection}>Save prompt correction</button></>}
      </>:<div className="clip-cleanup-placeholder" role="status"><strong>{selectedLogo?.phase==='failed'?'Logo repair needs attention':'Cleaning image locally'}</strong><span>{selectedLogo?.percent??0}%</span><progress max={100} value={Math.min(99,selectedLogo?.percent??0)} aria-label="Selected product cleanup progress"/>{selectedLogo?.phase==='failed'&&<><p>{selectedLogo.message}</p><button type="button" className="button button-secondary" onClick={()=>void cleanup.retry(selectedAttempt.id).catch(()=>{})}>Retry logo repair</button></>}</div>}
    </section>}
    {preview.errors.length > 0 && <div className="prompt-validation-error" role="alert">{preview.errors.map(issue => <p key={issue}>{issue}</p>)}</div>}
    {preview.warnings.map(warning => <div className="prompt-validation-warning" key={warning}>{warning}</div>)}

    <details className="generation-reference-list"><summary>Reference files</summary>{attemptReferences.length ? <ul>{attemptReferences.map(reference => <li key={reference.id}>{reference.name}</li>)}</ul> : <p>No project references were found.</p>}</details>
    <details className="flow-manual-fallback"><summary>Manual fallback / reconcile an old request</summary><p>Use only if automatic generation cannot continue. An uncertain request may already have used credits.</p>
    <div className="generation-controls">
      {!sceneActive ? <button className="button button-primary" disabled={busy || !!active || automaticRunning || !!preview.errors.length || preview.references.some(reference => !reference.available) || (project.outputType === 'reel' && !scene)} onClick={() => run(async () => { await persistChanges(); return api!.generations.prepare(project.id, sceneId) })}>Prepare generation request</button> : <>
        <span className={`generation-state state-${sceneActive.state}`}>{statusLabel(sceneActive.state, sceneActive.id)}</span>
        {sceneActive.state === 'queued' && <><button className="button button-primary" disabled={busy} onClick={() => void run(async () => { const marked = await api!.generations.setState(sceneActive.id, 'submission-uncertain'); if (marked.ok && flowApi) { const status = await flowApi.open(); setFlowState(status.state) } return marked })}>Continue in Flow (reconcile before retry)</button><button className="button button-secondary" disabled={busy} onClick={() => setState(sceneActive.id, 'paused')}>Pause request</button><button className="button button-secondary" disabled={busy} onClick={() => setState(sceneActive.id, 'failed')}>Discard before opening Flow</button></>}
        {sceneActive.state === 'paused' && <><button className="button button-secondary" disabled={busy} onClick={() => void flowApi?.open().then(status => setFlowState(status.state))}>Open Flow</button><button className="button button-primary" disabled={busy} onClick={() => setState(sceneActive.id, 'queued')}>Resume request</button><button className="button button-secondary" disabled={busy} onClick={() => setState(sceneActive.id, 'failed')}>Discard before submission</button></>}
        {sceneActive.state === 'submission-uncertain' && <><button className="button button-secondary" disabled={busy} onClick={() => void flowApi?.show().then(status => setFlowState(status.state))}>Inspect Flow before any retry</button><button className="button button-primary" disabled={busy} onClick={() => void importResult()}>Import downloaded result</button><button className="button button-secondary" disabled={busy} onClick={() => setState(sceneActive.id, 'failed')}>I confirmed no job exists</button></>}
      </>}
      {flowState === 'offline' && <span className="generation-offline">Offline · queued work is kept locally.</span>}
    </div>
    </details>
    {project.outputType === 'reel' && <div className="clips-combine-entry"><div><strong>Offline finish</strong><span>{exportPlan?.canExport ? 'All scenes are approved and local media tools are ready. Set trims and order in Export.' : exportPlan?.reasons[0] ?? 'Checking approved clips and local media tools…'}</span></div><button type="button" className="button button-primary" disabled={!exportPlan?.canExport || busy} onClick={onGoExport}>Combine approved clips</button></div>}
    {error && <p className="product-message product-error" role="alert">{error}</p>}{notice && <p className="product-notice" role="status">{notice}</p>}
    {cleanup.error&&<p className="product-message product-error" role="alert">{cleanup.error}</p>}
    {markAttempt&&<LogoRepairDialog attemptId={markAttempt} onClose={()=>setMarkAttempt(undefined)} onRepair={area=>{const id=markAttempt;setMarkAttempt(undefined);void cleanup.retry(id,area).catch(()=>{})}}/>}

  </section>
}

function ExportPanel({ project, onBack }: { project: ProjectInfo; onBack: () => void }) {
  const api = window.frameStudio?.exports ? window.frameStudio : undefined
  const [plan, setPlan] = useState<import('../electron/contracts.cjs').ExportPlan | null>(null)
  const [postSceneId, setPostSceneId] = useState('post')
  const [order, setOrder] = useState<string[]>([]), [trims, setTrims] = useState<Record<string, { inPoint: number; outPoint: number }>>({})
  const fit = 'crop' as const
  const [muteAll, setMuteAll] = useState(false)
  const [progress, setProgress] = useState<import('../electron/contracts.cjs').ExportProgress | null>(null)
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState(''), [latest, setLatest] = useState<import('../electron/contracts.cjs').ExportRecord | null>(null)
  const [batchResult,setBatchResult]=useState<import('../electron/contracts.cjs').PostBatchExport|null>(null)
  const refresh = async () => {
    if (!api) { setLoading(false); setError('Export requires the Frame Studio desktop app.'); return }
    setLoading(true); setError('')
    try {
      const response = await api.exports.inspect(project.id)
      if (!response.ok) throw new Error(response.error.message)
      setPlan(response.value); setLatest(response.value.lastExport)
      if (!order.length) setOrder(response.value.scenes.map(scene => scene.sceneId))
      setTrims(previous => Object.fromEntries(response.value.scenes.map(scene => [scene.sceneId, previous[scene.sceneId] ?? { inPoint: 0, outPoint: scene.duration ?? 0 }])))
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Export readiness could not be checked.') }
    finally { setLoading(false) }
  }
  useEffect(() => { void refresh() }, [project.id])
  useEffect(() => api?.exports.onProgress(value => { if (value.projectId === project.id) setProgress(value) }), [api, project.id])
  const total = order.reduce((sum, id) => { const trim = trims[id]; return sum + (trim ? trim.outPoint - trim.inPoint : 0) }, 0)
  const trimError = project.outputType === 'reel' && plan?.targetDuration != null && Math.abs(total - plan.targetDuration) > 1 / 30 ? `Selected trims total ${total.toFixed(2)}s; match the ${plan.targetDuration}s target within one 30 fps frame.` : ''
  const start = async () => {
    if (!api || !plan || (project.outputType==='post'?singleReasons:reasons).length) return
    setBusy(true); setError(''); setNotice('')
    try {
      const settings: import('../electron/contracts.cjs').ExportSettings = { order: project.outputType === 'reel' ? order : [], trims: project.outputType === 'reel' ? order.map(sceneId => ({ sceneId, ...trims[sceneId] })) : [], fit, muteAll, ...(project.outputType === 'post' ? { postSceneId } : {}) }
      const result = await api.exports.start(project.id, settings)
      if (!result.ok) throw new Error(result.error.message)
      if (!result.value) { setNotice('Export was cancelled in the Save dialog.'); return }
      setLatest(result.value); setNotice(project.outputType === 'reel' ? `MP4 export validated · ${result.value.width} × ${result.value.height} · ${result.value.duration?.toFixed(2)}s.` : `Image export saved · ${result.value.width} × ${result.value.height}.`)
      await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The local export failed. Original media has been preserved.') }
    finally { setBusy(false); setProgress(null) }
  }
  const startAll=async()=>{
    if(!api||busy||!readyPosts.length)return
    setBusy(true);setError('');setNotice('')
    try{
      const result=await api.exports.startPostBatch(project.id)
      if(!result.ok)throw Error(result.error.message)
      if(!result.value){setNotice('Export cancelled.');return}
      setBatchResult(result.value);setLatest(result.value.files.at(-1)??null)
      setNotice(`${result.value.files.length} images saved together as Image 1.png, Image 2.png…`)
      await refresh()
    }catch(cause){setError(cause instanceof Error?cause.message:'Bulk image export failed.')}
    finally{setBusy(false);setProgress(null)}
  }
  const cancel = async () => { if (!api) return; const result = await api.exports.cancel(project.id); if (!result.ok) setError(result.error.message); else setNotice('Cancel requested. Cleaning up the partial export.') }
  const updateTrim = (sceneId: string, key: 'inPoint' | 'outPoint', value: number) => setTrims(previous => ({ ...previous, [sceneId]: { ...previous[sceneId], [key]: value } }))
  const move = async (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= order.length || !plan) return
    const next = [...order]; [next[index], next[target]] = [next[target], next[index]]
    const movedContinuations = next.filter((id, position) => {
      const scene = project.storyboard.scenes.find(item => item.id === id)
      return scene?.relationship === 'continue' && project.storyboard.scenes.findIndex(item => item.id === id) !== position
    })
    if (movedContinuations.length) {
      if (!window.confirm('Reordering a continuation changes which previous scene it follows. Mark those scene reviews for recheck?')) return
      for (const sceneId of movedContinuations) {
        const selected = plan.scenes.find(item => item.sceneId === sceneId)?.attemptId
        if (selected) { const result = await window.frameStudio!.generations.review(project.id, sceneId, selected, 'pending', 'Sequence reordered for export; confirm visual continuity again.'); if (!result.ok) { setError(result.error.message); return } }
      }
      setNotice('Continuity review reset for the reordered scene(s). Re-approve them in Clips before exporting.')
      await refresh()
    }
    setOrder(next)
  }
  const selectedPost = plan?.scenes.find(scene => scene.sceneId === postSceneId)
  const readyPosts=plan?.scenes.filter(scene=>scene.reviewStatus==='approved'&&scene.logoReviewStatus==='approved'&&scene.attemptId&&!scene.issue&&scene.width)??[]
  const singleReasons=selectedPost?.reviewStatus==='approved'&&selectedPost.logoReviewStatus==='approved'&&selectedPost.attemptId&&!selectedPost.issue&&selectedPost.width?[]:[selectedPost?.issue??'Approve the selected image in Clips first.']
  const reasons = project.outputType === 'post'
    ? readyPosts.length ? [] : ['Approve images in Clips before exporting.']
    : [...(plan?.reasons ?? []), ...(trimError ? [trimError] : [])]
  return <section className="export-panel">
    <div className="generation-heading"><span className="eyebrow">STEP 4 OF 4 · LOCAL EXPORT</span><h3>{project.outputType === 'reel' ? 'Combine approved clips' : 'Export your Post images'}</h3><p>{project.outputType==='post'?'Save all approved images together. Choose a folder once; images are named Image 1.png, Image 2.png… in product order.':'Rendering stays on this computer. Flow is not contacted. Source attempts are preserved.'}</p></div>
    {loading && <p className="product-message" role="status">Checking local files, review decisions, media tools, and export readiness…</p>}
    {!loading && plan && <><div className="generation-safety-note"><strong>{project.outputType === 'reel' ? plan.toolMessage : 'Post image export works offline without FFmpeg.'}</strong><span>Output: {plan.width} × {plan.height}{project.outputType === 'reel' ? ` · target ${plan.targetDuration}s · 30 fps` : ''}. {plan.upscaledSources ? '1080p export — contains upscaled sources.' : ''}</span></div>
      {project.outputType === 'reel' ? <><div className="export-fit"><span>Theme dimensions · automatic crop</span><label className="export-mute"><input type="checkbox" checked={muteAll} onChange={event => setMuteAll(event.target.checked)} />Mute all source audio</label><strong>Trim total: {total.toFixed(2)}s / {plan.targetDuration}s</strong></div>
        <ol className="export-scene-list">{order.map((sceneId, index) => { const scene = plan.scenes.find(item => item.sceneId === sceneId)!; const trim = trims[sceneId] ?? { inPoint: 0, outPoint: scene.duration ?? 0 }; const originalIndex = project.storyboard.scenes.findIndex(item => item.id === sceneId); return <li key={sceneId}><div className="generation-attempt-head"><strong>{index + 1}. {scene.name}</strong><span className={`generation-state state-${scene.reviewStatus}`}>{scene.reviewStatus.replaceAll('-', ' ')}</span></div>{scene.duration == null ? <p>{scene.issue ?? 'Clip metadata unavailable. Install FFmpeg/FFprobe to inspect this source.'}</p> : <><p>{scene.width} × {scene.height} · {scene.duration.toFixed(2)}s · {scene.hasAudio ? 'audio' : 'silent audio will be added'}</p><div className="export-trim-fields"><label>In (s)<input type="number" min="0" max={scene.duration} step="0.01" value={trim.inPoint} onChange={event => updateTrim(sceneId, 'inPoint', event.target.valueAsNumber)} /></label><label>Out (s)<input type="number" min="0" max={scene.duration} step="0.01" value={trim.outPoint} onChange={event => updateTrim(sceneId, 'outPoint', event.target.valueAsNumber)} /></label><span>{Math.max(0, trim.outPoint - trim.inPoint).toFixed(2)}s included</span></div></>}<div className="scene-order-actions"><button type="button" aria-label={`Move ${scene.name} earlier`} disabled={index === 0 || busy} onClick={() => void move(index, -1)}>↑</button><button type="button" aria-label={`Move ${scene.name} later`} disabled={index === order.length - 1 || busy} onClick={() => void move(index, 1)}>↓</button></div>{originalIndex !== index && <small>Order changed · review continuity before export.</small>}</li> })}</ol></> : <div className="export-fit"><span>Theme dimensions · automatic crop</span><p>No video combine action is available for Post projects.</p></div>}
      {project.outputType === 'post' && <><p>{readyPosts.length} / {plan.scenes.length} images ready for bulk export. Images awaiting either approval are skipped.</p><details><summary>Export just one image</summary><label className="generation-scene-select">Product image to export<select value={postSceneId} disabled={busy} onChange={event => setPostSceneId(event.target.value)}>{plan.scenes.map(scene => <option value={scene.sceneId} key={scene.sceneId}>{scene.name} · {scene.reviewStatus.replaceAll('-', ' ')} · logo {scene.logoReviewStatus??'pending'}</option>)}</select></label><button type="button" className="button button-secondary" disabled={busy||singleReasons.length>0} onClick={()=>void start()}>Export selected image</button></details></>}
      {reasons.length > 0 && <div className="prompt-validation-warning" role="status"><strong>Export unavailable:</strong> {reasons.join(' ')}</div>}
      {progress && <div className="export-progress" role="status"><span>{progress.message}</span>{progress.percent == null ? <progress /> : <progress max="100" value={progress.percent} />}<span>{progress.percent == null ? 'Working…' : `${Math.round(progress.percent)}%`}</span><button type="button" className="button button-secondary button-small" onClick={() => void cancel()}>Cancel export</button></div>}
      <div className="project-savebar"><div><strong>{reasons.length ? 'Review the requirements above' : 'Ready to export locally'}</strong><span>{project.outputType === 'reel' ? 'Original clips are never modified.' : 'Each export uses a new folder, so existing images are preserved.'}</span></div><button type="button" className="button button-primary" disabled={busy || loading || reasons.length > 0} onClick={() => void (project.outputType==='post'?startAll():start())}>{busy ? 'Exporting…' : project.outputType === 'reel' ? 'Combine approved clips' : `Export ${readyPosts.length} approved image${readyPosts.length===1?'':'s'}`}</button></div>
      {batchResult&&<section className="export-result"><h4>{batchResult.files.length} images exported</h4><p>{batchResult.folder}</p><p>{batchResult.files.map((_,index)=>`Image ${index+1}.png`).join(' · ')}</p><button type="button" className="button button-secondary" onClick={()=>void api!.exports.openFolder(batchResult.files[0].id)}>Open exported images folder</button></section>}
      {latest && <section className="export-result"><h4>Last validated export</h4>{latest.outputType === 'reel' ? <video src={`frame-media://export/${latest.id}`} controls preload="metadata" aria-label="Validated finished reel" /> : <img src={`frame-media://export/${latest.id}`} alt="Validated exported Post image" />}<div><span>{latest.width} × {latest.height}{latest.duration == null ? '' : ` · ${latest.duration.toFixed(2)}s`}</span><button type="button" className="button button-secondary button-small" onClick={() => void api!.exports.openFolder(latest.id).then(result => { if (!result.ok) setError(result.error.message) })}>Open folder</button></div></section>}
    </>}
    {error && <p className="product-message product-error" role="alert">{error}</p>}{notice && <p className="product-notice" role="status">{notice}</p>}
    <button type="button" className="button button-secondary" disabled={busy} onClick={onBack}>Back to Clips</button>
  </section>
}

function ProjectEditor({ id, onDirty, onBusy }: { id?: string } & Guards) {
  const api = window.frameStudio?.projects ? window.frameStudio : undefined
  const [form, setForm] = useState<ProjectDraft>(empty), [saved, setSaved] = useState<ProjectInfo | null>(null)
  const [products, setProducts] = useState<ProductInfo[]>([]), [themes, setThemes] = useState<ThemeInfo[]>([]), [characters, setCharacters] = useState<CharacterInfo[]>([])
  const [productTrash, setProductTrash] = useState<ProductTrashInfo[]>([]), [removingProduct, setRemovingProduct] = useState<ProductInfo | null>(null)
  const [productBusy, setProductBusy] = useState(false)
  const productUpload = useRef(false)
  const [category, setCategory] = useState('all'), [step, setStep] = useState<Step>('Setup'), [selectedScene, setSelectedScene] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [retry, setRetry] = useState(0)
  const baseline = useRef(JSON.stringify(empty()))
  const dirty = JSON.stringify(form) !== baseline.current
  useEffect(() => { onDirty(dirty); return () => onDirty(false) }, [dirty, onDirty])
  useEffect(() => { onBusy(busy || productBusy); return () => onBusy(false) }, [busy, productBusy, onBusy])
  useEffect(() => { let active = true; if (!api) { setLoading(false); return }
    setLoading(true); setError('')
    void Promise.all([api.products.list(), api.products.trash(), api.themes.list(), api.characters.list(), id ? api.projects.get(id) : Promise.resolve(null), id ? api.generations.list(id) : Promise.resolve(null)]).then(([p, trash, t, c, project, generations]) => {
      if (!active) return
      setProducts(unwrap(p).items); setProductTrash(unwrap(trash)); setThemes(unwrap(t)); setCharacters(unwrap(c))
      if (project) { const value = unwrap(project), draft = draftOf(value); setSaved(value); setForm(draft); baseline.current = JSON.stringify(draft) }
      if(generations?.ok&&generations.value.length)setStep('Clips')
    }).catch(cause => { if (active) setError(message(cause)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [api, id, retry])
  const choice = <T extends { id: string },>(list: T[], selected: T | undefined) => selected ? list.some(item => item.id === selected.id) ? list.map(item => item.id === selected.id ? selected : item) : [selected, ...list] : list
  const availableProducts = choice(products, saved?.snapshot.product)
  const availableThemes = choice(themes, saved?.snapshot.theme).filter(item => item.outputType === form.outputType)
  const availableCharacters = choice(characters, saved?.snapshot.character ?? undefined).filter(item => category === 'all' || (item.category ?? 'none') === category)
  const selectedProduct = availableProducts.find(item => item.id === form.productId)
  const selectedLibraryProduct = products.find(item => item.id === form.productId)
  const selectedTheme = availableThemes.find(item => item.id === form.themeId)
  const savedProduct = saved?.snapshot.product.id === form.productId ? saved.snapshot.product : undefined
  const savedTheme = saved?.snapshot.theme.id === form.themeId ? saved.snapshot.theme : undefined
  const savedCharacter = saved?.snapshot.character?.id === form.characterId ? saved.snapshot.character : undefined
  const activeProduct = savedProduct ?? selectedProduct, activeTheme = savedTheme ?? selectedTheme
  const currentPreset = presets.find(item => item.id === (activeTheme ? presetForTheme(activeTheme) : form.preset))!
  const canSave = !!form.productId && !!form.themeId && !!activeTheme && !busy && !productBusy
  const change = <K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]) => { setNotice(''); setForm(current => ({ ...current, [key]: value })) }
  const switchOutput = (outputType: 'post' | 'reel') => setForm(current => ({ ...current, outputType, themeId: '', preset: outputType === 'reel' ? 'reel-vertical' : 'post-square', duration: outputType === 'reel' ? 20 : 0 }))
  const selectTheme = (theme: ThemeInfo) => setForm(current => current.themeId === theme.id ? current : ({ ...current, themeId: theme.id, storyboard: copyStoryboard(theme), preset: presetForTheme(theme), duration: current.outputType === 'reel' ? theme.defaultDuration : 0 }))
  const saveCurrent = async () => {
    if (!api || !canSave) return
    setBusy(true); setError(''); setNotice('')
    try {
      const project = unwrap(await api.projects.save({ ...form, ...(saved ? { id: saved.id, expectedRevision: saved.revision } : {}) }))
      const draft = draftOf(project); setSaved(project); setForm(draft); baseline.current = JSON.stringify(draft); onDirty(false)
      setNotice(`Saved locally · revision ${project.revision}.`)
      if (!id) window.history.replaceState(null, '', `#studio/${project.id}`)
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); await saveCurrent()
  }
  const storyboard: ProjectStoryboard = form.storyboard ?? (saved ? copyStoryboard(saved.snapshot.theme) : { scenes: [], compositionPrompt: '' })
  const activeScene = storyboard.scenes.find(scene => scene.id === selectedScene) ?? storyboard.scenes[0]
  const sceneTotal = storyboard.scenes.reduce((sum, scene) => sum + scene.editDuration, 0)
  const previewProject: ProjectInfo | null = saved ? { ...saved, ...form, id: saved.id, revision: saved.revision, createdAt: saved.createdAt, updatedAt: saved.updatedAt, snapshot: saved.snapshot, storyboard } : null
  const promptPreview = previewProject ? assemblePrompt(previewProject, form.outputType === 'reel' ? activeScene : undefined) : null
  const setStoryboard = (value: ProjectStoryboard) => change('storyboard', value)
  const updateScene = (sceneId: string, patch: Partial<ProjectScene>) => setStoryboard({ ...storyboard, scenes: storyboard.scenes.map(scene => scene.id === sceneId ? { ...scene, ...patch } : scene) })
  const addScene = () => { const scene: ProjectScene = { id: crypto.randomUUID(), name: `Scene ${storyboard.scenes.length + 1}`, prompt: 'Describe the shot.', sourceDuration: 1, editDuration: 1, relationship: 'new-shot', transition: 'cut' }; setStoryboard({ ...storyboard, scenes: [...storyboard.scenes, scene] }); setSelectedScene(scene.id) }
  const moveScene = (index: number, direction: -1 | 1) => { const scenes = [...storyboard.scenes], target = index + direction; if (target < 0 || target >= scenes.length) return; [scenes[index], scenes[target]] = [scenes[target], scenes[index]]; scenes[0].relationship = 'new-shot'; setStoryboard({ ...storyboard, scenes }); setSelectedScene(scenes[target].id) }
  const imageRefs = previewProject ? [
    ...previewProject.snapshot.product.photos.map(photo => ({ photo, group: 'Product' })),
    ...previewProject.snapshot.theme.images.map(photo => ({ photo, group: 'Theme' })),
    ...(previewProject.snapshot.character?.photos.map(photo => ({ photo, group: 'Character' })) ?? []),
  ].filter((item, index, all) => all.findIndex(other => other.photo.id === item.photo.id) === index) : []
  const addProduct = async () => {
    if (!api || busy || productUpload.current) return
    productUpload.current = true; setProductBusy(true); onBusy(true); setError(''); setNotice('')
    try {
      const imported = unwrap(await api.images.chooseManyAndImport(20))
      if (!imported) return
      const failures = imported.failures.map(item => `${item.filename}: ${item.message}`).join(' ')
      if (!imported.assets.length) { if (failures) setError(failures); return }
      const first = imported.assets[0]
      const product = unwrap(await api.products.save({
        name: first.originalName.replace(/\.[^.]+$/, '').trim().slice(0, 120) || 'Product',
        description: '', notes: '', assetIds: imported.assets.map(item => item.id), primaryAssetId: first.id,
      }))
      setProducts(current => [product, ...current])
      setForm(current => ({ ...current, productId: product.id }))
      if (failures) setError(failures)
    } catch (cause) { setError(message(cause)) }
    finally { productUpload.current = false; setProductBusy(false); onBusy(false) }
  }
  const moveProductToTrash = async () => {
    if (!api || !removingProduct || busy) return
    setBusy(true); setError('')
    try {
      unwrap(await api.products.remove(removingProduct.id, removingProduct.revision))
      const [list, trash] = await Promise.all([api.products.list(), api.products.trash()])
      setProducts(unwrap(list).items); setProductTrash(unwrap(trash))
      if (form.productId === removingProduct.id && !savedProduct) setForm(current => ({ ...current, productId: '' }))
      setNotice(`“${removingProduct.name}” moved to local trash.${savedProduct ? ' This project keeps its saved snapshot.' : ''}`)
      setRemovingProduct(null)
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  const restoreProduct = async (token: string) => {
    if (!api || busy) return
    setBusy(true); setError('')
    try {
      const restored = unwrap(await api.products.undo(token))
      const [list, trash] = await Promise.all([api.products.list(), api.products.trash()])
      setProducts(unwrap(list).items); setProductTrash(unwrap(trash))
      setForm(current => ({ ...current, productId: restored.id }))
      setNotice(`“${restored.name}” restored to your saved products.`)
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  if (!api) return <div className="empty-panel product-empty"><h2>Open Frame Studio on your desktop</h2><p>Project setup and local snapshots need the desktop workspace.</p><a className="button button-secondary" href="#studio">Back to Studio</a></div>
  if (loading) return <div className="product-message" role="status">Loading project setup…</div>
  if (error && id && !saved) return <div className="product-message product-error" role="alert">{error}<button className="button button-secondary" onClick={() => setRetry(n => n + 1)}>Retry</button></div>
  return <div className="project-editor">
    <div className="project-editor-head"><h2>{saved?.name || 'Set up your project'}</h2>{saved&&<DeleteProjectButton project={saved} onBusy={onBusy} onDeleted={()=>{baseline.current=JSON.stringify(form);onDirty(false);window.location.hash='#studio'}}/>}</div>
    <nav className="project-steps" aria-label="Project steps">{(['Setup', 'Storyboard', 'Clips', 'Export'] as Step[]).map((item, index) => <button type="button" key={item} className={step === item ? 'active' : ''} aria-current={step === item ? 'step' : undefined} disabled={item !== 'Setup' && (!saved || dirty)} onClick={() => setStep(item)}><span>{index + 1}</span>{item}</button>)}</nav>
    {step === 'Setup' ? <form onSubmit={submit} className="project-form">
      {error && <div className="product-message product-error" role="alert">{error}</div>}{notice && <div className="product-notice" role="status">{notice}</div>}
      <section className="project-form-section"><div className="project-section-title"><span>01</span><div><h3>Project details</h3><p>Give this draft a name and decide what you are making.</p></div></div><label className="project-name-field">Project name <input maxLength={120} value={form.name} placeholder="Generated from product and output if left blank" onChange={event => change('name', event.target.value)} /></label><div className="project-choice-row" role="group" aria-label="Output type">{(['reel', 'post'] as const).map(type => <button type="button" className={`project-choice ${form.outputType === type ? 'selected' : ''}`} aria-pressed={form.outputType === type} key={type} onClick={() => { if (form.outputType !== type) switchOutput(type) }}><Icon name={type === 'reel' ? 'film' : 'product'} size={22} /><strong>{type === 'reel' ? 'Reel' : 'Post'}</strong><small>{type === 'reel' ? 'Moving story' : 'Still image'}</small></button>)}</div></section>
      <section id="project-products" className="project-form-section">
        <div className="project-section-title project-product-heading"><span>02</span><div><h3>Add product</h3><p>Choose photos to add them directly to this project.</p></div><button type="button" className="button button-secondary" disabled={busy || productBusy} onClick={() => void addProduct()}><Icon name="plus" size={16} />{productBusy ? 'Adding photos…' : 'Add product'}</button></div>
        {selectedProduct && <div className="project-product-photos" aria-label="Added product photos">{selectedProduct.photos.map(photo => <div key={photo.id}><Photo photo={photo} name={photo.originalName} /></div>)}</div>}
        {productBusy && <p role="status">Adding your product photos…</p>}
        {selectedLibraryProduct && <button type="button" className="button button-secondary" disabled={busy || productBusy} onClick={() => setRemovingProduct(selectedLibraryProduct)}>Move product to trash</button>}
        {productTrash.length > 0 && <details className="product-trash"><summary>Local trash</summary><ul>{productTrash.map(entry => <li key={entry.token}><strong>{entry.kind === 'product' ? entry.productName : entry.photoName}</strong><button type="button" className="button button-secondary" disabled={busy || productBusy || !entry.canUndo} onClick={() => void restoreProduct(entry.token)}>Restore</button></li>)}</ul></details>}
      </section>
      {removingProduct && <Dialog title="Move product to local trash?" onClose={() => { if (!busy) setRemovingProduct(null) }}><p>“{removingProduct.name}” and its {removingProduct.photos.length} {removingProduct.photos.length === 1 ? 'photo will' : 'photos will'} leave your saved products. You can restore them from local trash. Existing project snapshots stay intact.</p><div className="dialog-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={() => setRemovingProduct(null)}>Keep product</button><button type="button" className="button button-danger" disabled={busy} onClick={() => void moveProductToTrash()}>{busy ? 'Moving…' : 'Move to trash'}</button></div></Dialog>}
      <section className="project-form-section"><div className="project-section-title"><span>03</span><div><h3>Choose a {form.outputType === 'reel' ? 'Reel' : 'Post'} theme</h3><p>Only themes made for this output type appear here.</p></div></div>{!availableThemes.length ? <div className="project-add-callout">No compatible theme yet. <a href="#themes/new">Add a {form.outputType} theme <Icon name="arrow" size={15} /></a></div> : <div className="project-option-grid">{availableThemes.map(item => { const image = item.images.find(photo => photo.id === item.coverAssetId); return <button type="button" key={item.id} className={`project-option ${form.themeId === item.id ? 'selected' : ''}`} aria-pressed={form.themeId === item.id} onClick={() => selectTheme(item)}><span className="project-option-image">{image ? <Photo photo={image} name={item.name} /> : <Icon name="theme" size={32} />}</span><strong>{item.name}</strong><small>{item.aspectRatio} · {item.outputType === 'reel' ? `${item.scenes.length} scenes · ${item.defaultDuration}s` : 'Still image'}{savedTheme?.id === item.id && !themes.some(value => value.id === item.id) ? ' · snapshot' : ''}</small></button> })}</div>}</section>
      <section className="project-form-section"><div className="project-section-title"><span>04</span><div><h3>Character</h3><p>Use a saved person or keep the story Product only.</p></div></div><div className="project-character-bar"><button type="button" className={`project-product-only ${form.characterId === null ? 'selected' : ''}`} aria-pressed={form.characterId === null} onClick={() => change('characterId', null)}>Product only <small>No character reference</small></button><label>Filter <select value={category} onChange={event => setCategory(event.target.value)}><option value="all">All categories</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option><option value="none">No category</option></select></label></div>{availableCharacters.length ? <div className="project-option-grid">{availableCharacters.map(item => { const photo = primary(item); return <button type="button" key={item.id} className={`project-option ${form.characterId === item.id ? 'selected' : ''}`} aria-pressed={form.characterId === item.id} onClick={() => change('characterId', item.id)}><span className="project-option-image">{photo && <Photo photo={photo} name={item.name} />}</span><strong>{item.name}</strong><small>{item.category ?? 'No category'} · {item.photos.length} references{savedCharacter?.id === item.id && !characters.some(value => value.id === item.id) ? ' · snapshot' : ''}</small></button> })}</div> : <p className="project-helper">{characters.length ? 'No characters in this category.' : <>Characters are optional. <a href="#characters/new">Add a character</a> if you want one.</>}</p>}</section>
      <section className="project-form-section"><div className="project-section-title"><span>05</span><div><h3>Theme output</h3><p>Dimensions follow the selected theme automatically. Flow source media is cropped to these dimensions when needed.</p></div></div><p className="project-helper">{activeTheme ? `${activeTheme.aspectRatio} · ${currentPreset.size} · from theme` : 'Choose a theme to set output dimensions.'}</p>{form.outputType === 'reel' && <label className="project-duration-field">Total final duration <span><input type="number" min="0.1" max="600" step="0.1" value={form.duration} onChange={event => change('duration', Number(event.target.value))} /> seconds</span></label>}{activeTheme && form.outputType === 'reel' && Math.abs(activeTheme.scenes.reduce((sum, scene) => sum + scene.duration, 0) - form.duration) > .005 && <p className="project-timing-note">Theme scenes total {activeTheme.scenes.reduce((sum, scene) => sum + scene.duration, 0).toFixed(1)}s. Your {form.duration}s target will need storyboard timing adjustments in Phase 7.</p>}</section>
      <div className="project-savebar"><div><strong>{dirty ? 'Unsaved setup changes' : saved ? 'Draft saved locally' : 'Ready to start a local draft'}</strong><span>{activeProduct && activeTheme ? `${activeProduct.name} · ${activeTheme.name} · ${currentPreset.size}` : 'Add a product and choose a compatible theme to save.'}</span></div><button className="button button-primary" type="submit" disabled={!canSave}>{busy ? 'Saving…' : saved ? 'Save changes' : 'Create project'}</button></div>
    </form> : step === 'Storyboard' && previewProject ? <section className="project-storyboard">
      <div className="storyboard-intro"><span className="eyebrow">STEP 2 OF 4 · PROJECT COPY</span><h3>{form.outputType === 'reel' ? 'Shape your scenes' : 'Refine your composition'}</h3><p>Edit this project?s scenes and review the final prompt.</p></div>
      {form.outputType === 'reel' ? <div className="storyboard-layout">
        <div className="storyboard-list-panel"><div className="storyboard-list-head"><strong>{storyboard.scenes.length} {storyboard.scenes.length === 1 ? 'scene' : 'scenes'}</strong><button type="button" className="button button-secondary button-small" disabled={storyboard.scenes.length >= 30} onClick={addScene}><Icon name="plus" size={15} />Add scene</button></div><ol className="storyboard-scene-list">{storyboard.scenes.map((scene, index) => <li key={scene.id}><button type="button" className={`storyboard-scene-select ${activeScene?.id === scene.id ? 'active' : ''}`} onClick={() => setSelectedScene(scene.id)}><span className="scene-order">{index + 1}</span><span><strong>{scene.name}</strong><small>{scene.sourceDuration}s source · {scene.editDuration}s timeline · {scene.relationship === 'new-shot' ? 'New shot' : 'Continue'}</small></span></button><div className="scene-order-actions"><button type="button" aria-label={`Move scene ${index + 1} up`} disabled={index === 0} onClick={() => moveScene(index, -1)}>↑</button><button type="button" aria-label={`Move scene ${index + 1} down`} disabled={index === storyboard.scenes.length - 1} onClick={() => moveScene(index, 1)}>↓</button></div></li>)}</ol><button type="button" className="storyboard-remove" disabled={storyboard.scenes.length <= 1} onClick={() => { const next = storyboard.scenes.filter(scene => scene.id !== activeScene?.id); if (next[0]) next[0].relationship = 'new-shot'; setStoryboard({ ...storyboard, scenes: next }); setSelectedScene(next[0]?.id ?? '') }}>Remove selected scene</button></div>
        {activeScene && <div className="storyboard-edit-panel"><div className="storyboard-field-row"><label>Scene name<input maxLength={120} value={activeScene.name} onChange={event => updateScene(activeScene.id, { name: event.target.value })} /></label><label>Source clip length (seconds)<input type="number" min="0.1" max="600" step="0.1" value={activeScene.sourceDuration} onChange={event => updateScene(activeScene.id, { sourceDuration: Number(event.target.value) })} /></label></div><div className="storyboard-field-row"><label>Final timeline duration (seconds)<input type="number" min="0.1" max="600" step="0.1" value={activeScene.editDuration} onChange={event => updateScene(activeScene.id, { editDuration: Number(event.target.value) })} /></label><label>Continuity relationship<select value={activeScene.relationship} disabled={storyboard.scenes[0]?.id === activeScene.id} onChange={event => updateScene(activeScene.id, { relationship: event.target.value as ProjectScene['relationship'] })}><option value="new-shot">New shot</option><option value="continue">Continue previous scene</option></select></label></div><PromptField label="Scene prompt" value={activeScene.prompt} onChange={prompt => updateScene(activeScene.id, { prompt })} /><div className="storyboard-field-row"><span className="hard-cut-label">Transition <strong>Hard cut</strong></span><span className="project-helper">Source length is checked against the available generation controls later.</span></div><div className="scene-preview-heading"><h4>Assembled prompt preview</h4><span>{activeScene.relationship === 'continue' ? 'Continues from the preceding scene' : 'Independent new shot'}</span></div>{promptPreview?.errors.length ? <div className="prompt-validation-error" role="alert">{promptPreview.errors.map(item => <p key={item}>{item}</p>)}</div> : <pre className="assembled-prompt">{promptPreview?.text}</pre>}{promptPreview?.warnings.map(item => <div className="prompt-validation-warning" key={item}>{item}</div>)}</div>}
      </div> : <div className="post-storyboard-layout"><div className="storyboard-edit-panel"><div className="scene-preview-heading"><h4>Assembled prompt preview</h4><span>Still image · {currentPreset.size}</span></div>{promptPreview?.errors.length ? <div className="prompt-validation-error" role="alert">{promptPreview.errors.map(item => <p key={item}>{item}</p>)}</div> : <ReferencePromptPreview selected={promptPreview?.selectedReference} images={previewProject?.snapshot.theme.images ?? []} prompt={promptPreview?.text ?? ''} />}{promptPreview?.warnings.map(item => <div className="prompt-validation-warning" key={item}>{item}</div>)}</div></div>}
      {form.outputType === 'reel' && <div className={`timing-status ${Math.abs(sceneTotal - form.duration) <= .005 ? 'timing-valid' : 'timing-invalid'}`} role="status"><div><strong>{Math.abs(sceneTotal - form.duration) <= .005 ? 'Timeline matches target' : 'Timeline durations need attention'}</strong><span>{sceneTotal.toFixed(1)}s of edit time · {form.duration}s final target. Source clip lengths are separate.</span></div>{Math.abs(sceneTotal - form.duration) > .005 && <button type="button" className="button button-secondary button-small" onClick={() => change('duration', Number(sceneTotal.toFixed(1)))}>Use timeline total as target</button>}</div>}
      <div className="project-reference-panel"><div><h4>Project references</h4><p>These saved images are references for later submission. Text paths alone do not attach files.</p></div><div className="project-reference-strip">{imageRefs.map(({ photo, group }) => <div className="project-reference" key={photo.id}><Photo photo={photo} name={photo.originalName} /><span>{group} · {photo.originalName}</span>{!photo.available && <small>Unavailable</small>}</div>)}</div></div>
      {error && <div className="product-message product-error" role="alert">{error}</div>}{notice && <div className="product-notice" role="status">{notice}</div>}<div className="project-savebar"><div><strong>{dirty ? 'Unsaved storyboard changes' : 'Storyboard saved locally'}</strong><span>Prompt preview only · generation is not available here</span></div><button type="button" className="button button-primary" disabled={!canSave || !dirty} onClick={() => void saveCurrent()}>{busy ? 'Saving…' : 'Save storyboard'}</button></div>
    </section> : step === 'Clips' && saved ? <GenerationPanel project={saved} scene={activeScene} prompt={promptPreview?.text ?? ''} onGoExport={() => setStep('Export')} /> : step === 'Export' && saved ? <ExportPanel project={saved} onBack={() => setStep('Clips')} /> : <section className="project-future"><span className="eyebrow">STEP {(['Setup', 'Storyboard', 'Clips', 'Export'] as Step[]).indexOf(step) + 1} OF 4</span><h3>{step}</h3><p>Export is available for saved projects.</p><button type="button" className="button button-secondary" onClick={() => setStep('Setup')}>Back to setup</button></section>}
  </div>
}
