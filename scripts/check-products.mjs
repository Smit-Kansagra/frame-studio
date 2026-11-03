import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { Workspace } from '../dist-electron/storage/workspace.cjs'

const reportFile = path.resolve('artifacts/product-check-report.json')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const draft = (product, changes = {}) => ({ id: product.id, expectedRevision: product.revision, name: product.name, description: product.description, notes: product.notes, assetIds: product.photos.map(photo => photo.id), primaryAssetId: product.primaryAssetId, ...changes })
const pass = message => console.log(`PASS ${message}`)

if (process.argv[2] === '--verify-restart') {
  const report = JSON.parse(await readFile(reportFile, 'utf8'))
  assert.ok(path.resolve(report.root).startsWith(`${path.resolve('artifacts')}${path.sep}products-demo-`))
  const workspace = await Workspace.open(report.workspace)
  try {
    const product = await workspace.products.get(report.product.id)
    assert.equal(product.name, report.product.name)
    assert.equal(product.primaryAssetId, report.product.primaryAssetId)
    assert.deepEqual(product.photos.map(photo => photo.id), report.product.photoIds)
    for (const asset of report.assets) assert.equal(hash(await readFile(await workspace.mediaFile(asset.id, 'original'))), asset.hash)
    assert.ok(workspace.products.trash().some(entry => entry.token === report.productTrash))
    assert.ok(workspace.products.trash().some(entry => entry.token === report.photoTrash))
    const restoredProduct = await workspace.products.undo(report.productTrash)
    assert.equal(restoredProduct.name, 'Demo restart restore')
    const restoredPhoto = await workspace.products.undo(report.photoTrash)
    assert.equal(restoredPhoto.photos.length, product.photos.length + 1)
    pass('separate process preserves products, photos, primary selection, readable media, and durable product/photo Undo')
  } finally { await workspace.close() }
  process.exit(0)
}

await mkdir('artifacts', { recursive: true })
const root = await mkdtemp(path.resolve('artifacts/products-demo-'))
const sourceFolder = path.join(root, 'Demo source photos')
const folder = path.join(root, 'workspace')
await mkdir(sourceFolder)
let workspace = await Workspace.open(folder)
const sql = action => { const db = new DatabaseSync(path.join(folder, 'workspace.sqlite')); try { return action(db) } finally { db.close() } }
const assets = []
const sources = []
try {
  for (const [index, format] of ['png', 'jpeg', 'webp'].entries()) {
    const bytes = await sharp({ create: { width: 160 + index * 40, height: 240, channels: 3, background: ['#244c3c', '#c79b62', '#8c9b75'][index] } }).toFormat(format).toBuffer()
    const source = path.join(sourceFolder, `Demo product ${index + 1}.${format}`)
    await writeFile(source, bytes)
    assets.push(await workspace.importImage(source)); sources.push({ source, hash: hash(bytes) })
  }
  // Construct the exact pre-products state in this disposable database to test upgrade.
  await workspace.close()
  sql(db => db.exec('DROP TABLE project_exports; DROP TABLE scene_reviews; DROP TABLE generation_attempts; DROP TABLE project_assets; DROP TABLE project_revisions; DROP TABLE projects; DROP TABLE character_trash; DROP TABLE character_assets; DROP TABLE character_revisions; DROP TABLE characters; DROP TABLE theme_trash; DROP TABLE theme_assets; DROP TABLE theme_revisions; DROP TABLE themes; DROP TABLE asset_edits; DROP TABLE product_trash; DROP TABLE product_assets; DROP TABLE products; DELETE FROM schema_migrations WHERE version >= 2; PRAGMA user_version = 1;'))
  workspace = await Workspace.open(folder)
  assert.equal((await workspace.status()).schemaVersion, 8)
  assert.equal((await workspace.status()).assetCount, 3)
  assert.equal((await workspace.products.list()).total, 0)
  assert.equal(sql(db => db.prepare('SELECT count(*) AS count FROM schema_migrations').get().count), 8)
  pass('schema 1 upgrades transactionally to schema 8 with existing image records and files intact')

  let product = await workspace.products.save({ name: "Demo Amber O'Brien", description: 'Amber glass bottle', notes: 'Keep the cap black', assetIds: [assets[0].id, assets[1].id], primaryAssetId: assets[0].id })
  assert.equal(product.photos.length, 2)
  assert.equal(product.revision, 1)
  assert.ok(product.photos.every(photo => photo.available && photo.thumbnailAvailable))
  assert.equal((await workspace.products.list('AMBER')).items[0].id, product.id)
  assert.equal((await workspace.products.list('cap black')).items.length, 1)
  assert.equal((await workspace.products.list("%' OR 1=1 --")).items.length, 0)
  assert.equal((await workspace.products.list('no match')).total, 1)
  pass('create, primary photo, multi-photo preview metadata, factual notes, and case-insensitive literal search')

  product = await workspace.products.save(draft(product, { name: 'Demo renamed bottle', primaryAssetId: assets[1].id, assetIds: assets.map(asset => asset.id) }))
  assert.equal(product.photos.length, 3)
  assert.equal(product.primaryAssetId, assets[1].id)
  assert.equal(product.name, 'Demo renamed bottle')
  pass('rename, add another photo, and change primary selection persist together')

  for (const changes of [{ name: '' }, { name: 'x'.repeat(121) }, { description: 'x'.repeat(2001) }, { assetIds: [] }, { assetIds: [assets[0].id, assets[0].id] }, { primaryAssetId: 'not-a-photo' }, { unexpected: 'field' }]) {
    await assert.rejects(workspace.products.save(draft(product, changes)), error => ['INVALID_REQUEST', 'INVALID_PRODUCT'].includes(error.code))
  }
  assert.equal((await workspace.products.get(product.id)).revision, product.revision)
  pass('invalid names, oversized fields, zero photos, duplicate photos, wrong primary photo, and unknown fields leave records unchanged')

  const original = await workspace.mediaFile(assets[0].id, 'original')
  const parked = path.join(sourceFolder, 'Demo temporarily unavailable managed image')
  await rename(original, parked)
  assert.equal((await workspace.products.get(product.id)).photos.find(photo => photo.id === assets[0].id).available, false)
  await assert.rejects(workspace.products.save({ name: 'Demo invalid photo', description: '', notes: '', assetIds: [assets[0].id], primaryAssetId: assets[0].id }), error => error.code === 'INVALID_PRODUCT')
  await assert.rejects(workspace.products.save(draft(product, { primaryAssetId: assets[0].id })), error => error.code === 'INVALID_PRODUCT')
  await rename(parked, original)
  pass('missing originals are reported; saving without a usable image or usable primary is refused')

  const originalOrder = product.photos.map(photo => photo.id)
  product = await workspace.products.save(draft(product, { assetIds: [assets[0].id, assets[2].id], primaryAssetId: assets[2].id }))
  let photoTrash = workspace.products.trash().find(entry => entry.kind === 'photo').token
  assert.equal(product.photos.length, 2)
  await access(await workspace.mediaFile(assets[1].id, 'original'))
  product = await workspace.products.undo(photoTrash)
  assert.equal(product.photos.length, 3)
  assert.deepEqual(product.photos.map(photo => photo.id), originalOrder)
  assert.equal(product.primaryAssetId, assets[1].id)
  await assert.rejects(workspace.products.undo(photoTrash), error => error.code === 'UNDO_UNAVAILABLE')
  pass('photo removal is recoverable, preserves managed originals, restores primary selection, and consumes Undo once')

  product = await workspace.products.save(draft(product, { assetIds: [assets[0].id, assets[2].id], primaryAssetId: assets[2].id }))
  photoTrash = workspace.products.trash().find(entry => entry.kind === 'photo').token
  product = await workspace.products.save(draft(product, { name: 'Demo edited after photo removal' }))
  product = await workspace.products.undo(photoTrash)
  assert.equal(product.name, 'Demo edited after photo removal')
  assert.equal(product.primaryAssetId, assets[2].id)
  pass('Undo restores a photo without overwriting newer names or intentional primary selection')

  const stale = draft(product)
  product = await workspace.products.save(draft(product, { notes: 'Keep the amber colour and black cap.' }))
  await assert.rejects(workspace.products.save({ ...stale, name: 'Demo stale write' }), error => error.code === 'PRODUCT_CHANGED')
  await assert.rejects(workspace.products.remove(product.id, stale.expectedRevision), error => error.code === 'PRODUCT_CHANGED')
  const concurrent = await Promise.allSettled([workspace.products.save(draft(product, { description: 'Demo concurrent A' })), workspace.products.save(draft(product, { description: 'Demo concurrent B' }))])
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(concurrent.filter(result => result.status === 'rejected' && result.reason.code === 'PRODUCT_CHANGED').length, 1)
  product = await workspace.products.get(product.id)
  pass('stale saves/removals and concurrent edits cannot silently overwrite newer product data')

  const snapshot = JSON.stringify(product)
  const trashCount = workspace.products.trash().length
  sql(db => db.exec("CREATE TRIGGER demo_fail_photo_trash BEFORE INSERT ON product_trash BEGIN SELECT RAISE(ABORT, 'Demo forced product transaction failure'); END;"))
  await assert.rejects(workspace.products.save(draft(product, { name: 'Demo should roll back', assetIds: [assets[0].id], primaryAssetId: assets[0].id })))
  sql(db => db.exec('DROP TRIGGER demo_fail_photo_trash'))
  assert.equal(JSON.stringify(await workspace.products.get(product.id)), snapshot)
  assert.equal(workspace.products.trash().length, trashCount)
  pass('failure after product and photo changes rolls back the full transaction and trash entries')

  const token = (await workspace.products.remove(product.id, product.revision)).token
  assert.equal((await workspace.products.list()).total, 0)
  await assert.rejects(workspace.products.get(product.id), error => error.code === 'PRODUCT_NOT_FOUND')
  await assert.rejects(workspace.products.save(draft(product)), error => error.code === 'PRODUCT_NOT_FOUND')
  for (const asset of assets) assert.equal(hash(await readFile(await workspace.mediaFile(asset.id, 'original'))), asset.sha256)
  await workspace.close(); workspace = await Workspace.open(folder)
  assert.ok(workspace.products.trash().some(entry => entry.token === token))
  product = await workspace.products.undo(token)
  assert.equal(product.name, 'Demo edited after photo removal')
  assert.equal(product.photos.length, 3)
  pass('product trash survives restart; Undo restores all details and photos without deleting any original')

  const one = await workspace.products.save({ name: 'Demo single image', description: '', notes: '', assetIds: [assets[0].id], primaryAssetId: assets[0].id })
  await assert.rejects(workspace.products.save(draft(one, { assetIds: [] })), error => error.code === 'INVALID_PRODUCT')
  assert.equal((await workspace.products.get(one.id)).photos.length, 1)
  pass('the last product photo cannot be removed from a saved product')

  for (const item of sources) assert.equal(hash(await readFile(item.source)), item.hash)
  await rename(sources[0].source, `${sources[0].source}.moved`)
  assert.equal(hash(await readFile(await workspace.mediaFile(assets[0].id, 'original'))), assets[0].sha256)
  pass('source photos stay byte-identical and moving a source cannot break a product preview')

  const restoreAfterRestart = await workspace.products.save({ name: 'Demo restart restore', description: 'Demo durable trash', notes: '', assetIds: [assets[0].id], primaryAssetId: assets[0].id })
  const productTrash = (await workspace.products.remove(restoreAfterRestart.id, restoreAfterRestart.revision)).token
  product = await workspace.products.save(draft(product, { assetIds: [assets[0].id, assets[2].id], primaryAssetId: assets[2].id }))
  photoTrash = workspace.products.trash().find(entry => entry.kind === 'photo' && entry.productName === product.name).token
  await writeFile(reportFile, JSON.stringify({ root, workspace: folder, product: { id: product.id, name: product.name, primaryAssetId: product.primaryAssetId, photoIds: product.photos.map(photo => photo.id) }, assets: assets.map(asset => ({ id: asset.id, hash: asset.sha256 })), productTrash, photoTrash }, null, 2))
  console.log(`Product checks passed. Demo artifacts: ${root}`)
} finally { await workspace.close() }
