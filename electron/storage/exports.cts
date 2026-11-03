import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { access, copyFile, lstat, mkdir, rename, rm, rmdir, stat, statfs } from 'node:fs/promises'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import type { ExportPlan, ExportProgress, ExportRecord, ExportSceneInfo, ExportSettings, GenerationAttempt, LogoReview, PostBatchExport, ProjectInfo, ProjectPreset, SceneReview } from '../contracts.cjs'
import { transaction } from './database.cjs'
import { StorageError } from './errors.cjs'
import { ManagedPaths, UUID_PATTERN } from './paths.cjs'
import { outputSizes } from './output-policy.mjs'
import { postPhotos } from './post-plan.mjs'
import { validResultPath } from './result-paths.cjs'
import {logoQueue,type LogoProgress} from '../media/logo-queue.cjs'

type Probe = { duration: number; width: number; height: number; hasAudio: boolean; size: number }
type ToolInfo = { available: boolean; message: string; encoder: 'libx264' | 'mpeg4' | null; hasAac: boolean }
type ExportRow = { id: string; project_id: string; output_type: 'reel' | 'post'; preset: ProjectPreset; path: string; width: number; height: number; duration: number | null; source_attempt_ids: string; created_at: string }
const presetSize = outputSizes
function invalid(message: string): never { throw new StorageError('INVALID_REQUEST', message) }
function record(row: ExportRow): ExportRecord { return { id: row.id, projectId: row.project_id, outputType: row.output_type, preset: row.preset, path: row.path, width: row.width, height: row.height, duration: row.duration, sourceAttemptIds: JSON.parse(row.source_attempt_ids) as string[], createdAt: row.created_at } }

function capture(command: string, args: string[], timeout = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', error = '', settled = false
    const timer = setTimeout(() => { child.kill(); finish(new Error('The local media tool did not respond in time.')) }, timeout)
    const finish = (cause?: Error) => { if (settled) return; settled = true; clearTimeout(timer); cause ? reject(cause) : resolve(output) }
    child.stdout.on('data', data => { if (output.length < 2_000_000) output += String(data) })
    child.stderr.on('data', data => { if (error.length < 8000) error += String(data) })
    child.once('error', () => finish(new Error('FFmpeg/FFprobe could not be started. Install a trusted local FFmpeg build and restart Frame Studio.')))
    child.once('close', code => code === 0 ? finish() : finish(new Error(error.trim().slice(-2500) || `The media tool exited with code ${code}.`)))
  })
}

export class Exports {
  async normalizeFlowResult(preset: ProjectPreset, source: string, attemptId: string, onCleanup?: (detail: string, removed: boolean) => void, progress?:LogoProgress): Promise<string> {
    if (!UUID_PATTERN.test(attemptId)) invalid('Invalid normalization request.')
    const size = presetSize[preset]
    const directory = await this.paths.directory(`temp/flow/${attemptId}`)
    if (preset.startsWith('post-')) {
      const target = path.join(directory, 'normalized.png')
      const partial = path.join(directory, `${randomUUID()}.normalizing`)
      try {
        const cleaned=await logoQueue.run(attemptId,{source,target:partial,width:size.width,height:size.height},progress)
        onCleanup?.(cleaned.removed ? 'Visible Gemini logo cleaned locally. Saving the cleaned image at the theme dimensions.' : 'No supported Gemini logo confidently detected; preserving the image and saving at the theme dimensions.', cleaned.removed)
        await rename(partial, target)
        progress?.(97,'Cleaned image staged; committing project file')
      } finally { await rm(partial, {force:true}).catch(() => {}) }
      return target
    }
    const media = await this.probe(source)
    if (Math.abs(media.width / media.height - size.width / size.height) < 0.002) return source
    const tools = await this.tools()
    if (!tools.available) invalid(tools.message)
    const target = path.join(directory, `${randomUUID()}.mp4`)
    await capture('ffmpeg', ['-hide_banner', '-nostdin', '-n', '-loglevel', 'error', '-i', source, '-map', '0:v:0', '-map', '0:a?', '-vf', `scale=${size.width}:${size.height}:force_original_aspect_ratio=increase,crop=${size.width}:${size.height},setsar=1`, '-c:v', tools.encoder!, ...(tools.encoder === 'libx264' ? ['-preset', 'veryfast', '-crf', '20'] : ['-q:v', '3']), '-c:a', 'aac', '-movflags', '+faststart', target], 10 * 60_000)
    const result = await this.probe(target)
    if (result.width !== size.width || result.height !== size.height) invalid('Automatic video crop did not produce the theme dimensions.')
    return target
  }
  private child: ChildProcess | undefined
  private runningProject: string | undefined
  private cancelled = false
  get busy() { return !!this.runningProject }
  constructor(private readonly db: DatabaseSync, private readonly paths: ManagedPaths, private readonly project: (id: string) => Promise<ProjectInfo>, private readonly attempts: (id: string) => Promise<GenerationAttempt[]>, private readonly reviewsFor: (id: string) => Promise<SceneReview[]>) {}

  private async tools(): Promise<ToolInfo> {
    try {
      const [version, encoders] = await Promise.all([capture('ffmpeg', ['-version']), capture('ffmpeg', ['-hide_banner', '-encoders'])])
      const encoder = /\blibx264\b/.test(encoders) ? 'libx264' : /\bmpeg4\b/.test(encoders) ? 'mpeg4' : null
      const hasAac = /\baac\b/.test(encoders)
      await capture('ffprobe', ['-version'])
      const label = version.split(/\r?\n/, 1)[0]?.trim() ?? 'FFmpeg available'
      return { available: !!encoder && hasAac, message: !encoder ? `${label}; no compatible MP4 video encoder was found.` : !hasAac ? `${label}; the AAC audio encoder is not available.` : `${label}; FFprobe available.`, encoder, hasAac }
    } catch (error) {
      return { available: false, message: error instanceof Error ? error.message : 'FFmpeg and FFprobe are not available on PATH.', encoder: null, hasAac: false }
    }
  }

  private async probe(filename: string): Promise<Probe> {
    const output = await capture('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,width,height', '-of', 'json', filename], 30_000)
    const parsed = JSON.parse(output) as { format?: { duration?: string; size?: string }; streams?: { codec_type?: string; width?: number; height?: number }[] }
    const video = parsed.streams?.find(stream => stream.codec_type === 'video')
    const duration = Number(parsed.format?.duration), size = Number(parsed.format?.size) || (await stat(filename)).size
    if (!video || !Number.isFinite(duration) || duration <= 0 || !video.width || !video.height) invalid('A selected clip is not readable video. Re-import the original Flow download.')
    return { duration, width: video.width, height: video.height, hasAudio: !!parsed.streams?.some(stream => stream.codec_type === 'audio'), size }
  }

  private async latest(projectId: string) { const row = this.db.prepare('SELECT * FROM project_exports WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(projectId) as ExportRow | undefined; return row ? record(row) : null }

  async continuationFrame(projectId: string, sceneId: string): Promise<string> {
    const project = await this.project(projectId), scene = project.storyboard.scenes.find(item => item.id === sceneId)
    const review = (await this.reviewsFor(projectId)).find(item => item.sceneId === sceneId)
    const attempt = (await this.attempts(projectId)).find(item => item.id === review?.selectedAttemptId)
    if (!scene || review?.status !== 'approved' || !attempt?.resultPath || attempt.state !== 'ready-for-review') invalid('Approve the preceding clip before generating a continuation.')
    const source = await this.paths.regularFile(attempt.resultPath), media = await this.probe(source)
    const position = Math.max(0, Math.min(media.duration, scene.editDuration) - 0.1)
    const directory = await this.paths.directory(`temp/flow-frames/${randomUUID()}`), destination = path.join(directory, 'start-frame.png')
    await capture('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(position), '-i', source, '-frames:v', '1', '-n', destination], 30_000)
    if ((await sharp(destination).metadata()).format !== 'png') invalid('The approved clip ending could not be extracted.')
    return destination
  }

  async inspect(projectId: string): Promise<ExportPlan> {
    if (!UUID_PATTERN.test(projectId)) invalid('The project identifier is invalid.')
    const project = await this.project(projectId), tools = project.outputType === 'reel' ? await this.tools() : { available: true, message: 'Post export uses the local image processor; FFmpeg is not required.', encoder: null, hasAac: false }
    const attempts = await this.attempts(projectId), reviews = await this.reviewsFor(projectId), size = presetSize[project.preset]
    const specs = project.outputType === 'post' ? postPhotos(project).map(photo => ({ sceneId: photo.id, name: photo.name })) : project.storyboard.scenes.map(scene => ({ sceneId: scene.id, name: scene.name }))
    const reasons: string[] = [], scenes: ExportSceneInfo[] = []
    if (project.outputType === 'reel' && !tools.available) reasons.push(tools.message)
    for (const spec of specs) {
      const review = reviews.find(item => item.sceneId === spec.sceneId), attempt = attempts.find(item => item.id === review?.selectedAttemptId && item.state === 'ready-for-review')
      const logoStatus = attempt && project.outputType==='post' ? this.logoStatus(attempt.id) : undefined
      let info: ExportSceneInfo = { sceneId: spec.sceneId, name: spec.name, attemptId: attempt?.id ?? null, reviewStatus: review?.status ?? 'pending', logoReviewStatus:logoStatus, duration: null, width: null, height: null, hasAudio: false, byteSize: null, issue: null }
      if (!review || review.status !== 'approved' || !attempt) reasons.push(`Approve a valid result for ${spec.name} before exporting.`)
      else {
        try {
          const managed = await this.paths.regularFile((await this.db.prepare('SELECT result_path FROM generation_attempts WHERE id = ?').get(attempt.id) as { result_path: string }).result_path)
          await access(managed, constants.R_OK)
          const file = await stat(managed)
          info = { ...info, byteSize: file.size }
          if (project.outputType === 'post') {
            const meta = await sharp(managed).metadata()
            if (!meta.width || !meta.height || !['jpeg', 'png', 'webp'].includes(meta.format ?? '')) throw new Error('The approved still image is not readable.')
            info = { ...info, duration: 0, width: meta.width, height: meta.height }
          } else if (tools.available) {
            const probed = await this.probe(managed)
            info = { ...info, duration: probed.duration, width: probed.width, height: probed.height, hasAudio: probed.hasAudio, byteSize: probed.size }
          }
        } catch (error) { info = { ...info, issue: error instanceof Error ? error.message : 'The selected media cannot be read.' }; reasons.push(`${spec.name}: ${info.issue}`) }
      }
      if(project.outputType==='post' && attempt && logoStatus!=='approved')reasons.push(`Approve ${spec.name} in Clips before exporting.`)
      scenes.push(info)
    }
    const upscaledSources = project.outputType === 'reel' && scenes.some(scene => !!scene.width && !!scene.height && (scene.width < size.width || scene.height < size.height))
    return { projectId, outputType: project.outputType, ...size, targetDuration: project.outputType === 'reel' ? project.duration : null, toolAvailable: tools.available, toolMessage: tools.message, videoEncoder: tools.encoder, canExport: reasons.length === 0, reasons: [...new Set(reasons)], upscaledSources, scenes, lastExport: await this.latest(projectId) }
  }

  private async validateDestination(destination: string, extension: '.mp4' | '.png' | '.jpg', requiredSpace: number) {
    if (typeof destination !== 'string' || !path.isAbsolute(destination) || path.extname(destination).toLowerCase() !== extension) invalid(`Choose a ${extension} export filename.`)
    const folder = path.dirname(destination), folderStat = await lstat(folder).catch(() => undefined)
    if (!folderStat?.isDirectory() || folderStat.isSymbolicLink()) invalid('Choose an existing local export folder.')
    await access(folder, constants.W_OK).catch(() => invalid('The selected export folder is not writable.'))
    if (await lstat(destination).catch(() => undefined)) invalid('That filename already exists. Choose another name; Frame Studio never overwrites an export.')
    const disk = await statfs(folder).catch(() => undefined)
    if (disk && disk.bavail * disk.bsize < requiredSpace) invalid('There is not enough free disk space for a safe temporary and final export.')
    const temp = path.join(folder, `.frame-studio-${randomUUID()}.partial${extension}`)
    return temp
  }

  async start(projectId: string, settings: ExportSettings, destination: string, progress: (value: ExportProgress) => void): Promise<ExportRecord> {
    if (this.busy) throw new StorageError('BUSY', 'Another local export is already running.')
    if (!settings || !Array.isArray(settings.order) || !Array.isArray(settings.trims) || !['pad', 'crop'].includes(settings.fit) || typeof settings.muteAll !== 'boolean') invalid('The export settings are invalid.')
    this.runningProject = projectId; this.cancelled = false
    let temp: string | undefined, finalCreated = false
    try {
      const project = await this.project(projectId), plan = await this.inspect(projectId)
      // Theme dimensions always fill the output; source ratio differences are
      // handled here even for older/manual imports.
      settings = { ...settings, fit: 'crop' }
      const sourceIds = plan.scenes.map(scene => scene.attemptId!).filter(Boolean)
      if (project.outputType === 'post') {
        if (settings.order.length || settings.trims.length) invalid('Post images do not use timeline or trim settings.')
        const selected = plan.scenes.find(scene => scene.sceneId === (settings.postSceneId ?? 'post'))
        if (!selected || selected.reviewStatus !== 'approved' || !selected.attemptId || selected.issue || !selected.width || !selected.height) invalid('Approve a readable result for the selected product before exporting it.')
        if(selected.logoReviewStatus!=='approved')invalid('Approve this image in Clips before exporting it.')
        const source = await this.sourceFor(selected.attemptId)
        const required = Math.max(32_000_000, plan.width * plan.height * 6)
        temp = await this.validateDestination(destination, path.extname(destination).toLowerCase() as '.png' | '.jpg', required)
        progress({ projectId, stage: 'rendering', percent: null, message: 'Resizing and encoding the approved Post image locally.' })
        await sharp(source).rotate().resize(plan.width, plan.height, { fit: settings.fit === 'crop' ? 'cover' : 'contain', background: '#ffffff' })[path.extname(destination).toLowerCase() === '.jpg' ? 'jpeg' : 'png']().toFile(temp)
        progress({ projectId, stage: 'validating', percent: null, message: 'Checking the exported image dimensions.' })
        const image = await sharp(temp).metadata()
        if (image.width !== plan.width || image.height !== plan.height) invalid('The exported image does not match the selected dimensions.')
        await this.assertPostApproval(projectId,selected.sceneId,selected.attemptId)
        const result = await this.commit(project, destination, temp, plan.width, plan.height, null, [selected.attemptId]); finalCreated = true; temp = undefined
        return result
      }
      if (plan.reasons.length) invalid(plan.reasons.join(' '))
      const specIds = project.storyboard.scenes.map(scene => scene.id)
      if (settings.order.length !== specIds.length || new Set(settings.order).size !== specIds.length || settings.order.some(id => !specIds.includes(id))) invalid('Include every approved Reel scene exactly once in the export order.')
      const ordered = settings.order.map(id => plan.scenes.find(scene => scene.sceneId === id)!)
      const trimById = new Map(settings.trims.map(trim => [trim.sceneId, trim]))
      if (trimById.size !== specIds.length || settings.trims.some(trim => !specIds.includes(trim.sceneId) || !Number.isFinite(trim.inPoint) || !Number.isFinite(trim.outPoint))) invalid('Each Reel scene needs one valid trim range.')
      const media = await Promise.all(ordered.map(async scene => ({ scene, trim: trimById.get(scene.sceneId)!, source: await this.sourceFor(scene.attemptId!) })))
      for (const { scene, trim } of media) if (trim.inPoint < 0 || trim.outPoint > scene.duration! + 0.001 || trim.outPoint - trim.inPoint < 0.1) invalid(`${scene.name} has a trim range outside its readable source clip.`)
      const total = media.reduce((sum, item) => sum + item.trim.outPoint - item.trim.inPoint, 0)
      if (Math.abs(total - project.duration) > 1 / 30) invalid(`The trimmed clips total ${total.toFixed(2)}s; adjust trims to match the ${project.duration}s target within one output frame.`)
      const requiredSpace = media.reduce((sum, item) => sum + item.scene.byteSize!, 0) * 2 + 100_000_000
      temp = await this.validateDestination(destination, '.mp4', requiredSpace)
      const filters: string[] = [], pairs: string[] = []
      media.forEach(({ scene, trim }, index) => {
        const length = trim.outPoint - trim.inPoint
        const scale = settings.fit === 'crop' ? `scale=${plan.width}:${plan.height}:force_original_aspect_ratio=increase,crop=${plan.width}:${plan.height}` : `scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease,pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2`
        filters.push(`[${index}:v:0]trim=start=${trim.inPoint}:end=${trim.outPoint},setpts=PTS-STARTPTS,${scale},fps=30,setsar=1,format=yuv420p[v${index}]`)
        if (settings.muteAll || !scene.hasAudio) filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${length},asetpts=PTS-STARTPTS[a${index}]`)
        else filters.push(`[${index}:a:0]atrim=start=${trim.inPoint}:end=${trim.outPoint},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${length}[a${index}]`)
        pairs.push(`[v${index}][a${index}]`)
      })
      filters.push(`${pairs.join('')}concat=n=${media.length}:v=1:a=1[outv][outa]`)
      const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-stats_period', '0.5', '-progress', 'pipe:1']
      for (const item of media) args.push('-i', item.source)
      args.push('-filter_complex', filters.join(';'), '-map', '[outv]', '-map', '[outa]', '-c:v', plan.videoEncoder ?? 'libx264', ...(plan.videoEncoder === 'libx264' ? ['-preset', 'veryfast', '-crf', '20'] : ['-q:v', '3']), '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-f', 'mp4', temp)
      progress({ projectId, stage: 'rendering', percent: 0, message: 'Combining approved clips offline.' })
      if (this.cancelled) invalid('Export stopped because the project was deleted or export was cancelled.')
      await this.encode(args, projectId, total, progress)
      progress({ projectId, stage: 'validating', percent: null, message: 'Verifying duration, dimensions, and playable audio/video streams.' })
      const finalProbe = await this.probe(temp)
      if (finalProbe.width !== plan.width || finalProbe.height !== plan.height || Math.abs(finalProbe.duration - project.duration) > 1 / 30 || !finalProbe.hasAudio) invalid('The finished MP4 did not pass its duration, dimensions, or stream validation. The original clips are unchanged.')
      const result = await this.commit(project, destination, temp, plan.width, plan.height, finalProbe.duration, sourceIds); finalCreated = true; temp = undefined
      return result
    } catch (error) {
      if (temp) await rm(temp, { force: true }).catch(() => undefined)
      if (finalCreated && destination) await rm(destination, { force: true }).catch(() => undefined)
      if (this.cancelled) throw new StorageError('INVALID_REQUEST', 'Export cancelled. The partial output was removed and original media was preserved.')
      throw error
    } finally { this.child = undefined; this.runningProject = undefined; this.cancelled = false }
  }

  private logoStatus(id: string) {
    const row=this.db.prepare('SELECT content FROM logo_reviews WHERE attempt_id=?').get(id) as {content:string}|undefined
    return row?(JSON.parse(row.content) as LogoReview).status:'pending'
  }
  private async assertPostApproval(projectId: string,sceneId: string,attemptId: string) {
    await this.project(projectId)
    const review=(await this.reviewsFor(projectId)).find(item=>item.sceneId===sceneId)
    if(review?.status!=='approved'||review.selectedAttemptId!==attemptId||this.logoStatus(attemptId)!=='approved')invalid('An image selection or approval changed during export. Review it again; the batch was not completed.')
  }
  async startPostBatch(projectId: string, parent: string, progress: (value: ExportProgress)=>void): Promise<PostBatchExport> {
    if(this.busy)throw new StorageError('BUSY','Another local export is already running.')
    this.runningProject=projectId;this.cancelled=false
    let folder: string|undefined,temp:string|undefined
    const files:ExportRecord[]=[]
    try {
      const project=await this.project(projectId)
      if(project.outputType!=='post')invalid('Bulk image export is available for Post projects.')
      const plan=await this.inspect(projectId),selected=plan.scenes.filter(item=>item.reviewStatus==='approved'&&item.logoReviewStatus==='approved'&&item.attemptId&&!item.issue&&item.width&&item.height)
      if(!selected.length)invalid('Approve images in Clips before exporting.')
      if(!path.isAbsolute(parent))invalid('Choose an existing local folder for the images.')
      const parentInfo=await lstat(parent)
      if(!parentInfo.isDirectory()||parentInfo.isSymbolicLink())invalid('Choose a regular local export folder.')
      await access(parent,constants.W_OK)
      const name=(project.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'-').replace(/[. ]+$/,'').slice(0,80)||'Project')+' - Images'
      for(let n=1;n<=9999;n++) {
        const candidate=path.join(parent,name+(n===1?'':` (${n})`))
        try{await mkdir(candidate);folder=candidate;break}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}
      }
      if(!folder)invalid('Could not create a new image export folder.')
      for(const [index,item] of selected.entries()) {
        if(this.cancelled)invalid('Export cancelled.')
        await this.assertPostApproval(projectId,item.sceneId,item.attemptId!)
        const source=await this.sourceFor(item.attemptId!),destination=path.join(folder,`Image ${index+1}.png`)
        temp=await this.validateDestination(destination,'.png',Math.max(32_000_000,plan.width*plan.height*6))
        progress({projectId,stage:'rendering',percent:Math.round(index/selected.length*100),message:`Saving Image ${index+1} of ${selected.length}.`})
        const meta=await sharp(source).metadata()
        if(meta.format==='png'&&meta.width===plan.width&&meta.height===plan.height)await copyFile(source,temp,constants.COPYFILE_EXCL)
        else await sharp(source).rotate().resize(plan.width,plan.height,{fit:'cover'}).png().toFile(temp)
        await this.assertPostApproval(projectId,item.sceneId,item.attemptId!)
        files.push(await this.commit(project,destination,temp,plan.width,plan.height,null,[item.attemptId!]));temp=undefined
      }
      for(const item of selected)await this.assertPostApproval(projectId,item.sceneId,item.attemptId!)
      progress({projectId,stage:'validating',percent:100,message:`${files.length} approved images saved together.`})
      return {projectId,folder,files}
    } catch(error) {
      if(temp)await rm(temp,{force:true}).catch(()=>{})
      for(const file of files){this.db.prepare('DELETE FROM project_exports WHERE id=?').run(file.id);await rm(file.path,{force:true}).catch(()=>{})}
      if(folder)await rmdir(folder).catch(()=>{})
      throw error
    } finally {this.runningProject=undefined;this.cancelled=false}
  }

  private async sourceFor(id: string): Promise<string> {
    if (!UUID_PATTERN.test(id)) invalid('The selected approved media is unavailable.')
    const row = this.db.prepare('SELECT a.project_id, a.result_path, a.state FROM generation_attempts a WHERE a.id = ?').get(id) as { project_id: string; result_path: string | null; state: string } | undefined
    if (!row || row.state !== 'ready-for-review' || !row.result_path || !validResultPath(row.project_id, id, row.result_path)) invalid('An approved result file is missing or unsafe.')
    const file = await this.paths.regularFile(row.result_path); await access(file, constants.R_OK); return file
  }

  private async encode(args: string[], projectId: string, duration: number, progress: (value: ExportProgress) => void) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      this.child = child
      let stdout = '', stderr = '', settled = false
      const finish = (error?: Error) => { if (settled) return; settled = true; error ? reject(error) : resolve() }
      child.stdout.on('data', data => {
        stdout += String(data)
        const chunks = stdout.split(/\r?\n/); stdout = chunks.pop() ?? ''
        const entries: Record<string, string> = {}
        for (const line of chunks) { const index = line.indexOf('='); if (index > 0) entries[line.slice(0, index)] = line.slice(index + 1) }
        const time = Number(entries.out_time_us ?? entries.out_time_ms)
        if (Number.isFinite(time) && duration > 0) progress({ projectId, stage: 'rendering', percent: Math.max(0, Math.min(99, time / 1_000_000 / duration * 100)), message: 'Combining approved clips offline.' })
        if (entries.progress === 'end') progress({ projectId, stage: 'rendering', percent: 100, message: 'Encoding finished; validating the MP4.' })
      })
      child.stderr.on('data', data => { if (stderr.length < 8000) stderr += String(data) })
      child.once('error', () => finish(new Error('FFmpeg could not be started. Install a trusted local FFmpeg build and restart Frame Studio.')))
      child.once('close', code => code === 0 && !this.cancelled ? finish() : finish(new Error(this.cancelled ? 'Export cancelled.' : stderr.trim().slice(-2500) || `FFmpeg exited with code ${code}.`)))
    })
  }

  private async commit(project: ProjectInfo, destination: string, temp: string, width: number, height: number, duration: number | null, sourceAttemptIds: string[]): Promise<ExportRecord> {
    if (this.cancelled) invalid('Export stopped because the project was deleted or export was cancelled.')
    if (await lstat(destination).catch(() => undefined)) invalid('That filename was created while exporting. Choose another name; the existing file was preserved.')
    if (this.cancelled) invalid('Export stopped because the project was deleted or export was cancelled.')
    await copyFile(temp, destination, constants.COPYFILE_EXCL)
    const id = randomUUID(), createdAt = new Date().toISOString()
    try {
      if (this.cancelled) invalid('Export stopped because the project was deleted or export was cancelled.')
      transaction(this.db, () => this.db.prepare('INSERT INTO project_exports(id, project_id, output_type, preset, path, width, height, duration, source_attempt_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, project.id, project.outputType, project.preset, destination, width, height, duration, JSON.stringify(sourceAttemptIds), createdAt))
    } catch (error) { await rm(destination, { force: true }).catch(() => undefined); throw error }
    await rm(temp, { force: true }).catch(() => undefined)
    return { id, projectId: project.id, outputType: project.outputType, preset: project.preset, path: destination, width, height, duration, sourceAttemptIds, createdAt }
  }

  async cancel(projectId: string) {
    if (this.runningProject !== projectId) return null
    this.cancelled = true; this.child?.kill(); return null
  }
  async cancelCurrent(){if(this.runningProject)await this.cancel(this.runningProject)}
  getExport(id: string): ExportRecord {
    if (!UUID_PATTERN.test(id)) invalid('The export identifier is invalid.')
    const row = this.db.prepare('SELECT * FROM project_exports WHERE id = ?').get(id) as ExportRow | undefined
    if (!row) invalid('This export is no longer in the local workspace.')
    return record(row)
  }
  async exportFile(id: string) {
    const result = this.getExport(id), info = await lstat(result.path).catch(() => undefined)
    if (!info?.isFile() || info.isSymbolicLink()) invalid('The exported file is missing or no longer a regular local file.')
    return { path: result.path, mediaType: result.outputType === 'reel' ? 'video/mp4' : path.extname(result.path).toLowerCase() === '.jpg' ? 'image/jpeg' : 'image/png' }
  }
  async openFolderPath(id: string) { const result = this.getExport(id); await this.exportFile(id); return path.dirname(result.path) }
}
