import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { Workspace } from '../dist-electron/storage/workspace.cjs'
import { FlowCoordinator } from '../dist-electron/flow-coordinator.cjs'
import { FlowBrowser, isFlowProject } from '../dist-electron/flow-browser.cjs'
import { StorageError } from '../dist-electron/storage/errors.cjs'

const root = await mkdtemp(path.join(os.tmpdir(), 'frame-flow-check-'))
const file = path.join(root, 'reference.png')
await writeFile(file, await sharp({ create: { width: 32, height: 32, channels: 3, background: '#a5b5a0' } }).png().toBuffer())
let ws = await Workspace.open(path.join(root, 'workspace'))
const image = await ws.importImage(file)
const product = await ws.products.save({ name: 'Test product', description: '', notes: '', assetIds: [image.id], primaryAssetId: image.id })
const theme = await ws.themes.save({ name: 'Test theme', description: '', coverAssetId: null, referenceAssetIds: [], masterPrompt: 'Keep the supplied product unchanged.', outputType: 'post', aspectRatio: '1:1', defaultDuration: 0, compositionPrompt: 'On a table.', scenes: [] })
const project = await ws.projects.save({ name: 'Flow integration test', productId: product.id, themeId: theme.id, characterId: null, outputType: 'post', preset: 'post-square', duration: 0 })
let submitted = 0, created = 0, failSubmit = false, failPrepare = false, failDownload = false, outputs = 2
const driver = {
  async createProject(commit) { created++; await commit('https://labs.google/fx/tools/flow/project/fixture'); return 'https://labs.google/fx/tools/flow/project/fixture' },
  async nameProject(_url, name) { assert.equal(name, project.name) },
  async prepare(_url, request) { if (failPrepare) throw new StorageError('INVALID_REQUEST', 'Unsupported Flow ratio'); outputs = request.outputs; return ['old-result', 'reference'] },
  async submit() { submitted++; if (failSubmit) throw new Error('Transport lost after click') },
  async results() { return Array.from({ length: outputs }, (_, index) => ({ id: `result-${submitted}-${index}`, selector: `#result-${index}` })) },
  async download() { if (failDownload) { failDownload = false; throw new Error('Download interrupted') } return file },
}
const settle = async coordinator => {
  const deadline = Date.now() + 5000
  while (coordinator.busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(coordinator.busy, false)
}
try {
  let runner = new FlowCoordinator(async () => ws, driver, 5, 100)
  let job = await runner.start(project.id, 'post', 2)
  await assert.rejects(() => runner.start(project.id, 'post', 1), /active/)
  await settle(runner)
  assert.equal(ws.flow.job(job.attemptId).stage, 'complete')
  assert.equal(created, 1); assert.equal(submitted, 1)
  assert.equal((await ws.generations.list(project.id)).filter(item => item.state === 'ready-for-review').length, 1)
  await ws.generations.review(project.id, 'post', job.attemptId, 'approved', 'Keep this result')
  const approved = job.attemptId
  failSubmit = true
  job = await runner.start(project.id, 'post', 1); await settle(runner)
  assert.equal(ws.generations.get(job.attemptId).state, 'submission-uncertain')
  assert.equal(ws.flow.job(job.attemptId).stage, 'needs-attention')
  await assert.rejects(() => runner.start(project.id, 'post', 1), /active or uncertain/)
  await ws.close(); ws = await Workspace.open(path.join(root, 'workspace'))
  runner = new FlowCoordinator(async () => ws, driver, 5, 100)
  failSubmit = false
  await runner.resume(job.attemptId); await settle(runner)
  assert.equal(submitted, 2, 'Resume never clicks Generate again')
  assert.equal(ws.generations.get(job.attemptId).state, 'ready-for-review')
  assert.equal((await ws.generations.reviews(project.id))[0].selectedAttemptId, approved, 'Regenerate keeps the previously approved result')
  failPrepare = true
  job = await runner.start(project.id, 'post', 1); await settle(runner)
  assert.equal(submitted, 2); assert.equal(ws.generations.get(job.attemptId).state, 'failed')
  assert.match(ws.flow.job(job.attemptId).message, /Unsupported Flow ratio/)
  failPrepare = false; failDownload = true
  job = await runner.start(project.id, 'post', 3); await settle(runner)
  assert.equal(ws.generations.get(job.attemptId).state, 'submission-uncertain')
  await runner.resume(job.attemptId); await settle(runner)
  assert.equal(submitted, 3); assert.equal(ws.flow.job(job.attemptId).stage, 'complete')
  assert.equal(created, 1, 'Regeneration reuses the linked Flow project')
  await assert.rejects(() => runner.start(project.id, 'post', 99), /1 and 4/)
  console.log('PASS coordinator: all variants, retained approval, one active request, restart recovery, ambiguous submit, failed preparation, interrupted downloads, no double billing')

  const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true })
  try {
    const page = await browser.newPage({ acceptDownloads: true })
    const url = 'https://labs.google/fx/tools/flow/project/fixture'
    const png = await sharp(file).png().toBuffer()
    const html = `<!doctype html><title>Local Flow contract fixture (not Google)</title>
      <button>Nano Banana Pro</button><button>Image</button><button>Video</button><button>Ingredients</button>
      <label>Aspect ratio<select><option>1:1</option><option>9:16</option></select></label>
      <label>Outputs<select><option>1</option><option>2</option></select></label>
      <label>Duration<select><option>8s</option></select></label>
      <form><label>Prompt<textarea></textarea></label><input type="file" accept="image/png"><div id="references"></div><button type="button">Generate</button></form>
      <div id="results"><article data-asset-id="old-result" data-prompt="A test product"><img alt="old"><button aria-label="Download">Download</button></article></div>
      <script>
      document.querySelector('input').onchange=e=>{const img=document.createElement('img');img.alt=e.target.files[0].name;img.src='data:image/png;base64,iVBORw0KGgo=';document.querySelector('#references').append(img)};
      document.querySelector('form button').onclick=()=>{
        window.submissions=(window.submissions||0)+1;
        const article=document.createElement('article');article.dataset.assetId='fresh-result';article.dataset.prompt=document.querySelector('textarea').value;
        article.innerHTML='<img alt="generated"><a download="result.png" href="data:image/png;base64,${png.toString('base64')}">Download</a>';
        document.querySelector('#results').append(article);
      };
      </script>`
    // Chromium's download manager can bypass page routing. Use a local data
    // download so this fixture cannot accidentally contact the real service.
    await page.context().route('**/*', route => route.request().url() === url ? route.fulfill({ body: html, contentType: 'text/html' }) : route.abort())
    await page.goto(url)
    const adapter = new FlowBrowser(path.join(root, 'unused-profile'))
    // Inject only an isolated routed test page; production has no renderer hook.
    adapter.page = page
    const request = { prompt: 'A test product', outputType: 'post', preset: 'post-square', sourceDuration: null, files: [file], outputs: 1 }
    const baseline = await adapter.prepare(url, request)
    assert.ok(baseline.includes('old-result'))
    assert.equal(await page.getByRole('textbox', { name: 'Prompt' }).inputValue(), request.prompt)
    assert.equal(await page.getByRole('img', { name: 'reference.png' }).count(), 1)
    await adapter.submit(url)
    const matches = await adapter.results(url, request.prompt, 'post', baseline)
    assert.deepEqual(matches.map(item => item.id), ['fresh-result'])
    const downloaded = await adapter.download(url, matches[0], root)
    assert.equal((await sharp(downloaded).metadata()).format, 'png')
    assert.equal(await page.evaluate(() => window.submissions), 1)
    assert.deepEqual(await adapter.results(url, 'unrelated prompt', 'post', baseline), [])
    assert.deepEqual(await adapter.results(url, request.prompt, 'reel', baseline), [])
    await assert.rejects(() => adapter.prepare(url, { ...request, preset: 'post-portrait' }), /does not offer 4:5/)
    assert.equal(isFlowProject('https://evil.example/project/123'), false)
    assert.equal(isFlowProject('https://labs.google@evil.example/project/123'), false)
    assert.equal(isFlowProject(url), true)
    const deniedLogin = 'https://accounts.google.com/fixture-signin-denied'
    await page.context().route(deniedLogin, route => route.fulfill({ contentType: 'text/html', body: '<main>This browser or app may not be secure.</main>' }))
    await page.goto(deniedLogin)
    const deniedStatus = await adapter.check()
    assert.equal(deniedStatus.state, 'needs-attention')
    assert.match(deniedStatus.message, /Google rejected sign-in/)
    assert.match(deniedStatus.message, /will not copy cookies or bypass/)
    console.log('PASS browser contract fixture: settings, real file attachment, exact prompt, single submit, stable result matching, actual download, unsupported ratio rejection. This is NOT a live Google account test.')
  } finally { await browser.close() }
} finally { await ws.close() }

console.log(`PASS Flow automation isolated checks. Test workspace: ${root}`)
