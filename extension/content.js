// Runs in Chrome's isolated world on the explicitly selected Flow tab only.
// Reads/writes visible UI. Never calls Google APIs or accesses session cookies.
(() => {
  if (globalThis.__frameStudioCompanion) return
  globalThis.__frameStudioCompanion = true
  const ADAPTER_VERSION = '0.1.6-fast.32'
  const seen = new Map()
  let prepared = null
  let submission = null
  let lastFailure = null
  let referenceCheck = null
  let referenceMediaType = 'image/png'
  const compact = value => String(value || '').replace(/[\u200b-\u200f\ufeff]/g, '').replace(/\s+/g, ' ').trim()
  const visible = element => element instanceof HTMLElement && element.checkVisibility() && !element.closest('[aria-hidden="true"]')
  const label = element => compact(element.getAttribute('aria-label') || element.labels?.[0]?.textContent || element.getAttribute('title') || element.textContent)
  const controlText = element => {
    const clone = element.cloneNode(true)
    clone.querySelectorAll('[aria-hidden="true"],svg,[class*="material-icons"],[class*="material-symbols"]').forEach(icon => icon.remove())
    return compact(clone.textContent).replace(/\b(?:expand_more|expand_less|arrow_drop_down|arrow_drop_up|auto_awesome|smart_toy|tune|settings|image_aspect_ratio|crop_portrait|crop_landscape|aspect_ratio|videocam|photo_camera)\b/gi, '').replace(/\p{Extended_Pictographic}/gu, '').trim()
  }
  const interactiveSelector = 'button,summary,label[for],label:has(input[type="file"]),[role="button"],[role="combobox"],[role="switch"],[role="tab"],[role="option"],[role="menuitem"],[role="radio"],[tabindex="0"]'
  // The owner's toolbar diagnostic identifies Angular Material <mat-icon>
  // glyphs (add / arrow_forward), aria-hidden inside visible native buttons.
  // Read the glyph as a control identifier, but activate its visible button.
  const glyphSelector = 'mat-icon,i,svg,[data-icon],[class*="material-icons"],[class*="material-symbols"],.google-symbols'
  const glyphMatches = (element, pattern) => [...element.querySelectorAll(glyphSelector)].some(icon =>
    [icon.getAttribute('data-icon'), icon.getAttribute('aria-label'), icon.textContent].some(value => {
      const name = compact(value)
      return name && name.length <= 100 && pattern.test(name)
    }))
  const controls = (pattern, root = document) => {
    let matches = [...root.querySelectorAll(interactiveSelector)].filter(element => {
      if (!visible(element)) return false
      const text = controlText(element)
      return pattern.test(label(element)) || pattern.test(text) || (!text && glyphMatches(element, pattern))
    })
    // Flow also renders controls as clickable div/span wrappers without button
    // roles. Resolve their own short label to the closest interactive wrapper.
    if (!matches.length) {
      matches = [...root.querySelectorAll('span,div')].filter(element => {
        const value = compact(element.textContent)
        return value && value.length <= 140 && !element.closest('textarea,[contenteditable="true"],article') && visible(element) && (pattern.test(controlText(element)) || pattern.test(label(element)))
      }).map(element => element.closest(interactiveSelector) || element).filter(element => root === document || root.contains(element))
    }
    if (!matches.length) {
      matches = [...root.querySelectorAll(`${glyphSelector},span`)].filter(element =>
        !element.closest('textarea,[contenteditable="true"],article') && [element.getAttribute('data-icon'), element.textContent].some(value => {
          const name = compact(value)
          return name && name.length <= 100 && pattern.test(name)
        })).map(element => iconTarget(element, root, pattern)).filter(Boolean)
    }
    const unique = [...new Set(matches)]
    return unique.filter(element => !unique.some(other => other !== element && element.contains(other)))
  }
  const generatePattern = /^(?:start generation|generate(?: image| video)?|create(?: image| video)?|submit|send|arrow_forward)$/i
  const summaryPattern = /(?:^(?:images?|videos?)\s*(?:[·•|]|\d{3,4}p|x\s*\d)|\b(?:nano\s*banana|imagen|veo|omni)\b)/i
  const modePattern = /^(?:images?|videos?|create (?:an? )?(?:image|video)|(?:image|video) generation)$/i
  // Restrict ratios to output shapes; project timestamps such as 11:57 are
  // not aspect-ratio choices, even though they contain a colon.
  const ratioPattern = /\b(?:1\.91:1|16:9|9:16|4:3|3:4|1:1|4:5|5:4|3:2|2:3|21:9|9:21)\b/
  const ratioValues = value => compact(value).match(new RegExp(ratioPattern.source, 'g')) || []
  const ratioNumber = value => { const [width, height] = value.split(':').map(Number); return width > 0 && height > 0 ? width / height : NaN }
  function sourceRatio(target, root) {
    const candidates = controls(ratioPattern, root).flatMap(element => {
      const matches = ratioValues(controlText(element))
      return matches.length === 1 ? matches : []
    })
    for (const select of root.querySelectorAll('select')) if (visible(select)) for (const option of select.options) {
      const match = compact(option.textContent).match(ratioPattern)
      if (match) candidates.push(match[0])
    }
    const available = [...new Set(candidates)].filter(value => Number.isFinite(ratioNumber(value)))
    if (available.includes(target)) return target
    if (!available.length) throw new Error('Flow aspect-ratio choices could not be read. Nothing was submitted.')
    const desired = ratioNumber(target)
    // Maximise the retained central area after the automatic crop. This chooses
    // 3:4 for a 4:5 Post when that is the closest visible supported ratio.
    return available.sort((a, b) => Math.min(ratioNumber(b) / desired, desired / ratioNumber(b)) - Math.min(ratioNumber(a) / desired, desired / ratioNumber(a)))[0]
  }
  async function applyRatio(target, root, exact = false) {
    const actual = sourceRatio(target, root)
    if (exact && actual !== target) throw new Error(`Flow does not offer the required ${target} ratio. Nothing was submitted.`)
    await setting(/aspect ratio|orientation/i, actual, new RegExp(`^(?:.*\\s)?${actual.replaceAll('.', '\\.').replaceAll(':', ':')}(?:\\s.*)?$`), root)
    return actual
  }
  const one = (items, name) => { if (items.length !== 1) throw new Error(`Flow ${name}: expected one supported control, found ${items.length}. Paused without guessing.`); return items[0] }
  function uploadRightsDialog() {
    const matchesDialog = panel => visible(panel) && /\bRights to use this video\b/i.test(panel.innerText || '') && controls(/^I agree\b/i, panel).length > 0 && controls(/^Cancel$/i, panel).length === 1
    let blocked = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog,[aria-modal="true"],.cdk-overlay-pane')].find(matchesDialog)
    if (!blocked) {
      // The screenshot also applies to modal components without dialog roles.
      // Require the exact title and its agreement/cancel controls together.
      const titles = [...document.querySelectorAll('h1,h2,h3,[role="heading"],span,p')].filter(element => visible(element) && /^Rights to use this video$/i.test(compact(element.textContent)))
      for (const title of titles) {
        let panel = title.parentElement
        while (panel && panel !== document.body && !panel.matches('main,[role="main"]')) {
          if (matchesDialog(panel)) { blocked = panel; break }
          panel = panel.parentElement
        }
        if (blocked) break
      }
    }
    return blocked || null
  }
  function assertNoUploadRightsDialog() {
    if (uploadRightsDialog()) throw new Error('The upload-rights dialog appeared during this action. Resume this saved request to accept it and continue without restarting completed uploads.')
  }
  async function acceptUploadRightsDialog() {
    // The owner explicitly requested automatic acceptance of this exact dialog.
    // Do not change the persistent preference or accept any unrelated dialog.
    const clicked = new WeakSet(), deadline = Date.now() + 45000
    for (;;) {
      const dialog = uploadRightsDialog()
      if (!dialog) return
      guard()
      const agree = controls(/^I agree$/i, dialog)
      if (agree.length === 1 && !agree[0].disabled && agree[0].getAttribute('aria-disabled') !== 'true' && !clicked.has(dialog)) {
        clicked.add(dialog)
        agree[0].click()
      }
      if (Date.now() >= deadline) throw new Error('Flow upload-rights confirmation did not close. The preparation checkpoint is preserved; resume this existing request.')
      await new Promise(resolve => setTimeout(resolve, 150))
    }
  }
  const click = (element, name) => { assertNoUploadRightsDialog(); if (element.disabled || element.getAttribute('aria-disabled') === 'true') throw new Error(`Flow ${name} is disabled. Nothing was submitted.`); element.click() }
  const wait = async (test, description, timeout = 15000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) { await acceptUploadRightsDialog(); const value = await test(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 150)) }
    throw new Error(`Flow did not confirm ${description}. The existing request is preserved.`)
  }
  const guard = url => {
    const u = new URL(location.href)
    if (u.protocol !== 'https:' || !(u.hostname === 'flow.google.com' || (u.hostname === 'labs.google' && /^\/fx\/(?:[a-z-]+\/)?tools\/flow(?:\/|$)/i.test(u.pathname)))) throw new Error('This is not an approved Flow page. No login page is controlled.')
    if (url && location.href !== url) throw new Error('Selected Flow project changed. Reopen the matching project before resuming.')
    const alerts = [...document.querySelectorAll('[role="alert"],[role="dialog"],main')].filter(visible).map(element => element.innerText).join('\n')
    if (/verify you are human|unusual traffic|verify it.s you|browser or app may not be secure|sign in to continue/i.test(alerts)) throw new Error('Google is requesting verification or rejecting access. Complete supported steps yourself; the extension will not bypass this.')
  }
  function promptEditor() {
    const editors = [...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(element => visible(element) && !element.parentElement?.closest('[contenteditable="true"]'))
    const named = editors.filter(element => /prompt|describe|what.*create/i.test(label(element) || element.getAttribute('placeholder') || ''))
    return one(named.length ? named : editors, 'prompt editor')
  }
  const promptText = element => element instanceof HTMLTextAreaElement ? element.value : element.innerText
  const preparationStorageKey = requestId => `frame-flow-preparation:${requestId}`
  async function persistPreparation() {
    const checkpoint = prepared?.checkpoint
    if (!checkpoint) return undefined
    for (const asset of checkpoint.assets) {
      const key = prepared.assets.get(asset.name)
      if (key) asset.key = key
    }
    if (chrome.storage?.local) await chrome.storage.local.set({ [preparationStorageKey(checkpoint.requestId)]: checkpoint })
    return checkpoint
  }
  function rememberReference(name, kind, stage) {
    const checkpoint = prepared?.checkpoint
    if (!checkpoint) return
    if (!checkpoint.manifest.some(item => item.name === name && item.kind === kind)) throw new Error('This reference does not belong to the saved request.')
    let asset = checkpoint.assets.find(item => item.name === name)
    if (!asset) { asset = { name, kind, stage }; checkpoint.assets.push(asset) }
    asset.stage = stage
    const key = prepared.assets.get(name)
    if (key) asset.key = key
  }
  function rememberReferenceKey(name, key) {
    const previous = prepared.assets.get(name)
    if (previous && previous !== key) throw new Error('The saved reference asset identity changed. Existing uploads were preserved; a different file was not substituted.')
    prepared.assets.set(name, key)
  }
  async function referenceState(name, kind) {
    if (!prepared || prepared.url !== location.href || typeof name !== 'string' || name.length > 200 || /[\\/\0]/.test(name) || !['reference','startFrame'].includes(kind)) throw new Error('Invalid saved reference lookup.')
    const checkpoint = prepared.checkpoint
    if (checkpoint && !checkpoint.manifest.some(item => item.name === name && item.kind === kind)) throw new Error('The reference does not match this preparation checkpoint.')
    const previous = checkpoint?.assets.find(item => item.name === name)
    if (previous?.key) prepared.assets.set(name, previous.key)
    const library = libraryReference(name)
    if (library) rememberReferenceKey(name, library.key)
    const attached = attachmentPresent(name)
    if (attached) {
      if (!prepared.files.includes(name)) prepared.files.push(name)
      if (kind === 'startFrame') prepared.startFrame = true
      rememberReference(name, kind, 'attached')
    } else if (library) rememberReference(name, kind, 'uploaded')
    const known = attached || !!previous || !!library || referenceCards(name, assetPicker()).length === 1
    return { attached, known, checkpoint: await persistPreparation() }
  }
  function reconcileReferenceSet(removeForeign) {
    const expected = new Set(prepared.files.map(name => prepared.assets.get(name)).filter(Boolean))
    const ingredients = [...composer().querySelectorAll('button[aria-label="Ingredient"]')].filter(visible)
    for (const ingredient of ingredients) {
      const keys = [...new Set([...ingredient.querySelectorAll('img,video')].map(mediaKey).filter(Boolean))]
      if (keys.some(key => expected.has(key))) continue
      if ([...ingredient.querySelectorAll('img,video')].some(media => prepared.files.some(name => [media.getAttribute('alt'),media.getAttribute('aria-label'),media.getAttribute('title'),media.getAttribute('data-filename')].includes(name)))) continue
      const removable = expected.size === prepared.files.length && keys.length === 1 && ingredient.getAttribute('aria-busy') !== 'true' && !ingredient.querySelector('[role="progressbar"]') && [...ingredient.querySelectorAll('mat-icon')].some(icon => /^cancel$/i.test(compact(icon.textContent)))
      if (!removeForeign || !removable) throw new Error('The composer contains an unconfirmed attachment from another preparation. Saved uploads are preserved; finish or remove that attachment before resuming this request.')
      // Remove only a different completed composer chip, never its library asset.
      click(ingredient, 'remove attachment belonging to a different request')
    }
  }
  const referencePattern = /^(?:\+|add(?:_2|_circle|_circle_outline|_photo_alternate)?|add (?:to (?:the )?prompt|media|images?|attachments?|references?)|attach(?: files?| media| images?)?|upload(?: images?| media)?)$/i
  function filledPlus(path) {
    // Material icons can draw a plus as one closed, filled outline rather
    // than two strokes. Check the glyph's shape in its own SVG coordinates;
    // never infer a button from its position on the page.
    if (getComputedStyle(path).fill === 'none') return false
    try {
      const box = path.getBBox()
      if (box.width <= 0 || box.height <= 0 || box.width / box.height < .8 || box.width / box.height > 1.25) return false
      const shape = new Path2D(path.getAttribute('d') || '')
      const context = document.createElement('canvas').getContext('2d')
      if (!context) return false
      const samples = [.12, .32, .5, .68, .88]
      return samples.every((y, row) => samples.every((x, column) =>
        context.isPointInPath(shape, box.x + box.width * x, box.y + box.height * y) === (row === 2 || column === 2)))
    } catch { return false }
  }
  function plusIcon(element) {
    const segments = []
    for (const svg of element.querySelectorAll('svg')) {
      segments.length = 0
      for (const line of svg.querySelectorAll('line')) segments.push([Number(line.getAttribute('x1')), Number(line.getAttribute('y1')), Number(line.getAttribute('x2')), Number(line.getAttribute('y2'))])
      for (const path of svg.querySelectorAll('path')) {
        if (filledPlus(path)) return true
        const d = path.getAttribute('d') || ''
        // Only two centered crossing strokes qualify as a plus glyph.
        if (/[^mMlLhHvV\d\s.,+\-]/.test(d)) continue
        const tokens = d.match(/[mMlLhHvV]|[-+]?(?:\d*\.)?\d+/g) || []
        let x = 0, y = 0, command = '', index = 0
        while (index < tokens.length) {
          if (/^[a-z]$/i.test(tokens[index])) command = tokens[index++]
          const relative = command === command.toLowerCase(), type = command.toLowerCase()
          const first = Number(tokens[index++]); if (!Number.isFinite(first)) break
          let nx = x, ny = y
          if (type === 'h') nx = (relative ? x : 0) + first
          else if (type === 'v') ny = (relative ? y : 0) + first
          else if (type === 'm' || type === 'l') {
            const second = Number(tokens[index++]); if (!Number.isFinite(second)) break
            nx = (relative ? x : 0) + first; ny = (relative ? y : 0) + second
          } else break
          if (type !== 'm') segments.push([x, y, nx, ny])
          x = nx; y = ny
          if (type === 'm') command = relative ? 'l' : 'L'
        }
      }
      if (segments.length !== 2) continue
      const horizontal = segments.find(([x1, y1, x2, y2]) => Math.abs(y2 - y1) < .01 && Math.abs(x2 - x1) > 2)
      const vertical = segments.find(([x1, y1, x2, y2]) => Math.abs(x2 - x1) < .01 && Math.abs(y2 - y1) > 2)
      if (horizontal && vertical && Math.abs((horizontal[0] + horizontal[2]) / 2 - vertical[0]) < .1 && Math.abs((vertical[1] + vertical[3]) / 2 - horizontal[1]) < .1) return true
    }
    return false
  }
  function referenceTriggers(root) {
    // This exact class/glyph pair is present in the saved live diagnostic.
    // Prefer the real button to short "add" text in wrappers or tooltips.
    const materialButtons = [...root.querySelectorAll('button')].filter(button => visible(button) &&
      [...button.querySelectorAll('mat-icon.add-menu-icon')].some(icon => /^add$/i.test(compact(icon.textContent))))
    if (materialButtons.length) return materialButtons
    const named = controls(referencePattern, root)
    if (named.length) return named
    const semanticIcons = [...root.querySelectorAll(`${glyphSelector},span`)].filter(icon => {
      if (icon.closest('textarea,[contenteditable="true"]')) return false
      const values = [icon.getAttribute('data-icon'), icon.getAttribute('aria-label'), icon.textContent]
      return values.some(value => referencePattern.test(compact(value))) || (icon instanceof SVGElement && plusIcon(icon.parentElement))
    }).map(icon => iconTarget(icon, root)).filter(Boolean)
    const buttons = [...root.querySelectorAll(interactiveSelector)].filter(element => {
      if (!visible(element)) return false
      // Decorative icons can be aria-hidden and therefore absent from the
      // computed control name. Read their explicit glyph/name, not their colour
      // or screen coordinates, to identify the composer's plus button.
      return plusIcon(element) || glyphMatches(element, /^(?:\+|add|add_2|add_circle|add_circle_outline|plus|plus-circle)$/i)
    })
    const matches = [...new Set([...semanticIcons, ...buttons])]
    return matches.filter(element => !matches.some(other => other !== element && element.contains(other)))
  }
  function iconTarget(icon, root, pattern = referencePattern) {
    // Decorative icons can be aria-hidden; only the enclosing control must
    // be visible. The witnessed Angular Material icons have native buttons.
    const interactive = icon.closest(interactiveSelector)
    if (interactive && root.contains(interactive) && visible(interactive) && !interactive.querySelector('textarea,[contenteditable="true"]')) {
      const text = controlText(interactive)
      // A decorative image/video icon inside the named model/settings button
      // must not turn that whole button into an Image/Video mode action.
      if (text && !pattern.test(text) && !pattern.test(label(interactive))) return null
      return interactive
    }
    let target = icon instanceof HTMLElement ? icon : icon.parentElement
    while (target && target !== root && root.contains(target)) {
      if (target.querySelector('textarea,[contenteditable="true"],input,button,[role="button"]')) return null
      if (visible(target)) {
        const raw = compact(target.textContent)
        if ((!raw || pattern.test(raw)) && target.querySelectorAll(glyphSelector).length <= 1) return target
        return null
      }
      target = target.parentElement
    }
    return null
  }
  function composer() {
    const editor = promptEditor()
    let parent = editor.parentElement
    let fallback = null
    let toolbarFallback = null
    while (parent && parent !== document.body) {
      if (parent.matches('main,[role="main"]')) break
      const agents = controls(/^agent$/i, parent), summaries = controls(summaryPattern, parent)
      if (agents.length === 1 && summaries.length === 1) {
        toolbarFallback ??= parent
        if (referenceTriggers(parent).length === 1) return parent
      }
      if (controls(generatePattern, parent).length === 1) {
        fallback ??= parent
        if (referenceTriggers(parent).length === 1) return parent
      }
      parent = parent.parentElement
    }
    if (toolbarFallback || fallback) return toolbarFallback || fallback
    throw new Error('Cannot safely isolate the Flow prompt and attachment area.')
  }
  function attachmentPresent(name) {
    const area = composer(), expected = prepared?.assets?.get(name)
    return [...area.querySelectorAll('img,video,[aria-label],[title],[data-filename]')].some(element => {
      if (!visible(element) || element.closest('[role="dialog"],[role="menu"],[role="listbox"]')) return false
      if (element.closest('[aria-busy="true"],[role="progressbar"]') || element.closest('[role="group"]')?.querySelector('[role="progressbar"]')) return false
      const named = [element.getAttribute('alt'), element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('data-filename')].includes(name)
      const identity = expected && (element instanceof HTMLImageElement || element instanceof HTMLVideoElement) && mediaKey(element) === expected &&
        element.closest('button[aria-label="Ingredient"][aria-busy="false"]')
      // The real uploader inserts role=group aria-label=<filename> while its
      // progress is 0%. That placeholder is not an attached image.
      return (named && (element instanceof HTMLImageElement || element instanceof HTMLVideoElement)) || !!identity
    })
  }
  function mediaKey(image) {
    const id = image.getAttribute('data-media-id')
    if (/^[0-9a-f-]{36}$/i.test(id || '')) return `asset:${id}`
    try {
      const url = new URL(image.currentSrc || image.src, location.href)
      // The live picker and composer use the same immutable asset ID but the
      // signed URL query can change. Do not infer identity from generic alt text.
      if (url.protocol === 'https:' && url.hostname === 'flow-content.google' && /^\/(?:image|video)\/[0-9a-f-]{36}$/i.test(url.pathname)) return `asset:${url.pathname.split('/').pop()}`
    } catch {}
    return null
  }
  const videoReferenceName = name => /\.(?:mp4|mov|webm)$/i.test(name)
  function videoPreviewConfirmControls(picker) {
    // The selected video's preview can be a sibling of the asset-list pane.
    const panel = picker.closest('[role="dialog"],[role="alertdialog"],dialog,[aria-modal="true"],.cdk-overlay-pane') || picker
    return controls(/^add to prompt$/i, panel)
  }
  function referenceNameMatches(value, name) {
    value = compact(value)
    if (value === name) return true
    if (!videoReferenceName(name)) return false
    const stem = name.replace(/\.(?:mp4|mov|webm)$/i, '')
    const aliases = prepared?.checkpoint?.manifest.filter(item => videoReferenceName(item.name) && item.name.replace(/\.(?:mp4|mov|webm)$/i, '') === stem) || []
    return aliases.length <= 1 && value === stem
  }
  function referenceCards(name, picker) {
    if (!picker) return []
    const cards = [...picker.querySelectorAll('[role="option"]')].filter(card => visible(card) &&
      [...card.querySelectorAll('.asset-title')].some(title => referenceNameMatches(title.textContent, name)))
    // Also retain the previous explicit metadata contract, deduplicating the
    // interactive card when both its title and thumbnail expose the filename.
    for (const named of picker.querySelectorAll('img,[aria-label],[title],[data-filename]')) {
      if (!visible(named) || ![named.getAttribute('alt'),named.getAttribute('aria-label'),named.getAttribute('title'),named.getAttribute('data-filename')].some(value => referenceNameMatches(value, name))) continue
      const card = named.closest('button,[role="button"],[role="option"],[role="gridcell"],[tabindex="0"]')
      if (card && picker.contains(card)) cards.push(card)
    }
    if (videoReferenceName(name)) {
      // The video picker shows the extensionless name beside its thumbnail.
      // Select that exact asset row before confirming its preview panel.
      const titles = [...picker.querySelectorAll('.asset-title,span,div')].filter(element => referenceNameMatches(element.textContent, name) && visible(element))
      for (const title of titles) {
        let card = title.closest('button,[role="button"],[role="option"],[role="gridcell"],[tabindex="0"]')
        if (!card || !picker.contains(card)) {
          card = title.parentElement
          while (card && card !== picker && compact(card.textContent).length <= 160) {
            if (card.querySelector('img,video') && !controls(/^add to prompt$/i, card).length) break
            card = card.parentElement
          }
        }
        if (card && card !== picker && picker.contains(card) && card.querySelector('img,video') && !controls(/^add to prompt$/i, card).length) cards.push(card)
      }
    }
    const expected = prepared?.assets?.get(name)
    if (expected) {
      const identified = [...picker.querySelectorAll('[role="option"]')].filter(card => visible(card) && [...card.querySelectorAll('img,video')].some(media => mediaKey(media) === expected))
      if (identified.length) return identified
    }
    const unique = [...new Set(cards)]
    return unique.filter(card => !unique.some(other => other !== card && card.contains(other)))
  }
  function libraryReference(name) {
    const expected = prepared?.assets?.get(name)
    const matches = [...document.querySelectorAll('flow-grid-tile-container')].filter(tile => visible(tile) && (expected ? [...tile.querySelectorAll('img,video')].some(media => mediaKey(media) === expected) : referenceNameMatches(tile.getAttribute('aria-label'), name)))
    if (matches.length > 1) throw new Error('Multiple Flow library assets share this reference filename. Nothing was selected or uploaded.')
    const tile = matches[0]
    if (!tile || tile.querySelector('[role="progressbar"],[aria-busy="true"]')) return null
    const image = expected ? [...tile.querySelectorAll('img,video')].find(media => mediaKey(media) === expected) : tile.querySelector('img,video'), key = image && mediaKey(image)
    return key ? { tile, key } : null
  }
  const uploadPattern = /^(?:upload(?: media| images?| files?| from computer)?|upload_file|upload_from_computer|file_upload)$/i
  function assetPicker() {
    const searches = [...document.querySelectorAll('input')].filter(element => visible(element) && /^search assets$/i.test(compact(element.getAttribute('placeholder') || element.getAttribute('aria-label'))))
    if (searches.length !== 1) return null
    let parent = searches[0].parentElement
    while (parent && parent !== document.body && !parent.matches('main,[role="main"]')) {
      if (controls(uploadPattern, parent).length === 1) return parent
      parent = parent.parentElement
    }
    return null
  }
  function imageInputs(root = document) {
    return [...root.querySelectorAll('input[type="file"]')].filter(input => !input.disabled && (!input.accept || (referenceMediaType.startsWith('video/') ? /video|\.mp4|\.mov|\.webm/i : /image|\.png|\.jpe?g|\.webp/i).test(input.accept)))
  }
  function referenceInput(picker, upload = null) {
    const candidates = imageInputs()
    // The input can be created later under document.body, outside the picker.
    // Apply the same resolution policy before AND after Upload media is clicked.
    const labelled = upload instanceof HTMLLabelElement ? upload.control : null
    const associated = upload?.getAttribute('for') ? document.getElementById(upload.getAttribute('for')) : null
    const explicit = [...new Set([labelled, associated])].filter(input => candidates.includes(input))
    if (explicit.length === 1) return explicit[0]
    const local = picker ? candidates.filter(input => picker.contains(input)) : []
    if (local.length === 1) return local[0]
    // Only a unique eligible input is accepted outside the known picker.
    return candidates.length === 1 ? candidates[0] : null
  }
  async function openReferenceInput(area, name) {
    // Uploaded assets already visible in the project can be attached through
    // their own native menu, without uploading another copy or using the picker.
    if (libraryReference(name)) return null
    let picker = assetPicker()
    const inline = imageInputs(area)
    if (!picker && inline.length === 1) return inline[0]
    if (!picker) {
      click(one(referenceTriggers(area), 'Add reference (+) in prompt toolbar'), 'Add reference (+)')
      await wait(() => assetPicker() || imageInputs().length === 1 || controls(uploadPattern).length === 1, 'asset picker with Upload media')
      picker = assetPicker()
    }
    // Reuse an exact existing filename once the picker is open. Re-uploading
    // the same source on every retry can create ambiguous duplicate cards.
    const existing = referenceCards(name, picker)
    if (existing.length > 1) throw new Error('Multiple Flow assets share this reference filename. Nothing was selected or uploaded.')
    if (existing.length === 1) return null
    // The Upload media control often wraps or labels a hidden input. Assign
    // that input directly rather than unnecessarily opening a native chooser.
    const ready = referenceInput(picker)
    if (ready) return ready
    const upload = one(controls(uploadPattern, picker || document), 'Upload media in asset picker')
    const associated = referenceInput(picker, upload)
    if (associated) return associated
    click(upload, 'Upload media')
    return wait(() => referenceInput(assetPicker(), upload), 'Upload media image input')
  }
  async function showExistingReference(name) {
    if (attachmentPresent(name) || libraryReference(name) || referenceCards(name, assetPicker()).length) return
    let picker = assetPicker()
    if (!picker) {
      click(one(referenceTriggers(composer()), 'reference picker for the saved upload'), 'open saved reference picker')
      picker = await wait(assetPicker, 'saved reference asset picker')
    }
    const searches = [...picker.querySelectorAll('input')].filter(input => visible(input) && /^search assets$/i.test(compact(input.getAttribute('placeholder') || input.getAttribute('aria-label'))))
    if (searches.length === 1) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(searches[0], name)
      searches[0].dispatchEvent(new Event('input', { bubbles: true }))
      searches[0].dispatchEvent(new Event('change', { bubbles: true }))
    }
    await wait(() => attachmentPresent(name) || libraryReference(name) || referenceCards(name, assetPicker()).length, `saved upload becoming available: ${name}`, 240000)
  }
  async function confirmReference(name) {
    await wait(() => libraryReference(name) || referenceCards(name, assetPicker()).length || attachmentPresent(name), `uploaded photo processed and available: ${name}`, 240000)
    const videoPicker = videoReferenceName(name) && assetPicker()
    const library = videoPicker ? null : libraryReference(name)
    if (library) {
      rememberReferenceKey(name, library.key)
      const asset = prepared.checkpoint?.assets.find(item => item.name === name)
      if (asset) { asset.key = library.key; if (asset.stage !== 'attached') asset.stage = 'uploaded'; await persistPreparation() }
      referenceCheck = { phase: 'library-add-to-prompt', assetRecorded: true }
      if (attachmentPresent(name)) { referenceCheck.phase = 'complete'; return }
      if (assetPicker()) {
        const close = [...composer().querySelectorAll('button')].filter(button => visible(button) &&
          (button.getAttribute('aria-label') === 'Add ingredients to the prompt box' || [...button.querySelectorAll('mat-icon.add-menu-icon')].some(icon => /^close$/i.test(compact(icon.textContent)))))
        click(one(close, 'close reference picker'), 'close reference picker')
        await wait(() => !assetPicker(), 'reference picker closed')
      }
      // This action was verified on the failed character's actual live card.
      // Match its immutable ID to the completed chip; generic Ingredient text
      // or a successful menu click cannot count as attachment confirmation.
      const current = libraryReference(name)
      if (!current || current.key !== library.key) throw new Error('The uploaded reference changed before attachment. Nothing was selected.')
      await closeStaleMenus()
      const more = one([...current.tile.querySelectorAll('button[aria-label="More options"]')], 'reference menu')
      more.click()
      await menuControl(/^add to prompt$/i, 'Add to prompt')
      await wait(() => attachmentPresent(name), `photo processing finished and attached in prompt: ${name}`, 240000)
      referenceCheck.phase = 'complete'
      return
    }
    let selectionMade = false, confirmationMade = false
    const ingredientKeys=()=>[...new Set([...composer().querySelectorAll('button[aria-label="Ingredient"][aria-busy="false"] img,button[aria-label="Ingredient"][aria-busy="false"] video')].filter(visible).map(mediaKey).filter(Boolean))]
    const before=new Set(ingredientKeys())
    referenceCheck={phase:'waiting',titleMatches:0,stableKeys:0,selected:false,assetRecorded:false}
    await wait(async () => {
      if(selectionMade){
        const added=ingredientKeys().filter(key=>!before.has(key))
        referenceCheck.newCompleted=added.length
        // The exact filename option was selected by this command. Associate
        // it with the single new completed chip, not a transient/recycled
        // thumbnail which can still show the preceding asset's URL.
        if(added.length===1){rememberReferenceKey(name,added[0]);referenceCheck.assetRecorded=true;await persistPreparation()}
        if(added.length>1) throw new Error('More than one new Flow ingredient appeared after selecting the reference. Paused without guessing.')
      }
      if (attachmentPresent(name)) {referenceCheck.phase='complete';return true}
      const picker = assetPicker()
      if (!picker) {referenceCheck.phase='waiting-for-completed-chip';return false}
      const cards = referenceCards(name, picker)
      referenceCheck.titleMatches=cards.length
      if (!selectionMade && cards.length === 1) {
        if (cards[0].querySelector('[role="progressbar"]') || /^Uploading\b/i.test(label(cards[0]))) return false
        const keys = [...new Set([...cards[0].querySelectorAll('img,video')].map(mediaKey).filter(Boolean))]
        referenceCheck.stableKeys=keys.length
        referenceCheck.selected=true;referenceCheck.phase='waiting-for-completed-chip'
        click(cards[0], 'select uploaded reference'); selectionMade = true; return false
      }
      if (selectionMade && !confirmationMade) {
        const previewConfirm = videoReferenceName(name) ? videoPreviewConfirmControls(picker) : []
        const confirm = previewConfirm.length ? previewConfirm : controls(/^(?:add(?: to prompt)?|attach|insert|use selected|add selected|done)$/i, picker)
        if (confirm.length > 1) throw new Error('Flow exposes multiple attachment confirmation buttons. The uploaded file is preserved; no unrelated button was clicked.')
        if (confirm.length === 1 && !confirm[0].disabled && confirm[0].getAttribute('aria-disabled') !== 'true') {
          referenceCheck.phase = videoReferenceName(name) ? 'video-preview-add-to-prompt' : 'confirm-selected-reference'
          await persistPreparation()
          click(confirm[0], videoReferenceName(name) ? 'Add to prompt for selected video preview' : 'attach selected reference')
          confirmationMade = true
        }
      }
      return false
    }, `photo processing finished and attached in prompt: ${name}`, 240000)
  }
  async function option(pattern, name) { const control = await wait(() => { const items = controls(pattern); return items.length === 1 ? items[0] : null }, name); click(control, name) }
  const durationSetting = name => name.test('duration') || name.test('length')
  function summaryDuration() {
    const summary = generationSummary()[0]
    return summary ? controlText(summary).match(/(?:^|[\s·•|])(\d+(?:\.\d+)?)\s*(?:s|seconds?)(?=$|[\s·•|])/i)?.[1] : undefined
  }
  async function setting(name, value, pattern, root = document) {
    if (durationSetting(name) && settingRetained(root, name, pattern)) return
    const selects = [...root.querySelectorAll('select,[role="combobox"],input[type="number"],input[type="range"]')].filter(element => visible(element) && name.test(label(element)))
    if (selects.length === 1) {
      const field = selects[0]
      if (field instanceof HTMLSelectElement) {
        const match = [...field.options].filter(item => compact(item.textContent) === value || pattern.test(compact(item.textContent)))
        const selected = one(match, value)
        field.value = selected.value; field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true }))
        if (field.value !== selected.value) throw new Error(`Flow did not retain ${value}.`)
      } else if (field instanceof HTMLInputElement) {
        let number = parseFloat(value)
        if (durationSetting(name)) {
          const displayed = compact(field.getAttribute('aria-valuetext')).match(/^(\d+(?:\.\d+)?)\s*(?:s|seconds?)$/i)?.[1] ?? summaryDuration()
          // Infer milliseconds only from the current numeric and displayed values.
          // Bounds alone cannot identify the control's unit.
          if (displayed && Number(displayed) > 0 && Number(field.value) / Number(displayed) === 1000) number *= 1000
        }
        if (!Number.isFinite(number) || field.min && number < Number(field.min) || field.max && number > Number(field.max)) throw new Error(`Flow does not offer ${value}. Nothing was submitted.`)
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, String(number))
        field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true }))
        if (Number(field.value) !== number) throw new Error(`Flow did not retain ${value}.`)
      } else { click(field, value); await option(pattern, value) }
    } else {
      const direct = controls(pattern, root)
      if (direct.length !== 1) {
        const ratios = [...new Set(controls(ratioPattern, root).flatMap(element => ratioValues(controlText(element))))]
        throw new Error(`Flow does not expose one supported control for ${value}.${ratios.length ? ` Visible ratios: ${ratios.join(', ')}.` : ''} No generation was submitted; requested settings were not substituted.`)
      }
      click(direct[0], value)
    }
  }
  function generationSummary() {
    const editor = promptEditor()
    let parent = editor.parentElement
    while (parent && parent !== document.body) {
      const matches = controls(summaryPattern, parent).filter(element => !element.closest('[role="dialog"],[role="menu"],[role="listbox"]'))
      if (matches.length === 1) return matches
      // Never expand the search into the whole media library or sidebars.
      if (parent.matches('main,[role="main"]')) break
      parent = parent.parentElement
    }
    return []
  }
  function summaryOutput() {
    const summary = generationSummary()[0]
    const value = summary ? `${label(summary)} ${controlText(summary)}` : ''
    const image = /\b(?:images?|nano\s*banana|imagen)\b/i.test(value), video = /\b(?:videos?|veo|omni)\b/i.test(value)
    return image && !video ? 'post' : video && !image ? 'reel' : null
  }
  function settingsPanels() {
    const looksLikeSettings = element => controls(ratioPattern, element).length > 0 && controls(/^x\s*[1-4]$/i, element).length > 0
    const panels = [...document.querySelectorAll('[role="dialog"],[role="menu"],[role="listbox"],[data-state="open"],[data-radix-popper-content-wrapper]')].filter(element => visible(element) && looksLikeSettings(element) && !/Agent settings/i.test(label(element).slice(0, 60)))
    // Detect an already-open roleless settings panel before clicking its
    // summary again; otherwise a second lookup would toggle that panel shut.
    for (const mode of controls(modePattern)) {
      let parent = mode.parentElement
      while (parent && parent !== document.body && !parent.matches('main,[role="main"]')) {
        if (looksLikeSettings(parent) && controls(modePattern, parent).length >= 2) { panels.push(parent); break }
        parent = parent.parentElement
      }
    }
    return [...new Set(panels)].filter(element => !panels.some(other => other !== element && element.contains(other)))
  }
  function controlDiagnostics() {
    // Only short control labels, never prompt contents, references, cookies,
    // account details or a general page dump. Useful when screenshots cannot
    // reveal accessibility roles and text nodes.
    let area
    try { area = composer() } catch { return 'Prompt toolbar was not detected.' }
    if (!area || area === document.body || area.matches('main,[role="main"]')) return 'A unique composer control group was not detected.'
    const allowed = /agent|nano\s*banana|imagen|veo|omni|image|video|generate|send|submit|arrow|upload|attach|\badd\b|^\+|x\s*[1-4]|\b\d+:\d+\b/i
    const values = [...area.querySelectorAll(`${interactiveSelector},span`)].filter(element => !element.closest('textarea,[contenteditable="true"]') && visible(element)).map(element => {
      const name = controlText(element)
      if (!name || name.length > 100 || !allowed.test(name)) return null
      return `${element.tagName.toLowerCase()}${element.getAttribute('role') ? ':' + element.getAttribute('role') : ''}=${name}`
    }).filter(Boolean)
    const icons = [...area.querySelectorAll(interactiveSelector)].filter(element => visible(element) && !controlText(element) && element.querySelector(glyphSelector)).slice(0, 3).map(element => {
      const paths = [...element.querySelectorAll('svg path')].slice(0, 2).map(path => (path.getAttribute('d') || '').slice(0, 160)).join('|')
      const glyphs = [...element.querySelectorAll(glyphSelector)].map(icon => compact(icon.getAttribute('data-icon') || icon.textContent)).filter(value => /^[a-z_+]{1,40}$/i.test(value)).slice(0, 2).join('|')
      return `${element.tagName.toLowerCase()}:icon(disabled=${!!element.disabled},glyph=${glyphs},plus=${plusIcon(element)}${paths ? `,path=${paths}` : ''})`
    })
    return [...new Set(values)].slice(0, 6).concat(icons).join('; ') || 'No supported composer labels detected.'
  }
  function uploadDiagnostic() {
    // A bounded structural report: no page HTML, prompt, filename, account,
    // project ID, media URL, cookies or pairing code is included.
    let editor
    try { editor = promptEditor() } catch { return { adapter: ADAPTER_VERSION, issue: 'No unique prompt editor', lastFailure } }
    const scopes = []
    let area = editor.parentElement, toolbar = null, toolbarDepth = null
    for (let depth = 0; area && area !== document.body && depth < 18; depth++, area = area.parentElement) {
      if (area.matches('main,[role="main"]')) break
      const agents = controls(/^agent$/i, area).length, summaries = controls(summaryPattern, area).length
      scopes.push({ depth, tag: area.tagName.toLowerCase(), agents, summaries, references: referenceTriggers(area).length, buttons: area.querySelectorAll(interactiveSelector).length })
      if (agents === 1 && summaries === 1) {
        if (!toolbar) { toolbar = area; toolbarDepth = depth }
        if (referenceTriggers(area).length === 1) { toolbar = area; break }
      }
      if (toolbarDepth !== null && depth >= toolbarDepth + 2) break
    }
    if (!toolbar) return { adapter: ADAPTER_VERSION, scopes, lastFailure, issue: 'No complete toolbar scope' }
    const safeName = value => {
      const name = compact(value)
      return name.length <= 100 && /^(?:\+|add(?:_2|_circle|_circle_outline|_photo_alternate)?|arrow_forward|arrow_upward|upload_file|file_upload|upload media|attach(?:ments?)?|agent|(?:image|video|nano banana|imagen|veo|omni)[\w\s.:×x-]*|x\s*[1-4])$/i.test(name) ? name : name ? '[text omitted]' : ''
    }
    const elements = [...toolbar.querySelectorAll('button,div,span,i,svg,path,[role],[tabindex],[data-icon]')].filter(element =>
      !element.contains(editor) && !element.closest('textarea,[contenteditable="true"]')).slice(0, 120)
    const picker = assetPicker(), eligibleInputs = imageInputs()
    return {
      adapter: ADAPTER_VERSION, scopes, lastFailure, imageInputs: eligibleInputs.length, assetPicker: !!picker,
      imageInputsInPicker: picker ? imageInputs(picker).length : 0,
      fileInputs: [...document.querySelectorAll('input[type="file"]')].slice(0, 12).map(input => ({
        eligibleImage: eligibleInputs.includes(input), disabled: input.disabled, multiple: input.multiple,
        inPicker: !!picker?.contains(input), inComposer: toolbar.contains(input), connected: input.isConnected,
      })),
      controls: elements.map(element => ({
        tag: element.tagName.toLowerCase(), parent: elements.indexOf(element.parentElement),
        role: element.getAttribute('role'), tabindex: element.getAttribute('tabindex'), ariaHidden: element.getAttribute('aria-hidden'),
        name: safeName(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent), icon: safeName(element.getAttribute('data-icon')),
        rendered: element.checkVisibility(), visible: visible(element), cursor: getComputedStyle(element).cursor,
        pointerEvents: getComputedStyle(element).pointerEvents, disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
        before: safeName(getComputedStyle(element, '::before').content.replace(/^['"]|['"]$/g, '')),
        after: safeName(getComputedStyle(element, '::after').content.replace(/^['"]|['"]$/g, '')),
        glyphCodePoints: !element.children.length && compact(element.textContent).length <= 4 ? [...compact(element.textContent)].filter(character => /[^\w\s]/u.test(character)).map(character => character.codePointAt(0).toString(16)) : undefined,
        iconClasses: [...element.classList].filter(value => /material|symbol|icon|lucide/i.test(value)).slice(0, 4).map(value => value.slice(0, 80)),
        path: element instanceof SVGPathElement ? (element.getAttribute('d') || '').replace(/[^a-zA-Z0-9.,+\s-]/g, '').slice(0, 500) : undefined,
      })),
    }
  }
  async function openGenerationSettings() {
    const inner = settingsPanels()
    if (inner.length === 1) return inner[0]
    const summary = one(generationSummary(), 'generation settings summary (Image/Video)')
    click(summary, 'generation settings summary')
    return wait(() => {
      const specific = settingsPanels()
      if (specific.length === 1) return specific[0]
      // Some Flow popovers have no menu/dialog role. A unique Image/Video tab
      // pair can still identify the smallest settings container without using
      // the account-level gear menu or page coordinates.
      const modes = controls(modePattern)
      if (modes.length !== 2) return null
      let parent = modes[0].parentElement
      while (parent && parent !== document.body) {
        if (parent.matches('main,[role="main"]')) break
        if (parent.contains(modes[1]) && controls(ratioPattern, parent).length && controls(/^x\s*[1-4]$/i, parent).length) return parent
        parent = parent.parentElement
      }
      return null
    }, 'Image/Video generation settings panel')
  }
  const omniModel = /^(?:Gemini\s+)?Omni\s+(?:Flash\s+1\.2|1\.2\s+Flash)$/i
  const selectedControl = element => ['true', 'active', 'checked', 'on'].includes(element.getAttribute('aria-selected') ?? element.getAttribute('aria-checked') ?? element.getAttribute('aria-pressed') ?? element.getAttribute('data-state'))
  function currentModelControl(root) {
    const candidates = [...root.querySelectorAll('select,[role="combobox"],button,[role="button"]')].filter(element => {
      if (!visible(element) || element.matches('[role="option"],[role="menuitem"],[role="radio"]')) return false
      const menu = element.closest('[role="menu"],[role="listbox"]')
      if (menu && menu !== root && root.contains(menu)) return false
      return /model/i.test(label(element)) && element.matches('select,[role="combobox"]') || /^(?:(?:Gemini\s+)?Omni\b|Veo\b|(?:select\s+)?(?:video\s+)?model$)/i.test(controlText(element))
    })
    const triggers = candidates.filter(element => element.matches('select,[role="combobox"]') || element.hasAttribute('aria-haspopup') || element.hasAttribute('aria-expanded') || glyphMatches(element, /^(?:expand_more|expand_less|arrow_drop_down|arrow_drop_up|keyboard_arrow_down)$/i))
    return triggers.length === 1 ? triggers[0] : candidates.length === 1 ? candidates[0] : null
  }
  function currentModelText(root) {
    const field = currentModelControl(root)
    return field instanceof HTMLSelectElement ? compact(field.selectedOptions[0]?.textContent) : field ? controlText(field) : ''
  }
  function summarySetting(root, name) {
    const summary = generationSummary()[0]
    if (!summary) return ''
    const text = controlText(summary)
    if (name.test('resolution') || name.test('quality')) return text.match(/(?:^|[\s·•|])(\d{3,4}\s*p)(?=$|[\s·•|])/i)?.[1] ?? ''
    if (name.test('outputs')) return text.match(/(?:^|[\s·•|])(x\s*[1-4])(?=$|[\s·•|])/i)?.[1] ?? ''
    if (name.test('aspect ratio') || name.test('orientation')) {
      const ratio = ratioValues(text)
      if (ratio.length === 1) return ratio[0]
      // The current toolbar uses an orientation icon instead of ratio text.
      // Only map it when the settings explicitly offer these two video ratios.
      const choices = [...new Set(controls(ratioPattern, root).flatMap(element => ratioValues(controlText(element))))]
      if (choices.length === 2 && choices.includes('9:16') && choices.includes('16:9')) {
        if (glyphMatches(summary, /^(?:crop_portrait|stay_current_portrait|smartphone)$/i)) return '9:16'
        if (glyphMatches(summary, /^(?:crop_landscape|stay_current_landscape)$/i)) return '16:9'
      }
    }
    return ''
  }
  function settingRetained(root, name, pattern) {
    // A model dropdown's displayed value is its selection. Its trigger does
    // not need aria-selected, which belongs to the choices inside the menu.
    if (name.test('model')) return pattern.test(currentModelText(root))
    const fields = [...root.querySelectorAll('select,[role="combobox"],input[type="number"],input[type="range"]')].filter(field => visible(field) && name.test(label(field)))
    if (durationSetting(name)) {
      const field = fields.length === 1 ? fields[0] : null
      const formatted = field instanceof HTMLSelectElement ? compact(field.selectedOptions[0]?.textContent) : compact(field?.getAttribute('aria-valuetext'))
      if (/^\d+(?:\.\d+)?\s*(?:s|seconds?)$/i.test(formatted)) return pattern.test(formatted)
      const duration = summaryDuration()
      if (duration !== undefined && pattern.test(`${duration}s`)) return true
    }
    if (fields.length === 1) {
      const field = fields[0]
      return pattern.test(field instanceof HTMLSelectElement ? compact(field.selectedOptions[0]?.textContent) : field instanceof HTMLInputElement ? `${field.value}s` : controlText(field))
    }
    return controls(pattern, root).some(selectedControl) || pattern.test(summarySetting(root, name)) || pattern.test(controlText(generationSummary()[0] || document.createElement('span')))
  }
  function closeGenerationSettings(panel) {
    const save = controls(/^save$/i, panel)
    if (save.length === 1) click(save[0], 'save generation settings')
    else {
      const close = controls(/^(?:close|done)$/i, panel)
      if (close.length === 1) click(close[0], 'close generation settings')
      else {
        const summary = one(generationSummary(), 'generation settings summary')
        if (summary.getAttribute('aria-expanded') !== 'false') click(summary, 'close generation settings')
      }
    }
  }
  async function checkSingleReelSettings() {
    const panel = await openGenerationSettings()
    const expected = [[/model/i, omniModel, 'Omni Flash 1.2'], [/resolution|quality/i, /^720\s*p$/i, '720p'], [/duration|length/i, /^15\s*(?:s|seconds?)$/i, '15 seconds'], [/aspect ratio|orientation/i, /^(?:.*\s)?9:16(?:\s.*)?$/, '9:16'], [/outputs|results per prompt|number of videos/i, /^(?:x\s*)?1(?:\s*(?:outputs?|videos?))?$/i, 'one clip']]
    if (summaryOutput() !== 'reel' && !controls(/^videos?$/i, panel).some(selectedControl)) throw new Error('Flow did not retain Video mode. Nothing was submitted.')
    for (const [name, pattern, value] of expected) {
      if (!settingRetained(panel, name, pattern)) throw new Error(`Flow did not confirm ${value}. Nothing was submitted.`)
    }
    closeGenerationSettings(panel)
  }
  async function configureGeneration(payload, ratio) {
    // A previous failed upload can leave the asset picker open. Its Images /
    // Videos navigation must never be used as generation settings.
    if (assetPicker()) {
      const close = [...composer().querySelectorAll('button')].filter(button => visible(button) &&
        [...button.querySelectorAll('mat-icon.add-menu-icon')].some(icon => /^close$/i.test(compact(icon.textContent))))
      click(one(close, 'close existing asset picker'), 'close existing asset picker')
      await wait(() => !assetPicker(), 'asset picker closed before generation settings')
    }
    await wait(() => {
      // On the current Flow UI Agent is a toggle, not a model dropdown.
      if (generationSummary().length === 1) return true
      const agent = controls(/^agent$/i)
      if (agent.length !== 1) return null
      const state = agent[0].getAttribute('aria-pressed') ?? agent[0].getAttribute('aria-checked') ?? agent[0].getAttribute('data-state')
      if (state === 'false' || state === 'unchecked' || state === 'off') return null
      click(agent[0], 'turn off Agent mode')
      return true
    }, 'Agent toggle or direct generation controls')
    await wait(() => generationSummary().length === 1, 'direct Image/Video generation settings after turning Agent off')
    let panel = await openGenerationSettings()
    const requestedMode = payload.outputType === 'post' ? /^(?:images?|create (?:an? )?image|image generation)$/i : /^(?:videos?|create (?:an? )?video|video generation)$/i
    if (summaryOutput() !== payload.outputType) {
      const modes = controls(requestedMode, panel)
      click(one(modes, 'output mode in generation settings'), 'output mode')
    }
    // The panel may be replaced or closed after selecting Image/Video.
    await new Promise(resolve => setTimeout(resolve, 200))
    panel = await openGenerationSettings()
    const modeControls = controls(requestedMode, panel)
    const selected = modeControls[0]
    const selectedState = selected?.getAttribute('aria-selected') ?? selected?.getAttribute('aria-checked') ?? selected?.getAttribute('data-state')
    const summaryMode = summaryOutput() === payload.outputType
    if (!summaryMode && !['true', 'active', 'checked', 'on'].includes(selectedState)) throw new Error('Flow did not confirm the requested Image/Video mode. Nothing was submitted.')
    if (payload.videoSettings) {
      if (!settingRetained(panel, /model/i, omniModel)) {
        const field = currentModelControl(panel)
        if (field instanceof HTMLSelectElement) await setting(/model/i, 'Omni Flash 1.2', omniModel, panel)
        else {
          if (!field) throw new Error('Flow model dropdown could not be identified. Nothing was submitted.')
          click(field, 'video model selector')
          await option(omniModel, 'Omni Flash 1.2')
        }
      }
      panel = await openGenerationSettings()
      await wait(() => settingRetained(settingsPanels()[0] || panel, /model/i, omniModel), 'selected model dropdown showing Omni 1.2 Flash')
      await setting(/resolution|quality/i, '720p', /^720\s*p$/i, panel)
      panel = await openGenerationSettings()
    }
    const actualRatio = await applyRatio(ratio, panel, !!payload.videoSettings)
    panel = await openGenerationSettings()
    await setting(/outputs|results per prompt|number of images|number of videos/i, String(payload.outputs), new RegExp(`^(?:x\\s*)?${payload.outputs}(?:\\s*(?:outputs?|images?|videos?))?$`, 'i'), panel)
    if (payload.outputType === 'reel') {
      panel = await openGenerationSettings()
      const mode = controls(payload.continuation ? /^frames$/i : /^ingredients$/i, panel)
      if (mode.length === 1) click(mode[0], 'video reference mode')
      panel = await openGenerationSettings()
      await setting(/duration|length/i, `${payload.sourceDuration}s`, new RegExp(`^${payload.sourceDuration}\\s*(?:s|seconds?)$`, 'i'), panel)
    }
    // Keep the existing selected model: the app does not request a model change.
    // Requiring a visible Nano Banana/Veo button here caused the original bug.
    // This legacy behavior applies when no explicit videoSettings were requested.
    closeGenerationSettings(panel)
    if (payload.videoSettings) await checkSingleReelSettings()
    return actualRatio
  }
  function videoCard(element) {
    if (element.querySelector('video') || element.matches('[data-media-type="video"],[data-type="video"]') || element.querySelector('[data-media-type="video"],[data-type="video"]')) return true
    const playName = /^(?:play|play video|play clip|preview video|replay|pause|pause video|play_arrow|play_circle|play_circle_filled|play_circle_outline)$/i
    if ([...element.querySelectorAll('button,[role="button"]')].some(button => visible(button) && playName.test(label(button)))) return true
    return [...element.querySelectorAll(glyphSelector)].some(icon => {
      if (!/^(?:play_arrow|play_circle|play_circle_filled|play_circle_outline)$/i.test(compact(icon.getAttribute('data-icon') || icon.getAttribute('aria-label') || icon.textContent))) return false
      const button = icon.closest('button,[role="button"]')
      // Video footers combine a play glyph with the generated clip title.
      // That title is not a play-control label; the glyph identifies the type.
      if (button) return visible(button)
      return icon.checkVisibility() && !icon.closest('[role="dialog"],[role="menu"],[role="listbox"]')
    })
  }
  function cards() {
    const result = new Map()
    for (const element of document.querySelectorAll('flow-grid-tile-container,[data-asset-id],[data-generation-id],article,[role="listitem"]')) {
      if (!visible(element)) continue
      const video = element.querySelector('video'), img = element.querySelector('img'), isVideo = videoCard(element)
      if (!video && !img) continue
      if (element.matches('flow-grid-tile-container')) {
        const media = element.matches('[data-media-id]') ? element : element.querySelector('[data-media-id]')
        const id = media?.getAttribute('data-media-id')
        // Include uploaded media in the baseline too. Result ownership is
        // established by its full prompt, not the hover toolbar's aria label.
        if (!id) continue
        const busy = element.querySelector('[role="progressbar"],[aria-busy="true"]')
        // Flow can show a finished video as a loaded poster and play overlay.
        // Playback metadata is lazy and must not gate result collection.
        const posterReady = !!img?.complete && img.naturalWidth > 0
        const videoReady = !!video && (video.readyState >= 1 || !!video.poster && !!element.querySelector('button[aria-label="More options"]'))
        const selector = element.hasAttribute('data-media-id') ? `flow-grid-tile-container[data-media-id="${CSS.escape(id)}"]` : `flow-grid-tile-container:has([data-media-id="${CSS.escape(id)}"])`
        result.set(id, { id, selector, kind: isVideo ? 'reel' : 'post', native: true,
          ready: !busy && (isVideo ? posterReady || videoReady : posterReady) })
        continue
      }
      const attr = element.hasAttribute('data-asset-id') ? 'data-asset-id' : element.hasAttribute('data-generation-id') ? 'data-generation-id' : null
      const link = element.querySelector('a[href*="/asset/"]')
      const id = attr ? element.getAttribute(attr) : link?.getAttribute('href')
      if (!id) continue
      const selector = attr ? `[${attr}="${CSS.escape(id)}"]` : `article:has(a[href="${CSS.escape(id)}"]),[role="listitem"]:has(a[href="${CSS.escape(id)}"])`
      result.set(id, { id, selector, prompt: compact(element.getAttribute('data-prompt') || element.innerText), kind: isVideo ? 'reel' : 'post', ready: !!element.querySelector('a[download],button[aria-label*="download" i]') && !/generating|queued|processing/i.test(element.innerText) })
    }
    return [...result.values()]
  }
  const resultPrompts = new Map()
  const failedBefore=new Map()
  async function closeStaleMenus(){
    if(![...document.querySelectorAll('[role="menu"]')].some(visible))return
    const backdrop=[...document.querySelectorAll('.cdk-overlay-backdrop')].find(visible)
    if(backdrop)backdrop.click()
    else{
      const outside=document.querySelector('.header-title')
      outside?.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse'}))
      outside?.click()
    }
    await wait(()=>![...document.querySelectorAll('[role="menu"]')].some(visible),'previous Flow menu closed',5000)
  }
  let openedResultFooter = null
  async function closeResultInfo(footer) {
    const panels = [...document.querySelectorAll('flow-info-panel')].filter(visible)
    if (!panels.length) { openedResultFooter = null; return }
    if (panels.length !== 1) throw new Error('Flow has multiple result information panels. Inspect the existing results.')
    const close = [...panels[0].querySelectorAll('button,[role="button"]')].filter(button => visible(button) && (/^(?:close|dismiss)(?: panel| information)?$/i.test(label(button)) || glyphMatches(button, /^close$/i)))
    if (close.length === 1) close[0].click()
    else if (document.querySelector('.header-title')) {
      // Flow's current CDK popover opens on its footer; clicking the footer
      // again need not toggle it closed. Dismiss through a neutral outside area.
      const outside = document.querySelector('.header-title')
      outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
      outside.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }))
      outside.click()
    }
    else if (footer?.isConnected) footer.click()
    else throw new Error('Close the open Flow result information panel, then collection will continue automatically.')
    const open = () => [...document.querySelectorAll('flow-info-panel')].some(visible)
    const deadline = Date.now() + 700
    while (open() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    if (open()) throw new Error('Flow result information panel is still closing. Collection will retry automatically.')
    openedResultFooter = null
  }
  async function resultPrompt(result) {
    if (!result.native) return result.prompt
    const key = `${location.href}:${result.id}`
    if (resultPrompts.has(key)) return resultPrompts.get(key)
    const card = one([...document.querySelectorAll(result.selector)], 'matched result')
    const embedded = compact(card.getAttribute('data-prompt') || card.getAttribute('data-generation-prompt') || card.querySelector('[data-prompt]')?.getAttribute('data-prompt'))
    if (embedded) { resultPrompts.set(key, embedded); return embedded }
    const footers = [...card.querySelectorAll('button.footer-left')]
    const named = [...card.querySelectorAll('button,[role="button"]')].filter(button => /^(?:view prompt|show prompt|generation details|view generation details|result information)$/i.test(label(button)))
    if (!footers.length && !named.length) return ''
    const footer = one(footers.length ? footers : named, 'result information')
    // Close an already open panel first: only read a panel opened for this ID.
    if ([...document.querySelectorAll('flow-info-panel')].some(visible)) {
      const expanded = [...document.querySelectorAll('flow-grid-tile-container button.footer-left[aria-expanded="true"]')]
      await closeResultInfo(openedResultFooter ?? (expanded.length === 1 ? expanded[0] : null))
    }
    openedResultFooter = footer
    footer.click()
    try {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const panels = [...document.querySelectorAll('flow-info-panel .prompt-text')].filter(visible)
        if (panels.length === 1 && compact(panels[0].textContent)) {
          const prompt = compact(panels[0].textContent)
          resultPrompts.set(key, prompt)
          if (resultPrompts.size > 100) resultPrompts.delete(resultPrompts.keys().next().value)
          return prompt
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error('Flow result prompt is not available yet. Resume collection; no new generation is needed.')
    } finally {
      // Real Flow footers can omit aria-expanded entirely. The panel opened by
      // this call must still be closed before inspecting the next product.
      await closeResultInfo(footer)
    }
  }
  async function menuControl(pattern, description) {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const matches = [...document.querySelectorAll('[role="menuitem"]')].filter(element => {
        if (!visible(element)) return false
        const clone = element.cloneNode(true)
        clone.querySelectorAll('mat-icon,svg,[aria-hidden="true"]').forEach(icon => icon.remove())
        return pattern.test(compact(clone.textContent))
      })
      if (matches.length === 1) { click(matches[0], description); return }
      if (matches.length > 1) throw new Error(`Flow has multiple ${description} controls. Close its menus and resume collection.`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`Flow did not expose ${description}. The generated result is preserved.`)
  }
  async function execute(action, payload) {
    guard(payload.url)
    await acceptUploadRightsDialog()
    if (action === 'uploadDiagnostic') return uploadDiagnostic()
    if (action === 'inspect') return { companionVersion: '0.1.6', adapterVersion: ADAPTER_VERSION, referenceCheck, url: location.href, title: document.title, ready: controls(/^(?:\+\s*|add\s*)?new project$/i).length === 1 || (/\/project\/[a-zA-Z0-9_-]+/.test(location.pathname) && [...document.querySelectorAll('textarea,[contenteditable="true"]')].some(visible)) }
    if (action === 'createProject') { click(one(controls(/^(?:\+\s*|add\s*)?new project$/i), 'New project'), 'New project'); return null }
    if (action === 'nameProject') {
      if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 120 || /[\u0000-\u001f]/.test(payload.name)) throw new Error('Invalid software project name.')
      const nameInput = () => {
        const fields = [...document.querySelectorAll('.header-title input[aria-label="Editable text"]')].filter(visible)
        return fields.length === 1 ? fields[0] : null
      }
      const input = await wait(nameInput, 'Flow project name field', 15000)
      const confirmed = () => {
        const current = nameInput()
        return current?.value === payload.name && current.closest('.header-title')?.querySelector('[role="heading"]')?.getAttribute('aria-label') === payload.name
      }
      if (!confirmed()) {
        // The live component enters edit mode on click, not focus. Focusing
        // alone leaves Done absent, even though the input is editable.
        click(input, 'edit project name')
        input.focus()
        // Flow's editable-text component saves through its inline Done button.
        // Blurring cancels the draft; Enter does not reliably commit it. Wait
        // for edit mode before assigning text, then use this header's Done only.
        const doneButton = () => {
          const header = nameInput()?.closest('.header-title')
          // The inline edit controls exist only in edit mode. Chrome can keep
          // their focus-dependent CSS hidden while the app/popup owns focus.
          // Resolve the unique control in this exact header; click() still
          // refuses disabled controls and the saved heading must acknowledge it.
          const buttons = header ? [...header.querySelectorAll('flow-editable-text button[aria-label="Done"]')] : []
          return buttons.length === 1 ? buttons[0] : null
        }
        await wait(doneButton, 'project name Done button', 10000)
        const editable = nameInput()
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(editable, payload.name)
        editable.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertReplacementText', data:payload.name}))
        editable.dispatchEvent(new Event('change', {bubbles:true}))
        click(await wait(doneButton, 'project name Done button'), 'save project name with Done')
        await wait(confirmed, 'saved Flow project name matching the software', 15000)
      }
      return {name:payload.name}
    }
    if (action === 'prepare') {
      if (!['post', 'reel'].includes(payload.outputType) || typeof payload.prompt !== 'string' || !payload.prompt.trim() || payload.prompt.length > 150000 || !Number.isInteger(payload.outputs) || payload.outputs < 1 || payload.outputs > 4) throw new Error('Invalid prepared generation settings.')
      if (payload.videoSettings && (payload.outputType !== 'reel' || payload.videoSettings.model !== 'Omni Flash 1.2' || payload.videoSettings.resolution !== '720p' || payload.preset !== 'reel-vertical' || payload.outputs !== 1 || payload.sourceDuration !== 15 || payload.continuation)) throw new Error('A single reel requires Video, 9:16, Omni Flash 1.2, 720p, one clip and 15 seconds.')
      const requestId = payload.requestId
      if (requestId !== undefined && !/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error('Invalid preparation request identifier.')
      const manifest = payload.manifest || []
      if (!Array.isArray(manifest) || manifest.length > 64 || new Set(manifest.map(item => item?.name)).size !== manifest.length || manifest.some(item => !item || typeof item.name !== 'string' || !item.name || item.name.length > 200 || /[\\/\0]/.test(item.name) || !['reference','startFrame'].includes(item.kind))) throw new Error('Invalid request reference manifest.')
      const settingsKey = JSON.stringify({ outputType: payload.outputType, preset: payload.preset, sourceDuration: payload.sourceDuration ?? null, outputs: payload.outputs, continuation: !!payload.continuation, videoSettings: payload.videoSettings ?? null })
      let saved = requestId && prepared?.checkpoint?.requestId === requestId ? prepared.checkpoint : undefined
      if (!saved && requestId && chrome.storage?.local) saved = (await chrome.storage.local.get(preparationStorageKey(requestId)))[preparationStorageKey(requestId)]
      if (!saved) saved = payload.checkpoint
      if (saved && (saved.requestId !== requestId || saved.url !== location.href || saved.prompt !== payload.prompt || saved.settingsKey !== settingsKey || (!Array.isArray(saved.manifest) || saved.manifest.length !== manifest.length || saved.manifest.some((item, index) => !item || item.name !== manifest[index]?.name || item.kind !== manifest[index]?.kind)) || !Array.isArray(saved.assets) || saved.assets.length > manifest.length || saved.assets.some(asset => !manifest.some(item => item.name === asset.name && item.kind === asset.kind) || !['uploading','uploaded','attached'].includes(asset.stage) || asset.key !== undefined && !/^asset:[0-9a-f-]{36}$/i.test(asset.key)))) throw new Error('The resume checkpoint belongs to different request data. Existing uploads were preserved.')
      const checkpoint = requestId ? saved || { requestId, url: location.href, prompt: payload.prompt, settingsKey, manifest, assets: [], attachmentsCleared: !!payload.resumePreparation } : undefined
      prepared = { url: location.href, prompt: payload.prompt, requestId, checkpoint, files: [], startFrame: false, assets: new Map((checkpoint?.assets || []).filter(asset => asset.key).map(asset => [asset.name, asset.key])), videoSettings: payload.videoSettings }
      submission = null
      await persistPreparation()
      failedBefore.set(`${location.href}:${compact(payload.prompt)}`,new Set(document.querySelectorAll('flow-grid-tile-container,[data-generation-id]')))
      if(failedBefore.size>100)failedBefore.delete(failedBefore.keys().next().value)
      await closeStaleMenus()
      await wait(() => {
        try { return !!promptEditor() } catch { return false }
      }, 'project prompt editor ready', 25000)
      const ratio = { 'post-square': '1:1', 'post-portrait': '4:5', 'post-tall': '3:4', 'post-landscape': '1.91:1', 'post-story': '9:16', 'reel-vertical': '9:16', 'reel-landscape': '16:9' }[payload.preset]
      if (!ratio) throw new Error('Invalid export preset.')
      let actualRatio = checkpoint?.sourceRatio || ratio
      let settingsDone = !!checkpoint?.settingsDone
      if (settingsDone && payload.videoSettings) {
        try { await checkSingleReelSettings() }
        catch (error) {
          if (!/Flow did not confirm (?:Video mode|Omni|720p|15 seconds|9:16|one clip)/i.test(error.message)) throw error
          settingsDone = false
        }
      } else if (settingsDone) {
        const panel = await openGenerationSettings()
        settingsDone = summaryOutput() === payload.outputType && settingRetained(panel, /aspect ratio|orientation/i, new RegExp(`^${actualRatio}$`)) && settingRetained(panel, /outputs|results per prompt|number of images|number of videos/i, new RegExp(`^(?:x\\s*)?${payload.outputs}$`, 'i'))
        if (payload.outputType === 'reel') settingsDone = settingsDone && settingRetained(panel, /duration|length/i, new RegExp(`^${payload.sourceDuration}\\s*(?:s|seconds?)$`, 'i'))
        closeGenerationSettings(panel)
      }
      if (!settingsDone) {
        if (generationSummary().length || controls(/^agent$/i).length) actualRatio = await configureGeneration(payload, ratio)
        else {
          if (payload.videoSettings) throw new Error('Flow does not expose verifiable single-reel settings. Nothing was submitted.')
          await option(payload.outputType === 'post' ? /^image$/i : /^video$/i, 'output mode')
          if (payload.outputType === 'reel') await option(payload.continuation ? /^frames$/i : /^ingredients$/i, 'video reference mode')
          actualRatio = await applyRatio(ratio, document)
          await setting(/outputs|results per prompt|number of images|number of videos/i, String(payload.outputs), new RegExp(`^(?:x\\s*)?${payload.outputs}(?:\\s*(?:outputs?|images?|videos?))?$`, 'i'))
          if (payload.outputType === 'reel') await setting(/duration|length/i, `${payload.sourceDuration}s`, new RegExp(`^${payload.sourceDuration}\\s*(?:s|seconds?)$`, 'i'))
        }
        if (checkpoint) { checkpoint.settingsDone = true; checkpoint.sourceRatio = actualRatio; checkpoint.targetRatio = ratio; await persistPreparation() }
      }
      if (!checkpoint?.attachmentsCleared) {
        const remove = () => {const area=composer();return [...new Set([
          ...controls(/^remove(?: reference| image| attachment)?(?:\s.*)?$/i, area),
          ...[...area.querySelectorAll('button[aria-label="Ingredient"]')].filter(button => visible(button) &&
            [...button.querySelectorAll('mat-icon')].some(icon => /^cancel$/i.test(compact(icon.textContent)))),
        ])]}
        for (let i = 0; remove().length && i < 60; i++) { click(remove()[0], 'remove old prompt attachment'); await new Promise(resolve => setTimeout(resolve, 100)) }
        if (remove().length) throw new Error('Old prompt attachments could not be cleared safely.')
        if (checkpoint) { checkpoint.attachmentsCleared = true; await persistPreparation() }
      }
      if (compact(promptText(promptEditor())) !== compact(payload.prompt)) {
        const editor=promptEditor()
        const editNonce=crypto.randomUUID();editor.setAttribute('data-frame-edit',editNonce)
        try {
          const edit=await chrome.runtime.sendMessage({type:'frame-flow-edit-prompt',nonce:editNonce,prompt:payload.prompt})
          if(!edit?.ok || edit.value?.retained!==true) throw new Error(edit?.error || 'Flow did not confirm prompt editing. Nothing was submitted.')
        } finally {editor.removeAttribute('data-frame-edit')}
        if (compact(promptText(editor)) !== compact(payload.prompt)) throw new Error('The complete prompt was not retained in Flow.')
      }
      if (checkpoint) { checkpoint.promptDone = true; await persistPreparation() }
      return { sourceRatio: actualRatio, targetRatio: ratio, automaticCrop: actualRatio !== ratio, checkpoint }
    }
    // Developer upload-only verification uses the same attach implementation,
    // preserves the live prompt/settings and clears its state before returning.
    // It can never leave a prepared request available for Generate.
    if (action === 'checkReference') {
      if (prepared) throw new Error('A prepared request exists. Finish or clear it before an upload-only check.')
      prepared = {url:location.href,prompt:promptText(promptEditor()),files:[],startFrame:false,assets:new Map()}
      try { await execute('attach',payload); return {attached:true,assetMatched:!!prepared.assets.get(payload.file.name)} }
      finally { prepared = null }
    }
    if (action === 'referenceState') {
      if (payload.requestId && prepared?.requestId !== payload.requestId) throw new Error('The active preparation belongs to a different request.')
      return referenceState(payload.name, payload.kind)
    }
    if (action === 'attach') {
      if (!prepared || prepared.url !== location.href || payload.requestId && prepared.requestId !== payload.requestId) throw new Error('Prepare this saved request before attaching files.')
      const file = payload.file
      if (!file || typeof file.name !== 'string' || !file.name || file.name.length > 200 || /[\\/\0]/.test(file.name)) throw new Error('Invalid reference filename.')
      const state = await referenceState(file.name, payload.kind)
      if (state.attached) return state
      if (payload.kind === 'startFrame') click(one(controls(/^(?:\+\s*)?add start frame$/i, composer()), 'Add start frame'), 'Add start frame')
      if (!state.known) {
        if (!['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm'].includes(file.type) || typeof file.base64 !== 'string' || file.base64.length > 28_000_000) throw new Error('Invalid reference media payload.')
        referenceMediaType = file.type
        const input = await openReferenceInput(composer(), file.name)
        if (input) {
          const nonce = crypto.randomUUID()
          input.setAttribute('data-frame-upload', nonce)
          // Persist upload intent before assigning bytes. A lost acknowledgement
          // resumes observation of this upload instead of sending it twice.
          rememberReference(file.name, payload.kind, 'uploading')
          await persistPreparation()
          try {
            const result = await chrome.runtime.sendMessage({ type: 'frame-flow-main-upload', nonce, file })
            if (!result?.ok || result.value?.assigned !== true) throw new Error(result?.error || 'The Flow page-context upload could not be confirmed. Its upload intent was saved; resume this reference without repeating completed uploads.')
          } finally { input.removeAttribute('data-frame-upload') }
        } else {
          rememberReference(file.name, payload.kind, 'uploaded')
          await persistPreparation()
        }
      }
      if (state.known) await showExistingReference(file.name)
      await confirmReference(file.name)
      if (!prepared.files.includes(file.name)) prepared.files.push(file.name)
      if (payload.kind === 'startFrame') prepared.startFrame = true
      rememberReference(file.name, payload.kind, 'attached')
      return { checkpoint: await persistPreparation() }
    }
    if (action === 'baseline' || action === 'armSubmit') {
      if (!prepared || prepared.url !== location.href || compact(promptText(promptEditor())) !== compact(prepared.prompt)) throw new Error('The prepared prompt changed; nothing was submitted.')
      for (const name of prepared.files) if (!attachmentPresent(name)) throw new Error('A prepared reference is no longer attached. Nothing was submitted.')
      if (prepared.checkpoint) reconcileReferenceSet(action === 'baseline')
      if (prepared.videoSettings) await checkSingleReelSettings()
      if (action === 'baseline') {
        if (prepared.files.length !== payload.references + (payload.startFrame ? 1 : 0) || prepared.startFrame !== payload.startFrame) throw new Error('The project reference count does not match the attached Flow references.')
        // A prior request may still occupy Flow's account/UI capacity. Wait
        // before marking this attempt as submitted; never guess or click twice.
        await wait(() => {
          const area = composer()
          const named = [...area.querySelectorAll('button[aria-label="Start generation"]')].filter(visible)
          const button = one(named.length ? named : controls(generatePattern, area), 'Generate')
          return !button.disabled && button.getAttribute('aria-disabled') !== 'true'
        }, 'Flow ready to accept the next generation request', 120000)
        return cards().map(item => item.id)
      }
      // Consume prepared state BEFORE the only click; a thrown click cannot retry.
      const area = composer()
      const named = [...area.querySelectorAll('button[aria-label="Start generation"]')].filter(visible)
      const submit = one(named.length ? named : controls(generatePattern, area), 'Generate')
      const existingIds = new Set(cards().map(item => item.id))
      const existingProgress = new Set(document.querySelectorAll('[role="progressbar"]'))
      // Consume before the single click, including when acknowledgement fails.
      if (submit.disabled || submit.getAttribute('aria-disabled') === 'true') throw new Error('Flow Start generation is disabled. Nothing was submitted.')
      const submitNonce=crypto.randomUUID()
      submission = { nonce: submitNonce, url: location.href, area, existingIds, existingProgress, armedAt: Date.now() }
      if (prepared.checkpoint && chrome.storage?.local) await chrome.storage.local.remove(preparationStorageKey(prepared.checkpoint.requestId)).catch(() => {})
      prepared = null
      return { nonce: submitNonce, title: document.title }
    }
    if (action === 'confirmSubmit') {
      if (!submission || submission.nonce !== payload.nonce || submission.url !== location.href || Date.now() - submission.armedAt > 90000) throw new Error('The native submit ticket is missing or expired. No click was made by result confirmation.')
      const {area,existingIds,existingProgress} = submission
      submission = null
      const deadline = Date.now() + 45000
      while (Date.now() < deadline) {
        await acceptUploadRightsDialog()
        const rejection = [...document.querySelectorAll('[role="alert"],.mat-mdc-snack-bar-label')].filter(visible).map(element => compact(element.textContent)).join(' ')
        if (/failed|unable|error|limit|not enough|too many|try again|maximum|couldn.t|cannot/i.test(rejection)) throw new Error(`Flow rejected submission: ${rejection.slice(0, 350)}. No automatic retry was made.`)
        const editors = [...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(visible)
        if (editors.length === 1 && !compact(promptText(editors[0]))) return { accepted: true, evidence: 'prompt-cleared' }
        if (cards().some(item => !existingIds.has(item.id))) return { accepted: true, evidence: 'new-generation-card' }
        if ([...document.querySelectorAll('[role="progressbar"]')].some(element => visible(element) && !area.contains(element) && !existingProgress.has(element))) return { accepted: true, evidence: 'generation-progress' }
        await new Promise(resolve => setTimeout(resolve, 150))
      }
      throw new Error('Flow did not acknowledge Start generation within 45 seconds. The click alone is not confirmation. Check the prepared prompt and any Flow warning; submission is uncertain. No automatic retry was made. Resume collection only checks for an existing result.')
    }
    if (action === 'results') {
      const failed=[...document.querySelectorAll('flow-grid-tile-container,[data-generation-id]')].find(tile=>{
        const before=failedBefore.get(`${location.href}:${compact(payload.prompt)}`)
        if(!before||before.has(tile))return false
        if(!visible(tile)||!/violat|polic(?:y|ies)|generation failed|could not generate|unable to generate/i.test(tile.textContent||''))return false
        const saved=tile.getAttribute('data-prompt')||tile.getAttribute('aria-label')||tile.querySelector('.prompt-text,[data-prompt]')?.textContent
        return compact(saved)===compact(payload.prompt)
      })
      if(failed)throw new Error(`Flow generation failed: ${compact(failed.textContent).slice(0,350)}. Other products can continue; this request is not automatically resubmitted.`)
      const results = [], observed = cards()
      const candidates = observed.filter(item => item.kind === payload.outputType && !payload.baseline.includes(item.id))
      let missingPrompt = 0, differentPrompt = 0
      for (const item of candidates.filter(item => item.ready)) {
        let prompt
        try { prompt = await resultPrompt(item) }
        catch (error) { if (/^Flow result prompt is not available yet\./.test(error.message)) { missingPrompt++; continue }; throw error }
        if (item.native ? prompt === compact(payload.prompt) : prompt.includes(compact(payload.prompt))) results.push({ id: item.id, selector: item.selector })
        else if (!prompt) missingPrompt++
        else differentPrompt++
      }
      const ready = candidates.filter(item => item.ready).length
      const diagnostic = `${candidates.length} new ${payload.outputType === 'reel' ? 'video' : 'image'} card(s), ${ready} ready, ${missingPrompt} without a readable full prompt, ${differentPrompt} with a different prompt.`
      return { results, diagnostic }
    }
    if (action === 'downloadOriginal') {
      const result = cards().find(item => item.id === payload.result?.id && item.ready && item.native)
      if (!result) throw new Error('The matching result is no longer available.')
      const card = one([...document.querySelectorAll(result.selector)], 'matched result')
      // These hotbar controls are intentionally revealed on hover in Flow.
      await closeStaleMenus()
      const more = one([...card.querySelectorAll('button[aria-label="More options"]')], 'result menu')
      more.click()
      await menuControl(/^download$/i, 'Download')
      await menuControl(/^(?:\d+(?:\.\d+)?[kp]\s*)?original size$/i, 'Original size download')
      return null
    }
    if (action === 'downloadLink') {
      // Resolve from currently observed IDs instead of trusting an arbitrary CSS
      // selector sent across the bridge.
      const result = cards().find(item => item.id === payload.result?.id && item.ready)
      if (!result) throw new Error('The matching result card is no longer visible.')
      const card = one([...document.querySelectorAll(result.selector)], 'matched result')
      if (result.native) return { mode: 'native-menu', title: card.getAttribute('aria-label') || '' }
      const link = one([...card.querySelectorAll('a[download][href]')], 'direct result download')
      const name = link.getAttribute('download') || new URL(link.href).pathname
      const extension = name.split('.').pop().toLowerCase()
      if (!/^(?:png|jpe?g|webp|mp4|mov|webm)$/.test(extension)) throw new Error('Flow does not expose a supported direct download in this interface. The existing generation is preserved.')
      return { url: link.href, extension }
    }
    throw new Error('Unsupported Flow page command.')
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || message.type !== 'frame-flow-command' || typeof message.id !== 'string') return false
    if (!seen.has(message.id)) {
      const operation = execute(message.action, message.payload || {}).then(value => ({ ok: true, value })).catch(error => {
        lastFailure = { action: message.action, stage: /^Flow (Add reference|Upload media|did not confirm)/.exec(error.message)?.[0] || 'Page action stopped' }
        return { ok: false, error: `${error.message}${['prepare', 'attach'].includes(message.action) ? ` [Companion ${ADAPTER_VERSION}; image inputs=${imageInputs().length}; picker inputs=${assetPicker() ? imageInputs(assetPicker()).length : 0}; asset picker=${!!assetPicker()}; detected controls: ${controlDiagnostics()}]` : ''}`.slice(0, 1450) }
      })
      seen.set(message.id, operation); if (seen.size > 200) seen.delete(seen.keys().next().value)
    }
    seen.get(message.id).then(reply)
    return true
  })
})()
