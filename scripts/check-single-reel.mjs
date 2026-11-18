import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { Workspace } from '../dist-electron/storage/workspace.cjs'
import { singleReelStoryboard } from '../dist-electron/storage/reel-plan.mjs'
import { assemblePrompt } from '../dist-electron/storage/prompt-core.mjs'
import { FlowCoordinator } from '../dist-electron/flow-coordinator.cjs'
import { StorageError } from '../dist-electron/storage/errors.cjs'

const root = await mkdtemp(path.join(os.tmpdir(), 'frame-single-reel-'))
let ws = await Workspace.open(path.join(root, 'workspace'))
try {
  const photos = []
  for (let index = 0; index < 5; index++) {
    const source = path.join(root, `${index}.png`)
    await sharp({ create: { width: 40, height: 50, channels: 3, background: '#8899aa' } }).png().toFile(source)
    photos.push(await ws.importImage(source))
  }
  const source = path.join(root, 'motion.webm')
  await writeFile(source, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32)]))
  const video = await ws.themes.importVideo(source)
  const product = await ws.products.save({ name: 'Dress', description: 'Preserve the embroidery.', notes: '', primaryAssetId: photos[0].id, assetIds: [photos[0].id] })
  const character = await ws.characters.save({ name: 'Person', category: null, primaryAssetId: photos[1].id, assetIds: [photos[1].id] })
  const theme = await ws.themes.save({ name: 'Storyboard reel', description: '', outputType: 'reel', aspectRatio: '16:9', defaultDuration: 10, coverAssetId: photos[4].id, storyboardAssetId: photos[2].id, referenceAssetIds: [photos[3].id], referenceVideoIds: [video.id], masterPrompt: 'MASTER_DIRECTION {{product_name}}', compositionPrompt: '', scenes: [1, 2].map(index => ({ id: randomUUID(), name: `Shot ${index}`, prompt: `ACTION_${index}`, duration: 5, relationship: 'new-shot', transition: 'cut' })) })
  const draft = { name: 'One reel', productId: product.id, themeId: theme.id, characterId: character.id, outputType: 'reel', preset: 'reel-vertical', duration: 15, storyboard: singleReelStoryboard(theme) }
  let project = await ws.projects.save(draft)
  assert.equal(project.storyboard.scenes.length, 1)
  assert.equal(project.preset, 'reel-vertical', 'The single-reel profile keeps 9:16 even for landscape theme references')
  assert.equal(project.storyboard.scenes[0].sourceDuration, 15)
  const preview = assemblePrompt(project)
  assert.deepEqual(preview.errors, [])
  assert.deepEqual(new Set(preview.references.map(reference => reference.id)), new Set([photos[0].id, photos[1].id, photos[2].id, photos[3].id, video.id]))
  assert.ok(!preview.references.some(reference => reference.id === photos[4].id), 'An unselected library cover is not uploaded')
  assert.match(preview.text, /MASTER_DIRECTION Dress/)
  assert.match(preview.text, /ACTION_1[\s\S]*ACTION_2/)
  assert.match(preview.text, /Storyboard: follow its visual sequence/)
  assert.match(preview.text, /Omni Flash 1.2.*720p.*1 clip.*15 seconds/)
  for (const patch of [{ duration: 8 }, { preset: 'reel-landscape' }, { storyboard: { ...draft.storyboard, scenes: [...draft.storyboard.scenes, { ...draft.storyboard.scenes[0], id: randomUUID() }] } }]) await assert.rejects(async () => ws.projects.save({ ...draft, ...patch }))
  await assert.rejects(async () => ws.projects.save({ ...draft, id: project.id, expectedRevision: project.revision, storyboard: undefined, duration: 8 }))
  let prepared, submissions = 0
  const driver = {
    async createProject(commit) { const url = 'https://flow.google.com/project/offline-reel'; await commit(url); return url },
    async nameProject() {},
    async prepare(_url, request) { prepared = request; throw new StorageError('INVALID_REQUEST', 'Offline fixture stops before submission.') },
    async submit() { submissions++ }, async results() { return [] }, async download() { throw Error('No remote results used') },
  }
  const runner = new FlowCoordinator(async () => ws, driver, 5, 100)
  await assert.rejects(() => runner.start(project.id, project.storyboard.scenes[0].id, 2), /exactly one/)
  const job = await runner.start(project.id, project.storyboard.scenes[0].id, 1)
  const deadline = Date.now() + 5000
  while (runner.busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(runner.busy, false)
  assert.equal(submissions, 0)
  assert.equal(prepared.outputs, 1)
  assert.equal(prepared.sourceDuration, 15)
  assert.deepEqual(prepared.videoSettings, { model: 'Omni Flash 1.2', resolution: '720p' })
  assert.ok(prepared.files.some(file => file.endsWith('.webm')))
  assert.equal(ws.flow.job(job.attemptId).stage, 'needs-attention')
  const plan = await ws.exports.inspect(project.id)
  assert.deepEqual([plan.width, plan.height, plan.targetDuration, plan.scenes.length], [720, 1280, 15, 1])
  await runner.close(); await ws.close(); ws = await Workspace.open(path.join(root, 'workspace'))
  project = await ws.projects.get(project.id)
  assert.equal(project.storyboard.singleClip, true)
  assert.deepEqual(assemblePrompt(project).references, preview.references)
  console.log('PASS one 15-second reel, 9:16/720p export, full storyboard/image/video/character references, exact Flow request, legacy scene directions, invalid settings blocked and persisted project reopened.')
} finally { await ws.close() }
