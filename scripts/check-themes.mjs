import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { Workspace } from '../dist-electron/storage/workspace.cjs'
import { readPromptFile } from '../dist-electron/storage/prompt-file.cjs'
import { validateThemeDraft } from '../dist-electron/storage/themes.cjs'
import { SCHEMA_VERSION } from '../dist-electron/storage/database.cjs'

const reportFile = path.resolve('artifacts/theme-check-report.json')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const pass = message => console.log(`PASS ${message}`)
const content = theme => { const { name, description, coverAssetId, referenceAssetIds, masterPrompt, outputType, aspectRatio, defaultDuration, compositionPrompt, scenes, referenceInstructions, negativePrompt } = theme; return { name, description, coverAssetId, referenceAssetIds, masterPrompt, outputType, aspectRatio, defaultDuration, compositionPrompt, scenes, referenceInstructions, negativePrompt } }
const draft = (theme, changes = {}) => ({ ...content(theme), id: theme.id, expectedRevision: theme.revision, ...changes })
const reel = () => ({ name: 'Demo Quiet morning', description: 'Warm light, slow details', coverAssetId: null, referenceAssetIds: [], masterPrompt: 'Warm morning light for {{product_name}}. Preserve {{product_notes}}.', outputType: 'reel', aspectRatio: '9:16', defaultDuration: 20, compositionPrompt: '', scenes: [6, 7, 7].map((duration, index) => ({ id: randomUUID(), name: `Demo shot ${index + 1}`, prompt: `Frame {{product_name}} in shot ${index + 1}.`, duration, relationship: index === 1 ? 'continue' : 'new-shot', transition: 'cut' })) })
const fails = (fn, code) => assert.rejects(Promise.resolve().then(fn), error => code ? error.code === code : ['INVALID_THEME', 'INVALID_REQUEST'].includes(error.code))

if (process.argv[2] === '--verify-restart') {
  const report = JSON.parse(await readFile(reportFile, 'utf8'))
  assert.ok(path.resolve(report.root).startsWith(`${path.resolve('artifacts')}${path.sep}themes-demo-`))
  const workspace = await Workspace.open(report.folder)
  try {
    const theme = await workspace.themes.get(report.theme.id)
    assert.deepEqual(content(theme), report.theme.content)
    assert.equal(theme.revision, report.theme.revision)
    for (const expected of report.assets) assert.equal(hash(await readFile(await workspace.mediaFile(expected.id, 'original'))), expected.hash)
    assert.ok(theme.images.every(image => image.available && image.thumbnailAvailable))
    assert.equal(workspace.getAsset(report.editedId).edit.sourceAssetId, report.sourceId)
    assert.ok(workspace.themes.trash().some(entry => entry.token === report.token))
    const restored = await workspace.themes.undo(report.token)
    assert.equal(restored.name, 'Demo persistent trash')
    pass('separate process retains three-scene timings, cover, references, master prompt, revisions, edit recipes, media, and durable Undo')
  } finally { await workspace.close().catch(error => { if(error.code !== 'ERR_INVALID_STATE') throw error }) }
  process.exit(0)
}

await mkdir('artifacts', { recursive: true })
const root = await mkdtemp(path.resolve('artifacts/themes-demo-')), folder = path.join(root, 'workspace')
let workspace = await Workspace.open(folder)
const sql = action => { const db = new DatabaseSync(path.join(folder, 'workspace.sqlite')); try { db.exec('PRAGMA foreign_keys=ON'); return action(db) } finally { db.close() } }
const source = path.join(root, 'Demo reference.png')
// Four coloured quadrants prove orientation and extract order, not just dimensions.
const bytes = await sharp({ create: { width: 200, height: 120, channels: 3, background: '#ff0000' } }).composite([{ input: await sharp({ create: { width: 100, height: 120, channels: 3, background: '#0000ff' } }).png().toBuffer(), left: 100, top: 0 }]).png().toBuffer()
await writeFile(source, bytes)
try {
  const asset = await workspace.importImage(source)
  const product = await workspace.products.save({ name: 'Demo existing product', description: '', notes: '', primaryAssetId: asset.id, assetIds: [asset.id] })
  await workspace.close()
  // Downgrade only an isolated, empty-theme test schema to the exact previous phase.
  sql(db => db.exec('DROP TABLE logo_reviews; DROP TABLE flow_jobs; DROP TABLE flow_projects; DROP TABLE project_exports; DROP TABLE scene_reviews; DROP TABLE generation_attempts; DROP TABLE project_assets; DROP TABLE project_revisions; DROP TABLE projects; DROP TABLE character_trash; DROP TABLE character_assets; DROP TABLE character_revisions; DROP TABLE characters; DROP TABLE theme_trash; DROP TABLE theme_assets; DROP TABLE theme_revisions; DROP TABLE themes; DROP TABLE asset_edits; DELETE FROM schema_migrations WHERE version >= 3; PRAGMA user_version = 2;'))
  workspace = await Workspace.open(folder)
  assert.equal((await workspace.status()).schemaVersion, SCHEMA_VERSION)
  assert.equal((await workspace.products.get(product.id)).name, product.name)
  assert.equal((await workspace.themes.list()).length, 0)
  assert.equal(hash(await readFile(await workspace.mediaFile(asset.id, 'original'))), hash(bytes))
  pass('schema 2 upgrades to the current schema without losing product records or media; empty installation has no theme fixtures')

  const imported = path.join(root, 'Demo prompt.txt')
  await writeFile(imported, '\ufeffDemo café – {{product_name}}\r\nKeep the label.'); const text = await readPromptFile(imported)
  assert.equal(text.text, 'Demo café – {{product_name}}\nKeep the label.')
  for (const data of [Buffer.from([255, 254, 65, 0]), Buffer.from(''), Buffer.from('binary\0text'), Buffer.alloc(80001, 65), Buffer.from('a'.repeat(20001))]) { await writeFile(imported, data); await fails(() => readPromptFile(imported), 'INVALID_PROMPT_FILE') }
  await fails(() => readPromptFile(source), 'INVALID_PROMPT_FILE')
  await fails(() => readPromptFile(path.join(root, 'missing.txt')), 'FILE_UNREADABLE')
  pass('bounded UTF-8 prompt import accepts BOM/newlines; empty, non-UTF-8, binary, oversized, wrong-extension, and missing files fail clearly')

  let theme = await workspace.themes.save({ ...reel(), coverAssetId: asset.id })
  assert.equal(theme.scenes.length, 3); assert.equal(theme.revision, 1)
  assert.deepEqual(theme.referenceAssetIds, [])
  const badChanges = [{ name: '' }, { masterPrompt: '' }, { masterPrompt: '{{unknown}}' }, { masterPrompt: '{{product_name}' }, { masterPrompt: 'oops }}' }, { defaultDuration: 19 }, { aspectRatio: '1:1' }, { scenes: [] }, { scenes: theme.scenes.map((s, i) => i === 0 ? { ...s, relationship: 'continue' } : s) }, { scenes: theme.scenes.map((s, i) => i === 1 ? { ...s, prompt: '' } : s) }, { scenes: theme.scenes.map(s => ({ ...s, id: theme.scenes[0].id })) }, { scenes: theme.scenes.map(s => ({ ...s, transition: 'crossfade' })) }, { scenes: theme.scenes.map(s => ({ ...s, duration: NaN })) }, { referenceAssetIds: [asset.id, asset.id] }, { extra: 'untrusted' }]
  for (const changes of badChanges) await fails(() => workspace.themes.save(draft(theme, changes)))
  assert.equal((await workspace.themes.get(theme.id)).revision, 1)
  validateThemeDraft({ ...reel(), masterPrompt: '{{product_name}} {{product_description}} {{product_notes}} {{character_name}} {{character_prompt}} {{scene_number}} {{scene_prompt}} {{aspect_ratio}} {{target_duration}}' })
  pass('three-scene creation and explicit cover/reference distinction; invalid names, placeholders, prompts, timings, ratios, scenes, transitions, and unknown fields rejected')

  const edit = { rotation: 90, crop: { x: 0, y: 0, width: 1, height: .5 } }
  const edited = await workspace.editImage(asset.id, edit)
  assert.deepEqual([edited.width, edited.height, edited.orientation], [120, 100, 1])
  assert.equal(edited.edit.sourceAssetId, asset.id)
  assert.ok((await workspace.mediaFile(edited.id, 'original')).includes(`${path.sep}edits${path.sep}`))
  const pixel = await sharp(await workspace.mediaFile(edited.id, 'original')).raw().toBuffer()
  assert.ok(pixel[0] > 240 && pixel[2] < 10, 'rotation then crop selects the red left half of the original')
  const reset = await workspace.editImage(edited.id, { rotation: 0, crop: { x: 0, y: 0, width: 1, height: 1 } })
  assert.deepEqual([reset.width, reset.height], [200, 120]); assert.equal(reset.edit.sourceAssetId, asset.id)
  for (const invalid of [{ ...edit, rotation: 45 }, { ...edit, crop: { x: .9, y: 0, width: .5, height: 1 } }, { ...edit, crop: { x: 0, y: 0, width: 0, height: 1 } }, { ...edit, path: source }, { ...edit, crop: { x: NaN, y: 0, width: 1, height: 1 } }]) await fails(() => workspace.editImage(asset.id, invalid), 'INVALID_REQUEST')
  assert.equal(hash(await readFile(source)), hash(bytes))
  assert.equal(hash(await readFile(await workspace.mediaFile(asset.id, 'original'))), hash(bytes))
  pass('real quarter-turn/crop pixels, derivative provenance, reset from original, safe bounds, and byte-for-byte source preservation')

  const oldContent = content(theme)
  theme = await workspace.themes.save(draft(theme, { name: 'Demo morning revised', coverAssetId: edited.id, referenceAssetIds: [asset.id, edited.id], masterPrompt: 'Edited master for {{product_name}}', scenes: [theme.scenes[0], theme.scenes[2], { ...theme.scenes[1], relationship: 'continue', duration: 6 }], defaultDuration: 19 }))
  assert.equal(theme.revision, 2); assert.equal(theme.scenes[2].duration, 6)
  assert.deepEqual(JSON.parse(sql(db => db.prepare('SELECT content FROM theme_revisions WHERE theme_id = ? AND revision = 1').get(theme.id).content)), oldContent)
  assert.equal(sql(db => db.prepare('SELECT count(*) AS n FROM theme_assets WHERE theme_id = ? AND revision = 1').get(theme.id).n), 1)
  pass('editing cover, references, master prompt, order, relationships and timings creates a new revision while preserving earlier snapshots')

  let copy = await workspace.themes.duplicate(theme.id, theme.revision)
  assert.notEqual(copy.id, theme.id); assert.notEqual(copy.scenes[0].id, theme.scenes[0].id)
  copy = await workspace.themes.save(draft(copy, { name: 'Demo independent copy', coverAssetId: asset.id, masterPrompt: 'Different master', scenes: copy.scenes.map((s, i) => i === 0 ? { ...s, prompt: 'Different shot' } : s) }))
  assert.deepEqual(content(await workspace.themes.get(theme.id)), content(theme))
  pass('duplicate theme has independent IDs, prompts, storyboard and image choices; source theme unchanged')

  const stale = draft(theme), next = await workspace.themes.save(draft(theme, { description: 'Revised description' }))
  await fails(() => workspace.themes.save(stale), 'THEME_CHANGED')
  await fails(() => workspace.themes.remove(theme.id, theme.revision), 'THEME_CHANGED')
  await fails(() => workspace.themes.duplicate(theme.id, theme.revision), 'THEME_CHANGED')
  const concurrent = await Promise.allSettled([workspace.themes.save(draft(next, { description: 'Winner one' })), workspace.themes.save(draft(next, { description: 'Winner two' }))])
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1)
  theme = await workspace.themes.get(theme.id)
  pass('stale saves/removals/duplicates rejected and concurrent writes serialized')

  sql(db => db.exec("CREATE TRIGGER demo_fail_theme BEFORE INSERT ON theme_revisions BEGIN SELECT RAISE(ABORT, 'Demo forced rollback'); END;"))
  await assert.rejects(workspace.themes.save(draft(theme, { name: 'Must roll back' })))
  sql(db => db.exec('DROP TRIGGER demo_fail_theme'))
  assert.equal((await workspace.themes.get(theme.id)).name, theme.name)
  const oldCount = (await workspace.status()).assetCount
  sql(db => db.exec("CREATE TRIGGER demo_fail_edit BEFORE INSERT ON asset_edits BEGIN SELECT RAISE(ABORT, 'Demo forced rollback'); END;"))
  await assert.rejects(workspace.editImage(asset.id, edit))
  sql(db => db.exec('DROP TRIGGER demo_fail_edit'))
  assert.equal((await workspace.status()).assetCount, oldCount)
  assert.equal(sql(db => db.prepare('SELECT count(*) AS n FROM import_jobs').get().n), 0)
  pass('forced theme revision and image derivative write failures roll back records and clean staged files')

  const post = await workspace.themes.save({ ...reel(), name: 'Demo post', outputType: 'post', aspectRatio: '4:5', defaultDuration: 0, scenes: [], compositionPrompt: 'One still of {{product_name}}.' })
  const masterOnly=await workspace.themes.save(draft(post, { compositionPrompt: '' }));assert.equal(masterOnly.compositionPrompt,'','Post themes can rely on the master prompt without a separate composition field')
  await fails(() => workspace.themes.save(draft(post, { scenes: reel().scenes })))
  pass('Post uses one validated composition with compatible image dimensions and no fake reel timeline')

  const originalFile = await workspace.mediaFile(asset.id, 'original'), moved = path.join(root, 'Demo temporarily missing.png')
  await rename(originalFile, moved)
  assert.equal((await workspace.themes.get(theme.id)).images.find(image => image.id === asset.id).available, false)
  theme = await workspace.themes.save(draft(theme, { description: 'Missing saved references retained for repair' }))
  await fails(() => workspace.themes.save({ ...reel(), coverAssetId: asset.id }), 'INVALID_THEME')
  await rename(moved, originalFile); await rename(source, path.join(root, 'Demo moved source.png'))
  assert.ok((await workspace.themes.get(theme.id)).images.every(image => image.available))
  pass('missing media is reported and retained; new missing selections refused; moving owner source does not break imports')

  const removed = await workspace.themes.remove(copy.id, copy.revision)
  await fails(() => workspace.themes.get(copy.id), 'THEME_NOT_FOUND')
  const restored = await workspace.themes.undo(removed.token)
  assert.equal(restored.name, copy.name)
  await fails(() => workspace.themes.undo(removed.token), 'UNDO_UNAVAILABLE')
  for (const image of theme.images) await access(await workspace.mediaFile(image.id, 'original'))
  const trashTheme = await workspace.themes.save({ ...reel(), name: 'Demo persistent trash' })
  const { token } = await workspace.themes.remove(trashTheme.id, trashTheme.revision)
  const expectedAssets = await Promise.all([asset, edited, reset].map(async image => ({ id: image.id, hash: hash(await readFile(await workspace.mediaFile(image.id, 'original'))) })))
  await writeFile(reportFile, JSON.stringify({ root, folder, theme: { id: theme.id, revision: theme.revision, content: content(theme) }, assets: expectedAssets, sourceId: asset.id, editedId: edited.id, token }, null, 2))
  pass('theme trash and single-use Undo preserve all media and revisions; pending trash retained for separate-process restart')
} finally { await workspace.close() }
