// Runs in Chrome's isolated world on the explicitly selected Flow tab only.
// Reads/writes visible UI. Never calls Google APIs or accesses session cookies.
(() => {
  if (globalThis.__frameStudioCompanion) return
  globalThis.__frameStudioCompanion = true
  const ADAPTER_VERSION = '0.1.6-fast.22'
  const seen = new Map()
  let prepared = null
  let submission = null
  let lastFailure = null
  let referenceCheck = null
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
  async function applyRatio(target, root) {
    const actual = sourceRatio(target, root)
    await setting(/aspect ratio|orientation/i, actual, new RegExp(`^(?:.*\\s)?${actual.replaceAll('.', '\\.').replaceAll(':', ':')}(?:\\s.*)?$`), root)
    return actual
  }
  const one = (items, name) => { if (items.length !== 1) throw new Error(`Flow ${name}: expected one supported control, found ${items.length}. Paused without guessing.`); return items[0] }
  const click = (element, name) => { if (element.disabled || element.getAttribute('aria-disabled') === 'true') throw new Error(`Flow ${name} is disabled. Nothing was submitted.`); element.click() }
  const wait = async (test, description, timeout = 15000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) { const value = test(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 150)) }
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
    return [...area.querySelectorAll('img,[aria-label],[title],[data-filename]')].some(element => {
      if (!visible(element) || element.closest('[role="dialog"],[role="menu"],[role="listbox"]')) return false
      if (element.closest('[aria-busy="true"],[role="progressbar"]') || element.closest('[role="group"]')?.querySelector('[role="progressbar"]')) return false
      const named = [element.getAttribute('alt'), element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('data-filename')].includes(name)
      const identity = expected && element instanceof HTMLImageElement && mediaKey(element) === expected &&
        element.closest('button[aria-label="Ingredient"][aria-busy="false"]')
      // The real uploader inserts role=group aria-label=<filename> while its
      // progress is 0%. That placeholder is not an attached image.
      return (named && element instanceof HTMLImageElement) || !!identity
    })
  }
  function mediaKey(image) {
    const id = image.getAttribute('data-media-id')
    if (/^[0-9a-f-]{36}$/i.test(id || '')) return `https://flow-content.google/image/${id}`
    try {
      const url = new URL(image.currentSrc || image.src, location.href)
      // The live picker and composer use the same immutable asset ID but the
      // signed URL query can change. Do not infer identity from generic alt text.
      if (url.protocol === 'https:' && url.hostname === 'flow-content.google' && /^\/image\/[0-9a-f-]{36}$/i.test(url.pathname)) return url.origin + url.pathname
    } catch {}
    return null
  }
  function referenceCards(name, picker) {
    if (!picker) return []
    const cards = [...picker.querySelectorAll('[role="option"]')].filter(card => visible(card) &&
      [...card.querySelectorAll('.asset-title')].some(title => compact(title.textContent) === name))
    // Also retain the previous explicit metadata contract, deduplicating the
    // interactive card when both its title and thumbnail expose the filename.
    for (const named of picker.querySelectorAll('img,[aria-label],[title],[data-filename]')) {
      if (!visible(named) || ![named.getAttribute('alt'),named.getAttribute('aria-label'),named.getAttribute('title'),named.getAttribute('data-filename')].includes(name)) continue
      const card = named.closest('button,[role="button"],[role="option"],[role="gridcell"],[tabindex="0"]')
      if (card && picker.contains(card)) cards.push(card)
    }
    return [...new Set(cards)]
  }
  function libraryReference(name) {
    const matches = [...document.querySelectorAll('flow-grid-tile-container')].filter(tile => visible(tile) && tile.getAttribute('aria-label') === name)
    if (matches.length > 1) throw new Error('Multiple Flow library assets share this reference filename. Nothing was selected or uploaded.')
    const tile = matches[0]
    if (!tile || tile.querySelector('[role="progressbar"],[aria-busy="true"]')) return null
    const image = tile.querySelector('img'), key = image && mediaKey(image)
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
    return [...root.querySelectorAll('input[type="file"]')].filter(input => !input.disabled && (!input.accept || /image|\.png|\.jpe?g|\.webp/i.test(input.accept)))
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
  async function confirmReference(name) {
    await wait(() => libraryReference(name) || referenceCards(name, assetPicker()).length || attachmentPresent(name), `uploaded photo processed and available: ${name}`, 240000)
    const library = libraryReference(name)
    if (library) {
      prepared.assets.set(name, library.key)
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
      const more = one([...current.tile.querySelectorAll('button[aria-label="More options"]')], 'reference menu')
      more.click()
      await menuControl(/^add to prompt$/i, 'Add to prompt')
      await wait(() => attachmentPresent(name), `photo processing finished and attached in prompt: ${name}`, 240000)
      referenceCheck.phase = 'complete'
      return
    }
    let selectionMade = false, confirmationMade = false
    const ingredientKeys=()=>[...new Set([...composer().querySelectorAll('button[aria-label="Ingredient"][aria-busy="false"] img')].filter(visible).map(mediaKey).filter(Boolean))]
    const before=new Set(ingredientKeys())
    referenceCheck={phase:'waiting',titleMatches:0,stableKeys:0,selected:false,assetRecorded:false}
    await wait(() => {
      if(selectionMade){
        const added=ingredientKeys().filter(key=>!before.has(key))
        referenceCheck.newCompleted=added.length
        // The exact filename option was selected by this command. Associate
        // it with the single new completed chip, not a transient/recycled
        // thumbnail which can still show the preceding asset's URL.
        if(added.length===1){prepared.assets.set(name,added[0]);referenceCheck.assetRecorded=true}
        if(added.length>1) throw new Error('More than one new Flow ingredient appeared after selecting the reference. Paused without guessing.')
      }
      if (attachmentPresent(name)) {referenceCheck.phase='complete';return true}
      const picker = assetPicker()
      if (!picker) {referenceCheck.phase='waiting-for-completed-chip';return false}
      const cards = referenceCards(name, picker)
      referenceCheck.titleMatches=cards.length
      if (!selectionMade && cards.length === 1) {
        if (cards[0].querySelector('[role="progressbar"]') || /^Uploading\b/i.test(label(cards[0]))) return false
        const keys = [...new Set([...cards[0].querySelectorAll('img')].map(mediaKey).filter(Boolean))]
        referenceCheck.stableKeys=keys.length
        referenceCheck.selected=true;referenceCheck.phase='waiting-for-completed-chip'
        click(cards[0], 'select uploaded reference'); selectionMade = true; return false
      }
      if (selectionMade && !confirmationMade) {
        const confirm = controls(/^(?:add(?: to prompt)?|attach|insert|use selected|add selected|done)$/i, picker)
        if (confirm.length === 1 && !confirm[0].disabled && confirm[0].getAttribute('aria-disabled') !== 'true') { click(confirm[0], 'attach selected reference'); confirmationMade = true }
      }
      return false
    }, `photo processing finished and attached in prompt: ${name}`, 240000)
  }
  async function option(pattern, name) { const control = await wait(() => { const items = controls(pattern); return items.length === 1 ? items[0] : null }, name); click(control, name) }
  async function setting(name, value, pattern, root = document) {
    const selects = [...root.querySelectorAll('select,[role="combobox"]')].filter(element => visible(element) && name.test(label(element)))
    if (selects.length === 1) {
      const field = selects[0]
      if (field instanceof HTMLSelectElement) {
        const match = [...field.options].filter(item => compact(item.textContent) === value || pattern.test(compact(item.textContent)))
        const selected = one(match, value)
        field.value = selected.value; field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true }))
        if (field.value !== selected.value) throw new Error(`Flow did not retain ${value}.`)
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
    const actualRatio = await applyRatio(ratio, panel)
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
    return actualRatio
  }
  function cards() {
    const result = new Map()
    for (const element of document.querySelectorAll('flow-grid-tile-container,[data-asset-id],[data-generation-id],article,[role="listitem"]')) {
      if (!visible(element)) continue
      const video = element.querySelector('video'), img = element.querySelector('img')
      if (!video && !img) continue
      if (element.matches('flow-grid-tile-container')) {
        const media = element.querySelector('[data-media-id]')
        const id = media?.getAttribute('data-media-id')
        if (!id || !element.querySelector('button[aria-label="Reuse prompt"]')) continue
        const busy = element.querySelector('[role="progressbar"],[aria-busy="true"]')
        result.set(id, { id, selector: `flow-grid-tile-container:has([data-media-id="${CSS.escape(id)}"])`, kind: video ? 'reel' : 'post', native: true,
          ready: !busy && (video ? video.readyState >= 2 : img.complete && img.naturalWidth > 0) })
        continue
      }
      const attr = element.hasAttribute('data-asset-id') ? 'data-asset-id' : element.hasAttribute('data-generation-id') ? 'data-generation-id' : null
      const link = element.querySelector('a[href*="/asset/"]')
      const id = attr ? element.getAttribute(attr) : link?.getAttribute('href')
      if (!id) continue
      const selector = attr ? `[${attr}="${CSS.escape(id)}"]` : `article:has(a[href="${CSS.escape(id)}"]),[role="listitem"]:has(a[href="${CSS.escape(id)}"])`
      result.set(id, { id, selector, prompt: compact(element.getAttribute('data-prompt') || element.innerText), kind: video ? 'reel' : 'post', ready: !!element.querySelector('a[download],button[aria-label*="download" i]') && !/generating|queued|processing/i.test(element.innerText) })
    }
    return [...result.values()]
  }
  const resultPrompts = new Map()
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
    const footer = one([...card.querySelectorAll('button.footer-left')], 'result information')
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
      prepared = null
      submission = null
      await wait(() => {
        try { return !!promptEditor() } catch { return false }
      }, 'project prompt editor ready', 25000)
      const ratio = { 'post-square': '1:1', 'post-portrait': '4:5', 'post-tall': '3:4', 'post-landscape': '1.91:1', 'post-story': '9:16', 'reel-vertical': '9:16', 'reel-landscape': '16:9' }[payload.preset]
      if (!ratio) throw new Error('Invalid export preset.')
      let actualRatio = ratio
      if (generationSummary().length || controls(/^agent$/i).length) actualRatio = await configureGeneration(payload, ratio)
      else {
        await option(payload.outputType === 'post' ? /^image$/i : /^video$/i, 'output mode')
        if (payload.outputType === 'reel') await option(payload.continuation ? /^frames$/i : /^ingredients$/i, 'video reference mode')
        actualRatio = await applyRatio(ratio, document)
        await setting(/outputs|results per prompt|number of images|number of videos/i, String(payload.outputs), new RegExp(`^(?:x\\s*)?${payload.outputs}(?:\\s*(?:outputs?|images?|videos?))?$`, 'i'))
        if (payload.outputType === 'reel') await setting(/duration|length/i, `${payload.sourceDuration}s`, new RegExp(`^${payload.sourceDuration}\\s*(?:s|seconds?)$`, 'i'))
      }
      const editor = promptEditor(), area = composer()
      const remove = () => [...new Set([
        ...controls(/^remove(?: reference| image| attachment)?(?:\s.*)?$/i, area),
        ...[...area.querySelectorAll('button[aria-label="Ingredient"]')].filter(button => visible(button) &&
          [...button.querySelectorAll('mat-icon')].some(icon => /^cancel$/i.test(compact(icon.textContent)))),
      ])]
      for (let i = 0; remove().length && i < 60; i++) { click(remove()[0], 'remove old prompt attachment'); await new Promise(resolve => setTimeout(resolve, 100)) }
      if (remove().length) throw new Error('Old prompt attachments could not be cleared safely.')
      const editNonce=crypto.randomUUID();editor.setAttribute('data-frame-edit',editNonce)
      try {
        const edit=await chrome.runtime.sendMessage({type:'frame-flow-edit-prompt',nonce:editNonce,prompt:payload.prompt})
        if(!edit?.ok || edit.value?.retained!==true) throw new Error(edit?.error || 'Flow did not confirm prompt editing. Nothing was submitted.')
      } finally {editor.removeAttribute('data-frame-edit')}
      if (compact(promptText(editor)) !== compact(payload.prompt)) throw new Error('The complete prompt was not retained in Flow.')
      prepared = { url: location.href, prompt: payload.prompt, files: [], startFrame: false, assets: new Map() }
      return { sourceRatio: actualRatio, targetRatio: ratio, automaticCrop: actualRatio !== ratio }
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
    if (action === 'attach') {
      if (!prepared || prepared.url !== location.href) throw new Error('Prepare this project before attaching files.')
      const file = payload.file
      if (!file || typeof file.name !== 'string' || file.name.length > 200 || /[\\/]/.test(file.name) || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || typeof file.base64 !== 'string' || file.base64.length > 28_000_000) throw new Error('Invalid reference image payload.')
      const area = composer()
      if (payload.kind === 'startFrame') click(one(controls(/^(?:\+\s*)?add start frame$/i, area), 'Add start frame'), 'Add start frame')
      const input = await openReferenceInput(area, file.name)
      if (input) {
        const nonce=crypto.randomUUID()
        input.setAttribute('data-frame-upload',nonce)
        try {
          const result=await chrome.runtime.sendMessage({type:'frame-flow-main-upload',nonce,file})
          if(!result?.ok || result.value?.assigned!==true) throw new Error(result?.error || 'The Flow page-context upload could not be confirmed.')
        } finally {input.removeAttribute('data-frame-upload')}
      }
      await confirmReference(file.name)
      prepared.files.push(file.name); if (payload.kind === 'startFrame') prepared.startFrame = true
      return null
    }
    if (action === 'baseline' || action === 'armSubmit') {
      if (!prepared || prepared.url !== location.href || compact(promptText(promptEditor())) !== compact(prepared.prompt)) throw new Error('The prepared prompt changed; nothing was submitted.')
      for (const name of prepared.files) if (!attachmentPresent(name)) throw new Error('A prepared reference is no longer attached. Nothing was submitted.')
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
      prepared = null
      return { nonce: submitNonce, title: document.title }
    }
    if (action === 'confirmSubmit') {
      if (!submission || submission.nonce !== payload.nonce || submission.url !== location.href || Date.now() - submission.armedAt > 90000) throw new Error('The native submit ticket is missing or expired. No click was made by result confirmation.')
      const {area,existingIds,existingProgress} = submission
      submission = null
      const deadline = Date.now() + 45000
      while (Date.now() < deadline) {
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
      const results = []
      for (const item of cards().filter(item => item.ready && item.kind === payload.outputType && !payload.baseline.includes(item.id))) {
        let prompt
        try { prompt = await resultPrompt(item) }
        catch (error) { if (/^Flow result prompt is not available yet\./.test(error.message)) continue; throw error }
        if (item.native ? prompt === compact(payload.prompt) : prompt.includes(compact(payload.prompt))) results.push({ id: item.id, selector: item.selector })
      }
      return results
    }
    if (action === 'downloadOriginal') {
      const result = cards().find(item => item.id === payload.result?.id && item.ready && item.native)
      if (!result) throw new Error('The matching result is no longer available.')
      const card = one([...document.querySelectorAll(result.selector)], 'matched result')
      // These hotbar controls are intentionally revealed on hover in Flow.
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
