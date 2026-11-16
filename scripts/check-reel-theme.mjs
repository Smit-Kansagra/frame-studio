import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { _electron as electron } from 'playwright'

// Real desktop bridge and media protocol, isolated from the owner's workspace.
const profile = await mkdtemp(path.join(os.tmpdir(), 'frame-studio-check-'))
const env = { ...process.env, FRAME_STUDIO_TEST_PROFILE: profile }
const unpackedIndex = process.argv.indexOf('--unpacked')
const unpacked = unpackedIndex >= 0 ? process.argv[unpackedIndex + 1] : undefined
if (unpackedIndex >= 0 && !unpacked) throw new Error('Pass the unpacked app executable after --unpacked.')
delete env.ELECTRON_RUN_AS_NODE
delete env.FRAME_STUDIO_DEV_URL
const photo1 = path.join(profile, 'storyboard.png'), photo2 = path.join(profile, 'replacement.png')
await sharp({ create: { width: 160, height: 120, channels: 3, background: '#6688aa' } }).png().toFile(photo1)
await sharp({ create: { width: 120, height: 160, channels: 3, background: '#aa8866' } }).png().toFile(photo2)
const launch = () => electron.launch({ executablePath: unpacked ? path.resolve(unpacked) : undefined, args: unpacked ? ['--frame-studio-package-check'] : ['.', `--user-data-dir=${profile}`], env, chromiumSandbox: true })
let desktop, page
const pick = filename => desktop.evaluate(({ dialog }, filename) => {
  dialog.showOpenDialog = async () => ({ canceled: !filename, filePaths: filename ? [filename] : [] })
}, filename)
const result = response => { assert.equal(response.ok, true, JSON.stringify(response)); return response.value }

try {
  desktop = await launch()
  page = await desktop.firstWindow()
  await page.waitForLoadState()
  page.on('dialog', dialog => { void dialog.accept().catch(() => {}) })
  await page.getByRole('link', { name: 'Themes', exact: true }).click()
  await page.getByRole('link', { name: 'Add your first theme' }).click()
  await page.locator('#theme-name').fill('Reel photo storyboard')
  assert.equal(await page.getByRole('button', { name: 'Reference instructions', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Edit instructions', exact: true }).count(), 0)
  await page.getByRole('button', { name: 'Master prompt', exact: true }).click()
  assert.equal(await page.locator('#theme-placeholder').count(), 0)
  assert.equal(await page.getByText('Insert a placeholder', { exact: true }).count(), 0)
  await page.locator('#theme-master').fill('Soft daylight for {{product_name}}.')
  await page.getByRole('button', { name: 'Next: Storyboard', exact: true }).click()
  assert.equal(await page.locator('.theme-storyboard-photo input, .theme-storyboard-photo textarea, .theme-storyboard-photo select, .theme-scenes, .theme-timing').count(), 0)
  await pick(null)
  await page.getByRole('button', { name: 'Add photo', exact: true }).click()
  assert.equal(await page.getByRole('img', { name: 'Storyboard photo', exact: true }).count(), 0)
  await pick(photo1)
  await page.getByRole('button', { name: 'Add photo', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.theme-storyboard-image img')?.naturalWidth === 160)
  await pick(photo2)
  await page.getByRole('button', { name: 'Replace photo', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.theme-storyboard-image img')?.naturalWidth === 120)
  assert.equal(await page.getByRole('img', { name: 'Storyboard photo', exact: true }).count(), 1)
  await page.getByRole('button', { name: 'Defaults', exact: true }).click()
  await page.locator('#theme-duration').fill('8')

  // Record a tiny playable WebM locally; no FFmpeg or network fixture needed.
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 64; canvas.height = 64
    const stream = canvas.captureStream(10), chunks = []
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
    recorder.ondataavailable = event => chunks.push(event.data)
    const done = new Promise(resolve => { recorder.onstop = resolve })
    recorder.start()
    for (let i = 0; i < 8; i++) {
      canvas.getContext('2d').fillStyle = i % 2 ? '#334455' : '#778899'
      canvas.getContext('2d').fillRect(0, 0, 64, 64)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    recorder.stop(); await done; stream.getTracks().forEach(track => track.stop())
    return [...new Uint8Array(await new Blob(chunks).arrayBuffer())]
  })
  const videoSource = path.join(profile, 'reference.webm')
  await writeFile(videoSource, Buffer.from(bytes))
  await pick(null)
  await page.getByRole('button', { name: 'Add video', exact: true }).click()
  assert.equal(await page.locator('.theme-video-references video').count(), 0)
  await pick(photo1)
  await page.getByRole('button', { name: 'Add video', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Choose an MP4' }).waitFor()
  await pick(videoSource)
  await page.getByRole('button', { name: 'Add video', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.theme-video-references video')?.readyState >= 1)
  await page.locator('.theme-video-references video').evaluate(async video => { await video.play(); video.pause() })
  await page.getByRole('button', { name: 'Save theme', exact: true }).click()
  await page.waitForURL(url => url.hash === '#themes')
  const saved = result(await page.evaluate(() => window.frameStudio.themes.list()))[0]
  assert.equal(saved.scenes[0].duration, 8)
  assert.equal(saved.defaultDuration, 8)
  assert.ok(saved.scenes[0].prompt)
  assert.equal(saved.referenceVideoIds.length, 1)
  assert.equal(saved.videos[0].available, true)
  assert.equal(saved.images.find(image => image.id === saved.storyboardAssetId).width, 120)

  const product = result(await page.evaluate(assetId => window.frameStudio.products.save({ name: 'Product', description: '', notes: '', assetIds: [assetId], primaryAssetId: assetId }), saved.storyboardAssetId))
  const project = result(await page.evaluate(({ product, saved }) => window.frameStudio.projects.save({ name: 'Reel test', productId: product.id, themeId: saved.id, characterId: null, outputType: 'reel', preset: 'reel-vertical', duration: 8 }), { product, saved }))
  assert.ok(project.snapshot.theme.images.some(image => image.id === saved.storyboardAssetId))
  result(await page.evaluate(({ id, sceneId }) => window.frameStudio.generations.prepare(id, sceneId), { id: project.id, sceneId: project.storyboard.scenes[0].id }))
  const copy = result(await page.evaluate(theme => window.frameStudio.themes.duplicate(theme.id, theme.revision), saved))
  assert.equal(copy.storyboardAssetId, saved.storyboardAssetId)
  assert.deepEqual(copy.referenceVideoIds, saved.referenceVideoIds)
  const removed = result(await page.evaluate(theme => window.frameStudio.themes.remove(theme.id, theme.revision), copy))
  const restored = result(await page.evaluate(token => window.frameStudio.themes.undo(token), removed.token))
  assert.equal(restored.videos[0].available, true)

  const invalidSource = path.join(profile, 'fake.mp4')
  await writeFile(invalidSource, Buffer.alloc(32))
  await pick(invalidSource)
  assert.equal((await page.evaluate(() => window.frameStudio.themes.importVideo())).ok, false)
  const invalidDrafts = await page.evaluate(theme => {
    const { images, videos, id, revision, createdAt, updatedAt, ...content } = theme
    return Promise.all([
      window.frameStudio.themes.save({ ...content, storyboardAssetId: ['two', 'photos'] }),
      window.frameStudio.themes.save({ ...content, referenceVideoIds: [...theme.referenceVideoIds, ...theme.referenceVideoIds] }),
      window.frameStudio.themes.save({ ...content, referenceVideoIds: [crypto.randomUUID()] }),
    ])
  }, saved)
  assert.ok(invalidDrafts.every(response => !response.ok))

  // Moving the source cannot break the managed copy after restart.
  await rename(videoSource, videoSource + '.moved')
  await desktop.close(); desktop = await launch(); page = await desktop.firstWindow()
  await page.waitForLoadState()
  page.on('dialog', dialog => { void dialog.accept().catch(() => {}) })
  await page.evaluate(id => { location.hash = `#themes/${id}` }, saved.id)
  await page.getByRole('button', { name: 'Storyboard', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.theme-storyboard-image img')?.naturalWidth === 120)
  await page.waitForFunction(() => document.querySelector('.theme-video-references video')?.readyState >= 1)
  await page.locator('.theme-video-references video').evaluate(async video => { await video.play(); video.pause() })
  await mkdir('.verification', { recursive: true })
  await page.screenshot({ path: '.verification/reel-theme-storyboard.png', fullPage: true })
  await page.getByRole('button', { name: 'Remove photo', exact: true }).click()
  assert.equal(await page.locator('.theme-storyboard-image img').count(), 0)
  await page.getByRole('button', { name: 'Undo draft change', exact: true }).click()
  assert.equal(await page.locator('.theme-storyboard-image img').count(), 1)
  await page.getByRole('button', { name: 'Remove video', exact: true }).click()
  assert.equal(await page.locator('.theme-video-references video').count(), 0)
  await page.getByRole('button', { name: 'Undo draft change', exact: true }).click()
  assert.equal(await page.locator('.theme-video-references video').count(), 1)
  await pick(videoSource + '.moved')
  // Unsupported extensions fail even if the bytes contain a WebM.
  await page.getByRole('button', { name: 'Replace video', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Choose an MP4' }).waitFor()
  const replacement = path.join(profile, 'replacement.webm')
  await writeFile(replacement, Buffer.from(bytes))
  await pick(replacement)
  await page.getByRole('button', { name: 'Replace video', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.theme-video-references video')?.getAttribute('aria-label') === 'replacement.webm')
  assert.equal(await page.locator('.theme-video-references video').count(), 1)
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await page.waitForURL(url => url.hash === '#themes')

  // Existing scene prompts and timings survive the photo-only theme editor.
  const legacy = result(await page.evaluate(theme => {
    const { images, videos, id, revision, createdAt, updatedAt, ...content } = theme
    return window.frameStudio.themes.save({ ...content, name: 'Legacy scene theme', defaultDuration: 15, scenes: [1, 2, 3].map(i => ({ id: crypto.randomUUID(), name: `Shot ${i}`, prompt: `Legacy prompt ${i}`, duration: 5, relationship: i === 2 ? 'continue' : 'new-shot', transition: 'cut' })) })
  }, saved))
  await page.evaluate(id => { location.hash = `#themes/${id}` }, legacy.id)
  await page.getByRole('button', { name: 'Storyboard', exact: true }).click()
  assert.equal(await page.locator('.theme-scenes, .theme-timing, .theme-storyboard-photo textarea').count(), 0)
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await page.waitForURL(url => url.hash === '#themes')
  assert.deepEqual(result(await page.evaluate(id => window.frameStudio.themes.get(id), legacy.id)).scenes, legacy.scenes)

  await page.evaluate(() => { location.hash = '#themes/new' })
  await page.getByRole('button', { name: 'Defaults', exact: true }).click()
  await page.locator('#theme-output').selectOption('post')
  assert.equal(await page.getByRole('button', { name: 'Reference instructions', exact: true }).count(), 1)
  assert.equal(await page.getByRole('button', { name: 'Storyboard', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Add video', exact: true }).count(), 0)
  await page.getByRole('button', { name: 'Master prompt', exact: true }).click()
  assert.equal(await page.locator('#theme-placeholder').count(), 0)
  console.log('PASS Reel hides reference instructions; storyboard accepts one photo; placeholders removed; native video import, playback, validation, replacement, removal, Undo, restart, duplication, local generation preparation and legacy scenes preserved; Post instructions remain.')
} finally {
  // A failed assertion can leave an unsaved draft. Destroy only test-profile windows.
  await desktop?.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
  await desktop?.close()
}
