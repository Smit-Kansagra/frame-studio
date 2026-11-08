// Product batching checks with isolated local storage and a fake Flow driver.
// No signed-in browser, app data or Flow credits are used.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { Workspace } from '../dist-electron/storage/workspace.cjs'
import { FlowCoordinator } from '../dist-electron/flow-coordinator.cjs'
import { StorageError } from '../dist-electron/storage/errors.cjs'
import { postPhotos } from '../dist-electron/storage/post-plan.mjs'
import { assemblePrompt } from '../dist-electron/storage/prompt-core.mjs'

const root = await mkdtemp(path.join(os.tmpdir(), 'frame-post-products-'))
const folder = path.join(root, 'workspace')
let ws = await Workspace.open(folder)
const assets = []
for (let index = 0; index < 10; index++) {
  const file = path.join(root, `photo-${index + 1}.png`)
  await writeFile(file, await sharp({ create: { width: 64, height: 80, channels: 3, background: { r: 20 + index * 20, g: 80, b: 120 } } }).png().toBuffer())
  assets.push(await ws.importImage(file))
}
const product = await ws.products.save({ name: 'Products', description: '', notes: '', assetIds: assets.slice(0, 5).map(item => item.id), primaryAssetId: assets[0].id })
const theme = await ws.themes.save({ name: 'Directions', description: '', coverAssetId: assets[8].id, referenceAssetIds: assets.slice(5, 8).map(item => item.id), masterPrompt: 'Style {{product_name}} using the supplied visual direction.', outputType: 'post', aspectRatio: '4:5', defaultDuration: 0, compositionPrompt: 'One product, styled photograph.', scenes: [] })
const character = await ws.characters.save({ name: 'Presenter', category: null, assetIds: [assets[9].id], primaryAssetId: assets[9].id })
const makeProject = name => ws.projects.save({ name, productId: product.id, themeId: theme.id, characterId: character.id, outputType: 'post', preset: 'post-portrait', duration: 0 })
const project = await makeProject('Five product images')
const slots = postPhotos(project)
assert.deepEqual(slots.map(item => item.reference.id), [5, 6, 7, 5, 6].map(index => assets[index].id))
for (const [index, slot] of slots.entries()) {
  const prompt = assemblePrompt(project, undefined, slot.id)
  assert.deepEqual(prompt.errors, [])
  assert.deepEqual(prompt.references.map(item => item.id), [assets[index].id, assets[5 + index % 3].id, assets[9].id])
  assert.match(prompt.text, new RegExp(`Product photo ${index + 1} of 5`))
  assert.ok(!prompt.references.some(item => item.id === assets[8].id), 'The theme cover is not a visual reference')
}
assert.equal(postPhotos({ ...project, snapshot: { ...project.snapshot, product: { ...project.snapshot.product, photos: product.photos.slice(0, 2) } } }).length, 2, 'Reference count cannot increase output count')
const noRefs = structuredClone(project); noRefs.snapshot.theme.referenceAssetIds = []
assert.deepEqual(assemblePrompt(noRefs).references.map(item => item.id), [assets[0].id, assets[9].id])

const requests = [], submissions = [], results = new Map(), names = new Map()
let current, created = 0, failOn = '', interruptDownload = false
const resultFile = path.join(root, 'photo-1.png')
const driver = {
  async createProject(commit) { const url = `https://flow.google.com/project/fixture-${++created}`; await commit(url); return url },
  async nameProject(url, name) { names.set(url, name) },
  async prepare(_url, request) {
    current = request; requests.push(request)
    assert.equal(request.outputs, 1)
    if (request.prompt.includes(failOn) && failOn) throw new StorageError('INVALID_REQUEST', 'Fixture preparation failed')
    return [...results.keys()]
  },
  async submit() { const id = `result-${submissions.length + 1}`; submissions.push(current); results.set(id, current.prompt) },
  async results(_url, prompt, _type, baseline) { return [...results].filter(([id, text]) => text === prompt && !baseline.includes(id)).map(([id]) => ({ id, selector: `#${id}` })) },
  async download() { if (interruptDownload) { interruptDownload = false; throw new StorageError('INVALID_REQUEST', 'Fixture interrupted download') } return resultFile },
}
const settle = async runner => {
  const end = Date.now() + 8000
  while (runner.busy && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(runner.busy, false, 'Queue finished or paused')
}
try {
  let runner = new FlowCoordinator(async () => ws, driver, 5, 100)
  await runner.startPosts(project.id)
  await assert.rejects(() => runner.startPosts(project.id), /active/)
  await settle(runner)
  assert.equal(submissions.length, 5); assert.equal(created, 1)
  assert.equal(names.get(ws.flow.project(project.id).url), project.name)
  assert.equal(new Set(submissions.map(item => item.prompt)).size, 5)
  let attempts = await ws.generations.list(project.id)
  assert.equal(attempts.length, 5)
  for (const [index, slot] of slots.entries()) {
    const attempt = attempts.find(item => item.sceneId === slot.id)
    assert.equal(attempt.state, 'ready-for-review')
    assert.deepEqual(attempt.references, [assets[index].id, assets[5 + index % 3].id, assets[9].id])
    await ws.generations.review(project.id, slot.id, attempt.id, 'approved', 'Keep')
  }
  assert.equal((await ws.generations.reviews(project.id)).length, 5)
  const last = ws.flow.latest(project.id)
  assert.equal(last.postBatch.index, 5); assert.equal(last.postBatch.total, 5)
  await assert.rejects(() => runner.startPosts(project.id), /already has a saved image/)
  const approved = attempts.find(item => item.sceneId === slots[2].id).id
  await ws.generations.reviewLogo(approved,'approved')
  await runner.start(project.id, slots[2].id, 1); await settle(runner)
  assert.equal(submissions.length, 6, 'Regenerate submits only the selected product')
  assert.equal((await ws.generations.reviews(project.id)).find(item => item.sceneId === slots[2].id).selectedAttemptId, approved, 'Previous approval survives regeneration')
  const exported = await ws.exports.start(project.id, { order: [], trims: [], fit: 'crop', muteAll: false, postSceneId: slots[2].id }, path.join(root, 'product-3.png'), () => {})
  assert.deepEqual(exported.sourceAttemptIds, [approved])
  assert.equal((await sharp(exported.path).metadata()).height, 1350)

  const second = await makeProject('Interrupted batch')
  failOn = 'Product photo 2 of 5'
  await runner.startPosts(second.id); await settle(runner)
  assert.notEqual(ws.flow.project(second.id).url, ws.flow.project(project.id).url, 'Different local projects use different Flow projects')
  assert.equal(names.get(ws.flow.project(second.id).url), second.name)
  assert.equal(submissions.length, 10, 'Failed preparation does not submit, while the other four products continue')
  assert.ok(ws.flow.jobs(second.id).some(job=>job.stage==='needs-attention'&&ws.generations.get(job.attemptId).state==='failed'))
  failOn = ''; interruptDownload = true
  await runner.startPosts(second.id); await settle(runner)
  assert.equal(submissions.length, 11, 'A temporary download failure retries automatically and remaining products continue')
  assert.equal((await ws.generations.list(second.id)).filter(item => item.state === 'ready-for-review').length, 5)
  await ws.close(); ws = await Workspace.open(folder)
  runner = new FlowCoordinator(async () => ws, driver, 5, 100)
  await runner.collectPending()
  assert.equal(submissions.length, 11, 'Automatic restart collection never submits work')
  const partial = (await ws.generations.list(second.id)).find(item => item.sceneId === slots[1].id && item.state === 'ready-for-review')
  await ws.generations.review(second.id, slots[1].id, partial.id, 'approved', '')
  await ws.generations.reviewLogo(partial.id,'approved')
  await ws.exports.start(second.id, { order: [], trims: [], fit: 'crop', muteAll: false, postSceneId: slots[1].id }, path.join(root, 'partial-product-2.png'), () => {})
  await assert.rejects(() => ws.exports.start(second.id, { order: [], trims: [], fit: 'crop', muteAll: false, postSceneId: slots[3].id }, path.join(root, 'unapproved.png'), () => {}), /Approve/)
  await assert.rejects(() => runner.startPosts(second.id), /already has a saved image/)
  assert.equal(submissions.length, 11, 'Saved products are never submitted again')
  assert.equal((await ws.generations.list(second.id)).filter(item => item.state === 'ready-for-review').length, 5)
  assert.ok((await readFile(exported.path)).length > 16)
  await assert.rejects(() => ws.generations.prepare(project.id, assets[8].id), /Choose a product photo/)
  console.log('PASS 5 products / 3 references: balanced cycling, isolated attachments, overlapping accepted requests, independent approvals, single-product regeneration, selected export, failed-product isolation, restart recovery and remaining-only continuation. No live Flow generation.')
} finally { await ws.close() }
