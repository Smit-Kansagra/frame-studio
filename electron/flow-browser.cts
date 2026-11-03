import { chromium } from 'playwright-core'
import type { BrowserContext, Page, Locator } from 'playwright-core'
import path from 'node:path'
import type { FlowConnection, GenerationAttempt } from './contracts.cjs'
import { StorageError } from './storage/errors.cjs'

import { FLOW_HOME, isFlowProject } from './flow-urls.cjs'
export { FLOW_HOME, isFlowProject } from './flow-urls.cjs'
export type FlowRequest = Pick<GenerationAttempt, 'outputType' | 'prompt' | 'preset' | 'sourceDuration'> & { files: string[]; outputs: number; startFrame?: string; referenceLabels?: string[] }
export type RemoteResult = { id: string; selector: string }
function attention(message: string): never { throw new StorageError('INVALID_REQUEST', message) }

/** Visible, ordinary Chrome UI only. No private APIs, cookie extraction, stealth,
 * CAPTCHA solving, or speculative resubmission. Unsupported UI fails closed. */
export class FlowBrowser {
  private context?: BrowserContext
  private page?: Page
  private opening?: Promise<Page>
  private connection: FlowConnection = { state: 'not-connected', message: 'Connect Google Chrome, then sign in to Flow once in the app-owned profile.', pageTitle: null, checkedAt: null }
  constructor(private readonly profile: string) {}
  status(): FlowConnection { return { ...this.connection } }
  async connect(): Promise<FlowConnection> {
    try { const page = await this.getPage(); await page.bringToFront(); return await this.check() }
    catch (error) { this.connection = { ...this.connection, state: 'needs-attention', message: error instanceof StorageError ? error.message : 'Chrome could not open. Install Google Chrome, close any previous Frame Studio Chrome window, and reconnect.' }; return this.status() }
  }
  private async getPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page
    if (this.opening) return this.opening
    this.opening = (async () => {
      this.connection = { ...this.connection, state: 'opening', message: 'Opening the dedicated Google Chrome profile.' }
      this.context = await chromium.launchPersistentContext(this.profile, { channel: 'chrome', headless: false, chromiumSandbox: true, acceptDownloads: true, viewport: null })
      this.context.on('close', () => { this.context = undefined; this.page = undefined; this.connection = { ...this.connection, state: 'not-connected', message: 'Chrome closed. Reconnect to collect existing jobs; they will not be resubmitted.' } })
      this.page = this.context.pages()[0] ?? await this.context.newPage()
      this.page.setDefaultTimeout(15000)
      await this.page.goto(FLOW_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 })
      return this.page
    })()
    try { return await this.opening } finally { this.opening = undefined }
  }
  async show(): Promise<FlowConnection> { return this.connect() }
  async close(): Promise<FlowConnection> { await this.context?.close(); return this.status() }
  async check(): Promise<FlowConnection> {
    if (!this.page || this.page.isClosed()) return this.status()
    try {
      await this.assertWorkspace(this.page)
      this.connection = { state: 'connected', message: 'Flow workspace verified in Google Chrome. Automatic UI actions are enabled; unsupported controls pause safely.', pageTitle: await this.page.title(), checkedAt: new Date().toISOString() }
    } catch (error) { this.connection = { ...this.connection, state: 'needs-attention', message: error instanceof StorageError ? error.message : 'Flow is unavailable. Check the Chrome window.', checkedAt: new Date().toISOString() } }
    return this.status()
  }
  private async assertWorkspace(page: Page) {
    const url = new URL(page.url())
    if (url.protocol === 'https:' && url.hostname === 'accounts.google.com') {
      // Only read the denial text. Never fill or automate authentication forms.
      const notice = await page.locator('body').innerText()
      if (/browser or app may not be secure|couldn.t sign you in/i.test(notice)) attention('Google rejected sign-in in this automated Chrome session. Stop retrying this login method. Your normal Chrome login is separate; Frame Studio will not copy cookies or bypass Google security checks.')
    }
    if (url.protocol !== 'https:' || !['labs.google', 'flow.google.com'].includes(url.hostname)) attention('Complete Google sign-in in the Chrome window, then Recheck connection. No password is read by Frame Studio.')
    const text = await page.locator('body').innerText()
    if (/verify you are human|unusual traffic|verify it.s you|sign in to continue|couldn.t sign you in/i.test(text) || await page.locator('iframe[src*="recaptcha"][title*="challenge" i]:visible').count()) attention('Google needs sign-in or verification. Complete it yourself in Chrome, then resume. No verification bypass was attempted.')
    if (!isFlowProject(page.url()) && !await page.getByRole('button', { name: /new project/i }).count()) attention('The Flow workspace is not accessible yet. Finish sign-in or account setup in Chrome, then Recheck connection.')
  }
  async openProject(url: string) {
    if (!isFlowProject(url)) attention('The saved Flow project link is invalid. No external page was opened.')
    const page = await this.getPage()
    if (page.url() !== url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await this.assertWorkspace(page)
    return page
  }
  async createProject(onCreated: (url: string) => Promise<void>): Promise<string> {
    const page = await this.getPage()
    await this.assertWorkspace(page)
    await page.goto(FLOW_HOME, { waitUntil: 'domcontentloaded' })
    const create = page.getByRole('button', { name: /^(?:add\s*|\+\s*)?new project$/i })
    await this.unique(create, 'New project')
    // The coordinator journals 'creating' BEFORE this action. A timeout never
    // causes another project creation; the owner can recover the visible link.
    await create.click()
    await page.waitForURL(url => isFlowProject(url.toString()), { timeout: 30000 })
    const url = page.url()
    await onCreated(url)
    return url
  }
  async recoverProject(): Promise<string | null> { return this.page && isFlowProject(this.page.url()) ? this.page.url() : null }
  private async unique(locator: Locator, label: string) {
    await locator.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => attention(`Flow's ${label} control is unavailable. No generation was submitted. Open Chrome to check this account's interface.`))
    if (await locator.count() !== 1) attention(`Flow exposes multiple ${label} controls. Automation paused rather than choosing the wrong one.`)
  }
  private async option(page: Page, name: RegExp, label: string) {
    const option = page.getByRole('option', { name }).or(page.getByRole('menuitem', { name })).or(page.getByRole('tab', { name })).or(page.getByRole('button', { name })).filter({ visible: true })
    await this.unique(option, label)
    await option.click()
  }
  private async selectSetting(page: Page, label: RegExp, value: string, visibleOption: RegExp) {
    const field = page.getByRole('combobox', { name: label }).filter({ visible: true })
    if (await field.count() === 1) {
      if (await field.evaluate(element => element.tagName === 'SELECT')) {
        await field.selectOption({ label: value }).catch(() => attention(`Flow does not offer ${value}. Choose a supported project setting; no generation was submitted.`))
      } else { await field.click(); await this.option(page, visibleOption, value) }
      return
    }
    const direct = page.getByRole('button', { name: visibleOption }).or(page.getByRole('radio', { name: visibleOption })).filter({ visible: true })
    if (await direct.count() === 1) { await direct.click(); return }
    attention(`Cannot verify Flow's ${value} setting in this interface. Automation stopped before spending credits. The selected setting is not silently substituted.`)
  }
  async prepare(url: string, request: FlowRequest): Promise<string[]> {
    const page = await this.openProject(url)
    // Reload clears transient editors, but never submits a generation.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await this.assertWorkspace(page)
    const model = page.getByRole('button', { name: /^(?:model|select model|.*nano banana.*|.*veo.*|.*omni.*)$/i }).filter({ visible: true })
    await this.unique(model, 'model selector'); await model.click()
    await this.option(page, request.outputType === 'post' ? /^image$/i : /^video$/i, 'Image/Video mode')
    if (request.outputType === 'reel') await this.option(page, request.startFrame ? /^frames$/i : /^ingredients$/i, request.startFrame ? 'video Frames mode' : 'video Ingredients mode')
    const ratio = ({ 'post-square': '1:1', 'post-portrait': '4:5', 'post-tall': '3:4', 'post-landscape': '1.91:1', 'post-story': '9:16', 'reel-vertical': '9:16', 'reel-landscape': '16:9' })[request.preset]
    await this.selectSetting(page, /aspect ratio|orientation/i, ratio, new RegExp(`^(?:.*\\s)?${ratio}(?:\\s.*)?$`))
    await this.selectSetting(page, /outputs|results per prompt|number of images|number of videos/i, String(request.outputs), new RegExp(`^(?:x\\s*)?${request.outputs}(?:\\s*(?:outputs?|images?|videos?))?$`, 'i'))
    if (request.outputType === 'reel') await this.selectSetting(page, /duration|length/i, `${request.sourceDuration}s`, new RegExp(`^${request.sourceDuration}\\s*(?:s|seconds?)$`, 'i'))
    // Dismiss only an actual open settings popover, not arbitrary dialogs.
    if (await page.getByRole('dialog').filter({ has: page.getByRole('tab', { name: /^image$/i }) }).count()) await page.keyboard.press('Escape')
    const editor = page.getByRole('textbox').filter({ visible: true }).filter({ hasNot: page.locator('input[type="search"]') })
    const named = page.getByRole('textbox', { name: /prompt|describe|what.*create/i }).filter({ visible: true })
    const prompt = await named.count() === 1 ? named : editor
    await this.unique(prompt, 'prompt editor')
    const composer = prompt.locator('xpath=ancestor::*[self::form or @role="group"][.//button][1]')
    await this.unique(composer, 'prompt attachment area')
    // Old reference chips must be cleared; never carry another attempt's inputs.
    const remove = composer.getByRole('button', { name: /^(?:remove|remove reference|remove image|remove attachment)(?:\s.*)?$/i }).filter({ visible: true })
    for (let count = 0; await remove.count() && count < 60; count++) await remove.first().click()
    if (await remove.count()) attention('Could not clear previous prompt attachments. No generation was submitted.')
    await prompt.fill(request.prompt)
    if ((await prompt.innerText().catch(() => '')) !== request.prompt && await prompt.inputValue().catch(() => '') !== request.prompt) attention('Flow did not retain the complete prompt. No generation was submitted.')
    if (request.startFrame) {
      const start = composer.getByRole('button', { name: /^(?:\+\s*)?add start frame$/i })
      await this.unique(start, 'Add start frame')
      const choice = page.waitForEvent('filechooser', { timeout: 15000 })
      await start.click()
      await (await choice).setFiles(request.startFrame)
      await composer.getByRole('img', { name: /start.frame/i }).waitFor({ state: 'visible', timeout: 60000 })
    }
    for (const file of request.files) {
      const input = composer.locator('input[type="file"][accept*="image"]')
      if (await input.count() === 1) await input.setInputFiles(file)
      else {
        const add = composer.getByRole('button', { name: /^(?:add|add reference|add image|upload image|upload)$/i }).filter({ visible: true })
        await this.unique(add, 'Add reference')
        const choice = page.waitForEvent('filechooser', { timeout: 15000 })
        await add.click()
        const chooser = await choice.catch(() => attention('Flow did not open a reference file picker. No generation was submitted.'))
        await chooser.setFiles(file)
      }
      // File-input completion alone is not evidence of an attached ingredient.
      const filename = path.basename(file)
      const chip = composer.getByRole('img', { name: filename, exact: true }).or(composer.getByText(filename, { exact: true })).filter({ visible: true })
      await chip.first().waitFor({ state: 'visible', timeout: 60000 }).catch(() => attention(`Flow has not confirmed the reference ${filename}. No generation was submitted.`))
    }
    await this.unique(page.getByRole('button', { name: /^(?:generate|arrow_forward)$/i }).filter({ visible: true }), 'Generate')
    return (await this.cards(page)).map(card => card.id)
  }
  async submit(url: string) {
    const page = await this.openProject(url)
    await this.assertWorkspace(page)
    const generate = page.getByRole('button', { name: /^(?:generate|arrow_forward)$/i }).filter({ visible: true })
    await this.unique(generate, 'Generate')
    // ONE click. The coordinator has already durably recorded uncertainty.
    await generate.click({ timeout: 15000 })
  }
  private async cards(page: Page): Promise<(RemoteResult & { prompt: string; kind: string; ready: boolean })[]> {
    return page.locator('[data-asset-id], [data-generation-id], article, [role="listitem"]').evaluateAll(elements => {
      const found = new Map<string, { id: string; selector: string; prompt: string; kind: string; ready: boolean }>()
      for (const element of elements) {
        if (!(element instanceof HTMLElement) || !element.checkVisibility()) continue
        const video = element.querySelector('video'), image = element.querySelector('img')
        if (!video && !image) continue
        const attr = element.hasAttribute('data-asset-id') ? 'data-asset-id' : element.hasAttribute('data-generation-id') ? 'data-generation-id' : null
        const link = element.querySelector<HTMLAnchorElement>('a[href*="/asset/"]')
        const id = attr ? element.getAttribute(attr)! : link?.getAttribute('href')
        if (!id) continue
        const selector = attr ? `[${attr}=${JSON.stringify(id)}]` : `article:has(a[href=${JSON.stringify(id)}]), [role="listitem"]:has(a[href=${JSON.stringify(id)}])`
        const prompt = element.getAttribute('data-prompt') || element.innerText || ''
        found.set(id, { id, selector, prompt, kind: video ? 'reel' : 'post', ready: !!element.querySelector('button[aria-label*="Download" i], a[download], button[title*="Download" i]') && !/generating|queued|processing/i.test(element.innerText) })
      }
      return [...found.values()]
    })
  }
  async results(url: string, prompt: string, outputType: string, baseline: string[]): Promise<RemoteResult[]> {
    const page = await this.openProject(url)
    await this.assertWorkspace(page)
    const compact = (value: string) => value.replace(/\s+/g, ' ').trim()
    // Require a stable ID AND the full submitted prompt, never just the newest
    // thumbnail. Old variants and uploaded reference photos cannot match.
    return (await this.cards(page)).filter(card => !baseline.includes(card.id) && card.kind === outputType && card.ready && compact(card.prompt).includes(compact(prompt))).map(({ id, selector }) => ({ id, selector }))
  }
  async download(url: string, result: RemoteResult, directory: string): Promise<string> {
    const page = await this.openProject(url)
    const card = page.locator(result.selector)
    await this.unique(card, 'matched result')
    const button = card.getByRole('button', { name: /^download(?:\s.*)?$/i }).or(card.locator('a[download]'))
    await this.unique(button, 'result Download')
    const downloadEvent = page.waitForEvent('download', { timeout: 60000 })
    await button.click()
    const download = await downloadEvent.catch(() => attention('Flow did not expose a direct result download. The submitted job is preserved; no generation will be repeated.'))
    const extension = path.extname(download.suggestedFilename()).toLowerCase()
    if (!['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov', '.webm'].includes(extension)) attention('Flow returned an unsupported download. The existing job is preserved.')
    const destination = path.join(directory, `result${extension}`)
    await download.saveAs(destination)
    return destination
  }
}
