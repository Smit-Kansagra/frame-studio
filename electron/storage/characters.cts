import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import type { AssetInfo, CharacterContent, CharacterDraft, CharacterInfo, CharacterTrashInfo, ProductPhoto } from '../contracts.cjs'
import { transaction } from './database.cjs'
import { StorageError } from './errors.cjs'
import { UUID_PATTERN } from './paths.cjs'

function invalid(message: string): never { throw new StorageError('INVALID_CHARACTER', message) }
// Older revisions may contain text fields. Keep them in storage for data
// compatibility, but never accept or expose them through the Character API.
type StoredCharacterContent = CharacterContent & { masterPrompt?: string; notes?: string }
export function validateCharacterDraft(value: unknown): CharacterDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('The character details are invalid.')
  const d = value as Record<string, unknown>
  if (Object.keys(d).some(key => !['id', 'expectedRevision', 'name', 'category', 'assetIds', 'primaryAssetId'].includes(key))) invalid('The character contains an unknown field.')
  if ((d.id !== undefined && (typeof d.id !== 'string' || !UUID_PATTERN.test(d.id) || !Number.isSafeInteger(d.expectedRevision) || (d.expectedRevision as number) < 1)) || (d.id === undefined && d.expectedRevision !== undefined)) invalid('Reopen this character before saving changes.')
  if (typeof d.name !== 'string' || d.name.length > 120 || /\0/.test(d.name)) invalid('Character name must be plain text, 120 characters or fewer.')
  if (!(d.name as string).trim()) invalid('Give this character a name.')
  if (d.category !== null && !['female', 'male', 'other'].includes(d.category as string)) invalid('Choose Female, Male, Other, or no category. Categories are optional and entered by you.')
  if (!Array.isArray(d.assetIds) || d.assetIds.length < 1 || d.assetIds.length > 20 || d.assetIds.some(id => typeof id !== 'string' || !UUID_PATTERN.test(id)) || new Set(d.assetIds).size !== d.assetIds.length) invalid('Keep between 1 and 20 different reference photos. Replace the last photo or remove the character instead.')
  if (typeof d.primaryAssetId !== 'string' || !d.assetIds.includes(d.primaryAssetId)) invalid('Choose a primary portrait from this character’s references.')
  return { ...(d.id ? { id: d.id as string, expectedRevision: d.expectedRevision as number } : {}), name: (d.name as string).trim(), category: d.category as CharacterContent['category'], assetIds: [...d.assetIds] as string[], primaryAssetId: d.primaryAssetId }
}
type Row = { id: string; name: string; content: string; revision: number; created_at: string; updated_at: string; trashed_at: string | null }
type Trash = { token: string; character_id: string; kind: 'character' | 'photo'; asset_id: string | null; position: number | null; photo_order: string; old_primary_id: string; fallback_primary_id: string; removed_revision: number; created_at: string; restored_at: string | null }
type Dependencies = { enqueue: <T>(action: () => Promise<T>) => Promise<T>; asset: (id: string) => AssetInfo; media: (id: string, kind: 'original' | 'thumbnail') => Promise<string> }
export class Characters {
  constructor(private readonly db: DatabaseSync, private readonly deps: Dependencies) {}
  private row(id: string, trash = false): Row {
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) throw new StorageError('INVALID_REQUEST', 'The character identifier is invalid.')
    const row = this.db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as Row | undefined
    if (!row || (row.trashed_at && !trash)) throw new StorageError('CHARACTER_NOT_FOUND', 'This character is not in the library. Check local trash or return to Characters.')
    return row
  }
  private checkRevision(row: Row, revision: number) { if (!Number.isSafeInteger(revision) || row.revision !== revision) throw new StorageError('CHARACTER_CHANGED', 'This character changed. Reopen it before continuing; newer data has not been overwritten.') }
  private async photo(id: string): Promise<ProductPhoto> {
    const asset = this.deps.asset(id)
    const readable = async (kind: 'original' | 'thumbnail') => { try { const file = await this.deps.media(id, kind); await access(file, constants.R_OK); const size = (await stat(file)).size; return kind === 'original' ? size === asset.byteSize && size > 0 : size > 0 } catch { return false } }
    const [available, thumbnailAvailable] = await Promise.all([readable('original'), readable('thumbnail')])
    return { ...asset, available, thumbnailAvailable }
  }
  async get(id: string): Promise<CharacterInfo> { const row = this.row(id), stored = JSON.parse(row.content) as StoredCharacterContent; const { name, category, assetIds, primaryAssetId } = stored; return { name, category, assetIds, primaryAssetId, id, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, photos: await Promise.all(assetIds.map(id => this.photo(id))) } }
  async list(): Promise<CharacterInfo[]> { return Promise.all((this.db.prepare('SELECT id FROM characters WHERE trashed_at IS NULL ORDER BY updated_at DESC, id').all() as { id: string }[]).map(row => this.get(row.id))) }
  // Must be called inside a transaction. Every revision pins its immutable reference assets.
  private write(content: StoredCharacterContent, previous?: Row): string {
    const id = previous?.id ?? randomUUID(), revision = (previous?.revision ?? 0) + 1, now = new Date().toISOString(), json = JSON.stringify(content)
    if (previous) this.db.prepare('UPDATE characters SET name = ?, content = ?, revision = ?, updated_at = ? WHERE id = ?').run(content.name, json, revision, now, id)
    else this.db.prepare('INSERT INTO characters(id, name, content, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, content.name, json, revision, now, now)
    this.db.prepare('INSERT INTO character_revisions(character_id, revision, content, created_at) VALUES (?, ?, ?, ?)').run(id, revision, json, now)
    for (const assetId of content.assetIds) this.db.prepare('INSERT INTO character_assets(character_id, revision, asset_id) VALUES (?, ?, ?)').run(id, revision, assetId)
    return id
  }
  save(value: unknown): Promise<CharacterInfo> {
    const { id, expectedRevision, ...content } = validateCharacterDraft(value)
    return this.deps.enqueue(async () => {
      const previous = id ? this.row(id) : undefined
      if (previous) this.checkRevision(previous, expectedRevision!)
      const photos = await Promise.all(content.assetIds.map(id => this.photo(id)))
      if (!photos.some(photo => photo.available) || !photos.find(photo => photo.id === content.primaryAssetId)?.available) invalid('Keep at least one readable reference and choose an available primary portrait. Replace or reset an unavailable photo before saving.')
      const old = previous ? JSON.parse(previous.content) as StoredCharacterContent : undefined
      const storedContent: StoredCharacterContent = old ? { ...old, ...content } : content
      const now = new Date().toISOString()
      let savedId = ''
      transaction(this.db, () => {
        savedId = this.write(storedContent, previous)
        if (old) for (const [position, assetId] of old.assetIds.entries()) if (!content.assetIds.includes(assetId)) this.db.prepare("INSERT INTO character_trash(token, character_id, kind, asset_id, position, photo_order, old_primary_id, fallback_primary_id, removed_revision, created_at) VALUES (?, ?, 'photo', ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), savedId, assetId, position, JSON.stringify(old.assetIds), old.primaryAssetId, content.primaryAssetId, previous!.revision + 1, now)
        for (const assetId of content.assetIds) this.db.prepare("UPDATE character_trash SET restored_at = ? WHERE character_id = ? AND asset_id = ? AND kind = 'photo' AND restored_at IS NULL").run(now, savedId, assetId)
      })
      return this.get(savedId)
    })
  }
  duplicate(id: string, revision: number): Promise<CharacterInfo> { return this.deps.enqueue(async () => { const row = this.row(id); this.checkRevision(row, revision); const content = JSON.parse(row.content) as StoredCharacterContent; content.name = `${content.name.slice(0, 113)} (copy)`; const savedId = transaction(this.db, () => this.write(content)); return this.get(savedId) }) }
  remove(id: string, revision: number): Promise<{ token: string }> {
    return this.deps.enqueue(async () => {
      const row = this.row(id); this.checkRevision(row, revision)
      const content = JSON.parse(row.content) as StoredCharacterContent, token = randomUUID(), now = new Date().toISOString()
      transaction(this.db, () => {
        this.db.prepare('UPDATE characters SET trashed_at = ?, updated_at = ? WHERE id = ?').run(now, now, id)
        this.db.prepare("INSERT INTO character_trash(token, character_id, kind, old_primary_id, fallback_primary_id, removed_revision, created_at) VALUES (?, ?, 'character', ?, ?, ?, ?)").run(token, id, content.primaryAssetId, content.primaryAssetId, revision, now)
      })
      return { token }
    })
  }
  trash(): CharacterTrashInfo[] {
    return (this.db.prepare(`SELECT t.*, c.name, c.trashed_at, a.original_name FROM character_trash t JOIN characters c ON c.id = t.character_id LEFT JOIN assets a ON a.id = t.asset_id WHERE t.restored_at IS NULL ORDER BY t.created_at DESC, t.token`).all() as (Trash & { name: string; trashed_at: string | null; original_name: string | null })[]).map(row => ({ token: row.token, kind: row.kind, characterName: row.name, photoName: row.original_name, removedAt: row.created_at, canUndo: row.kind === 'character' || !row.trashed_at }))
  }
  undo(token: string): Promise<CharacterInfo> {
    return this.deps.enqueue(async () => {
      if (typeof token !== 'string' || !UUID_PATTERN.test(token)) throw new StorageError('INVALID_REQUEST', 'The Undo identifier is invalid.')
      const entry = this.db.prepare('SELECT * FROM character_trash WHERE token = ? AND restored_at IS NULL').get(token) as Trash | undefined
      if (!entry) throw new StorageError('UNDO_UNAVAILABLE', 'This removal has already been undone.')
      const row = this.row(entry.character_id, true), content = JSON.parse(row.content) as StoredCharacterContent
      if (entry.kind === 'photo') {
        if (row.trashed_at) throw new StorageError('UNDO_UNAVAILABLE', 'Restore this character before restoring its photo.')
        if (content.assetIds.includes(entry.asset_id!) || content.assetIds.length >= 20) throw new StorageError('UNDO_UNAVAILABLE', 'This photo is already restored or all 20 reference slots are in use.')
        const oldOrder = JSON.parse(entry.photo_order) as string[], oldIndex = oldOrder.indexOf(entry.asset_id!)
        const following = oldOrder.slice(oldIndex + 1).find(id => content.assetIds.includes(id))
        const preceding = oldOrder.slice(0, oldIndex).reverse().find(id => content.assetIds.includes(id))
        const position = following ? content.assetIds.indexOf(following) : preceding ? content.assetIds.indexOf(preceding) + 1 : Math.min(entry.position ?? content.assetIds.length, content.assetIds.length)
        content.assetIds.splice(position, 0, entry.asset_id!)
        const restoredPhoto = await this.photo(entry.asset_id!)
        if (restoredPhoto.available && row.revision === entry.removed_revision && content.primaryAssetId === entry.fallback_primary_id && entry.old_primary_id === entry.asset_id) content.primaryAssetId = entry.asset_id!
      } else if (!row.trashed_at || row.revision !== entry.removed_revision) throw new StorageError('UNDO_UNAVAILABLE', 'This trash entry changed. Reload local trash.')
      transaction(this.db, () => {
        const now = new Date().toISOString()
        if (entry.kind === 'photo') this.write(content, row)
        else this.db.prepare('UPDATE characters SET trashed_at = NULL, updated_at = ? WHERE id = ?').run(now, row.id)
        this.db.prepare('UPDATE character_trash SET restored_at = ? WHERE token = ?').run(now, token)
      })
      return this.get(row.id)
    })
  }
}
