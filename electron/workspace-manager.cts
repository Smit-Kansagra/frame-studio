import type { AppResult, AssetInfo, WorkspaceInfo } from './contracts.cjs'
import { failure,StorageError } from './storage/errors.cjs'
import { Workspace } from './storage/workspace.cjs'
import type { Products } from './storage/products.cjs'
import type { Themes } from './storage/themes.cjs'
import type { Characters } from './storage/characters.cjs'
import type { Projects } from './storage/projects.cjs'
import type { Generations } from './storage/generations.cjs'
import type { ExportSettings, ExportProgress } from './contracts.cjs'
import type { Exports } from './storage/exports.cjs'

export class WorkspaceManager {
  private opening: Promise<Workspace> | undefined
  private workspace: Workspace | undefined
  private failed = false
  private closing=false
  private readonly operations=new Set<Promise<unknown>>()
  constructor(private readonly folder: string) { this.begin() }

  private begin() {
    this.failed = false
    this.opening = Workspace.open(this.folder).then(workspace => { this.workspace = workspace; return workspace })
    // Initialization starts before the renderer asks for status. Handle rejection immediately.
    void this.opening.catch(() => { this.failed = true })
  }

  async status(retry = false): Promise<AppResult<WorkspaceInfo>> {
    if (retry && this.failed) this.begin()
    try { return { ok: true, value: await (await this.opening!).status() } }
    catch (error) { return failure(error) }
  }

  async importImage(filename: string): Promise<AppResult<AssetInfo>> {
    try { return { ok: true, value: await (await this.opening!).importImage(filename) } }
    catch (error) { return failure(error, 'IMPORT_FAILED') }
  }

  async asset(id: string): Promise<AppResult<AssetInfo>> {
    try { return { ok: true, value: (await this.opening!).getAsset(id) } }
    catch (error) { return failure(error) }
  }

  async mediaFile(id: string, kind: 'original' | 'thumbnail') { return (await this.opening!).mediaFile(id, kind) }
  async attemptFile(id: string) { return (await this.opening!).attemptFile(id) }

  async editImage(id: string, edit: unknown): Promise<AppResult<AssetInfo>> {
    try { return { ok: true, value: await (await this.opening!).editImage(id, edit) } }
    catch (error) { return failure(error) }
  }

  async themeOperation<T>(action: (themes: Themes) => T | Promise<T>): Promise<AppResult<T>> {
    try { return { ok: true, value: await action((await this.opening!).themes) } }
    catch (error) { return failure(error) }
  }

  async characterOperation<T>(action: (characters: Characters) => T | Promise<T>): Promise<AppResult<T>> {
    try { return { ok: true, value: await action((await this.opening!).characters) } }
    catch (error) { return failure(error) }
  }

  async projectOperation<T>(action: (projects: Projects) => T | Promise<T>): Promise<AppResult<T>> {
    try { return { ok: true, value: await action((await this.opening!).projects) } }
    catch (error) { return failure(error) }
  }

  async productOperation<T>(action: (products: Products) => T | Promise<T>): Promise<AppResult<T>> {
    try { return { ok: true, value: await action((await this.opening!).products) } }
    catch (error) { return failure(error) }
  }

  async generationOperation<T>(action: (generations: Generations) => T | Promise<T>): Promise<AppResult<T>> {
    if(this.closing)return failure(new StorageError('BUSY','Frame Studio is closing.'))
    const operation=(async():Promise<AppResult<T>>=>{try{return {ok:true,value:await action((await this.opening!).generations)}}catch(error){return failure(error)}})()
    this.operations.add(operation)
    try{return await operation}finally{this.operations.delete(operation)}
  }

  async exportOperation<T>(action: (exports: Exports) => T | Promise<T>): Promise<AppResult<T>> {
    if(this.closing)return failure(new StorageError('BUSY','Frame Studio is closing.'))
    const operation=(async():Promise<AppResult<T>>=>{try{return {ok:true,value:await action((await this.opening!).exports)}}catch(error){return failure(error)}})()
    this.operations.add(operation)
    try{return await operation}finally{this.operations.delete(operation)}
  }
  async startExport(projectId: string, settings: ExportSettings, destination: string, progress: (value: ExportProgress) => void) {
    return this.exportOperation(exports => exports.start(projectId, settings, destination, progress))
  }
  async cancelExport(projectId: string) { return this.exportOperation(exports => exports.cancel(projectId)) }
  async exportFolder(id: string) { return (await this.opening!).exports.openFolderPath(id) }
  async exportMedia(id: string) { return (await this.opening!).exportFile(id) }

  async close() {
    this.closing=true
    await this.opening?.catch(() => undefined)
    await this.workspace?.exports.cancelCurrent()
    await Promise.allSettled([...this.operations])
    await this.workspace?.close()
  }
  async automationWorkspace(): Promise<Workspace> { return this.opening! }
}
