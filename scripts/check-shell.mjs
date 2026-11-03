import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import sharp from 'sharp'
import os from 'node:os'
import path from 'node:path'
import { chromium, _electron as electron } from 'playwright'

// Uses the real desktop by default. --ui URL checks the same renderer in Chrome.
const uiIndex = process.argv.indexOf('--ui')
const uiUrl = uiIndex >= 0 ? process.argv[uiIndex + 1] : undefined
const unpackedIndex = process.argv.indexOf('--unpacked')
const unpackedPath = unpackedIndex >= 0 ? process.argv[unpackedIndex + 1] : undefined
if (unpackedIndex >= 0 && (!unpackedPath || uiUrl)) throw new Error('Pass one unpacked application executable after --unpacked, without --ui.')
if (uiIndex >= 0 && !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(uiUrl ?? '')) {
  throw new Error('Pass a local preview URL after --ui, such as http://127.0.0.1:4173.')
}
await mkdir('artifacts', { recursive: true })
let desktop
let browser
let page
let profile
let desktopEnvironment
const issues = []
const remoteRequests = []

try {
  if (uiUrl) {
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    page = await browser.newPage()
  } else {
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    delete environment.FRAME_STUDIO_DEV_URL
    profile = await mkdtemp(path.join(os.tmpdir(), 'frame-studio-check-'))
    environment.FRAME_STUDIO_TEST_PROFILE = profile
    desktopEnvironment = environment
    desktop = await electron.launch({ executablePath: unpackedPath ? path.resolve(unpackedPath) : undefined, args: unpackedPath ? ['--frame-studio-package-check'] : ['.', `--user-data-dir=${profile}`], env: environment, chromiumSandbox: true })
    page = await desktop.firstWindow()
    const preferences = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences())
    assert.equal(preferences.contextIsolation, true)
    assert.equal(preferences.sandbox, true)
    assert.equal(preferences.nodeIntegration, false)
  }
  page.on('pageerror', (error) => issues.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') issues.push(message.text()) })
  page.on('request', (request) => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith(uiUrl ?? 'frame-studio://app/')) remoteRequests.push(request.url())
  })
  if (uiUrl) await page.goto(uiUrl)
  await page.getByRole('heading', { name: 'Studio', exact: true }).waitFor()
  if (desktop) {
    const flowStatus = await page.evaluate(() => window.frameStudio.flow.status())
    assert.ok(['not-connected', 'offline'].includes(flowStatus.state), 'Flow starts detached without contacting Google')
  }

  const routes = ['Studio', 'Themes', 'Characters', 'Settings']
  for (const [width, height] of [[1440, 960], [1100, 760]]) {
    if (desktop) {
      await desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height])
    } else await page.setViewportSize({ width, height })

    for (const route of routes) {
      await page.getByRole('link', { name: route, exact: true }).click()
      await page.getByRole('heading', { name: route, exact: true, level: 1 }).waitFor()
      if (route === 'Settings') {
        await page.getByRole('button', { name: 'Connect Flow', exact: true }).waitFor()
        await page.getByText('Generating remains owner controlled through Generate/Regenerate', { exact: false }).waitFor()
        await page.getByText('Frame Studio never asks for or stores your password', { exact: false }).waitFor()
      }
      assert.equal(await page.getByRole('link', { name: route, exact: true }).getAttribute('aria-current'), 'page')
      assert.equal(await page.locator('a[aria-current="page"]').count(), 1)

      const layout = await page.evaluate(() => {
        const scroll = document.querySelector('.page-scroll')
        const action = document.querySelector('.topbar-actions')?.getBoundingClientRect()
        const heading = document.querySelector('h1')?.getBoundingClientRect()
        const settings = document.querySelector('.settings-nav')?.getBoundingClientRect()
        return {
          overflow: document.documentElement.scrollWidth > window.innerWidth || scroll.scrollWidth > scroll.clientWidth,
          pageScrolls: scroll.scrollHeight > scroll.clientHeight,
          headerOverlap: action && heading && action.left < heading.right,
          settingsReachable: settings.bottom <= window.innerHeight && settings.top >= 0,
          unknownNodeAccess: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
        }
      })
      assert.equal(layout.overflow, false, `${route} overflows at ${width}×${height}`)
      assert.equal(layout.headerOverlap, false, `${route} header overlaps at ${width}×${height}`)
      assert.equal(layout.settingsReachable, true, 'Settings navigation is outside the window')
      assert.equal(layout.unknownNodeAccess, false, 'Renderer exposes Node primitives')
      for (const button of await page.locator('.future-button').all()) {
        assert.equal(await button.isDisabled(), true, 'An unimplemented action is enabled')
        assert.match(await button.innerText(), /Coming later/)
      }
      await page.screenshot({ path: `artifacts/${route.toLowerCase()}-${width}x${height}.png`, fullPage: false })
      console.log(`PASS ${route}: navigation, layout, honest actions at ${width}×${height}`)
    }
  }
  assert.equal(await page.getByRole('link', { name: 'Products', exact: true }).count(), 0, 'Products remains a separate navigation tab')

  const darkButton = page.getByRole('button', { name: 'Switch to dark mode' })
  await darkButton.click()
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
  assert.equal(await page.evaluate(() => localStorage.getItem('frame-studio-theme')), 'dark')
  for (const route of routes) {
    await page.getByRole('link', { name: route, exact: true }).click()
    const palette = await page.evaluate(() => ({
      page: getComputedStyle(document.documentElement).backgroundColor,
      sidebar: getComputedStyle(document.querySelector('.sidebar')).backgroundColor,
      card: (() => { const card = document.querySelector('.settings-card, .empty-panel, .product-card, .theme-scene, .character-card, .project-card, .welcome-panel'); return card ? getComputedStyle(card).backgroundColor : null })(),
      overflow: document.documentElement.scrollWidth > innerWidth,
    }))
    assert.equal(palette.page, 'rgb(18, 24, 21)')
    assert.equal(palette.sidebar, 'rgb(24, 33, 28)')
    if (palette.card) assert.notEqual(palette.card, 'rgb(255, 255, 255)', `${route} retained a light card`)
    assert.equal(palette.overflow, false, `${route} dark mode overflows`)
  }
  await page.screenshot({ path: 'artifacts/dark-mode-settings.png', fullPage: false })
  await page.reload()
  await page.getByRole('button', { name: 'Switch to light mode' }).waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
  await page.getByRole('button', { name: 'Switch to light mode' }).click()
  assert.equal(await page.evaluate(() => localStorage.getItem('frame-studio-theme')), 'light')
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), 'rgb(246, 245, 241)')
  console.log('PASS dark/light toggle, palette across four pages, and preference persistence on reload')

  if (desktop) {
    const storage = await page.evaluate(() => window.frameStudio.workspace.status())
    assert.equal(storage.ok, true, 'Desktop SQLite workspace did not initialize')
    assert.equal(path.resolve(storage.value.folder), path.join(profile, 'workspace'), 'Desktop checks must use the isolated test workspace')
    assert.equal(storage.value.assetCount, 0, 'Fresh installation contains unexpected image fixtures')
    assert.deepEqual(storage.value.issues, [])
    await page.getByText('Ready', { exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: 'Recheck storage', exact: true }).click()
    await page.getByRole('button', { name: 'Recheck storage', exact: true }).waitFor({ state: 'visible' })
    const invalid = await page.evaluate(() => window.frameStudio.images.get('../secret'))
    assert.equal(invalid.ok, false)
    assert.equal(invalid.error.code, 'INVALID_REQUEST')
    console.log('PASS desktop storage bridge, empty installation, recheck action, and invalid-input rejection')

    const source = path.join(profile, 'Demo desktop IPC.png')
    const sourceBytes = await sharp({ create: { width: 80, height: 120, channels: 3, background: '#244c3c' } }).png().toBuffer()
    await writeFile(source, sourceBytes)
    await desktop.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }) }, source)
    const chosen = await page.evaluate(() => window.frameStudio.images.chooseManyAndImport())
    assert.equal(chosen.ok, true)
    assert.equal(chosen.value.assets.length, 1)
    assert.deepEqual(chosen.value.failures, [])
    const saved = await page.evaluate(assetId => window.frameStudio.products.save({ name: 'Demo desktop bridge check', description: '', notes: '', assetIds: [assetId], primaryAssetId: assetId }), chosen.value.assets[0].id)
    assert.equal(saved.ok, true)
    await page.getByRole('link', { name: 'Studio', exact: true }).click()
    await page.locator('.topbar-actions').getByRole('link', { name: 'New project' }).click()
    await page.getByRole('textbox', { name: 'Project name' }).fill('Demo setup in progress')
    await desktop.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }) })
    await page.getByRole('button', { name: 'Add product', exact: true }).click()
    await page.getByRole('button', { name: 'Add product', exact: true }).waitFor()
    assert.equal(await page.locator('.project-product-photos img').count(), 0)
    await desktop.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }) }, source)
    await page.getByRole('button', { name: 'Add product', exact: true }).click()
    await page.waitForFunction(() => { const image = document.querySelector('.project-product-photos img'); return image?.complete && image.naturalWidth > 0 })
    assert.equal(await page.evaluate(() => location.hash), '#studio/new')
    assert.equal(await page.getByRole('textbox', { name: 'Project name' }).inputValue(), 'Demo setup in progress')
    assert.equal(await page.locator('.product-editor, #product-name, #product-description, #product-notes').count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Save product', exact: true }).count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Back to project', exact: true }).count(), 0)
    await page.locator('#project-products').scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'artifacts/project-add-product.png', fullPage: false })
    await page.getByRole('button', { name: 'Move product to trash', exact: true }).click()
    await page.getByRole('dialog', { name: 'Move product to local trash?' }).getByRole('button', { name: 'Move to trash', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.project-product-photos'))
    await page.getByText('Local trash', { exact: true }).click()
    await page.getByRole('button', { name: 'Restore', exact: true }).last().click()
    await page.locator('.project-product-photos img').waitFor()
    page.once('dialog', dialog => { void dialog.accept() })
    await page.getByRole('link', { name: 'All projects' }).first().click()
    console.log('PASS direct photo upload, cancellation, preserved project draft, trash/restore, and no product editor')
    const removed = await page.evaluate(product => window.frameStudio.products.remove(product.id, product.revision), saved.value)
    assert.equal(removed.ok, true)
    const restored = await page.evaluate(token => window.frameStudio.products.undo(token), removed.value.token)
    assert.equal(restored.ok, true)
    assert.equal(restored.value.photos.length, 1)
    const promptFile = path.join(profile, 'Demo theme master.txt')
    await writeFile(promptFile, 'Demo warm light for {{product_name}}.')
    await desktop.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }) }, promptFile)
    const importedPrompt = await page.evaluate(() => window.frameStudio.themes.importPrompt())
    assert.equal(importedPrompt.ok, true)
    const transformed = await page.evaluate(id => window.frameStudio.images.transform(id, { rotation: 90, crop: { x: 0, y: 0, width: 1, height: .5 } }), chosen.value.assets[0].id)
    assert.equal(transformed.ok, true)
    assert.equal(transformed.value.edit.sourceAssetId, chosen.value.assets[0].id)
    const theme = await page.evaluate(({ assetId, text }) => window.frameStudio.themes.save({ name: 'Demo native theme', description: '', coverAssetId: assetId, referenceAssetIds: [], masterPrompt: text, outputType: 'reel', aspectRatio: '9:16', defaultDuration: 15, compositionPrompt: '', scenes: [1, 2, 3].map(i => ({ id: crypto.randomUUID(), name: `Demo scene ${i}`, prompt: 'Show {{product_name}}.', duration: 5, relationship: 'new-shot', transition: 'cut' })) }), { assetId: transformed.value.id, text: importedPrompt.value.text })
    assert.equal(theme.ok, true)
    await page.getByRole('link', { name: 'Themes', exact: true }).click()
    await page.getByRole('link', { name: 'Edit theme', exact: true }).click()
    await page.waitForFunction(() => { const image = document.querySelector('.theme-cover-preview img'); return image?.complete && image.naturalWidth === 120 })
    const copyTheme = await page.evaluate(t => window.frameStudio.themes.duplicate(t.id, t.revision), theme.value)
    assert.equal(copyTheme.ok, true)
    const removedTheme = await page.evaluate(t => window.frameStudio.themes.remove(t.id, t.revision), copyTheme.value)
    assert.equal(removedTheme.ok, true)
    assert.equal((await page.evaluate(token => window.frameStudio.themes.undo(token), removedTheme.value.token)).ok, true)
    console.log('PASS native theme prompt import (picker stubbed), transform, three-scene save, media protocol, duplicate, trash and Undo')
    const character = await page.evaluate(({ assetId, editedId }) => window.frameStudio.characters.save({ name: 'Demo native character', category: null, assetIds: [assetId, editedId], primaryAssetId: editedId }), { assetId: chosen.value.assets[0].id, editedId: transformed.value.id })
    assert.equal(character.ok, true)
    assert.equal('masterPrompt' in character.value, false)
    assert.equal('notes' in character.value, false)
    assert.equal(await page.evaluate(() => 'importPrompt' in window.frameStudio.characters), false)
    const obsoleteCharacterText = await page.evaluate(c => window.frameStudio.characters.save({ id: c.id, expectedRevision: c.revision, name: c.name, category: c.category, assetIds: c.assetIds, primaryAssetId: c.primaryAssetId, masterPrompt: 'Do not accept character text.' }), character.value)
    assert.equal(obsoleteCharacterText.ok, false)
    assert.equal(obsoleteCharacterText.error.code, 'INVALID_CHARACTER')
    await page.getByRole('link', { name: 'Characters', exact: true }).click()
    await page.getByRole('button', { name: 'Preview Demo native character', exact: true }).click()
    await page.waitForFunction(() => { const image = document.querySelector('.full-photo img'); return image?.complete && image.naturalWidth === 120 })
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await page.getByRole('link', { name: 'Edit character', exact: true }).click()
    assert.equal(await page.getByLabel('Character master prompt').count(), 0)
    assert.equal(await page.getByLabel('Preservation notes').count(), 0)
    await page.getByRole('link', { name: 'Characters', exact: true }).click()
    const lastPhoto = await page.evaluate(c => window.frameStudio.characters.save({ id: c.id, expectedRevision: c.revision, name: c.name, category: c.category, assetIds: [], primaryAssetId: c.primaryAssetId }), character.value)
    assert.equal(lastPhoto.ok, false)
    assert.equal(lastPhoto.error.code, 'INVALID_CHARACTER')
    const copyCharacter = await page.evaluate(c => window.frameStudio.characters.duplicate(c.id, c.revision), character.value)
    assert.equal(copyCharacter.ok, true)
    const removedCharacter = await page.evaluate(c => window.frameStudio.characters.remove(c.id, c.revision), copyCharacter.value)
    assert.equal(removedCharacter.ok, true)
    assert.equal((await page.evaluate(token => window.frameStudio.characters.undo(token), removedCharacter.value.token)).ok, true)
    console.log('PASS native photo-only character save/primary/media, last-photo protection, duplicate, trash and Undo')
    const project = await page.evaluate(({ productId, themeId, characterId }) => window.frameStudio.projects.save({ name: 'Demo native project', productId, themeId, characterId, outputType: 'reel', preset: 'reel-vertical', duration: 15 }), { productId: restored.value.id, themeId: theme.value.id, characterId: character.value.id })
    assert.equal(project.ok, true)
    assert.equal(project.value.snapshot.theme.scenes.length, 3)
    assert.equal(project.value.storyboard.scenes[0].sourceDuration, 5)
    assert.equal(project.value.storyboard.scenes[0].editDuration, 5)
    assert.equal((await page.evaluate(id => window.frameStudio.projects.get(id), project.value.id)).value.snapshot.product.name, restored.value.name)
    assert.equal((await page.evaluate(() => window.frameStudio.projects.list())).value.length, 1)
    await page.getByRole('link', { name: 'Studio', exact: true }).click()
    await page.getByRole('link', { name: 'Resume draft' }).waitFor()
    await page.getByRole('link', { name: 'Resume draft' }).click()
    await page.getByRole('button', { name: '2 Storyboard' }).click()
    await page.getByText('Assembled prompt preview', { exact: true }).waitFor()
    assert.doesNotMatch(await page.locator('.assembled-prompt').innerText(), /Character: Demo native character/)
    console.log('PASS native project IPC, saved snapshot, separate source/edit timings, Studio card, resume and prompt preview')
    const postTheme = await page.evaluate(assetId => window.frameStudio.themes.save({ name: 'Demo offline Post theme', description: '', coverAssetId: assetId, referenceAssetIds: [], masterPrompt: 'Show {{product_name}}.', outputType: 'post', aspectRatio: '1:1', defaultDuration: 0, compositionPrompt: 'A clean product image.', scenes: [] }), chosen.value.assets[0].id)
    assert.equal(postTheme.ok, true)
    const post = await page.evaluate(({ productId, themeId }) => window.frameStudio.projects.save({ name: 'Demo offline Post', productId, themeId, characterId: null, outputType: 'post', preset: 'post-square', duration: 0 }), { productId: restored.value.id, themeId: postTheme.value.id })
    assert.equal(post.ok, true)
    const attempt = await page.evaluate(id => window.frameStudio.generations.prepare(id, 'post'), post.value.id)
    assert.equal(attempt.ok, true)
    assert.equal((await page.evaluate(id => window.frameStudio.generations.setState(id, 'submission-uncertain'), attempt.value.id)).ok, true)
    await desktop.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }) }, source)
    const imported = await page.evaluate(id => window.frameStudio.generations.importResult(id), attempt.value.id)
    assert.equal(imported.ok, true)
    assert.equal((await page.evaluate(({ projectId, attemptId }) => window.frameStudio.generations.review(projectId, 'post', attemptId, 'approved', 'Checked locally.'), { projectId: post.value.id, attemptId: imported.value.id })).ok, true)
    assert.equal((await page.evaluate(id => window.frameStudio.exports.inspect(id), post.value.id)).value.canExport, true)
    const exportPath = path.join(profile, 'Demo offline Post export.png')
    await desktop.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }) }, exportPath)
    await page.context().setOffline(true)
    const exported = await page.evaluate(id => window.frameStudio.exports.start(id, { order: [], trims: [], fit: 'pad', muteAll: false }), post.value.id)
    assert.equal(exported.ok, true)
    assert.equal((await sharp(exportPath).metadata()).width, 1080)
    await page.waitForFunction(exportId => new Promise(resolve => { const image = new Image(); image.onload = () => resolve(image.naturalWidth === 1080); image.onerror = () => resolve(false); image.src = `frame-media://export/${exportId}` }), exported.value.id)
    await page.context().setOffline(false)
    console.log('PASS packaged Post import, approval gate, offline image export, and final media preview')
    assert.deepEqual(await readFile(source), sourceBytes)
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await page.getByRole('heading', { name: 'Settings', exact: true, level: 1 }).waitFor()
    console.log('PASS native IPC multi-image import (picker stubbed), product save, media protocol preview, trash, Undo, and source preservation')
  }

  // Exercise actual keyboard navigation, the skip link, and focus treatment.
  await page.reload()
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor()
  await page.keyboard.press('Tab')
  assert.equal(await page.locator(':focus').innerText(), 'Skip to content')
  assert.equal(await page.locator(':focus').evaluate((element) => getComputedStyle(element).outlineStyle), 'solid')
  await page.keyboard.press('Enter')
  assert.equal(await page.locator(':focus').evaluate((element) => element.tagName), 'H1')
  await page.getByRole('link', { name: 'Studio', exact: true }).focus()
  await page.keyboard.press('Tab')
  assert.equal(await page.locator(':focus').innerText(), 'Themes')
  await page.keyboard.press('Enter')
  await page.getByRole('heading', { name: 'Themes', exact: true, level: 1 }).waitFor()
  assert.equal(await page.locator(':focus').evaluate((element) => element.tagName), 'H1')
  console.log('PASS keyboard: skip link, visible focus, navigation, heading focus')

  if (desktop) {
    // Stub writes instead of reading or overwriting the owner's system clipboard.
    await desktop.evaluate(({ clipboard }) => {
      globalThis.originalClipboardWrite = clipboard.writeText
      clipboard.writeText = text => { globalThis.fixturePairingCopy = text }
    })
    try {
      await page.getByRole('link', { name: 'Settings', exact: true }).click()
      assert.equal((await page.evaluate(() => window.frameStudio.flow.copyPairingCode())).ok, false)
      await page.getByRole('button', { name: 'Connect Flow', exact: true }).click()
      await page.getByRole('button', { name: 'Copy pairing code', exact: true }).click()
      await page.getByRole('button', { name: 'Copied', exact: true }).waitFor()
      assert.equal(await desktop.evaluate(() => /^\d{1,5}\.[0-9a-f]{64}$/.test(globalThis.fixturePairingCopy)), true)
      await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
      assert.equal((await page.evaluate(() => window.frameStudio.flow.copyPairingCode())).ok, false)
      console.log('PASS pairing code copy through scoped desktop IPC; disconnected codes cannot be copied')
    } finally {
      await desktop.evaluate(({ clipboard }) => { clipboard.writeText = globalThis.originalClipboardWrite; delete globalThis.originalClipboardWrite; delete globalThis.fixturePairingCopy })
    }
  }

  // Library shortcuts, back navigation, reload, and unknown routes.
  await page.getByRole('link', { name: 'Studio', exact: true }).click()
  await page.getByRole('heading', { name: 'Studio', exact: true, level: 1 }).waitFor()
  await page.locator('.library-link').filter({ hasText: 'Themes' }).click()
  await page.getByRole('heading', { name: 'Themes', exact: true, level: 1 }).waitFor()
  await page.goBack()
  await page.getByRole('heading', { name: 'Studio', exact: true, level: 1 }).waitFor()
  await page.evaluate(() => { window.location.hash = '#does-not-exist' })
  await page.reload()
  await page.getByRole('heading', { name: 'Studio', exact: true, level: 1 }).waitFor()
  console.log('PASS library shortcuts, history, reload, and unknown-route fallback')

  await page.context().setOffline(true)
  await page.getByText('Offline', { exact: true }).waitFor()
  await page.getByRole('link', { name: 'Characters', exact: true }).click()
  await page.getByRole('heading', { name: 'Characters', exact: true, level: 1 }).waitFor()
  await page.context().setOffline(false)
  await page.getByText('Offline', { exact: true }).waitFor({ state: 'hidden' })
  console.log('PASS offline indicator and offline navigation')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await page.locator('.nav-link').first().evaluate((element) => getComputedStyle(element).transitionDuration), '0s')
  assert.deepEqual(remoteRequests, [], 'Local pages made external requests')
  assert.deepEqual(issues, [], 'Renderer errors occurred')
  console.log('PASS reduced motion, no external requests, and no renderer errors')
  if (unpackedPath && desktop && desktopEnvironment) {
    await page.getByRole('button', { name: 'Switch to dark mode' }).click()
    await desktop.close()
    desktop = await electron.launch({ executablePath: path.resolve(unpackedPath), args: ['--frame-studio-package-check'], env: desktopEnvironment, chromiumSandbox: true })
    page = await desktop.firstWindow()
    await page.getByRole('heading', { name: 'Studio', exact: true, level: 1 }).waitFor()
    await page.getByRole('button', { name: 'Switch to light mode' }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
    const saved = await page.evaluate(async () => ({ projects: await window.frameStudio.projects.list(), products: await window.frameStudio.products.list(), themes: await window.frameStudio.themes.list(), characters: await window.frameStudio.characters.list() }))
    assert.ok(saved.projects.ok && saved.projects.value.some(item => item.name === 'Demo native project'))
    assert.ok(saved.projects.ok && saved.projects.value.some(item => item.name === 'Demo offline Post'))
    assert.ok(saved.products.ok && saved.products.value.items.some(item => item.name === 'Demo desktop bridge check'))
    assert.ok(saved.themes.ok && saved.themes.value.some(item => item.name === 'Demo native theme'))
    assert.ok(saved.characters.ok && saved.characters.value.some(item => item.name === 'Demo native character'))
    console.log('PASS packaged app reopens the same isolated workspace with its projects, libraries, and dark-mode preference intact')
  }
  console.log(uiUrl ? 'Renderer checks passed. Desktop runtime was not checked in this mode.' : 'Desktop shell checks passed.')
} finally {
  await desktop?.close()
  await browser?.close()
}
