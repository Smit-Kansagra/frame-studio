import { randomUUID } from 'node:crypto'
import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type { AssetInfo, ProductPhoto, ThemeContent, ThemeDraft, ThemeInfo, ThemeTrashInfo } from '../contracts.cjs'
import { transaction } from './database.cjs'
import { StorageError } from './errors.cjs'
import { UUID_PATTERN } from './paths.cjs'
import { referenceInstructions } from './theme-references.mjs'

const placeholders = new Set(['product_name', 'product_description', 'product_notes', 'character_name', 'character_prompt', 'scene_number', 'scene_prompt', 'aspect_ratio', 'target_duration'])
function invalid(message: string): never { throw new StorageError('INVALID_THEME', message) }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid('The theme contains invalid or unknown fields.')
  return value as Record<string, unknown>
}
function text(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) invalid(`${label} must be ${max} characters or fewer.`)
  if (required && !value.trim()) invalid(`Add ${label.toLowerCase()} before saving.`)
  return value.trim()
}
function prompt(value: unknown, label: string, required = true): string {
  const result = text(value, label, 20000, required)
  const remainder = result.replace(/{{([^{}]*)}}/g, (_match, token: string) => {
    if (!placeholders.has(token.trim())) invalid(`${label}: unknown placeholder {{${token}}}. Use a supported placeholder or plain text.`)
    return ''
  })
  if (remainder.includes('{{') || remainder.includes('}}')) invalid(`${label}: close each placeholder with matching {{ and }}.`)
  return result
}
export function validateThemeDraft(value: unknown): ThemeDraft {
  const d = object(value, ['id', 'expectedRevision', 'name', 'description', 'coverAssetId', 'coverUseCount', 'referenceAssetIds', 'referenceInstructions', 'negativePrompt', 'masterPrompt', 'outputType', 'aspectRatio', 'defaultDuration', 'compositionPrompt', 'scenes'])
  if ((d.id !== undefined && (typeof d.id !== 'string' || !UUID_PATTERN.test(d.id) || !Number.isSafeInteger(d.expectedRevision) || (d.expectedRevision as number) < 1)) || (d.id === undefined && d.expectedRevision !== undefined)) invalid('Reopen this theme before saving changes.')
  if (d.coverAssetId !== null && (typeof d.coverAssetId !== 'string' || !UUID_PATTERN.test(d.coverAssetId))) invalid('Choose a valid cover image or remove it.')
  if (d.coverUseCount !== undefined && d.coverUseCount !== 'unlimited' && (typeof d.coverUseCount !== 'number' || !Number.isInteger(d.coverUseCount) || d.coverUseCount < 0 || d.coverUseCount > 20)) invalid('Cover image uses must be a whole number from 0 to 20, or Every product.')
  if (d.coverAssetId === null && d.coverUseCount !== undefined) invalid('Choose a cover image before setting its use count.')
  if (!Array.isArray(d.referenceAssetIds) || d.referenceAssetIds.length > 20 || d.referenceAssetIds.some(id => typeof id !== 'string' || !UUID_PATTERN.test(id)) || new Set(d.referenceAssetIds).size !== d.referenceAssetIds.length) invalid('Choose up to 20 different visual references.')
  const referenceIds = d.referenceAssetIds as string[]
  if (d.referenceInstructions !== undefined && (!Array.isArray(d.referenceInstructions) || d.referenceInstructions.length > 20)) invalid('Reference instructions must match the selected visual references.')
  const instructionIds = new Set<string>()
  const instructions = ((d.referenceInstructions ?? []) as unknown[]).map((value, index) => {
    const item = object(value, ['assetId', 'name', 'compositionPrompt', 'negativePrompt'])
    if (typeof item.assetId !== 'string' || !referenceIds.includes(item.assetId) || instructionIds.has(item.assetId)) invalid('Each reference instruction must belong to one selected reference image.')
    instructionIds.add(item.assetId)
    return { assetId: item.assetId, name: text(item.name, `Reference ${index + 1} name`, 120, true), compositionPrompt: prompt(item.compositionPrompt, `Reference ${index + 1} composition`, false), negativePrompt: prompt(item.negativePrompt ?? '', `Reference ${index + 1} negative prompt`, false) }
  })
  if (!['post', 'reel'].includes(d.outputType as string)) invalid('Choose Post or Reel.')
  const ratios = d.outputType === 'reel' ? ['9:16', '16:9'] : ['1:1', '4:5', '3:4', '1.91:1', '9:16']
  if (!ratios.includes(d.aspectRatio as string)) invalid('Choose dimensions compatible with this output type.')
  if (typeof d.defaultDuration !== 'number' || !Number.isFinite(d.defaultDuration) || (d.outputType === 'reel' ? d.defaultDuration < 0.1 || d.defaultDuration > 600 : d.defaultDuration !== 0)) invalid('Reel duration must be between 0.1 and 600 seconds. A Post has no duration.')
  if (!Array.isArray(d.scenes) || d.scenes.length > 30 || (d.outputType === 'reel' ? !d.scenes.length : d.scenes.length !== 0)) invalid('A Reel needs 1–30 scenes. A Post uses one composition instead of scenes.')
  const ids = new Set<string>()
  const scenes = d.scenes.map((value, index) => {
    const s = object(value, ['id', 'name', 'prompt', 'duration', 'relationship', 'transition'])
    if (typeof s.id !== 'string' || !UUID_PATTERN.test(s.id) || ids.has(s.id)) invalid('Every scene needs a unique identifier.')
    ids.add(s.id)
    if (typeof s.duration !== 'number' || !Number.isFinite(s.duration) || s.duration < 0.1 || s.duration > 600) invalid(`Scene ${index + 1}: enter a duration between 0.1 and 600 seconds.`)
    if (!['new-shot', 'continue'].includes(s.relationship as string) || (index === 0 && s.relationship !== 'new-shot')) invalid('The first scene must start a new shot. Choose a valid relationship for every scene.')
    if (s.transition !== 'cut') invalid('Only hard-cut transitions are supported in this phase.')
    return { id: s.id, name: text(s.name, `Scene ${index + 1} name`, 120, true), prompt: prompt(s.prompt, `Scene ${index + 1} prompt`), duration: s.duration, relationship: s.relationship as 'new-shot' | 'continue', transition: 'cut' as const }
  })
  const total = scenes.reduce((sum, scene) => sum + scene.duration, 0)
  if (d.outputType === 'reel' && Math.abs(total - d.defaultDuration) > 0.005) invalid(`Scene timings total ${Number(total.toFixed(3))}s, but the default duration is ${d.defaultDuration}s. Adjust the timings or explicitly use the total.`)
  return { ...(d.id ? { id: d.id as string, expectedRevision: d.expectedRevision as number } : {}), ...(d.coverUseCount !== undefined ? { coverUseCount: d.coverUseCount as number | 'unlimited' } : {}), name: text(d.name, 'Theme name', 120, true), description: text(d.description, 'Description', 2000), coverAssetId: d.coverAssetId as string | null, referenceAssetIds: [...d.referenceAssetIds] as string[], referenceInstructions: instructions, negativePrompt: prompt(d.negativePrompt ?? '', 'Shared negative prompt', false), masterPrompt: prompt(d.masterPrompt, 'Master prompt'), outputType: d.outputType as 'post' | 'reel', aspectRatio: d.aspectRatio as ThemeContent['aspectRatio'], defaultDuration: d.defaultDuration, compositionPrompt: d.outputType === 'post' ? prompt(d.compositionPrompt, 'Shared composition fallback', false) : text(d.compositionPrompt, 'Composition instruction', 20000), scenes }
}
type Row = { id: string; name: string; content: string; revision: number; created_at: string; updated_at: string; trashed_at: string | null }
type Dependencies = { enqueue: <T>(action: () => Promise<T>) => Promise<T>; asset: (id: string) => AssetInfo; media: (id: string, kind: 'original' | 'thumbnail') => Promise<string> }
export class Themes {
  constructor(private readonly db: DatabaseSync, private readonly deps: Dependencies) {}
  private row(id: string, includeTrash = false): Row {
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) throw new StorageError('INVALID_REQUEST', 'The theme identifier is invalid.')
    const row = this.db.prepare('SELECT * FROM themes WHERE id = ?').get(id) as Row | undefined
    if (!row || (!includeTrash && row.trashed_at)) throw new StorageError('THEME_NOT_FOUND', 'This theme is not in the library. Check local trash or return to Themes.')
    return row
  }
  private async photo(id: string): Promise<ProductPhoto> {
    const asset = this.deps.asset(id)
    const readable = async (kind: 'original' | 'thumbnail') => { try { const filename = await this.deps.media(id, kind); await access(filename, constants.R_OK); const size = (await stat(filename)).size; return kind === 'original' ? size === asset.byteSize && size > 0 : size > 0 } catch { return false } }
    const [available, thumbnailAvailable] = await Promise.all([readable('original'), readable('thumbnail')])
    return { ...asset, available, thumbnailAvailable }
  }
  async get(id: string): Promise<ThemeInfo> {
    const row = this.row(id)
    const content = JSON.parse(row.content) as ThemeContent
    const imageIds = [...new Set([content.coverAssetId, ...content.referenceAssetIds].filter((id): id is string => !!id))]
    const images = await Promise.all(imageIds.map(id => this.photo(id)))
    return { ...content, negativePrompt: content.negativePrompt ?? '', referenceInstructions: content.referenceAssetIds.map(assetId => referenceInstructions(content, assetId, images.find(image => image.id === assetId)?.originalName ?? 'Reference image')), id: row.id, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, images }
  }
  async list(): Promise<ThemeInfo[]> { return Promise.all((this.db.prepare('SELECT id FROM themes WHERE trashed_at IS NULL ORDER BY updated_at DESC, id').all() as { id: string }[]).map(row => this.get(row.id))) }
  private write(content: ThemeContent, previous?: Row): string {
    const id = previous?.id ?? randomUUID(), revision = (previous?.revision ?? 0) + 1, now = new Date().toISOString(), json = JSON.stringify(content)
    transaction(this.db, () => {
      if (previous) this.db.prepare('UPDATE themes SET name = ?, content = ?, revision = ?, updated_at = ? WHERE id = ?').run(content.name, json, revision, now, id)
      else this.db.prepare('INSERT INTO themes(id, name, content, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, content.name, json, revision, now, now)
      this.db.prepare('INSERT INTO theme_revisions(theme_id, revision, content, created_at) VALUES (?, ?, ?, ?)').run(id, revision, json, now)
      for (const asset of new Set([content.coverAssetId, ...content.referenceAssetIds].filter(Boolean))) this.db.prepare('INSERT INTO theme_assets(theme_id, revision, asset_id) VALUES (?, ?, ?)').run(id, revision, asset!)
    })
    return id
  }
  save(value: unknown): Promise<ThemeInfo> {
    const { id, expectedRevision, ...content } = validateThemeDraft(value)
    return this.deps.enqueue(async () => {
      const previous = id ? this.row(id) : undefined
      if (previous && previous.revision !== expectedRevision) throw new StorageError('THEME_CHANGED', 'This theme changed. Reopen it before saving; your draft has not been overwritten.')
      const old = previous ? JSON.parse(previous.content) as ThemeContent : undefined
      content.referenceInstructions = content.referenceAssetIds.map(assetId => referenceInstructions(content, assetId, this.deps.asset(assetId).originalName))
      const oldIds = new Set(old ? [old.coverAssetId, ...old.referenceAssetIds] : [])
      for (const assetId of new Set([content.coverAssetId, ...content.referenceAssetIds].filter((id): id is string => !!id))) {
        const photo = await this.photo(assetId)
        if (!photo.available && !oldIds.has(assetId)) invalid('A newly selected image is unavailable. Replace or remove it before saving.')
      }
      return this.get(this.write(content, previous))
    })
  }
  duplicate(id: string, revision: number): Promise<ThemeInfo> {
    return this.deps.enqueue(async () => {
      const row = this.row(id)
      this.assertRevision(row, revision)
      const content = JSON.parse(row.content) as ThemeContent
      content.name = `${content.name.slice(0, 113)} (copy)`
      content.scenes = content.scenes.map(scene => ({ ...scene, id: randomUUID() }))
      // Immutable image assets can be shared. Changing either theme creates new asset/revision IDs.
      return this.get(this.write(content))
    })
  }
  private assertRevision(row: Row, revision: number) { if (!Number.isSafeInteger(revision) || revision !== row.revision) throw new StorageError('THEME_CHANGED', 'This theme changed. Reload the library before continuing.') }
  remove(id: string, revision: number): Promise<{ token: string }> {
    return this.deps.enqueue(async () => {
      const row = this.row(id); this.assertRevision(row, revision)
      const token = randomUUID(), now = new Date().toISOString()
      transaction(this.db, () => {
        this.db.prepare('UPDATE themes SET trashed_at = ?, updated_at = ? WHERE id = ?').run(now, now, id)
        this.db.prepare('INSERT INTO theme_trash(token, theme_id, removed_revision, created_at) VALUES (?, ?, ?, ?)').run(token, id, revision, now)
      })
      return { token }
    })
  }
  trash(): ThemeTrashInfo[] { return (this.db.prepare('SELECT t.token, t.created_at, p.name FROM theme_trash t JOIN themes p ON p.id = t.theme_id WHERE t.restored_at IS NULL ORDER BY t.created_at DESC, t.token').all() as { token: string; created_at: string; name: string }[]).map(row => ({ token: row.token, themeName: row.name, removedAt: row.created_at })) }
  undo(token: string): Promise<ThemeInfo> {
    return this.deps.enqueue(async () => {
      if (typeof token !== 'string' || !UUID_PATTERN.test(token)) throw new StorageError('INVALID_REQUEST', 'The Undo identifier is invalid.')
      const entry = this.db.prepare('SELECT * FROM theme_trash WHERE token = ? AND restored_at IS NULL').get(token) as { theme_id: string; removed_revision: number } | undefined
      if (!entry) throw new StorageError('UNDO_UNAVAILABLE', 'This removal has already been undone.')
      const row = this.row(entry.theme_id, true)
      if (!row.trashed_at || row.revision !== entry.removed_revision) throw new StorageError('UNDO_UNAVAILABLE', 'This trash entry changed. Reload local trash.')
      transaction(this.db, () => {
        const now = new Date().toISOString()
        this.db.prepare('UPDATE themes SET trashed_at = NULL, updated_at = ? WHERE id = ?').run(now, row.id)
        this.db.prepare('UPDATE theme_trash SET restored_at = ? WHERE token = ?').run(now, token)
      })
      return this.get(row.id)
    })
  }
}
