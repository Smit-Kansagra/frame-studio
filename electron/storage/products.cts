import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import type { AssetInfo, ProductDraft, ProductInfo, ProductPhoto, ProductTrashInfo } from '../contracts.cjs'
import { transaction } from './database.cjs'
import { StorageError } from './errors.cjs'
import { UUID_PATTERN } from './paths.cjs'

type ProductRow = { id: string; name: string; description: string; notes: string; primary_asset_id: string; revision: number; created_at: string; updated_at: string; trashed_at: string | null }
type Relation = { asset_id: string; position: number; removed_at: string | null }
type TrashRow = { token: string; product_id: string; kind: 'product' | 'photo'; asset_id: string | null; old_primary_id: string; fallback_primary_id: string; removed_revision: number; created_at: string; restored_at: string | null }
type Dependencies = {
  enqueue: <T>(action: () => Promise<T>) => Promise<T>
  asset: (id: string) => AssetInfo
  media: (id: string, kind: 'original' | 'thumbnail') => Promise<string>
}

export function validateProductDraft(value: unknown): ProductDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StorageError('INVALID_REQUEST', 'The product details are invalid.')
  const draft = value as Record<string, unknown>
  const keys = ['id', 'expectedRevision', 'name', 'description', 'notes', 'assetIds', 'primaryAssetId']
  if (Object.keys(draft).some(key => !keys.includes(key))) throw new StorageError('INVALID_REQUEST', 'The product details contain an unknown field.')
  if ((draft.id !== undefined && (typeof draft.id !== 'string' || !UUID_PATTERN.test(draft.id))) || (draft.id !== undefined && (!Number.isSafeInteger(draft.expectedRevision) || (draft.expectedRevision as number) < 1)) || (draft.id === undefined && draft.expectedRevision !== undefined)) throw new StorageError('INVALID_REQUEST', 'Reload the product before saving changes.')
  for (const [key, limit] of [['name', 120], ['description', 2000], ['notes', 2000]] as const) {
    if (typeof draft[key] !== 'string' || (draft[key] as string).length > limit) throw new StorageError('INVALID_PRODUCT', `${key === 'name' ? 'Product name' : key === 'notes' ? 'Preservation notes' : 'Description'} must be ${limit} characters or fewer.`)
  }
  if (!(draft.name as string).trim()) throw new StorageError('INVALID_PRODUCT', 'Give this product a name.')
  if (!Array.isArray(draft.assetIds) || draft.assetIds.length < 1 || draft.assetIds.length > 20 || draft.assetIds.some(id => typeof id !== 'string' || !UUID_PATTERN.test(id)) || new Set(draft.assetIds).size !== draft.assetIds.length) throw new StorageError('INVALID_PRODUCT', 'Choose between 1 and 20 different product photos.')
  if (typeof draft.primaryAssetId !== 'string' || !draft.assetIds.includes(draft.primaryAssetId)) throw new StorageError('INVALID_PRODUCT', 'Choose a primary photo from this product’s images.')
  return { ...(draft.id ? { id: draft.id as string, expectedRevision: draft.expectedRevision as number } : {}), name: (draft.name as string).trim(), description: (draft.description as string).trim(), notes: (draft.notes as string).trim(), assetIds: [...draft.assetIds] as string[], primaryAssetId: draft.primaryAssetId }
}

export class Products {
  constructor(private readonly db: DatabaseSync, private readonly deps: Dependencies) {}

  private row(id: string, includeTrash = false): ProductRow {
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) throw new StorageError('INVALID_REQUEST', 'The product identifier is invalid.')
    const row = this.db.prepare('SELECT * FROM products WHERE id = ?').get(id) as ProductRow | undefined
    if (!row || (!includeTrash && row.trashed_at)) throw new StorageError('PRODUCT_NOT_FOUND', 'This product is no longer in the library. Check local trash or return to Products.')
    return row
  }

  private relations(id: string): Relation[] { return this.db.prepare('SELECT asset_id, position, removed_at FROM product_assets WHERE product_id = ? ORDER BY position, asset_id').all(id) as Relation[] }

  private async photo(id: string): Promise<ProductPhoto> {
    const asset = this.deps.asset(id)
    const readable = async (kind: 'original' | 'thumbnail') => {
      try {
        const filename = await this.deps.media(id, kind)
        await access(filename, constants.R_OK)
        const size = (await stat(filename)).size
        return kind === 'original' ? size === asset.byteSize && size > 0 : size > 0
      } catch { return false }
    }
    const [available, thumbnailAvailable] = await Promise.all([readable('original'), readable('thumbnail')])
    return { ...asset, available, thumbnailAvailable }
  }

  async get(id: string): Promise<ProductInfo> {
    const row = this.row(id)
    const photos = await Promise.all(this.relations(id).filter(item => !item.removed_at).map(item => this.photo(item.asset_id)))
    return { id: row.id, name: row.name, description: row.description, notes: row.notes, primaryAssetId: row.primary_asset_id, photos, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at }
  }

  async list(search: string = ''): Promise<{ items: ProductInfo[]; total: number }> {
    if (typeof search !== 'string' || search.length > 200) throw new StorageError('INVALID_REQUEST', 'Keep product searches to 200 characters or fewer.')
    const rows = this.db.prepare('SELECT * FROM products WHERE trashed_at IS NULL ORDER BY updated_at DESC, id').all() as ProductRow[]
    const needle = search.trim().toLocaleLowerCase()
    const selected = needle ? rows.filter(row => [row.name, row.description, row.notes].some(text => text.toLocaleLowerCase().includes(needle))) : rows
    return { items: await Promise.all(selected.map(row => this.get(row.id))), total: rows.length }
  }

  async save(value: unknown): Promise<ProductInfo> {
    const draft = validateProductDraft(value)
    return this.deps.enqueue(async () => {
      const previous = draft.id ? this.row(draft.id) : undefined
      if (previous && previous.revision !== draft.expectedRevision) throw new StorageError('PRODUCT_CHANGED', 'This product changed since it was opened. Return to Products and reopen it before saving.')
      const photos = await Promise.all(draft.assetIds.map(id => this.photo(id)))
      if (!photos.some(photo => photo.available)) throw new StorageError('INVALID_PRODUCT', 'Add at least one readable photo before saving this product.')
      if (!photos.find(photo => photo.id === draft.primaryAssetId)?.available) throw new StorageError('INVALID_PRODUCT', 'Choose an available photo as the primary image.')
      const id = previous?.id ?? randomUUID()
      const now = new Date().toISOString()
      const revision = (previous?.revision ?? 0) + 1
      const allPreviousPhotos = previous ? this.relations(id) : []
      const oldPhotos = allPreviousPhotos.filter(item => !item.removed_at)
      let nextPosition = Math.max(-1, ...allPreviousPhotos.map(item => item.position)) + 1
      transaction(this.db, () => {
        if (previous) this.db.prepare('UPDATE products SET name = ?, description = ?, notes = ?, primary_asset_id = ?, revision = ?, updated_at = ? WHERE id = ?').run(draft.name, draft.description, draft.notes, draft.primaryAssetId, revision, now, id)
        else this.db.prepare('INSERT INTO products(id, name, description, notes, primary_asset_id, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(id, draft.name, draft.description, draft.notes, draft.primaryAssetId, now, now)
        for (const item of oldPhotos.filter(item => !draft.assetIds.includes(item.asset_id))) {
          this.db.prepare('UPDATE product_assets SET removed_at = ? WHERE product_id = ? AND asset_id = ?').run(now, id, item.asset_id)
          this.db.prepare("INSERT INTO product_trash(token, product_id, kind, asset_id, old_primary_id, fallback_primary_id, removed_revision, created_at) VALUES (?, ?, 'photo', ?, ?, ?, ?, ?)").run(randomUUID(), id, item.asset_id, previous!.primary_asset_id, draft.primaryAssetId, revision, now)
        }
        for (const assetId of draft.assetIds) {
          // Keep removed photos' positions reserved so Undo restores gallery order.
          const position = allPreviousPhotos.find(item => item.asset_id === assetId)?.position ?? nextPosition++
          this.db.prepare('INSERT INTO product_assets(product_id, asset_id, position, removed_at) VALUES (?, ?, ?, NULL) ON CONFLICT(product_id, asset_id) DO UPDATE SET position = excluded.position, removed_at = NULL').run(id, assetId, position)
          this.db.prepare("UPDATE product_trash SET restored_at = ? WHERE product_id = ? AND asset_id = ? AND kind = 'photo' AND restored_at IS NULL").run(now, id, assetId)
        }
      })
      return this.get(id)
    })
  }

  remove(id: string, revision: number): Promise<{ token: string }> {
    return this.deps.enqueue(async () => {
      const row = this.row(id)
      if (!Number.isSafeInteger(revision) || revision !== row.revision) throw new StorageError('PRODUCT_CHANGED', 'This product changed. Reload the library before removing it.')
      const token = randomUUID()
      const now = new Date().toISOString()
      transaction(this.db, () => {
        this.db.prepare('UPDATE products SET trashed_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(now, now, id)
        this.db.prepare("INSERT INTO product_trash(token, product_id, kind, old_primary_id, fallback_primary_id, removed_revision, created_at) VALUES (?, ?, 'product', ?, ?, ?, ?)").run(token, id, row.primary_asset_id, row.primary_asset_id, row.revision + 1, now)
      })
      return { token }
    })
  }

  trash(): ProductTrashInfo[] {
    return (this.db.prepare(`SELECT t.*, p.name AS product_name, p.trashed_at, a.original_name AS photo_name
      FROM product_trash t JOIN products p ON p.id = t.product_id LEFT JOIN assets a ON a.id = t.asset_id
      WHERE t.restored_at IS NULL ORDER BY t.created_at DESC, t.token`).all() as (TrashRow & { product_name: string; trashed_at: string | null; photo_name: string | null })[])
      .map(row => ({ token: row.token, kind: row.kind, productName: row.product_name, photoName: row.photo_name, removedAt: row.created_at, canUndo: row.kind === 'product' || !row.trashed_at }))
  }

  undo(token: string): Promise<ProductInfo> {
    return this.deps.enqueue(async () => {
      if (typeof token !== 'string' || !UUID_PATTERN.test(token)) throw new StorageError('INVALID_REQUEST', 'The Undo identifier is invalid.')
      const entry = this.db.prepare('SELECT * FROM product_trash WHERE token = ? AND restored_at IS NULL').get(token) as TrashRow | undefined
      if (!entry) throw new StorageError('UNDO_UNAVAILABLE', 'This removal has already been undone.')
      const row = this.row(entry.product_id, true)
      if (entry.kind === 'photo' && row.trashed_at) throw new StorageError('UNDO_UNAVAILABLE', 'Restore the product from local trash before restoring its photo.')
      const now = new Date().toISOString()
      transaction(this.db, () => {
        if (entry.kind === 'product') {
          if (!row.trashed_at || row.revision !== entry.removed_revision) throw new StorageError('UNDO_UNAVAILABLE', 'This product’s trash entry has changed. Reload local trash.')
          this.db.prepare('UPDATE products SET trashed_at = NULL, updated_at = ?, revision = revision + 1 WHERE id = ?').run(now, row.id)
        } else {
          const relation = this.relations(row.id).find(item => item.asset_id === entry.asset_id)
          if (!relation?.removed_at) throw new StorageError('UNDO_UNAVAILABLE', 'This photo has already been restored.')
          this.db.prepare('UPDATE product_assets SET removed_at = NULL WHERE product_id = ? AND asset_id = ?').run(row.id, entry.asset_id!)
          const primary = row.revision === entry.removed_revision && row.primary_asset_id === entry.fallback_primary_id && entry.old_primary_id === entry.asset_id ? entry.asset_id! : row.primary_asset_id
          this.db.prepare('UPDATE products SET primary_asset_id = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(primary, now, row.id)
        }
        this.db.prepare('UPDATE product_trash SET restored_at = ? WHERE token = ?').run(now, token)
      })
      return this.get(row.id)
    })
  }
}
