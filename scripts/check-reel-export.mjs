import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { Workspace } from '../dist-electron/storage/workspace.cjs'

const run = promisify(execFile)
const pass = message => console.log(`PASS ${message}`)
const ffmpeg = async args => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { timeout: 120_000 })
const ffprobe = async file => JSON.parse((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file])).stdout)

await mkdir('artifacts', { recursive: true })
const root = await mkdtemp(path.resolve('artifacts/reel-export-'))
const image = path.join(root, 'product.png')
const silent = path.join(root, 'silent.mp4')
const audible = path.join(root, 'audible.mp4')
await writeFile(image, await sharp({ create: { width: 160, height: 200, channels: 3, background: '#416e8b' } }).png().toBuffer())
await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=320x568:r=30:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', silent])
await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=560x320:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', audible])
const workspace = await Workspace.open(path.join(root, 'workspace'))
try {
  const asset = await workspace.importImage(image)
  const product = await workspace.products.save({ name: 'Export check', description: '', notes: '', assetIds: [asset.id], primaryAssetId: asset.id })
  const scenes = [
    { id: randomUUID(), name: 'Silent portrait', prompt: 'Show the product.', duration: 2, relationship: 'new-shot', transition: 'cut' },
    { id: randomUUID(), name: 'Audible landscape', prompt: 'Show the product again.', duration: 2, relationship: 'new-shot', transition: 'cut' },
  ]
  const theme = await workspace.themes.save({ name: 'Export check', description: '', coverAssetId: null, referenceAssetIds: [], masterPrompt: 'Product video of {{product_name}}.', outputType: 'reel', aspectRatio: '9:16', defaultDuration: 4, compositionPrompt: '', scenes })
  const project = await workspace.projects.save({ name: 'Export check', productId: product.id, themeId: theme.id, characterId: null, outputType: 'reel', preset: 'reel-vertical', duration: 4 })
  const initial = await workspace.exports.inspect(project.id)
  assert.equal(initial.toolAvailable, true, initial.toolMessage)
  assert.equal(initial.canExport, false)
  for (const [scene, file] of [[scenes[0], silent], [scenes[1], audible]]) {
    const attempt = await workspace.generations.prepare(project.id, scene.id)
    await workspace.generations.setState(attempt.id, 'submission-uncertain')
    await workspace.generations.importResult(attempt.id, file)
    await workspace.generations.review(project.id, scene.id, attempt.id, 'approved', '')
  }
  const ready = await workspace.exports.inspect(project.id)
  assert.equal(ready.canExport, true, ready.reasons.join(' '))
  assert.equal(ready.upscaledSources, true)
  assert.deepEqual(ready.scenes.map(scene => scene.hasAudio), [false, true])
  pass('approved mixed-audio clips are probed; source upscaling is warned')

  const settings = { order: scenes.map(scene => scene.id), trims: scenes.map(scene => ({ sceneId: scene.id, inPoint: 0, outPoint: 2 })), fit: 'pad', muteAll: false }
  const invalidOutput = path.join(root, 'invalid.mp4')
  await assert.rejects(workspace.exports.start(project.id, { ...settings, trims: [{ sceneId: scenes[0].id, inPoint: 0, outPoint: 1 }, settings.trims[1]] }, invalidOutput, () => undefined), error => error.code === 'INVALID_REQUEST')
  await assert.rejects(stat(invalidOutput), error => error.code === 'ENOENT')
  pass('invalid timeline fails without an output file')

  const output = path.join(root, 'reel.mp4')
  const progress = []
  const result = await workspace.exports.start(project.id, settings, output, value => progress.push(value))
  const probe = await ffprobe(output)
  assert.equal(result.outputType, 'reel')
  assert.equal(result.width, 1080)
  assert.equal(result.height, 1920)
  assert.ok(Math.abs(Number(probe.format.duration) - 4) <= 1 / 30)
  assert.ok(probe.streams.some(stream => stream.codec_type === 'video' && stream.width === 1080 && stream.height === 1920))
  assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'))
  assert.ok(progress.some(value => value.stage === 'rendering'))
  assert.ok(progress.some(value => value.stage === 'validating'))
  assert.ok((await stat(output)).size > 1000)
  assert.deepEqual(await readFile(silent), await readFile(await workspace.attemptFile(ready.scenes[0].attemptId)))
  assert.deepEqual(await readFile(audible), await readFile(await workspace.attemptFile(ready.scenes[1].attemptId)))
  assert.deepEqual((await readdir(root)).filter(name => name.includes('.partial')), [])
  await assert.rejects(workspace.exports.start(project.id, settings, output, () => undefined), error => error.code === 'INVALID_REQUEST')
  pass('offline Reel export joins portrait silent and landscape audio clips at exact preset/duration, preserves originals, cleans temp files, and refuses overwrite')

  const cropOutput = path.join(root, 'reel-crop-muted.mp4')
  await workspace.exports.start(project.id, { ...settings, fit: 'crop', muteAll: true }, cropOutput, () => undefined)
  const cropProbe = await ffprobe(cropOutput)
  assert.ok(cropProbe.streams.some(stream => stream.codec_type === 'video' && stream.width === 1080 && stream.height === 1920))
  assert.ok(cropProbe.streams.some(stream => stream.codec_type === 'audio'))
  assert.ok(Math.abs(Number(cropProbe.format.duration) - 4) <= 1 / 30)
  pass('crop and mute-all export also produces a valid MP4')

  const cancelledOutput = path.join(root, 'cancelled.mp4')
  let cancellationRequested = false
  await assert.rejects(workspace.exports.start(project.id, settings, cancelledOutput, value => {
    if (value.stage === 'rendering' && value.percent > 0 && value.percent < 100 && !cancellationRequested) {
      cancellationRequested = true
      void workspace.exports.cancel(project.id)
    }
  }), error => error.code === 'INVALID_REQUEST' && /cancelled/i.test(error.message))
  assert.equal(cancellationRequested, true)
  await assert.rejects(stat(cancelledOutput), error => error.code === 'ENOENT')
  assert.deepEqual((await readdir(root)).filter(name => name.includes('.partial')), [])
  pass('cancelled encode removes the partial output and leaves the completed exports and source clips intact')
  console.log(`Output: ${output}`)
} finally {
  await workspace.close()
}
