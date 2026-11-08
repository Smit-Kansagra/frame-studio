import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'
const profile = await mkdtemp(path.join(os.tmpdir(), 'frame-studio-check-'))
const env = { ...process.env, FRAME_STUDIO_TEST_PROFILE: profile }
delete env.ELECTRON_RUN_AS_NODE
delete env.FRAME_STUDIO_DEV_URL
let desktop
async function launch() {
  desktop = await electron.launch({ args: ['.'], env })
  const page = await desktop.firstWindow()
  await page.getByRole('link', { name: 'Product Find', exact: true }).click()
  await page.getByRole('heading', { name: 'Product Find', exact: true }).waitFor()
  return page
}
try {
  let page = await launch()
  const nav = await page.locator('nav[aria-label="Main navigation"] a').allTextContents()
  assert.deepEqual(nav, ['Studio', 'Themes', 'Characters', 'Product Find'])
  await page.getByLabel('What products should Antigravity find?').fill('Meesho bags under Rs 500')
  await page.getByText('Manual fallback', { exact: true }).click()
  await page.getByRole('button', { name: 'Copy Antigravity request' }).click()
  await page.getByText('Request copied.', { exact: false }).waitFor()
  const prompt = await desktop.evaluate(({ clipboard }) => clipboard.readText())
  assert.ok(prompt.includes('Meesho bags under Rs 500'))
  assert.ok(prompt.includes(path.join(profile, 'product-find', 'products.json')))
  const state = await page.evaluate(() => window.frameStudio.productFind.status())
  assert.equal(state.products.length, 0)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  await page.route('https://images.example.com/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: png }))
  const row = { product_url: 'https://www.meesho.com/test-product/p/123', image_url: 'https://images.example.com/product.png' }
  const file = path.join(state.folder, 'products.json')
  await writeFile(file, JSON.stringify([row, row]))
  await page.getByRole('heading', { name: 'Products (1)', exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('.find-photo img')?.naturalWidth > 0)
  await page.getByRole('button', { name: 'Copy link', exact: true }).click()
  await page.getByText('Product link copied.', { exact: true }).waitFor()
  assert.equal(await desktop.evaluate(({ clipboard }) => clipboard.readText()), row.product_url)
  await writeFile(file, JSON.stringify([{ ...row, product_url: 'javascript:alert(1)' }]))
  await page.getByRole('alert').filter({ hasText: 'public HTTPS' }).waitFor()
  assert.equal(await page.locator('.find-card').count(), 1)
  await writeFile(file, '{')
  await page.getByRole('alert').filter({ hasText: 'Last displayed results' }).waitFor()
  assert.equal(await page.locator('.find-card').count(), 1)
  await writeFile(file, JSON.stringify([row]))
  await page.waitForFunction(() => !document.querySelector('[role="alert"]'))
  await mkdir('artifacts', { recursive: true })
  await page.screenshot({ path: 'artifacts/product-find.png', fullPage: true })
  await desktop.close()
  page = await launch()
  await page.getByRole('heading', { name: 'Products (1)', exact: true }).waitFor()
  const fixture = path.join(profile, 'automatic-fixture.cjs')
  await writeFile(fixture, `setTimeout(() => console.log(JSON.stringify({status:'SUCCESS', structured_output:{products:[${JSON.stringify(row)}],note:'Automatic test result'}})), 1000)`)
  await desktop.evaluate(async (_electron, options) => {
    const load = process.getBuiltinModule('module').createRequire(options.modulePath)
    const { ProductFindRunner } = load(options.modulePath)
    const start = ProductFindRunner.prototype.start
    ProductFindRunner.prototype.start = function(query) {
      this.options = { resolveCLI: async () => options.node, prefixArgs: [options.fixture] }
      return start.call(this, query)
    }
  }, { modulePath: path.resolve('dist-electron/product-find-runner.cjs'), node: process.execPath, fixture })
  await page.getByLabel('What products should Antigravity find?').fill('Find a product automatically')
  await page.getByRole('button', { name: 'Find products', exact: true }).click()
  await page.getByText('Saved 1 candidate(s). Automatic test result', { exact: true }).waitFor()
  await writeFile(fixture, 'setInterval(() => {}, 1000)')
  await page.getByRole('button', { name: 'Find products', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel search', exact: true }).click()
  await page.getByText('Search cancelled. Saved products are unchanged.', { exact: true }).waitFor()
  assert.equal(await page.locator('.find-card').count(), 1)
  await page.locator('.page-scroll').evaluate(element => element.scrollTo(0,0))
  await page.screenshot({ path: 'artifacts/product-find-automatic.png', fullPage: true })
  console.log('PASS: sidebar, manual fallback, images, copying, invalid-file recovery, restart persistence, one-click automatic execution and UI cancellation.')
} finally { await desktop?.close() }
