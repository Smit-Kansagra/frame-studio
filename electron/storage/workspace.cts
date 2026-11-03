import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, copyFile, lstat, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AssetInfo, ImageTransform, StorageIssue, WorkspaceInfo } from '../contracts.cjs'
import { openDatabase, SCHEMA_VERSION, transaction } from './database.cjs'
import type { AssetRow, ImportRow } from './database.cjs'
import { StorageError } from './errors.cjs'
import { decodeImage, readImageSource, transformImage, validateImageTransform } from './images.cjs'
import { ManagedPaths, UUID_PATTERN } from './paths.cjs'
import { Products } from './products.cjs'
import { Themes } from './themes.cjs'
import { Characters } from './characters.cjs'
import { Projects } from './projects.cjs'
import { Generations } from './generations.cjs'
import { Exports } from './exports.cjs'
import { FlowState } from './flow-state.cjs'

function toAsset(row: AssetRow): AssetInfo {
  return { id: row.id, originalName: row.original_name, format: row.format, width: row.width, height: row.height, orientation: row.orientation, byteSize: row.byte_size, sha256: row.sha256, thumbnailWidth: row.thumbnail_width, thumbnailHeight: row.thumbnail_height, revision: row.revision, createdAt: row.created_at, originalUrl: `frame-media://asset/${row.id}/original`, thumbnailUrl: `frame-media://asset/${row.id}/thumbnail` }
}

export class Workspace {
  private queue: Promise<unknown> = Promise.resolve()
  private closing = false
  private recoveryIssues: StorageIssue[] = []
  readonly products: Products
  readonly themes: Themes
  readonly characters: Characters
  readonly projects: Projects
  readonly generations: Generations
  readonly exports: Exports
  readonly flow: FlowState
  private constructor(readonly paths: ManagedPaths, private readonly db: DatabaseSync) {
    this.flow = new FlowState(db)
    this.flow.recover()
    this.products = new Products(db, { enqueue: action => this.enqueue(action), asset: id => this.getAsset(id), media: (id, kind) => this.mediaFile(id, kind) })
    this.themes = new Themes(db, { enqueue: action => this.enqueue(action), asset: id => this.getAsset(id), media: (id, kind) => this.mediaFile(id, kind) })
    this.characters = new Characters(db, { enqueue: action => this.enqueue(action), asset: id => this.getAsset(id), media: (id, kind) => this.mediaFile(id, kind) })
    this.projects = new Projects(db, { enqueue: action => this.enqueue(action), product: id => this.products.get(id), theme: id => this.themes.get(id), character: id => this.characters.get(id) }, paths)
    this.generations = new Generations(db, paths, id => this.projects.get(id))
    this.exports = new Exports(db, paths, id => this.projects.get(id), id => this.generations.list(id), id => this.generations.reviews(id))
  }

  static async open(folder: string): Promise<Workspace> {
    const paths = await ManagedPaths.create(folder)
    const db = await openDatabase(paths.resolve('workspace.sqlite'))
    const workspace = new Workspace(paths, db)
    try {
      await workspace.reconcileImports()
      workspace.generations.recoverLogoCleanup()
      await workspace.generations.organizeResults().catch(() => workspace.recoveryIssues.push({ code: 'INTERRUPTED_IMPORT', message: 'Some saved results could not be organized into Final Projects. Their saved previews and files were preserved; organization will retry on reopening.' }))
      return workspace
    }
    catch (error) { db.close(); throw error }
  }

  getAsset(id: string): AssetInfo {
    const asset = toAsset(this.assetRow(id))
    const edit = this.db.prepare('SELECT source_asset_id, recipe FROM asset_edits WHERE asset_id = ?').get(id) as { source_asset_id: string; recipe: string } | undefined
    return edit ? { ...asset, edit: { ...JSON.parse(edit.recipe) as ImageTransform, sourceAssetId: edit.source_asset_id } } : asset
  }

  private assetRow(id: string): AssetRow {
    if (!UUID_PATTERN.test(id)) throw new StorageError('INVALID_REQUEST', 'The image identifier is invalid.')
    const row = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow | undefined
    if (!row) throw new StorageError('ASSET_NOT_FOUND', 'This image is no longer in the local library.')
    return row
  }

  async mediaFile(id: string, kind: 'original' | 'thumbnail'): Promise<string> {
    const row = this.assetRow(id)
    const relative = kind === 'original' ? row.original_path : row.thumbnail_path
    this.validateAssetPath(id, relative, kind)
    return this.paths.regularFile(relative)
  }

  async attemptFile(id: string) { return (await this.generations.resultFile(id)).path }
  async exportFile(id: string) { return this.exports.exportFile(id) }

  private validateAssetPath(id: string, relative: string, kind: 'original' | 'thumbnail') {
    const allowed = kind === 'thumbnail' ? relative === `library/thumbnails/${id}.webp` : relative === `library/edits/${id}.png` || ['jpeg', 'png', 'webp'].some(ext => relative === `library/originals/${id}.${ext}`)
    if (!UUID_PATTERN.test(id) || !allowed) throw new StorageError('INVALID_REQUEST', 'The saved image path is invalid. The record and its files were preserved.')
  }

  async status(): Promise<WorkspaceInfo> {
    const issues = [...this.recoveryIssues]
    const rows = this.db.prepare('SELECT * FROM assets ORDER BY created_at').all() as AssetRow[]
    for (const row of rows) {
      for (const kind of ['original', 'thumbnail'] as const) {
        try { await access(await this.mediaFile(row.id, kind), constants.R_OK) }
        catch (error) {
          const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
          issues.push({ code: missing ? 'MISSING_MEDIA' : 'UNREADABLE_MEDIA', assetId: row.id, message: `${row.original_name}: ${kind === 'original' ? 'original image' : 'thumbnail'} ${missing ? 'is missing' : 'cannot be read'}. Its saved record has been kept.` })
        }
      }
    }
    return { folder: this.paths.root, schemaVersion: SCHEMA_VERSION, assetCount: rows.length, issues }
  }

  importImage(source: string): Promise<AssetInfo> {
    return this.enqueue(() => this.performImport(source))
  }

  editImage(id: string, value: unknown): Promise<AssetInfo> {
    const edit = validateImageTransform(value)
    return this.enqueue(async () => {
      const selected = this.getAsset(id)
      const sourceId = selected.edit?.sourceAssetId ?? selected.id
      const source = this.getAsset(sourceId)
      const bytes = await readImageSource(await this.mediaFile(sourceId, 'original'))
      const result = await transformImage(bytes, edit)
      return this.performImport(source.originalName, { bytes: result, sourceAssetId: sourceId, recipe: edit })
    })
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new StorageError('STORAGE_UNAVAILABLE', 'The workspace is closing. Reopen the application to make changes.'))
    const operation = this.queue.then(action)
    this.queue = operation.catch(() => undefined)
    return operation
  }

  private async performImport(source: string, edit?: { bytes: Buffer; sourceAssetId: string; recipe: ImageTransform }): Promise<AssetInfo> {
    const bytes = edit?.bytes ?? await readImageSource(source)
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    this.db.prepare('INSERT INTO import_jobs(id, created_at) VALUES (?, ?)').run(id, createdAt)
    let originalPath: string | undefined
    let thumbnailPath: string | undefined
    try {
      await this.paths.directory(`temp/imports/${id}`)
      await writeFile(this.paths.resolve(`temp/imports/${id}/source`), bytes, { flag: 'wx' })
      const decoded = await decodeImage(bytes)
      originalPath = edit ? `library/edits/${id}.png` : `library/originals/${id}.${decoded.format}`
      thumbnailPath = `library/thumbnails/${id}.webp`
      await writeFile(this.paths.resolve(`temp/imports/${id}/thumbnail.webp`), decoded.thumbnail, { flag: 'wx' })
      this.db.prepare('UPDATE import_jobs SET original_path = ?, thumbnail_path = ? WHERE id = ?').run(originalPath, thumbnailPath, id)
      await this.paths.directory('library/originals')
      await this.paths.directory('library/edits')
      await this.paths.directory('library/thumbnails')
      await copyFile(this.paths.resolve(`temp/imports/${id}/source`), this.paths.resolve(originalPath), constants.COPYFILE_EXCL)
      await copyFile(this.paths.resolve(`temp/imports/${id}/thumbnail.webp`), this.paths.resolve(thumbnailPath), constants.COPYFILE_EXCL)
      transaction(this.db, () => {
        this.db.prepare(`INSERT INTO assets(id, original_name, format, width, height, orientation, byte_size, sha256, original_path, thumbnail_path, thumbnail_width, thumbnail_height, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(id, path.basename(source), decoded.format, decoded.width, decoded.height, decoded.orientation, bytes.length, createHash('sha256').update(bytes).digest('hex'), originalPath!, thumbnailPath!, decoded.thumbnailWidth, decoded.thumbnailHeight, createdAt, createdAt)
        if (edit) this.db.prepare('INSERT INTO asset_edits(asset_id, source_asset_id, recipe) VALUES (?, ?, ?)').run(id, edit.sourceAssetId, JSON.stringify(edit.recipe))
        this.db.prepare('DELETE FROM import_jobs WHERE id = ?').run(id)
      })
    } catch (error) {
      // If a write failed, retain the journal until all disposable copies are gone.
      await this.cleanupJob({ id, original_path: originalPath ?? null, thumbnail_path: thumbnailPath ?? null, created_at: createdAt }).catch(() => {
        this.recoveryIssues.push({ code: 'INTERRUPTED_IMPORT', message: 'An incomplete image import needs cleanup on the next restart. Existing images were preserved.' })
      })
      throw error
    }
    // A committed asset remains successful even if temporary cleanup must wait.
    await this.paths.removeImportStage(id).catch(() => {
      this.recoveryIssues.push({ code: 'INTERRUPTED_IMPORT', message: 'An image was saved, but its temporary copy could not be removed. Cleanup will be retried on restart.' })
    })
    return this.getAsset(id)
  }

  private async cleanupJob(job: ImportRow) {
    if (!UUID_PATTERN.test(job.id)) throw new StorageError('INVALID_REQUEST', 'An interrupted import has an invalid identifier; its files were preserved.')
    const committed = this.db.prepare('SELECT id FROM assets WHERE id = ?').get(job.id)
    if (!committed) {
      for (const [relative, kind] of [[job.original_path, 'original'], [job.thumbnail_path, 'thumbnail']] as const) {
        if (!relative) continue
        this.validateAssetPath(job.id, relative, kind)
        if (this.db.prepare('SELECT id FROM assets WHERE original_path = ? OR thumbnail_path = ?').get(relative, relative)) continue
        const target = this.paths.resolve(relative)
        const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
        if (stat) { await this.paths.regularFile(relative); await rm(target) }
      }
    }
    await this.paths.removeImportStage(job.id)
    this.db.prepare('DELETE FROM import_jobs WHERE id = ?').run(job.id)
  }

  private async reconcileImports() {
    const jobs = this.db.prepare('SELECT * FROM import_jobs').all() as ImportRow[]
    for (const job of jobs) {
      await this.cleanupJob(job).catch(() => this.recoveryIssues.push({ code: 'INTERRUPTED_IMPORT', message: 'An interrupted import could not be cleaned up. Its files were preserved for recovery.' }))
    }
    // A crash after commit can leave a stage directory without a journal row.
    for (const entry of await readdir(this.paths.resolve('temp/imports'), { withFileTypes: true })) {
      if (!UUID_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        this.recoveryIssues.push({ code: 'INTERRUPTED_IMPORT', message: 'An unrecognised temporary entry was preserved for inspection.' })
        continue
      }
      if (this.db.prepare('SELECT id FROM import_jobs WHERE id = ?').get(entry.name)) continue
      await this.paths.removeImportStage(entry.name).catch(() => this.recoveryIssues.push({ code: 'INTERRUPTED_IMPORT', message: 'A temporary import copy could not be cleaned up. It has been preserved.' }))
    }
  }

  async close() { this.closing = true; await this.queue; this.db.close() }
}
