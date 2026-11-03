import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { CharacterInfo, DeletedProjectInfo, ProductInfo, ProjectDraft, ProjectInfo, ProjectPreset, ProjectScene, ProjectSnapshot, ProjectStoryboard, ThemeInfo } from '../contracts.cjs'
import { transaction } from './database.cjs'
import { StorageError } from './errors.cjs'
import { UUID_PATTERN } from './paths.cjs'
import type { ManagedPaths } from './paths.cjs'
import { rm } from 'node:fs/promises'
import { presetForTheme } from './output-policy.mjs'
import { resultFolder, validResultPath } from './result-paths.cjs'

const presets: Record<ProjectPreset, { outputType: 'post' | 'reel'; ratio: string }> = {
  'reel-vertical': { outputType: 'reel', ratio: '9:16' },
  'reel-landscape': { outputType: 'reel', ratio: '16:9' },
  'post-square': { outputType: 'post', ratio: '1:1' },
  'post-portrait': { outputType: 'post', ratio: '4:5' },
  'post-story': { outputType: 'post', ratio: '9:16' },
  'post-tall': { outputType: 'post', ratio: '3:4' },
  'post-landscape': { outputType: 'post', ratio: '1.91:1' },
}
type Row = { id: string; name: string; content: string; snapshot: string; revision: number; created_at: string; updated_at: string; trashed_at: string | null }
type Dependencies = {
  enqueue: <T>(action: () => Promise<T>) => Promise<T>
  product: (id: string) => Promise<ProductInfo>
  theme: (id: string) => Promise<ThemeInfo>
  character: (id: string) => Promise<CharacterInfo>
}
function invalid(message: string): never { throw new StorageError('INVALID_PROJECT', message) }
export function validateProjectDraft(value: unknown): ProjectDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('The project setup is invalid.')
  const draft = value as Record<string, unknown>
  if (Object.keys(draft).some(key => !['id', 'expectedRevision', 'name', 'productId', 'themeId', 'characterId', 'outputType', 'preset', 'duration', 'storyboard'].includes(key))) invalid('The project contains an unknown field.')
  if (draft.id !== undefined && (typeof draft.id !== 'string' || !UUID_PATTERN.test(draft.id) || !Number.isSafeInteger(draft.expectedRevision) || (draft.expectedRevision as number) < 1)) invalid('Reopen the project before saving changes.')
  if (draft.id === undefined && draft.expectedRevision !== undefined) invalid('Reopen the project before saving changes.')
  if (typeof draft.name !== 'string' || draft.name.length > 120 || draft.name.includes('\0')) invalid('Keep the project name to 120 characters or fewer.')
  for (const field of ['productId', 'themeId'] as const) if (typeof draft[field] !== 'string' || !UUID_PATTERN.test(draft[field])) invalid(`Choose a ${field === 'productId' ? 'product' : 'theme'} from your library.`)
  if (draft.characterId !== null && (typeof draft.characterId !== 'string' || !UUID_PATTERN.test(draft.characterId))) invalid('Choose a saved character or Product only.')
  if (draft.outputType !== 'post' && draft.outputType !== 'reel') invalid('Choose Post or Reel.')
  if (typeof draft.preset !== 'string' || !Object.hasOwn(presets, draft.preset) || presets[draft.preset as ProjectPreset].outputType !== draft.outputType) invalid('Choose dimensions compatible with Post or Reel.')
  if (typeof draft.duration !== 'number' || !Number.isFinite(draft.duration) || (draft.outputType === 'reel' ? draft.duration < 0.1 || draft.duration > 600 : draft.duration !== 0)) invalid('Reel duration must be between 0.1 and 600 seconds. Posts have no duration.')
  return { ...(draft.id ? { id: draft.id as string, expectedRevision: draft.expectedRevision as number } : {}), name: draft.name.trim(), productId: draft.productId as string, themeId: draft.themeId as string, characterId: draft.characterId as string | null, outputType: draft.outputType, preset: draft.preset as ProjectPreset, duration: draft.duration, ...(draft.storyboard !== undefined ? { storyboard: validateStoryboard(draft.storyboard, draft.outputType) } : {}) }
}
function validateStoryboard(value: unknown, outputType: unknown): ProjectStoryboard {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('The project storyboard is invalid.')
  const board = value as Record<string, unknown>
  if (Object.keys(board).some(key => !['scenes', 'compositionPrompt'].includes(key))) invalid('The project storyboard contains an unknown field.')
  if (typeof board.compositionPrompt !== 'string' || board.compositionPrompt.length > 20000 || board.compositionPrompt.includes('\0')) invalid('Keep the composition prompt to 20,000 characters or fewer.')
  if (!Array.isArray(board.scenes) || board.scenes.length > 30 || (outputType === 'reel' ? !board.scenes.length : board.scenes.length !== 0)) invalid('A Reel needs 1–30 scenes. A Post uses one composition instead of scenes.')
  const ids = new Set<string>()
  const scenes = board.scenes.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`Scene ${index + 1} is invalid.`)
    const scene = value as Record<string, unknown>
    if (Object.keys(scene).some(key => !['id', 'name', 'prompt', 'sourceDuration', 'editDuration', 'relationship', 'transition'].includes(key))) invalid(`Scene ${index + 1} contains an unknown field.`)
    if (typeof scene.id !== 'string' || !UUID_PATTERN.test(scene.id) || ids.has(scene.id)) invalid('Every project scene needs a unique identifier.')
    ids.add(scene.id)
    if (typeof scene.name !== 'string' || !scene.name.trim() || scene.name.length > 120 || scene.name.includes('\0')) invalid(`Scene ${index + 1} needs a name of 120 characters or fewer.`)
    if (typeof scene.prompt !== 'string' || !scene.prompt.trim() || scene.prompt.length > 20000 || scene.prompt.includes('\0')) invalid(`Scene ${index + 1} needs a prompt of 20,000 characters or fewer.`)
    for (const field of ['sourceDuration', 'editDuration'] as const) if (typeof scene[field] !== 'number' || !Number.isFinite(scene[field]) || (scene[field] as number) < 0.1 || (scene[field] as number) > 600) invalid(`Scene ${index + 1}: source and timeline durations must each be between 0.1 and 600 seconds.`)
    if (!['new-shot', 'continue'].includes(scene.relationship as string) || (index === 0 && scene.relationship !== 'new-shot')) invalid('The first project scene must start a new shot. Choose a valid relationship for every scene.')
    if (scene.transition !== 'cut') invalid('Only hard-cut transitions are supported.')
    return { id: scene.id, name: scene.name.trim(), prompt: scene.prompt.trim(), sourceDuration: scene.sourceDuration as number, editDuration: scene.editDuration as number, relationship: scene.relationship as 'new-shot' | 'continue', transition: 'cut' as const }
  }) as ProjectScene[]
  return { scenes, compositionPrompt: board.compositionPrompt.trim() }
}
const storyboardFromTheme = (theme: ThemeInfo): ProjectStoryboard => ({ scenes: theme.scenes.map(({ duration, ...scene }) => ({ ...scene, sourceDuration: duration, editDuration: duration })), compositionPrompt: theme.compositionPrompt })
export class Projects {
  constructor(private readonly db: DatabaseSync, private readonly deps: Dependencies, private readonly paths: ManagedPaths) {}
  private row(id: string, includeDeleted = false): Row {
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) throw new StorageError('INVALID_REQUEST', 'The project identifier is invalid.')
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined
    if (!row || (row.trashed_at && !includeDeleted)) throw new StorageError('PROJECT_NOT_FOUND', 'This project was deleted or is no longer available. Restore it from Deleted projects in Studio.')
    return row
  }
  async get(id: string): Promise<ProjectInfo> {
    const row = this.row(id)
    const content = JSON.parse(row.content) as ProjectDraft, snapshot = JSON.parse(row.snapshot) as ProjectSnapshot
    return { ...content, preset: presetForTheme(snapshot.theme), storyboard: content.storyboard ?? storyboardFromTheme(snapshot.theme), id: row.id, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, snapshot }
  }
  async list(): Promise<ProjectInfo[]> {
    const rows = this.db.prepare('SELECT id FROM projects WHERE trashed_at IS NULL ORDER BY updated_at DESC, id').all() as { id: string }[]
    return Promise.all(rows.map(row => this.get(row.id)))
  }
  async deleted(): Promise<DeletedProjectInfo[]> {
    return (this.db.prepare('SELECT id, name, revision, trashed_at FROM projects WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC, id').all() as Row[]).map(row => ({ id: row.id, name: row.name, revision: row.revision, deletedAt: row.trashed_at! }))
  }
  isDeleted(id: string): boolean { return !!this.row(id, true).trashed_at }
  trash(id: string, expectedRevision: number): Promise<DeletedProjectInfo> {
    return this.deps.enqueue(async () => {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) invalid('Invalid project revision.')
      const row = this.row(id, true)
      if (row.trashed_at) return { id, name: row.name, revision: row.revision, deletedAt: row.trashed_at }
      // Deletion intentionally applies to the latest saved revision, even if a
      // save completed after the user opened the card/editor.
      const now = new Date().toISOString(), revision = row.revision + 1
      this.changeTrashState(row, now, revision, now)
      return { id, name: row.name, revision, deletedAt: now }
    })
  }
  restore(id: string, expectedRevision: number): Promise<ProjectInfo> {
    return this.deps.enqueue(async () => {
      const row = this.row(id, true)
      if (!row.trashed_at || row.revision !== expectedRevision) throw new StorageError('PROJECT_CHANGED', 'This deleted project changed. Refresh Deleted projects before restoring.')
      this.changeTrashState(row, null, row.revision + 1, new Date().toISOString())
      return this.get(id)
    })
  }
  deletePermanently(id: string, expectedRevision: number): Promise<{ cleanupWarnings: number }> {
    return this.deps.enqueue(async () => {
      const row = this.row(id, true)
      if (!row.trashed_at || row.revision !== expectedRevision) throw new StorageError('PROJECT_CHANGED', 'Refresh Deleted projects before permanently deleting this project.')
      const attempts = this.db.prepare('SELECT id, result_path FROM generation_attempts WHERE project_id = ?').all(id) as { id: string; result_path: string | null }[]
      const files: string[] = []
      // Resolve exact managed attempt files before changing records. External
      // exports/downloads and shared library originals are never deletion targets.
      for (const attempt of attempts) if (attempt.result_path) {
        if (!validResultPath(id, attempt.id, attempt.result_path)) invalid('A saved project result path is invalid. No project was permanently deleted.')
        try { files.push(await this.paths.regularFile(attempt.result_path)) }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
      }
      transaction(this.db, () => {
        for (const table of ['flow_jobs', 'flow_projects', 'project_exports', 'logo_reviews', 'scene_reviews', 'generation_attempts', 'project_assets', 'project_revisions']) this.db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(id)
        this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
      })
      let cleanupWarnings = 0
      for (const file of files) { try { await rm(file) } catch { cleanupWarnings++ } }
      for (const attempt of attempts) { try { await this.paths.removeFlowStage(attempt.id) } catch { cleanupWarnings++ } }
      return { cleanupWarnings }
    })
  }
  private changeTrashState(row: Row, deletedAt: string | null, revision: number, now: string) {
    // Keep all snapshots, original photos, attempts, approvals and remote links.
    // A new revision prevents an old open editor from overwriting a restore.
    transaction(this.db, () => {
      this.db.prepare('UPDATE projects SET trashed_at = ?, revision = ?, updated_at = ? WHERE id = ?').run(deletedAt, revision, now, row.id)
      if (deletedAt) {
        const reason = 'Project deleted. Local processing was abandoned by the owner. Any already-submitted Google Flow job may still run remotely; submission must not be retried automatically.'
        this.db.prepare("UPDATE generation_attempts SET state = 'failed', error = ?, updated_at = ? WHERE project_id = ? AND state IN ('queued','paused','submission-uncertain')").run(reason, now, row.id)
        for (const item of this.db.prepare('SELECT attempt_id, content FROM flow_jobs WHERE project_id = ?').all(row.id) as { attempt_id: string; content: string }[]) {
          const job = JSON.parse(item.content) as import('../contracts.cjs').FlowJob
          if (job.stage === 'complete') continue
          const activity = job.activity?.map(step => step.state === 'running' ? { ...step, state: step.id === 'submit' ? 'uncertain' : 'error', detail: reason, updatedAt: now } : step)
          this.db.prepare('UPDATE flow_jobs SET content = ? WHERE attempt_id = ?').run(JSON.stringify({ ...job, abandoned: true, stage: 'needs-attention', message: reason, activity, updatedAt: now }), item.attempt_id)
        }
      }
      this.db.prepare('INSERT INTO project_revisions(project_id, revision, content, snapshot, created_at) VALUES (?, ?, ?, ?, ?)').run(row.id, revision, row.content, row.snapshot, now)
      this.db.prepare('INSERT INTO project_assets(project_id, revision, asset_id) SELECT project_id, ?, asset_id FROM project_assets WHERE project_id = ? AND revision = ?').run(revision, row.id, row.revision)
    })
  }
  save(value: unknown): Promise<ProjectInfo> {
    const draft = validateProjectDraft(value)
    return this.deps.enqueue(async () => {
      const previous = draft.id ? this.row(draft.id) : undefined
      if (previous && previous.revision !== draft.expectedRevision) throw new StorageError('PROJECT_CHANGED', 'This project changed. Reopen it before saving; your draft has not been overwritten.')
      const old = previous ? JSON.parse(previous.content) as ProjectDraft : undefined
      const oldSnapshot = previous ? JSON.parse(previous.snapshot) as ProjectSnapshot : undefined
      const product = old?.productId === draft.productId ? oldSnapshot!.product : await this.deps.product(draft.productId)
      const theme = old?.themeId === draft.themeId ? oldSnapshot!.theme : await this.deps.theme(draft.themeId)
      const character = draft.characterId === null ? null : old?.characterId === draft.characterId ? oldSnapshot!.character : await this.deps.character(draft.characterId)
      if (theme.outputType !== draft.outputType) invalid('Choose a theme made for this output type.')
      // New selections need readable primary images. Existing snapshots survive later media or library changes.
      if (old?.productId !== draft.productId && !product.photos.find(photo => photo.id === product.primaryAssetId)?.available) invalid('This product primary photo is unavailable. Replace it in Products before selecting it.')
      if (draft.characterId && old?.characterId !== draft.characterId && !character?.photos.find(photo => photo.id === character.primaryAssetId)?.available) invalid('This character primary photo is unavailable. Replace it in Characters before selecting it.')
      const snapshot: ProjectSnapshot = { product, theme, character }
      const storyboard = draft.storyboard ?? (old?.themeId === draft.themeId && old.storyboard ? old.storyboard : storyboardFromTheme(theme))
      const name = draft.name || `${product.name} · ${draft.outputType === 'reel' ? 'Reel' : 'Post'}`.slice(0, 120)
      const content: ProjectDraft = { ...draft, preset: presetForTheme(theme), name, storyboard }
      delete content.id; delete content.expectedRevision
      const id = previous?.id ?? randomUUID(), revision = (previous?.revision ?? 0) + 1, now = new Date().toISOString()
      if (!previous) await this.paths.directory(resultFolder(id, name))
      const contentJson = JSON.stringify(content), snapshotJson = JSON.stringify(snapshot)
      const assetIds = new Set([
        ...product.photos.map(photo => photo.id), ...theme.images.map(photo => photo.id),
        ...(character?.photos.map(photo => photo.id) ?? []),
      ])
      transaction(this.db, () => {
        if (previous) this.db.prepare('UPDATE projects SET name = ?, content = ?, snapshot = ?, revision = ?, updated_at = ? WHERE id = ?').run(name, contentJson, snapshotJson, revision, now, id)
        else this.db.prepare('INSERT INTO projects(id, name, content, snapshot, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, name, contentJson, snapshotJson, revision, now, now)
        this.db.prepare('INSERT INTO project_revisions(project_id, revision, content, snapshot, created_at) VALUES (?, ?, ?, ?, ?)').run(id, revision, contentJson, snapshotJson, now)
        for (const assetId of assetIds) this.db.prepare('INSERT INTO project_assets(project_id, revision, asset_id) VALUES (?, ?, ?)').run(id, revision, assetId)
        if (old?.storyboard) {
          for (let oldIndex = 0; oldIndex < old.storyboard.scenes.length; oldIndex++) {
            const priorScene = old.storyboard.scenes[oldIndex]
            const newIndex = storyboard.scenes.findIndex(scene => scene.id === priorScene.id)
            const nextScene = newIndex < 0 ? undefined : storyboard.scenes[newIndex]
            const changed = !nextScene || oldIndex !== newIndex || priorScene.prompt !== nextScene.prompt || priorScene.sourceDuration !== nextScene.sourceDuration || priorScene.relationship !== nextScene.relationship
            if (!changed) continue
            this.db.prepare(`UPDATE scene_reviews SET status = 'needs-changes', updated_at = ? WHERE project_id = ? AND scene_id = ? AND selected_attempt_id IS NOT NULL AND status <> 'needs-changes'`).run(now, id, priorScene.id)
            const start = Math.max(0, newIndex >= 0 ? newIndex : Math.min(oldIndex, storyboard.scenes.length - 1))
            for (let index = start + 1; index < storyboard.scenes.length; index++) {
              const dependent = storyboard.scenes[index]
              if (dependent.relationship === 'new-shot') break
              this.db.prepare(`UPDATE scene_reviews SET status = 'needs-recheck', updated_at = ? WHERE project_id = ? AND scene_id = ? AND status = 'approved'`).run(now, id, dependent.id)
            }
          }
        }
      })
      return this.get(id)
    })
  }
}
