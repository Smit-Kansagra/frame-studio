import { registerDiscovery } from './product-discovery.cjs'
import { registerReadyPacks } from './ready-packs.cjs'
import { isProductFindImage } from './product-find.cjs'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, protocol, session, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import os from 'node:os'
import { lstatSync, mkdirSync } from 'node:fs'
import { WorkspaceManager } from './workspace-manager.cjs'
import { isTrustedRendererUrl } from './security.cjs'
import { UUID_PATTERN } from './storage/paths.cjs'
import type { ExportSettings, FlowConnection, ImageSelection } from './contracts.cjs'
import { readPromptFile } from './storage/prompt-file.cjs'
import { failure, StorageError } from './storage/errors.cjs'
import { FLOW_HOME } from './flow-urls.cjs'
import { FlowCompanion } from './flow-companion.cjs'
import { nativeFlowSubmit } from './flow-native-submit.cjs'
import { FlowScheduler } from './flow-scheduler.cjs'
import { postPhotos } from './storage/post-plan.mjs'
import { validateRepairArea } from './media/logo-inpaint.cjs'

const appOrigin = 'frame-studio://app'
const devUrl = process.env.FRAME_STUDIO_DEV_URL

if (devUrl && devUrl !== 'http://127.0.0.1:5173') {
  throw new Error('The development address must be http://127.0.0.1:5173.')
}
if (app.isPackaged && devUrl) throw new Error('A packaged Frame Studio cannot load a development server.')

protocol.registerSchemesAsPrivileged([
  { scheme: 'frame-studio', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'frame-media', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

app.setName('Frame Studio')
app.setAppUserModelId('local.frame-studio')
const testProfile = process.env.FRAME_STUDIO_TEST_PROFILE
if (!testProfile) {
  // Keep the same per-user profile when a newer installer replaces the app files.
  const profile = path.join(app.getPath('appData'), 'Frame Studio')
  mkdirSync(profile, { recursive: true })
  app.setPath('userData', profile)
  app.setPath('sessionData', profile)
} else {
  const resolved = path.resolve(testProfile)
  if ((app.isPackaged && !process.argv.includes('--frame-studio-package-check')) || !path.isAbsolute(testProfile) || path.dirname(resolved) !== path.resolve(os.tmpdir()) || !/^frame-studio-check-[a-zA-Z0-9]+$/.test(path.basename(resolved))) throw new Error('Invalid isolated desktop-check profile.')
  const info = lstatSync(resolved)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The desktop-check profile must be a regular temporary directory.')
  app.setPath('userData', resolved)
  app.setPath('sessionData', resolved)
}
const primaryInstance = app.requestSingleInstanceLock()
let workspace: WorkspaceManager
let mainWindow: BrowserWindow | undefined
let quitPrepared = false
let flowBrowser: FlowCompanion
let flowCoordinator: FlowScheduler

function currentFlowStatus(): FlowConnection {
  const status = flowBrowser.status()
  return net.isOnline() ? status : { ...status, state: 'offline', message: 'Offline. Existing remote jobs are preserved; no automatic resubmission.' }
}

function registerFlowBridge() {
  ipcMain.handle('flow:results-folder', async (event, ...args: unknown[]) => {
    if (!authorized(event) || args.length !== 1 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0])) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid project folder request.' } }
    try {
      const ws = await workspace.automationWorkspace(), folder = await ws.generations.folder(args[0])
      const error = await shell.openPath(folder)
      return error ? { ok: false, error: { code: 'INVALID_REQUEST', message: error } } : { ok: true, value: null }
    } catch (error) { return failure(error) }
  })
  ipcMain.handle('flow:active-request', async (event, ...args: unknown[]) => {
    if (!authorized(event) || args.length > 1 || (args.length && (typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0])))) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid Flow status request.' } }
    try {
      const ws = await workspace.automationWorkspace(), attempt = ws.generations.active(args[0] as string | undefined) ?? ws.generations.active()
      if (!attempt) return { ok: true, value: null }
      if (args[0] && attempt.projectId !== args[0] && ws.flow.job(attempt.id)) return { ok: true, value: null }
      const project = await ws.projects.get(attempt.projectId)
      return { ok: true, value: { attemptId: attempt.id, projectId: attempt.projectId, projectName: project.name, state: attempt.state, automatic: !!ws.flow.job(attempt.id) } }
    } catch (error) { return failure(error) }
  })
  ipcMain.handle('flow:link-project', async (event, ...args: unknown[]) => {
    if (!authorized(event) || args.length !== 2 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0]) || typeof args[1] !== 'string' || args[1].length > 2048) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid Flow recovery request.' } }
    try { return { ok: true, value: await flowCoordinator.linkProject(args[0], args[1]) } } catch (error) { return failure(error) }
  })
  ipcMain.handle('flow:copy-pairing-code', (event, ...args: unknown[]) => {
    if (!authorized(event) || args.length) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid companion request.' } }
    // Write only our current one-time code; no arbitrary clipboard access or
    // clipboard reads are exposed to the renderer.
    try { clipboard.writeText(flowBrowser.pairingCode()); return { ok: true, value: null } } catch (error) { return failure(error) }
  })
  ipcMain.handle('flow:pair-companion', async (event, ...args: unknown[]) => {
    if (!authorized(event) || args.length) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid companion request.' } }
    if (flowCoordinator.busy && currentFlowStatus().state === 'connected') return { ok: false, error: { code: 'BUSY', message: 'Wait for the current Flow operation before changing its connection.' } }
    try { return { ok: true, value: await flowBrowser.pair() } } catch (error) { return failure(error) }
  })
  ipcMain.handle('flow:extension-folder', async (event, ...args: unknown[]) => {
    if (!authorized(event) || args.length) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid companion request.' } }
    const folder = app.isPackaged ? path.join(process.resourcesPath, 'flow-companion') : path.resolve(__dirname, '../extension')
    const error = await shell.openPath(folder)
    return error ? { ok: false, error: { code: 'INVALID_REQUEST', message: error } } : { ok: true, value: null }
  })
  for (const [channel, action] of [
    ['flow:status', () => currentFlowStatus()],
    ['flow:connect', () => flowCoordinator.busy ? currentFlowStatus() : flowBrowser.connect()],
    ['flow:open', () => flowCoordinator.busy ? currentFlowStatus() : flowBrowser.show()],
    ['flow:show', () => flowCoordinator.busy ? currentFlowStatus() : flowBrowser.show()],
    ['flow:check', () => flowCoordinator.busy ? currentFlowStatus() : flowBrowser.check()],
    ['flow:disconnect', async () => {
      return flowBrowser.close()
    }],
    ['flow:open-manual', async () => { await shell.openExternal(FLOW_HOME); return { ...currentFlowStatus(), message: 'Flow opened in your normal browser. Pair its tab using the companion extension.' } }],
  ] as const) ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!authorized(event) || args.length) return { state: 'needs-attention', message: 'Invalid Flow request.', pageTitle: null, checkedAt: null }
    if (!net.isOnline() && channel !== 'flow:disconnect') return currentFlowStatus()
    return action()
  })
  for (const channel of ['flow:project', 'flow:job', 'flow:jobs', 'flow:resume', 'flow:resume-posts','flow:retry'] as const) ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    if (!authorized(event) || args.length !== 1 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0])) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid Flow project request.' } }
    try {
      if (['flow:resume','flow:resume-posts','flow:retry'].includes(channel) && currentFlowStatus().state !== 'connected') return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Pair and recheck your normal Chrome Flow tab in Settings first.' } }
      const ws = await workspace.automationWorkspace(), id = args[0]
      const value = channel === 'flow:project' ? ws.flow.project(id) : channel === 'flow:job' ? ws.flow.latest(id) : channel === 'flow:jobs' ? ws.flow.jobs(id) : channel === 'flow:resume-posts' ? await flowCoordinator.resumePosts(id) : channel==='flow:retry'?await flowCoordinator.retry(id):await flowCoordinator.resume(id)
      return { ok: true, value }
    } catch (error) { return failure(error) }
  })
  ipcMain.handle('flow:generate', async (event, ...args: unknown[]) => {
    if (!authorized(event) || args.length !== 3 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0]) || typeof args[1] !== 'string' || (args[1] !== 'post' && !UUID_PATTERN.test(args[1])) || !Number.isInteger(args[2]) || Number(args[2]) < 1 || Number(args[2]) > 4) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid generation request.' } }
    if (currentFlowStatus().state !== 'connected') return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Pair and recheck your normal Chrome Flow tab in Settings first. Nothing was submitted.' } }
    try { return { ok: true, value: await flowCoordinator.start(args[0], args[1], Number(args[2])) } } catch (error) { return failure(error) }
  })
  ipcMain.handle('flow:generate-posts', async (event, ...args: unknown[]) => {
    if (!authorized(event) || args.length !== 1 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0])) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid product generation request.' } }
    if (currentFlowStatus().state !== 'connected') return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Pair and recheck your Chrome Flow tab in Settings first.' } }
    try { return { ok: true, value: await flowCoordinator.startPosts(args[0]) } } catch (error) { return failure(error) }
  })
}

if (!primaryInstance) app.quit()

function authorized(event: IpcMainInvokeEvent): boolean {
  return !!mainWindow && !mainWindow.isDestroyed() && event.sender.id === mainWindow.webContents.id && event.senderFrame === event.sender.mainFrame && isTrustedRendererUrl(event.senderFrame?.url ?? '', devUrl)
}

function registerBridge() {
  const denied = { ok: false, error: { code: 'UNAUTHORIZED', message: 'This operation is only available from the local application window.' } }
  const invalid = { ok: false, error: { code: 'INVALID_REQUEST', message: 'This request is invalid. Please try again from the application.' } }
  ipcMain.handle('projects:list', (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length) return invalid
    return workspace.projectOperation(projects => projects.list())
  })
  ipcMain.handle('projects:deleted', (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length) return invalid
    return workspace.projectOperation(projects => projects.deleted())
  })
  for (const channel of ['projects:trash', 'projects:restore', 'projects:delete-permanently'] as const) ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length !== 2 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0]) || !Number.isSafeInteger(args[1]) || Number(args[1]) < 1) return invalid
    if (channel === 'projects:trash') {
      const result = await workspace.projectOperation(projects => projects.trash(args[0] as string, Number(args[1])))
      if (result.ok) {
        void flowCoordinator.stopDeletedProject(args[0] as string).catch(() => undefined)
        void workspace.cancelExport(args[0] as string)
      }
      return result
    }
    if (picking) return { ok: false, error: { code: 'BUSY', message: 'Finish the current file operation or export before restoring a project.' } }
    try {
      if (channel === 'projects:delete-permanently') return await flowCoordinator.localProjectChange(() => workspace.projectOperation(projects => projects.deletePermanently(args[0] as string, Number(args[1]))), args[0] as string)
      return await flowCoordinator.localProjectChange(() => workspace.projectOperation(projects => projects.restore(args[0] as string, Number(args[1]))), args[0] as string)
    } catch (error) { return failure(error) }
  })
  ipcMain.handle('projects:get', (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length !== 1 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0])) return invalid
    return workspace.projectOperation(projects => projects.get(args[0] as string))
  })
  ipcMain.handle('projects:save', async (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length !== 1) return invalid
    // Save is local only. Creating/naming a Flow project, uploading references
    // and preparing its prompt belong exclusively to an explicit Generate.
    return workspace.projectOperation(projects => projects.save(args[0]))
  })
  for (const [channel, retry] of [['workspace:status', false], ['workspace:retry', true]] as const) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!authorized(event)) return denied
      if (args.length) return invalid
      return workspace.status(retry)
    })
  }
  ipcMain.handle('images:get', (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length !== 1 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0])) return invalid
    return workspace.asset(args[0])
  })
  let picking = false
  ipcMain.handle('images:choose-many-and-import', async (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length !== 1 || !Number.isSafeInteger(args[0]) || (args[0] as number) < 1 || (args[0] as number) > 20) return invalid
    const limit = args[0] as number
    if (picking) return { ok: false, error: { code: 'BUSY', message: 'Finish the current image import before choosing more photos.' } }
    picking = true
    try {
      const ready = await workspace.status()
      if (!ready.ok) return ready
      const choice = await dialog.showOpenDialog(mainWindow!, { title: 'Choose images', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] })
      if (choice.canceled || !choice.filePaths.length) return { ok: true, value: null }
      if (choice.filePaths.length > limit) return { ok: false, error: { code: 'INVALID_REQUEST', message: `Choose up to ${limit} more ${limit === 1 ? 'image' : 'images'}.` } }
      const selection: ImageSelection = { assets: [], failures: [] }
      for (const filename of choice.filePaths) {
        const result = await workspace.importImage(filename)
        if (result.ok) selection.assets.push(result.value)
        else selection.failures.push({ filename: path.basename(filename), message: result.error.message })
      }
      return { ok: true, value: selection }
    } catch { return { ok: false, error: { code: 'IMPORT_FAILED', message: 'The image picker could not open. Please try again.' } } }
    finally { picking = false }
  })
  ipcMain.handle('images:choose-and-import', async (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length) return invalid
    if (picking) return { ok: false, error: { code: 'BUSY', message: 'Finish choosing the current image before importing another.' } }
    picking = true
    try {
      const ready = await workspace.status()
      if (!ready.ok) return ready
      const choice = await dialog.showOpenDialog(mainWindow!, { title: 'Choose an image', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] })
      if (choice.canceled || !choice.filePaths.length) return { ok: true, value: null }
      return await workspace.importImage(choice.filePaths[0])
    } catch { return { ok: false, error: { code: 'IMPORT_FAILED', message: 'The image picker could not open. Please try again.' } } }
    finally { picking = false }
  })
  ipcMain.handle('products:list', (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length !== 1 || typeof args[0] !== 'string' || args[0].length > 200) return invalid
    return workspace.productOperation(products => products.list(args[0] as string))
  })
  for (const channel of ['products:get', 'products:undo'] as const) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!authorized(event)) return denied
      if (args.length !== 1 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0])) return invalid
      return workspace.productOperation(products => channel === 'products:get' ? products.get(args[0] as string) : products.undo(args[0] as string))
    })
  }
  ipcMain.handle('products:save', (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length !== 1) return invalid
    return workspace.productOperation(products => products.save(args[0]))
  })
  ipcMain.handle('products:remove', (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length !== 2 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0]) || !Number.isSafeInteger(args[1]) || (args[1] as number) < 1) return invalid
    return workspace.productOperation(products => products.remove(args[0] as string, args[1] as number))
  })
  ipcMain.handle('products:trash', (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length) return invalid
    return workspace.productOperation(products => products.trash())
  })
  ipcMain.handle('images:transform', (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length !== 2 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0])) return invalid
    return workspace.editImage(args[0], args[1])
  })
  for (const channel of ['themes:list', 'themes:trash'] as const) ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length) return invalid
    if (channel === 'themes:list') return workspace.themeOperation(themes => themes.list())
    return workspace.themeOperation(themes => themes.trash())
  })
  for (const channel of ['themes:get', 'themes:undo'] as const) ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length !== 1 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0])) return invalid
    return workspace.themeOperation(themes => channel === 'themes:get' ? themes.get(args[0] as string) : themes.undo(args[0] as string))
  })
  for (const channel of ['themes:remove', 'themes:duplicate'] as const) ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length !== 2 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0]) || !Number.isSafeInteger(args[1]) || (args[1] as number) < 1) return invalid
    if (channel === 'themes:remove') return workspace.themeOperation(themes => themes.remove(args[0] as string, args[1] as number))
    return workspace.themeOperation(themes => themes.duplicate(args[0] as string, args[1] as number))
  })
  ipcMain.handle('themes:save', (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length !== 1) return invalid
    return workspace.themeOperation(themes => themes.save(args[0]))
  })
  ipcMain.handle('themes:import-prompt', async (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length) return invalid
    if (picking) return { ok: false, error: { code: 'BUSY', message: 'Finish the current file selection first.' } }
    picking = true
    try {
      const choice = await dialog.showOpenDialog(mainWindow!, { title: 'Import a UTF-8 master prompt', properties: ['openFile'], filters: [{ name: 'UTF-8 text', extensions: ['txt'] }] })
      return { ok: true, value: choice.canceled || !choice.filePaths.length ? null : await readPromptFile(choice.filePaths[0]) }
    } catch (error) { return failure(error) }
    finally { picking = false }
  })
  for (const channel of ['characters:list', 'characters:trash'] as const) ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length) return invalid
    if (channel === 'characters:list') return workspace.characterOperation(characters => characters.list())
    return workspace.characterOperation(characters => characters.trash())
  })
  for (const channel of ['characters:get', 'characters:undo'] as const) ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length !== 1 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0])) return invalid
    return workspace.characterOperation(characters => channel === 'characters:get' ? characters.get(args[0] as string) : characters.undo(args[0] as string))
  })
  for (const channel of ['characters:remove', 'characters:duplicate'] as const) ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length !== 2 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0]) || !Number.isSafeInteger(args[1]) || (args[1] as number) < 1) return invalid
    if (channel === 'characters:remove') return workspace.characterOperation(characters => characters.remove(args[0] as string, args[1] as number))
    return workspace.characterOperation(characters => characters.duplicate(args[0] as string, args[1] as number))
  })
  ipcMain.handle('characters:save', (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length !== 1) return invalid
    return workspace.characterOperation(characters => characters.save(args[0]))
  })
  ipcMain.handle('generations:list', (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length !== 1 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0])) return invalid
    return workspace.generationOperation(generations => generations.list(args[0] as string))
  })
  ipcMain.handle('generations:reviews', (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length !== 1 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0])) return invalid
    return workspace.generationOperation(generations => generations.reviews(args[0] as string))
  })
  ipcMain.handle('generations:review', (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length !== 5 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0]) || typeof args[1] !== 'string' || (args[1] !== 'post' && !UUID_PATTERN.test(args[1])) || typeof args[2] !== 'string' || !UUID_PATTERN.test(args[2]) || !['pending', 'approved', 'needs-changes'].includes(args[3] as string) || typeof args[4] !== 'string' || args[4].length > 2000) return invalid
    return workspace.generationOperation(generations => generations.review(args[0] as string, args[1] as string, args[2] as string, args[3] as 'pending' | 'approved' | 'needs-changes', args[4] as string))
  })
  ipcMain.handle('generations:logo-reviews', (event,...args:unknown[]) => {
    if(!authorized(event))return denied
    if(args.length!==1||typeof args[0]!=='string'||!UUID_PATTERN.test(args[0]))return invalid
    return workspace.generationOperation(generations=>generations.logoReviews(args[0] as string))
  })
  ipcMain.handle('generations:approve-post',(event,...args:unknown[])=>{
    if(!authorized(event))return denied
    if(args.length!==2||typeof args[0]!=='string'||!UUID_PATTERN.test(args[0])||typeof args[1]!=='string'||args[1].length>2000||args[1].includes('\0'))return invalid
    return workspace.generationOperation(generations=>generations.approvePost(args[0] as string,args[1] as string))
  })
  ipcMain.handle('generations:approve-all',(event,...args:unknown[])=>{
    if(!authorized(event))return denied
    if(args.length!==2||typeof args[0]!=='string'||!UUID_PATTERN.test(args[0])||!Array.isArray(args[1])||!args[1].length||args[1].length>10000)return invalid
    return workspace.generationOperation(generations=>generations.approveAll(args[0] as string,args[1] as {attemptId:string;note:string}[]))
  })
  ipcMain.handle('generations:review-logo', (event,...args:unknown[]) => {
    if(!authorized(event))return denied
    if(args.length!==2||typeof args[0]!=='string'||!UUID_PATTERN.test(args[0])||!['approved','needs-changes'].includes(args[1] as string))return invalid
    return workspace.generationOperation(generations=>generations.reviewLogo(args[0] as string,args[1] as 'approved'|'needs-changes'))
  })
  ipcMain.handle('generations:retry-logo', (event,...args:unknown[]) => {
    if(!authorized(event))return denied
    if((args.length!==1&&args.length!==2)||typeof args[0]!=='string'||!UUID_PATTERN.test(args[0]))return invalid
    let area
    try{area=args.length===2?validateRepairArea(args[1]):undefined}catch{return invalid}
    return workspace.generationOperation(async generations=>{
      const ws=await workspace.automationWorkspace(),attempt=generations.get(args[0] as string)
      if(ws.exports.busy)throw new StorageError('BUSY','Wait for the local export to finish before retrying logo cleanup.')
      return generations.retryLogo(attempt.id,area)
    })
  })
  ipcMain.handle('generations:prepare', (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (flowCoordinator.busy) return { ok: false, error: { code: 'BUSY', message: 'Wait for the current automatic generation queue to finish.' } }
    if (args.length !== 2 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0]) || typeof args[1] !== 'string' || (args[1] !== 'post' && !UUID_PATTERN.test(args[1]))) return invalid
    return workspace.generationOperation(generations => generations.prepare(args[0] as string, args[1] as string))
  })
  ipcMain.handle('generations:set-state', (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (flowCoordinator.busy) return { ok: false, error: { code: 'BUSY', message: 'Wait for automatic Flow collection to finish or pause before changing this request.' } }
    if (args.length !== 2 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0]) || !['paused', 'queued', 'submission-uncertain', 'failed'].includes(args[1] as string)) return invalid
    return workspace.generationOperation(generations => generations.setState(args[0] as string, args[1] as 'paused' | 'queued' | 'submission-uncertain' | 'failed'))
  })
  ipcMain.handle('generations:import-result', async (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (flowCoordinator.busy) return { ok: false, error: { code: 'BUSY', message: 'Automatic Flow collection is active.' } }
    if (args.length !== 1 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0])) return invalid
    if (picking) return { ok: false, error: { code: 'BUSY', message: 'Finish the current result import before choosing another file.' } }
    picking = true
    try {
      const attempt = await workspace.generationOperation(generations => generations.get(args[0] as string))
      if (!attempt.ok) return attempt
      const filters = attempt.value.outputType === 'post' ? [{ name: 'Flow still image', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] : [{ name: 'Flow video', extensions: ['mp4', 'mov', 'webm'] }]
      const choice = await dialog.showOpenDialog(mainWindow!, { title: 'Import downloaded Flow result', properties: ['openFile'], filters })
      if (choice.canceled || !choice.filePaths.length) return { ok: true, value: null }
      return workspace.generationOperation(async generations => {
        const ws = await workspace.automationWorkspace()
        let removed=false
        if(attempt.value.outputType==='post')generations.beginLogoCleanup(attempt.value.id)
        let source:string
        try{source = attempt.value.outputType === 'post' ? await ws.exports.normalizeFlowResult(attempt.value.preset, choice.filePaths[0], attempt.value.id,(_detail,value)=>{removed=value},(percent,message)=>generations.logoProgress(attempt.value.id,percent,message)) : choice.filePaths[0]}
        catch(error){if(attempt.value.outputType==='post')generations.failLogoCleanup(attempt.value.id,'Local cleanup failed. Resume or retry the existing result.');throw error}
        const result = await generations.importResult(attempt.value.id, source)
        if(attempt.value.outputType==='post')generations.recordLogoCleanup(attempt.value.id,removed)
        await ws.paths.removeFlowStage(attempt.value.id).catch(() => {})
        return result
      })
    } catch { return { ok: false, error: { code: 'IMPORT_FAILED', message: 'The Flow result could not be imported. The original download has been left untouched.' } } }
    finally { picking = false }
  })
  ipcMain.handle('exports:inspect', (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length !== 1 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0])) return invalid
    return workspace.exportOperation(exports => exports.inspect(args[0] as string))
  })
  ipcMain.handle('exports:start', async (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length !== 2 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0]) || !args[1] || typeof args[1] !== 'object') return invalid
    if (picking) return { ok: false, error: { code: 'BUSY', message: 'Finish the current file operation before starting an export.' } }
    picking = true
    try {
      const project = await workspace.projectOperation(projects => projects.get(args[0] as string))
      if (!project.ok) return project
      const filters = project.value.outputType === 'reel' ? [{ name: 'MP4 video', extensions: ['mp4'] }] : [{ name: 'PNG image', extensions: ['png'] }, { name: 'JPEG image', extensions: ['jpg'] }]
      const imageIndex=postPhotos(project.value).findIndex(photo=>photo.id===((args[1] as ExportSettings).postSceneId??'post'))
      const suggestedName = project.value.outputType==='post' ? `Image ${Math.max(1,imageIndex+1)}.png` : `${project.value.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim() || 'Frame Studio export'}.mp4`
      const choice = await dialog.showSaveDialog(mainWindow!, { title: project.value.outputType === 'reel' ? 'Export finished Reel' : 'Export finished Post image', defaultPath: suggestedName, filters })
      if (choice.canceled || !choice.filePath) return { ok: true, value: null }
      return workspace.startExport(args[0] as string, args[1] as ExportSettings, choice.filePath, progress => mainWindow?.webContents.send('exports:progress', progress))
    } catch (error) { return failure(error) }
    finally { picking = false }
  })
  ipcMain.handle('exports:start-post-batch', async(event,...args:unknown[])=>{
    if(!authorized(event))return denied
    if(args.length!==1||typeof args[0]!=='string'||!UUID_PATTERN.test(args[0]))return invalid
    if(picking)return {ok:false,error:{code:'BUSY',message:'Finish the current file operation before exporting images.'}}
    picking=true
    try{
      const choice=await dialog.showOpenDialog(mainWindow!,{title:'Choose a folder for all approved images',properties:['openDirectory','createDirectory']})
      if(choice.canceled||!choice.filePaths[0])return {ok:true,value:null}
      return await workspace.exportOperation(exports=>exports.startPostBatch(args[0] as string,choice.filePaths[0],progress=>mainWindow?.webContents.send('exports:progress',progress)))
    }catch(error){return failure(error)}finally{picking=false}
  })
  ipcMain.handle('exports:cancel', (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length !== 1 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0])) return invalid
    return workspace.cancelExport(args[0] as string)
  })
  ipcMain.handle('exports:open-folder', async (event, ...args: unknown[]) => {
    if (!authorized(event)) return denied
    if (args.length !== 1 || typeof args[0] !== 'string' || !UUID_PATTERN.test(args[0])) return invalid
    try { const folder = await workspace.exportFolder(args[0] as string); const error = await shell.openPath(folder); return error ? { ok: false, error: { code: 'INVALID_REQUEST', message: `The export folder could not be opened: ${error}` } } : { ok: true, value: null } }
    catch (error) { return failure(error) }
  })
}

function createWindow() {
  const window = new BrowserWindow({
    title: 'Frame Studio',
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 760,
    backgroundColor: '#F6F5F1',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  })
  mainWindow = window
  window.on('closed', () => { mainWindow = undefined })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, destination) => {
    if (!isTrustedRendererUrl(destination, devUrl)) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.once('ready-to-show', () => window.show())

  const destination = devUrl ?? `${appOrigin}/index.html`
  void window.loadURL(destination).catch((error: Error) => {
    dialog.showErrorBox('Frame Studio could not open', `The local interface could not be loaded. Run npm run build, then npm start.\n\n${error.message}`)
    window.destroy()
    app.quit()
  })
}

if (primaryInstance) void app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const productImage = details.resourceType === 'image' && details.webContentsId === mainWindow?.webContents.id && isProductFindImage(details.url)
    callback({ cancel: !productImage && (!devUrl || !details.url.startsWith(`${devUrl}/`)) })
  })
  workspace = new WorkspaceManager(path.join(app.getPath('userData'), 'workspace'))
  void workspace.automationWorkspace().then(ws=>ws.generations.onLogoProgress(value=>mainWindow?.webContents.send('generations:logo-progress',value))).catch(()=>{})
  flowBrowser = new FlowCompanion(app.getPath('downloads'), nativeFlowSubmit(app.isPackaged ? path.join(process.resourcesPath, 'flow-native-submit.ps1') : path.join(app.getAppPath(), 'electron', 'flow-native-submit.ps1')))
  flowCoordinator = new FlowScheduler(() => workspace.automationWorkspace(), (id, dispatch) => flowBrowser.forProject(id, dispatch))
  // Independent of React/page focus; automatically recover downloads after a
  // temporary error, app restart or re-pair. Collection cannot submit work.
  const collectionTimer = setInterval(() => {
    if (currentFlowStatus().state === 'connected' && !quitPrepared) void flowCoordinator.collectPending().catch(() => {})
  }, 1000)
  collectionTimer.unref()
  registerBridge()
  registerFlowBridge()
  registerDiscovery(path.join(app.getPath('userData'), 'product-discovery'), authorized)
  registerReadyPacks(path.join(app.getPath('userData'), 'product-discovery'), authorized)

  protocol.handle('frame-media', async request => {
    const url = new URL(request.url)
    const match = /^\/([0-9a-f-]{36})\/(original|thumbnail)$/.exec(url.pathname)
    const attempt = /^\/([0-9a-f-]{36})$/.exec(url.pathname)
    const initiator = 'initiatorOrigin' in request ? request.initiatorOrigin : undefined
    const expectedOrigin = devUrl ?? appOrigin
    const validAsset = url.host === 'asset' && match && UUID_PATTERN.test(match[1])
    const validAttempt = url.host === 'attempt' && attempt && UUID_PATTERN.test(attempt[1])
    const exportId = /^\/([0-9a-f-]{36})$/.exec(url.pathname)
    const validExport = url.host === 'export' && exportId && UUID_PATTERN.test(exportId[1])
    if ((!validAsset && !validAttempt && !validExport) || url.search || !['GET', 'HEAD'].includes(request.method) || (initiator && initiator !== expectedOrigin)) return new Response('Not found', { status: 404 })
    try {
      const filename = validAttempt ? await workspace.attemptFile(attempt![1]) : validExport ? (await workspace.exportMedia(exportId![1])).path : await workspace.mediaFile(match![1], match![2] as 'original' | 'thumbnail')
      const response = await net.fetch(pathToFileURL(filename).toString(), { method: request.method, headers: request.headers })
      const headers = new Headers(response.headers)
      if (validAttempt) {
        const result = await workspace.generationOperation(generations => generations.resultFile(attempt![1]))
        if (!result.ok) return new Response('Result unavailable', { status: 404 })
        headers.set('Content-Type', result.value.mediaType)
      }
      if (validExport) {
        const result = await workspace.exportOperation(exports => exports.exportFile(exportId![1]))
        if (!result.ok) return new Response('Export unavailable', { status: 404 })
        headers.set('Content-Type', result.value.mediaType)
      }
      headers.set('X-Content-Type-Options', 'nosniff')
      headers.set('Cache-Control', 'no-store')
      return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers })
    } catch { return new Response('Image unavailable', { status: 404 }) }
  })

  // Only built interface assets can be read through this protocol.
  const rendererRoot = path.resolve(__dirname, '../dist')
  protocol.handle('frame-studio', (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'app' || !['GET', 'HEAD'].includes(request.method)) {
      return new Response('Not found', { status: 404 })
    }
    let relativePath: string
    try {
      relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    } catch {
      return new Response('Invalid path', { status: 400 })
    }
    const filePath = path.resolve(rendererRoot, relativePath)
    const relative = path.relative(rendererRoot, filePath)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(':')) {
      return new Response('Access denied', { status: 403 })
    }
    return net.fetch(pathToFileURL(filePath).toString()).catch(() => new Response('Not found', { status: 404 }))
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((error: Error) => {
  dialog.showErrorBox('Frame Studio could not start', error.message)
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('second-instance', () => {
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.focus()
})
app.on('before-quit', event => {
  if (!workspace || quitPrepared) return
  event.preventDefault()
  quitPrepared = true
  void (async () => { await flowBrowser.close(); await flowCoordinator.close(); await workspace.close() })().catch(() => undefined).finally(() => app.quit())
})
