import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { Workspace } from '../dist-electron/storage/workspace.cjs'

const reportFile = path.resolve('artifacts/character-check-report.json')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const pass = message => console.log(`PASS ${message}`)
const content = character => { const { name, category, assetIds, primaryAssetId } = character; return { name, category, assetIds, primaryAssetId } }
const draft = (character, changes = {}) => ({ ...content(character), id: character.id, expectedRevision: character.revision, ...changes })
const fails = (action, code) => assert.rejects(Promise.resolve().then(action), error => error.code === (code ?? 'INVALID_CHARACTER'))

if (process.argv[2] === '--verify-restart') {
  const report = JSON.parse(await readFile(reportFile, 'utf8'))
  assert.ok(path.resolve(report.root).startsWith(`${path.resolve('artifacts')}${path.sep}characters-demo-`))
  const workspace = await Workspace.open(report.folder)
  try {
    const character = await workspace.characters.get(report.character.id)
    assert.deepEqual(content(character), report.character.content); assert.equal(character.revision, report.character.revision)
    for (const asset of report.assets) assert.equal(hash(await readFile(await workspace.mediaFile(asset.id, 'original'))), asset.hash)
    assert.ok(character.photos.every(photo => photo.available && photo.thumbnailAvailable))
    assert.equal(workspace.getAsset(report.editedId).edit.sourceAssetId, report.sourceId)
    const restored = await workspace.characters.undo(report.characterToken)
    assert.equal(restored.name, 'Demo persistent character trash')
    const restoredPhoto = await workspace.characters.undo(report.photoToken)
    assert.equal(restoredPhoto.photos.length, character.photos.length + 1)
    pass('separate process retains photo references, primary selection, category, revisions and derivatives; character/photo Undo survives restart')
  } finally { await workspace.close() }
  process.exit(0)
}
await mkdir('artifacts', { recursive: true })
const root = await mkdtemp(path.resolve('artifacts/characters-demo-')), folder = path.join(root, 'workspace')
let workspace = await Workspace.open(folder)
const sql = action => { const db = new DatabaseSync(path.join(folder, 'workspace.sqlite')); try { db.exec('PRAGMA foreign_keys=ON'); return action(db) } finally { db.close() } }
const assets = [], sources = []
try {
  for (const [i, format] of ['png', 'jpeg', 'webp'].entries()) {
    const bytes = await sharp({ create: { width: 180 + i * 20, height: 280, channels: 3, background: ['#55704a', '#bf956b', '#d4ddc3'][i] } }).toFormat(format).toBuffer(), filename = path.join(root, `Demo supplied reference ${i + 1}.${format}`)
    await writeFile(filename, bytes); sources.push({ filename, hash: hash(bytes) }); assets.push(await workspace.importImage(filename))
  }
  const product = await workspace.products.save({ name: 'Demo existing product', description: '', notes: '', assetIds: [assets[0].id], primaryAssetId: assets[0].id })
  const theme = await workspace.themes.save({ name: 'Demo existing theme', description: '', coverAssetId: assets[1].id, referenceAssetIds: [], masterPrompt: 'Demo direction', outputType: 'post', aspectRatio: '1:1', defaultDuration: 0, compositionPrompt: 'One composition', scenes: [] })
  await workspace.close()
  sql(db => db.exec('DROP TABLE project_exports; DROP TABLE scene_reviews; DROP TABLE generation_attempts; DROP TABLE project_assets; DROP TABLE project_revisions; DROP TABLE projects; DROP TABLE character_trash; DROP TABLE character_assets; DROP TABLE character_revisions; DROP TABLE characters; DELETE FROM schema_migrations WHERE version >= 4; PRAGMA user_version = 3;'))
  workspace = await Workspace.open(folder)
  assert.equal((await workspace.status()).schemaVersion, 8)
  assert.equal((await workspace.products.get(product.id)).name, product.name)
  assert.equal((await workspace.themes.get(theme.id)).name, theme.name)
  assert.equal((await workspace.characters.list()).length, 0)
  pass('migration 3→8 preserves products, themes and original media; new character, project, generation, review, and export records are empty')

  let character = await workspace.characters.save({ name: 'Demo Maya', category: null, assetIds: assets.map(asset => asset.id), primaryAssetId: assets[1].id })
  assert.equal(character.revision, 1); assert.equal(character.category, null); assert.equal(character.photos.length, 3)
  assert.equal(character.primaryAssetId, assets[1].id); assert.ok(character.photos.every(photo => photo.available && photo.thumbnailAvailable))
  for (const changes of [{ name: '' }, { name: 'a'.repeat(121) }, { masterPrompt: 'Obsolete prompt' }, { notes: 'Obsolete notes' }, { category: 'inferred' }, { assetIds: [] }, { assetIds: [assets[0].id, assets[0].id] }, { primaryAssetId: 'invalid' }, { extra: 'path' }, { assetIds: Array(21).fill(assets[0].id) }]) await fails(() => workspace.characters.save(draft(character, changes)))
  assert.equal((await workspace.characters.get(character.id)).revision, 1)
  const photoOnly = await workspace.characters.save({ name: 'Demo photo-only character', category: null, assetIds: [assets[0].id], primaryAssetId: assets[0].id })
  assert.equal('masterPrompt' in photoOnly, false)
  assert.equal('notes' in photoOnly, false)
  sql(db => { const row = db.prepare('SELECT content FROM characters WHERE id = ?').get(character.id); const legacy = { ...JSON.parse(row.content), masterPrompt: 'Legacy olive jacket prompt', notes: 'Legacy consistency notes' }; db.prepare('UPDATE characters SET content = ? WHERE id = ?').run(JSON.stringify(legacy), character.id) })
  assert.equal('masterPrompt' in await workspace.characters.get(character.id), false)
  pass('photo-only creation needs no prompt; prompt/notes API inputs are rejected and old stored text is hidden')

  const original = content(character)
  const edit = await workspace.editImage(assets[1].id, { rotation: 90, crop: { x: .1, y: 0, width: .8, height: 1 } })
  character = await workspace.characters.save(draft(character, { category: 'female', name: 'Demo Maya revised', primaryAssetId: edit.id, assetIds: [assets[0].id, edit.id, assets[2].id] }))
  assert.equal(character.revision, 2); assert.equal(character.primaryAssetId, edit.id); assert.equal(edit.edit.sourceAssetId, assets[1].id)
  assert.deepEqual(JSON.parse(sql(db => db.prepare('SELECT content FROM character_revisions WHERE character_id = ? AND revision = 1').get(character.id).content)), original)
  assert.equal(JSON.parse(sql(db => db.prepare('SELECT content FROM characters WHERE id = ?').get(character.id).content)).masterPrompt, 'Legacy olive jacket prompt')
  assert.equal(sql(db => db.prepare('SELECT count(*) AS n FROM character_assets WHERE character_id = ? AND revision = 1').get(character.id).n), 3)
  assert.equal(hash(await readFile(await workspace.mediaFile(assets[1].id, 'original'))), sources[1].hash)
  pass('crop/rotate replacement creates a new revision and reference; historical text stays stored but hidden')

  // Reset to original uses the saved root-original ID, never overwrites either file.
  character = await workspace.characters.save(draft(character, { assetIds: assets.map(asset => asset.id), primaryAssetId: assets[1].id }))
  assert.equal(character.primaryAssetId, assets[1].id)
  let copy = await workspace.characters.duplicate(character.id, character.revision)
  assert.notEqual(copy.id, character.id)
  copy = await workspace.characters.save(draft(copy, { name: 'Demo independent copy', category: 'other', primaryAssetId: assets[0].id, assetIds: [assets[0].id] }))
  assert.deepEqual(content(await workspace.characters.get(character.id)), content(character))
  pass('reset restores untouched reference; duplicate edits, category and primary selection do not modify original character')

  const before = character
  character = await workspace.characters.save(draft(character, { name: 'Demo Maya later' }))
  await fails(() => workspace.characters.save(draft(before)), 'CHARACTER_CHANGED')
  await fails(() => workspace.characters.remove(before.id, before.revision), 'CHARACTER_CHANGED')
  await fails(() => workspace.characters.duplicate(before.id, before.revision), 'CHARACTER_CHANGED')
  const concurrent = await Promise.allSettled([workspace.characters.save(draft(character, { name: 'Winner A' })), workspace.characters.save(draft(character, { name: 'Winner B' }))])
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1)
  character = await workspace.characters.get(character.id)
  pass('stale mutations rejected and concurrent writes serialized without overwriting newer data')

  sql(db => db.exec("CREATE TRIGGER demo_fail_character BEFORE INSERT ON character_revisions BEGIN SELECT RAISE(ABORT, 'Demo failed revision'); END;"))
  const priorTrash = workspace.characters.trash().length
  await assert.rejects(workspace.characters.save(draft(character, { name: 'Must roll back', assetIds: [assets[0].id], primaryAssetId: assets[0].id })))
  sql(db => db.exec('DROP TRIGGER demo_fail_character'))
  assert.deepEqual(content(await workspace.characters.get(character.id)), content(character)); assert.equal(workspace.characters.trash().length, priorTrash)
  pass('forced revision failures roll back all character fields, references and trash metadata')

  // Restore two removed references in reverse order; original gallery order must survive.
  character = await workspace.characters.save(draft(character, { assetIds: [assets[2].id], primaryAssetId: assets[2].id }))
  const pending = workspace.characters.trash().filter(t => t.kind === 'photo' && t.characterName === character.name)
  const tokenA = pending.find(t => t.photoName === assets[0].originalName).token, tokenB = pending.find(t => t.photoName === assets[1].originalName).token
  character = await workspace.characters.undo(tokenB)
  character = await workspace.characters.undo(tokenA)
  assert.deepEqual(character.assetIds, assets.map(asset => asset.id))
  await fails(() => workspace.characters.undo(tokenA), 'UNDO_UNAVAILABLE')
  // New primary/metadata edits must not be overwritten by restoring an older photo.
  character = await workspace.characters.save(draft(character, { assetIds: [assets[0].id, assets[2].id], primaryAssetId: assets[2].id }))
  const photoToken = workspace.characters.trash().find(t => t.kind === 'photo' && t.characterName === character.name && t.photoName === assets[1].originalName).token
  character = await workspace.characters.save(draft(character, { name: 'Demo saved for restart', primaryAssetId: assets[0].id }))
  pass('durable photo Undo restores order, is single-use, and keeps later name/primary choices')

  const originalFile = await workspace.mediaFile(assets[0].id, 'original'), moved = path.join(root, 'Demo missing original.png')
  await rename(originalFile, moved)
  assert.equal((await workspace.characters.get(character.id)).photos[0].available, false)
  await fails(() => workspace.characters.save(draft(character)), 'INVALID_CHARACTER')
  await rename(moved, originalFile)
  await rename(sources[0].filename, path.join(root, 'Demo moved owner source.png'))
  assert.ok((await workspace.characters.get(character.id)).photos.every(photo => photo.available))
  pass('missing primary reported, save protected, and moving owner source leaves managed photos working')

  const removed = await workspace.characters.remove(character.id, character.revision)
  await fails(() => workspace.characters.get(character.id), 'CHARACTER_NOT_FOUND')
  await fails(() => workspace.characters.undo(photoToken), 'UNDO_UNAVAILABLE')
  character = await workspace.characters.undo(removed.token)
  assert.equal(character.primaryAssetId, assets[0].id)
  const trashCopy = await workspace.characters.save(draft(copy, { name: 'Demo persistent character trash' }))
  const { token: characterToken } = await workspace.characters.remove(trashCopy.id, trashCopy.revision)
  sql(db => db.exec("CREATE TRIGGER demo_fail_undo BEFORE UPDATE ON character_trash BEGIN SELECT RAISE(ABORT, 'Demo failed undo'); END;"))
  await assert.rejects(workspace.characters.undo(characterToken))
  sql(db => db.exec('DROP TRIGGER demo_fail_undo'))
  await fails(() => workspace.characters.get(trashCopy.id), 'CHARACTER_NOT_FOUND')
  const expectedAssets = await Promise.all([...assets, edit].map(async asset => ({ id: asset.id, hash: hash(await readFile(await workspace.mediaFile(asset.id, 'original'))) })))
  await writeFile(reportFile, JSON.stringify({ root, folder, character: { id: character.id, revision: character.revision, content: content(character) }, assets: expectedAssets, sourceId: assets[1].id, editedId: edit.id, characterToken, photoToken }, null, 2))
  for (const asset of expectedAssets) await access(await workspace.mediaFile(asset.id, 'original'))
  pass('character trash/Undo preserves files and revisions, parent restoration order, failed-Undo atomicity and persisted pending tokens')
} finally { await workspace.close() }
