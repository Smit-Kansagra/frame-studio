import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, open, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { Workspace } from '../dist-electron/storage/workspace.cjs'
import { ManagedPaths } from '../dist-electron/storage/paths.cjs'
import { failure } from '../dist-electron/storage/errors.cjs'
import { isTrustedRendererUrl } from '../dist-electron/security.cjs'
import { WorkspaceManager } from '../dist-electron/workspace-manager.cjs'
import { SCHEMA_VERSION } from '../dist-electron/storage/database.cjs'

// Synthetic Demo fixtures live only under artifacts/, never in app userData.
const reportFile = path.resolve('artifacts/storage-check-report.json')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const exists = async filename => access(filename).then(() => true, () => false)
const files = async folder => (await readdir(folder)).sort()

if (process.argv[2] === '--verify-restart') {
  const report = JSON.parse(await readFile(reportFile, 'utf8'))
  const artifacts = path.resolve('artifacts')
  assert.ok(path.resolve(report.root).startsWith(`${artifacts}${path.sep}storage-demo-`), 'Report must describe a diagnostic workspace')
  const workspace = await Workspace.open(report.workspace)
  try {
    const status = await workspace.status()
    assert.equal(status.assetCount, report.assets.length)
    assert.deepEqual(status.issues, [])
    for (const expected of report.assets) {
      assert.equal(workspace.getAsset(expected.id).sha256, expected.sha256)
      assert.equal(hash(await readFile(await workspace.mediaFile(expected.id, 'original'))), expected.sha256)
      assert.equal((await sharp(await workspace.mediaFile(expected.id, 'thumbnail')).metadata()).format, 'webp')
    }
    console.log(`PASS separate Node process reopened SQLite and all ${report.assets.length} original/thumbnail pairs`)
  } finally { await workspace.close() }
  process.exit(0)
}

await mkdir('artifacts', { recursive: true })
const root = await mkdtemp(path.resolve('artifacts/storage-demo-'))
const fixtureFolder = path.join(root, 'Demo source images')
const workspaceFolder = path.join(root, 'workspace')
await mkdir(fixtureFolder)
let workspace
const results = []
const imported = []
const sources = []
const pass = message => { results.push(message); console.log(`PASS ${message}`) }
const snapshot = async () => ({
  count: (await workspace.status()).assetCount,
  originals: await files(path.join(workspaceFolder, 'library/originals')),
  thumbnails: await files(path.join(workspaceFolder, 'library/thumbnails')),
})
const sql = query => {
  const db = new DatabaseSync(path.join(workspaceFolder, 'workspace.sqlite'))
  try { return query(db) } finally { db.close() }
}
async function rejection(filename, code) {
  const before = await snapshot()
  await assert.rejects(workspace.importImage(filename), error => { if (code) assert.equal(error.code, code); return true })
  assert.deepEqual(await snapshot(), before, 'Failed import changed committed media')
  assert.deepEqual(await files(path.join(workspaceFolder, 'temp/imports')), [], 'Failed import left a temporary copy')
  assert.equal(sql(db => db.prepare('SELECT count(*) AS count FROM import_jobs').get().count), 0, 'Failed import left a journal row')
}

try {
  workspace = await Workspace.open(workspaceFolder)
  let status = await workspace.status()
  assert.equal(status.assetCount, 0)
  assert.equal(status.schemaVersion, SCHEMA_VERSION)
  assert.deepEqual(status.issues, [])
  assert.equal(sql(db => db.prepare('SELECT count(*) AS count FROM schema_migrations').get().count), SCHEMA_VERSION)
  assert.equal(sql(db => db.prepare('SELECT count(*) AS count FROM products').get().count), 0)
  pass('fresh SQLite migrations and managed folders; no invented product records')

  for (const [format, width, height, filename, orientation] of [
    ['jpeg', 640, 480, 'Demo product.jpg', 1],
    ['png', 1200, 800, "Demo O'Brien.png", 1],
    ['webp', 320, 640, 'Demo portrait.webp', 1],
    ['jpeg', 120, 80, 'Demo rotated.jpg', 6],
    ['png', 48, 32, 'Demo valid photo.unusual-extension', 1],
  ]) {
    let pipeline = sharp({ create: { width, height, channels: 3, background: '#244c3c' } }).toFormat(format)
    if (orientation !== 1) pipeline = pipeline.withMetadata({ orientation })
    const bytes = await pipeline.toBuffer()
    const source = path.join(fixtureFolder, filename)
    await writeFile(source, bytes)
    const asset = await workspace.importImage(source)
    imported.push(asset)
    sources.push({ filename: source, sha256: hash(bytes) })
    assert.equal(asset.format, format)
    assert.equal(asset.width, width)
    assert.equal(asset.height, height)
    assert.equal(asset.orientation, orientation)
    assert.equal(asset.sha256, hash(bytes))
    assert.deepEqual(await readFile(await workspace.mediaFile(asset.id, 'original')), bytes)
    const thumbnail = await sharp(await workspace.mediaFile(asset.id, 'thumbnail')).metadata()
    assert.equal(thumbnail.format, 'webp')
    assert.ok(thumbnail.width <= 512 && thumbnail.height <= 512)
    assert.equal(thumbnail.width, asset.thumbnailWidth)
    assert.equal(thumbnail.height, asset.thumbnailHeight)
    if (orientation === 6) { assert.equal(thumbnail.width, height); assert.equal(thumbnail.height, width) }
    assert.equal(asset.originalUrl, `frame-media://asset/${asset.id}/original`)
    assert.ok(!JSON.stringify(asset).includes(workspaceFolder))
  }
  pass('real JPG/PNG/WebP imports, byte-identical managed originals, orientation, content detection, and decoded WebP thumbnails')

  const fake = path.join(fixtureFolder, 'Demo fake.jpg')
  await writeFile(fake, '%PDF-1.7 This is not a photograph')
  await rejection(fake, 'UNSUPPORTED_IMAGE')
  const damaged = path.join(fixtureFolder, 'Demo damaged.png')
  await writeFile(damaged, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('damaged')]))
  await rejection(damaged, 'INVALID_IMAGE')
  await rejection(path.join(fixtureFolder, 'Demo absent.jpg'), 'FILE_UNREADABLE')
  await rejection(fixtureFolder, 'FILE_UNREADABLE')
  pass('spoofed, damaged, missing, and directory inputs fail cleanly without records or leftover media')

  const frameData = Buffer.alloc(10 * 20 * 3)
  frameData.fill(40, 0, 300)
  frameData.fill(210, 300)
  const animation = await sharp(frameData, { raw: { width: 10, height: 20, pageHeight: 10, channels: 3 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer()
  assert.equal((await sharp(animation).metadata()).pages, 2)
  const animationPath = path.join(fixtureFolder, 'Demo animated.webp')
  await writeFile(animationPath, animation)
  await rejection(animationPath, 'UNSUPPORTED_IMAGE')
  pass('real animated WebP is rejected instead of silently importing its first frame')

  const oversized = path.join(fixtureFolder, 'Demo oversized.png')
  const largeFile = await open(oversized, 'wx')
  await largeFile.truncate(20 * 1024 * 1024 + 1)
  await largeFile.close()
  await rejection(oversized, 'IMAGE_TOO_LARGE')
  const hugePixels = await sharp({ create: { width: 8000, height: 6000, channels: 3, background: '#fff' } }).png().toBuffer()
  const hugePath = path.join(fixtureFolder, 'Demo too many pixels.png')
  await writeFile(hugePath, hugePixels)
  await rejection(hugePath, 'IMAGE_TOO_LARGE')
  pass('20 MB byte limit and 40 million decoded-pixel limit enforced on real files')

  sql(db => db.exec("CREATE TRIGGER demo_fail_asset BEFORE INSERT ON assets BEGIN SELECT RAISE(ABORT, 'Demo forced database failure'); END;"))
  await rejection(sources[0].filename)
  sql(db => db.exec('DROP TRIGGER demo_fail_asset'))
  assert.ok(!JSON.stringify(failure(new Error('Demo private database details'), 'IMPORT_FAILED')).includes('private'))
  pass('database failure after file copies rolls back record, journal, staging, and final copies; public errors omit internal details')

  await workspace.close()
  workspace = await Workspace.open(workspaceFolder)
  assert.equal(sql(db => db.prepare('SELECT count(*) AS count FROM schema_migrations').get().count), SCHEMA_VERSION)
  assert.equal((await workspace.status()).assetCount, imported.length)
  pass('close/reopen preserves SQLite records; schema migration is not applied twice')

  const originalPath = await workspace.mediaFile(imported[0].id, 'original')
  const originalBackup = path.join(fixtureFolder, 'Demo temporarily missing managed original')
  await rename(originalPath, originalBackup)
  await workspace.close()
  workspace = await Workspace.open(workspaceFolder)
  status = await workspace.status()
  assert.equal(status.assetCount, imported.length)
  assert.ok(status.issues.some(issue => issue.code === 'MISSING_MEDIA' && issue.assetId === imported[0].id))
  assert.equal(workspace.getAsset(imported[0].id).id, imported[0].id)
  await rename(originalBackup, originalPath)
  assert.deepEqual((await workspace.status()).issues, [])
  pass('startup reports missing media without deleting its record or other good files')

  const interrupted = randomUUID()
  const partialOriginal = `library/originals/${interrupted}.png`
  const partialThumbnail = `library/thumbnails/${interrupted}.webp`
  await mkdir(path.join(workspaceFolder, 'temp/imports', interrupted))
  await writeFile(path.join(workspaceFolder, 'temp/imports', interrupted, 'source'), 'Demo incomplete copy')
  await writeFile(path.join(workspaceFolder, partialOriginal), 'Demo partial final copy')
  sql(db => db.prepare('INSERT INTO import_jobs(id, original_path, thumbnail_path, created_at) VALUES (?, ?, ?, ?)').run(interrupted, partialOriginal, partialThumbnail, new Date().toISOString()))
  const committedStage = path.join(workspaceFolder, 'temp/imports', imported[0].id)
  await mkdir(committedStage)
  await writeFile(path.join(committedStage, 'source'), 'Demo leftover after commit')
  await workspace.close()
  workspace = await Workspace.open(workspaceFolder)
  assert.equal(await exists(path.join(workspaceFolder, partialOriginal)), false)
  assert.deepEqual(await files(path.join(workspaceFolder, 'temp/imports')), [])
  assert.equal(hash(await readFile(await workspace.mediaFile(imported[0].id, 'original'))), imported[0].sha256)
  assert.equal(sql(db => db.prepare('SELECT count(*) AS count FROM import_jobs').get().count), 0)
  pass('restart reconciles partially copied imports and post-commit temporary copies while preserving committed assets')

  const invalidJob = randomUUID()
  const protectedSource = sources[1].filename
  sql(db => db.prepare('INSERT INTO import_jobs(id, original_path, created_at) VALUES (?, ?, ?)').run(invalidJob, '../Demo source images/' + path.basename(protectedSource), new Date().toISOString()))
  await workspace.close()
  workspace = await Workspace.open(workspaceFolder)
  assert.ok((await workspace.status()).issues.some(issue => issue.code === 'INTERRUPTED_IMPORT'))
  assert.equal(hash(await readFile(protectedSource)), sources[1].sha256)
  sql(db => db.prepare('DELETE FROM import_jobs WHERE id = ?').run(invalidJob))
  await workspace.close()
  workspace = await Workspace.open(workspaceFolder)
  pass('invalid recovery paths preserve files and report attention instead of deleting outside managed media')

  const paths = await ManagedPaths.create(path.join(root, 'Demo path checks'))
  for (const relative of ['../secret', '/../../secret', 'C:/secret', 'library\\originals\\secret', 'library//originals', 'library/../secret']) {
    assert.throws(() => paths.resolve(relative), error => error.code === 'INVALID_REQUEST')
  }
  assert.throws(() => workspace.getAsset("' OR 1=1 --"), error => error.code === 'INVALID_REQUEST')
  await assert.rejects(workspace.mediaFile(randomUUID(), 'original'), error => error.code === 'ASSET_NOT_FOUND')
  assert.ok(isTrustedRendererUrl('frame-studio://app/index.html#settings'))
  assert.ok(isTrustedRendererUrl('http://127.0.0.1:5173/#settings', 'http://127.0.0.1:5173'))
  for (const url of ['https://evil.example/index.html', 'frame-studio://evil/index.html', 'frame-studio://app/other.html', 'frame-studio://app:123/index.html', 'frame-studio://user@app/index.html', 'frame-studio://app/index.html?remote=1']) assert.equal(isTrustedRendererUrl(url), false)
  pass('managed path traversal, unknown asset identifiers, and untrusted renderer URLs are rejected')

  const futureFolder = path.join(root, 'Demo newer workspace')
  await mkdir(futureFolder)
  const futureDatabase = path.join(futureFolder, 'workspace.sqlite')
  const future = new DatabaseSync(futureDatabase)
  future.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('Demo preserved'); PRAGMA user_version = 999;")
  future.close()
  const futureBytes = hash(await readFile(futureDatabase))
  await assert.rejects(Workspace.open(futureFolder), error => error.code === 'SCHEMA_TOO_NEW')
  assert.equal(hash(await readFile(futureDatabase)), futureBytes)
  pass('a newer database schema is refused with database bytes preserved')

  const blockedFolder = path.join(root, 'Demo blocked workspace')
  await writeFile(blockedFolder, 'Demo blocking file, preserved during retry')
  const manager = new WorkspaceManager(blockedFolder)
  try {
    const unavailable = await manager.status()
    assert.equal(unavailable.ok, false)
    assert.equal(unavailable.error.code, 'STORAGE_UNAVAILABLE')
    await rename(blockedFolder, path.join(fixtureFolder, 'Demo preserved blocking file'))
    const retried = await manager.status(true)
    assert.equal(retried.ok, true)
    assert.equal(retried.value.assetCount, 0)
  } finally { await manager.close() }
  pass('storage initialization reports a friendly error and retry opens the workspace after the cause is resolved')

  for (const source of sources) assert.equal(hash(await readFile(source.filename)), source.sha256)
  await rename(sources[0].filename, `${sources[0].filename}.moved`)
  assert.equal(hash(await readFile(await workspace.mediaFile(imported[0].id, 'original'))), imported[0].sha256)
  assert.deepEqual((await workspace.status()).issues, [])
  pass('source photos are unmodified; moving a source does not break the managed import')

  const queued = await Promise.allSettled([workspace.importImage(fake), workspace.importImage(sources[1].filename), workspace.importImage(sources[2].filename)])
  assert.equal(queued[0].status, 'rejected')
  for (const result of queued.slice(1)) { assert.equal(result.status, 'fulfilled'); imported.push(result.value) }
  assert.equal((await workspace.status()).assetCount, imported.length)
  assert.deepEqual(await files(path.join(workspaceFolder, 'temp/imports')), [])
  pass('concurrent import requests are serialized and a failed request does not poison later imports')

  await writeFile(reportFile, JSON.stringify({ root, workspace: workspaceFolder, assets: imported.map(asset => ({ id: asset.id, sha256: asset.sha256 })), checks: results }, null, 2))
  console.log(`Storage checks passed. Demo artifacts: ${root}`)
  console.log('Run node scripts/check-storage.mjs --verify-restart to verify in a separate process.')
} finally { await workspace?.close() }
