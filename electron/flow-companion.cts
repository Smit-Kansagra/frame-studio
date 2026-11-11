import { createServer, type Server } from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import type { FlowConnection } from './contracts.cjs'
import type { FlowRequest, RemoteResult } from './flow-browser.cjs'
import { StorageError,FlowNotSubmittedError } from './storage/errors.cjs'
import { allowedFlowPage, isFlowProject as validProject } from './flow-urls.cjs'
import type { FlowReporter } from './flow-progress.cjs'
import { FlowResultFiles } from './flow-result-files.cjs'
import type { FlowDriver } from './flow-coordinator.cjs'
import { UUID_PATTERN } from './storage/paths.cjs'
import type { FlowCommandDispatch } from './flow-command-queue.cjs'
export { allowedFlowPage } from './flow-urls.cjs'

export type CompanionPairing = { code: string; expiresAt: string }
function invalid(message: string): never { throw new StorageError('INVALID_REQUEST', message) }
type Pending = { projectId?: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

/** Local IPC, not a Google API. No browser profile, credential, cookie or
 * arbitrary file/JavaScript endpoint is exposed to the extension or web pages. */
export class FlowCompanion {
  private server?: Server
  private sockets?: WebSocketServer
  private socket?: WebSocket
  private heartbeat?: NodeJS.Timeout
  private lastSeen = 0
  private token?: Buffer
  private expires = 0
  private port = 0
  private pending = new Map<string, Pending>()
  private cancelledScopes = new Set<string>()
  private pairing?: Promise<CompanionPairing>
  private connection: FlowConnection = { state: 'not-connected', message: 'Pair the Frame Studio companion with one already-signed-in Flow tab in normal Chrome.', pageTitle: null, checkedAt: null }
  constructor(private readonly downloads: string, private readonly nativeSubmit?: (url: string, title: string) => Promise<void>) {}
  status(): FlowConnection { return { ...this.connection } }
  pairingCode(): string {
    if (!this.token || Date.now() > this.expires) invalid('Pairing code expired or was already used. Create a new pairing code.')
    return `${this.port}.${this.token.toString('hex')}`
  }
  async pair(): Promise<CompanionPairing> {
    if (this.pairing) return this.pairing
    this.pairing = this.beginPair()
    try { return await this.pairing } finally { this.pairing = undefined }
  }
  private async beginPair(): Promise<CompanionPairing> {
    await this.close()
    this.token = randomBytes(32); this.expires = Date.now() + 5 * 60_000
    const server = this.server = createServer((_req, res) => { res.writeHead(404); res.end() })
    const sockets = this.sockets = new WebSocketServer({ noServer: true, maxPayload: 1_000_000, perMessageDeflate: false })
    server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/companion' || !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin ?? '') || req.headers.host !== `127.0.0.1:${this.port}` || !this.token || Date.now() > this.expires || this.socket) { socket.destroy(); return }
      sockets.handleUpgrade(req, socket, head, ws => this.accept(ws))
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
    const address = server.address()
    if (!address || typeof address === 'string') invalid('Could not start the local companion bridge.')
    this.port = address.port
    this.connection = { state: 'opening', message: 'Open the companion on your signed-in Flow tab and paste the pairing code. Code expires in five minutes.', pageTitle: null, checkedAt: null }
    return { code: `${this.port}.${this.token.toString('hex')}`, expiresAt: new Date(this.expires).toISOString() }
  }
  private accept(ws: WebSocket) {
    let authenticated = false
    const timeout = setTimeout(() => ws.close(), 5000)
    ws.on('error', () => ws.close())
    ws.on('message', raw => {
      try {
        const data = JSON.parse(raw.toString()) as Record<string, unknown>
        if (!authenticated) {
          if (data.type !== 'pair' || typeof data.token !== 'string' || !/^[0-9a-f]{64}$/.test(data.token) || !this.token || Date.now() > this.expires || this.socket || !timingSafeEqual(Buffer.from(data.token, 'hex'), this.token) || typeof data.url !== 'string' || !allowedFlowPage(data.url)) { ws.close(); return }
          authenticated = true; clearTimeout(timeout); this.token = undefined; this.socket = ws; this.lastSeen = Date.now()
          this.connection = { state: 'opening', message: 'Companion paired. Checking the selected Flow workspace…', pageTitle: null, checkedAt: null }
          ws.send(JSON.stringify({ type: 'paired' }))
          this.heartbeat = setInterval(() => {
            if (Date.now() - this.lastSeen > 45_000) ws.close()
            else if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
          }, 20_000)
          void this.check()
          return
        }
        this.lastSeen = Date.now()
        if (data.type === 'pong') return
        if (data.type === 'detached') { ws.close(); return }
        if (data.type !== 'reply' || typeof data.id !== 'string') return
        const item = this.pending.get(data.id)
        if (!item) return
        this.pending.delete(data.id); clearTimeout(item.timer)
        if (item.projectId && data.projectId !== item.projectId) item.reject(new StorageError('INVALID_REQUEST', 'Flow reply project ownership is ambiguous. No result was accepted.'))
        else if (data.ok === true) item.resolve(data.value)
        else item.reject(new StorageError('INVALID_REQUEST', typeof data.error === 'string' ? data.error.slice(0, 1500) : 'The companion action could not be verified.'))
      } catch { ws.close() }
    })
    ws.on('close', () => {
      clearTimeout(timeout)
      if (this.socket !== ws) return
      this.socket = undefined; clearInterval(this.heartbeat)
      this.connection = { ...this.connection, state: 'not-connected', message: 'Companion disconnected. Pair again and resume existing results; uncertain jobs are never resubmitted.' }
      this.rejectPending()
    })
  }
  private rejectPending() {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new StorageError('INVALID_REQUEST', 'Companion connection ended. If a generation was submitted, use Resume result collection, not Regenerate.')) }
    this.pending.clear()
  }
  private async request<T>(action: string, payload: unknown = {}, projectId?: string, dispatch?: FlowCommandDispatch): Promise<T> {
    if (dispatch) return dispatch(action, () => this.request<T>(action, payload, projectId))
    if (projectId && this.cancelledScopes.has(projectId)) invalid('Project deleted. No further Flow actions will be sent for this project.')
    const ws = this.socket
    if (!ws || ws.readyState !== WebSocket.OPEN) invalid('Pair the companion extension with your signed-in Flow tab first.')
    const id = randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new StorageError('INVALID_REQUEST', `Flow companion timed out during ${action}. No command is automatically repeated.`)) }, action === 'attach' ? 600_000 : action === 'download' ? 300_000 : 180_000)
      this.pending.set(id, { projectId, resolve: value => resolve(value as T), reject, timer })
      ws.send(JSON.stringify({ type: 'command', id, action, payload, ...(projectId ? { projectId } : {}) }), error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error) } })
    })
  }
  async connect(): Promise<FlowConnection> { return this.check() }
  async check(): Promise<FlowConnection> {
    if (!this.socket) return this.status()
    try {
      const value = await this.request<{ url: string; title: string; ready: boolean; companionVersion?: string; adapterVersion?: string }>('inspect')
      if (!value || typeof value.url !== 'string' || !allowedFlowPage(value.url) || value.ready !== true) invalid('Selected tab is not a signed-in Flow workspace. Finish sign-in manually and reconnect the companion.')
      if (!['0.1.6','0.1.7','0.1.8','0.1.9','0.1.10'].includes(value.companionVersion??'')) invalid('Old Flow companion code is still loaded. Use Flow Bridge from this app, reload it in chrome://extensions, refresh the Flow tab, then pair again.')
      if (value.adapterVersion !== '0.1.6-fast.24') invalid(`Flow tab is running ${value.adapterVersion || 'an older adapter'}. Reload companion 0.1.6-fast.24 in chrome://extensions, refresh the Flow tab, then pair again. The current fixes are not loaded in that tab yet.`)
      this.connection = { state: 'connected', message: `Flow companion ${value.companionVersion} connected to your selected Flow tab. Live generation compatibility still requires verification.`, pageTitle: String(value.title).slice(0, 200), checkedAt: new Date().toISOString() }
    } catch (error) { this.connection = { ...this.connection, state: 'needs-attention', message: error instanceof Error ? error.message : 'Could not verify the selected Flow tab.', checkedAt: new Date().toISOString() } }
    return this.status()
  }
  async show(): Promise<FlowConnection> { if (this.socket) await this.request('show'); return this.status() }
  async createProject(commit: (url: string) => Promise<void>, scope?: string): Promise<string> {
    const result = await this.request<{ url: string }>('createProject', {}, scope)
    if (!result || !validProject(result.url)) invalid('The companion could not verify the new Flow project link. Do not repeat creation; recover the existing project.')
    await commit(result.url)
    return result.url
  }
  async nameProject(url: string, name: string, scope?: string): Promise<void> {
    if (!validProject(url) || typeof name !== 'string' || !name.trim() || name.length > 120) invalid('Invalid Flow project name.')
    const value = await this.request<{ name?: string }>('nameProject', { url, name }, scope)
    if (value?.name !== name) invalid('Flow did not confirm the software project name. Nothing was submitted.')
  }
  private async photo(file: string) {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 20 * 1024 * 1024) invalid('A project reference is not a regular image under 20 MB.')
    const extension = path.extname(file).toLowerCase()
    const type = ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' } as Record<string, string>)[extension]
    if (!type) invalid('Unsupported project reference type.')
    return { name: path.basename(file), type, base64: (await readFile(file)).toString('base64') }
  }
  private async preparationStep<T>(action:string,payload:unknown,scope?:string,dispatch?:FlowCommandDispatch):Promise<T>{
    for(let retry=0;;retry++){
      try{return await this.request<T>(action,payload,scope,dispatch)}
      catch(error){if(retry>=2||!/scoped editor|retain.*prompt|marked Flow editor|multiple Add to prompt|Tabs cannot be edited/i.test(error instanceof Error?error.message:''))throw error}
    }
  }
  async prepare(url: string, request: FlowRequest, report?: FlowReporter, scope?: string, dispatch?: FlowCommandDispatch): Promise<string[]> {
    if (!validProject(url)) invalid('Invalid Flow project URL.')
    const { files, startFrame, referenceLabels, ...settings } = request
    report?.({ id: 'prompt-settings', label: 'Flow prompt and settings', state: 'running', detail: `Opening the linked project; applying ${request.outputType === 'post' ? 'image' : 'video'} mode, requested settings and the saved prompt. Photos are not uploaded in this step.` })
    const preparation = await this.preparationStep<{ sourceRatio?: string; targetRatio?: string; automaticCrop?: boolean }>('prepare', { url, ...settings, continuation: !!startFrame }, scope, dispatch)
    const ratioNote = preparation?.sourceRatio && preparation.targetRatio ? ` Flow source ${preparation.sourceRatio}; theme output ${preparation.targetRatio}.${preparation.automaticCrop ? ' The downloaded result will be cropped automatically to the theme dimensions.' : ''}` : ''
    report?.({ id: 'prompt-settings', label: 'Flow prompt and settings', state: 'done', detail: `Chrome companion confirmed the saved prompt and settings.${ratioNote}` })
    if (startFrame) {
      report?.({ id: 'start-frame', label: 'Previous approved scene: start frame', state: 'running', detail: 'Uploading and waiting for its attachment to appear in the Flow composer.' })
      await this.preparationStep('attach', { url, kind: 'startFrame', file: await this.photo(startFrame) }, scope, dispatch)
      report?.({ id: 'start-frame', label: 'Previous approved scene: start frame', state: 'done', detail: 'Companion confirmed the start-frame attachment is visible in Flow.' })
    }
    for (const [index, file] of files.entries()) {
      const label = referenceLabels?.[index] ?? `Reference photo ${index + 1}`
      report?.({ id: `reference-${index}`, label, state: 'running', detail: `Uploading ${index + 1} of ${files.length}; waiting for the attachment to appear in Flow.` })
      await this.preparationStep('attach', { url, kind: 'reference', file: await this.photo(file) }, scope, dispatch)
      report?.({ id: `reference-${index}`, label, state: 'done', detail: 'Companion confirmed this photo attachment is visible in the Flow composer.' })
    }
    report?.({ id: 'verify', label: 'Final prompt and reference check', state: 'running', detail: 'Checking attachment count, saved prompt and existing result IDs before submission.' })
    const baseline = await this.request<unknown>('baseline', { url, prompt: request.prompt, references: files.length, startFrame: !!startFrame }, scope, dispatch)
    if (!Array.isArray(baseline) || baseline.some(value => typeof value !== 'string') || baseline.length > 10000) invalid('Invalid Flow result baseline.')
    report?.({ id: 'verify', label: 'Final prompt and reference check', state: 'done', detail: `${files.length} reference photo(s)${startFrame ? ' and the start frame' : ''} confirmed. Generate has not been clicked by this preparation step.` })
    return baseline
  }
  async submit(url: string, scope?: string, dispatch?:FlowCommandDispatch): Promise<void> {
    if (!validProject(url)) invalid('Invalid Flow project.')
    const activate=async()=>{
    let ticket:{nonce?:string;title?:string}
    try{
      if (!this.nativeSubmit) invalid('The Windows Chrome submit driver is not configured. Nothing was clicked.')
      ticket = await this.request<{nonce?: string, title?: string}>('armSubmit', { url }, scope)
      if (!ticket || !/^[0-9a-f-]{36}$/i.test(ticket.nonce || '') || typeof ticket.title !== 'string' || !ticket.title.trim() || ticket.title.length > 500) invalid('Flow did not prepare a scoped submit ticket. Nothing was clicked.')
      if (scope && this.cancelledScopes.has(scope)) invalid('Project deleted before the native Generate click. Nothing was submitted by this action.')
    }catch(error){
      // This block ends before native activation, so retry cannot duplicate a click.
      throw new FlowNotSubmittedError(error instanceof Error?error.message:'Flow could not prepare its Generate control. Nothing was clicked.')
    }
    await this.nativeSubmit!(url, ticket.title!)
    return ticket
    }
    // Only selecting the tab, arming and clicking need exclusive foreground
    // ownership. Flow's acknowledgement can take seconds or time out; holding
    // the shared lock for it would stop every other prepared project.
    const ticket=dispatch?await dispatch('submit',activate):await activate()
    const acknowledgement = await this.request<{accepted?: boolean, evidence?: string} | null>('confirmSubmit', { url, nonce: ticket.nonce }, scope, dispatch)
    if (acknowledgement?.accepted !== true || !['prompt-cleared', 'new-generation-card', 'generation-progress'].includes(acknowledgement.evidence || '')) invalid('Flow submission was not acknowledged. Reload the updated companion and inspect the existing request before resuming collection. A click alone does not confirm submission.')
  }
  async results(url: string, prompt: string, outputType: string, baseline: string[], scope?: string): Promise<RemoteResult[]> {
    if (!validProject(url)) invalid('Invalid Flow project.')
    const results = await this.request<unknown>('results', { url, prompt, outputType, baseline }, scope)
    if (!Array.isArray(results) || results.length > 4 || results.some(item => !item || typeof item.id !== 'string' || typeof item.selector !== 'string')) invalid('Invalid Flow result association.')
    return results
  }
  async download(url: string, result: RemoteResult, directory: string, scope?: string): Promise<string> {
    if (!validProject(url)) invalid('Invalid Flow project.')
    const files = new FlowResultFiles(directory, url, result.id)
    const existing = await files.existing()
    if (existing) return existing
    // A stable, result-specific staging name survives lost replies/reconnects.
    // Reuse completed downloads instead of starting another browser download.
    const hex = createHash('sha256').update(url).update('\0').update(result.id).digest('hex')
    const nonce = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
    const staged: string[] = []
    for (const ext of ['png','jpg','jpeg','webp','mp4','mov','webm']) {
      const candidate = path.join(this.downloads, 'Frame Studio', `${nonce}.${ext}`)
      try { await lstat(candidate); staged.push(candidate) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      try { await lstat(`${candidate}.crdownload`); invalid('Result download is still pending in Chrome. It will be checked automatically without starting a second download.') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    if (staged.length > 1) invalid('Multiple staging files exist for this Flow result. Inspect the existing download.')
    const value = staged.length ? { filename: staged[0],originalMediaId:undefined,originalTitle:undefined } : await this.request<{ filename: string;originalMediaId?:string;originalTitle?:string }>('download', { url, result, nonce }, scope)
    if (!value || typeof value.filename !== 'string') invalid('The companion did not confirm the result download.')
    const resolved = path.resolve(value.filename), expectedFolder = path.resolve(this.downloads, 'Frame Studio')
    const named=/^(.+)_([a-f0-9]{8})(?: \(\d+\))?\.(?:png|jpe?g|webp|mp4|mov|webm)$/i.exec(path.basename(resolved))
    const canonical=(name:string)=>name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'')
    const stem=named?canonical(named[1]):'',title=typeof value.originalTitle==='string'&&value.originalTitle.length<=500?canonical(value.originalTitle):''
    const recovered=value.originalMediaId===result.id&&/^[0-9a-f-]{36}$/i.test(result.id)&&named?.[2].toLowerCase()===result.id.slice(0,8).toLowerCase()&&!!title&&(stem===title||stem.length>=16&&title.startsWith(stem))
    const folder=path.dirname(resolved).toLowerCase()
    if (!(folder===expectedFolder.toLowerCase()&&new RegExp(`^${nonce}\\.(?:png|jpe?g|webp|mp4|mov|webm)$`,'i').test(path.basename(resolved)))&&!(recovered&&[path.resolve(this.downloads).toLowerCase(),expectedFolder.toLowerCase()].includes(folder))) invalid('Chrome saved the file outside the expected Downloads/Frame Studio folder. Use manual import; arbitrary file paths are never read.')
    for (const candidate of [this.downloads, path.dirname(resolved), resolved]) if ((await lstat(candidate)).isSymbolicLink()) invalid('The download path is redirected; use manual import.')
    if ((await realpath(resolved)).toLowerCase() !== resolved.toLowerCase()) invalid('The downloaded file path is redirected.')
    const stat = await lstat(resolved)
    if (!stat.isFile() || stat.size < 16 || stat.size > 2_000_000_000) invalid('Flow result download is not a supported local file.')
    return files.store(resolved)
  }
  forProject(projectId: string, dispatch?: FlowCommandDispatch): FlowDriver {
    if (!UUID_PATTERN.test(projectId)) invalid('Invalid project scope.')
    this.cancelledScopes.delete(projectId)
    const send: FlowCommandDispatch = (kind, action) => dispatch ? dispatch(kind, action) : action()
    return {
      granularQueue: !!dispatch,
      createProject: commit => send('createProject', () => this.createProject(commit, projectId)),
      nameProject: (url, name) => send('nameProject', () => this.nameProject(url, name, projectId)),
      prepare: (url, request, report) => this.prepare(url, request, report, projectId, dispatch),
      submit: url => this.submit(url, projectId, dispatch),
      results: (url, prompt, outputType, baseline) => send('results', () => this.results(url, prompt, outputType, baseline, projectId)),
      download: (url, result, directory) => send('download', () => this.download(url, result, directory, projectId)),
      close: async () => { this.cancelledScopes.add(projectId) },
    }
  }
  async close(): Promise<FlowConnection> {
    this.token = undefined; this.expires = 0; clearInterval(this.heartbeat)
    this.rejectPending(); this.socket?.close(); this.socket = undefined
    this.sockets?.clients.forEach(ws => ws.terminate()); this.sockets?.close(); this.sockets = undefined
    const server = this.server; this.server = undefined
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
    this.connection = { state: 'not-connected', message: 'Companion disconnected. Your Chrome tabs and Google login were not changed.', pageTitle: null, checkedAt: null }
    return this.status()
  }
}
