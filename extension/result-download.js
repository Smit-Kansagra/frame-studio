// Capture only the native download initiated by the selected result's UI.
// No history enumeration, credential access, preview URL fetch, or upscaling.
export function safeMediaUrl(value, origin) {
  try {
    const url = new URL(value)
    return !url.username && !url.password && !url.port &&
      ((url.protocol === 'blob:' && url.origin === origin) ||
       (url.protocol === 'https:' && (['flow.google.com', 'flow-content.google', 'labs.google', 'storage.googleapis.com'].includes(url.hostname) || url.hostname.endsWith('.googleusercontent.com') || url.hostname.endsWith('.storage.googleapis.com'))))
  } catch { return false }
}
export function matchesOriginalName(filename, title, mediaId) {
  if (typeof title !== 'string' || !title.trim() || title.length > 500) return false
  const base = String(filename || '').split(/[\\/]/).pop()
  // Flow uses either <title>_<timestamp> or <title>_<first 8 media-ID
  // characters>. The latter must identify this exact selected result; a title
  // alone can be shared by several products/projects and is not sufficient.
  const match = /^(.*?)_(\d{14}|[0-9a-f]{8})(?: \(\d+\))?\.(?:png|jpe?g|webp|mp4|mov|webm)$/i.exec(base)
  const canonical = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  if (!match || !canonical(title)) return false
  const stem=canonical(match[1]),full=canonical(title)
  if(match[2].length===14)return stem===full
  // Flow truncates long download titles, but retains this selected media's ID.
  // Timestamp-only names still require the complete title above.
  return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(mediaId || '') && match[2].toLowerCase()===mediaId.slice(0,8).toLowerCase() &&
    (stem===full || stem.length>=16 && full.startsWith(stem))
}
export async function existingOriginal(api,{projectUrl,mediaId,title}){
  if(!/^[0-9a-f-]{36}$/i.test(mediaId)||typeof api.search!=='function')return
  // Query this result suffix only, never enumerate the user's download history.
  const items=await api.search({filenameRegex:`_${mediaId.slice(0,8)}( \\(\\d+\\))?\\.(png|jpe?g|webp|mp4|mov|webm)$`,orderBy:['-startTime']})
  const origin=new URL(projectUrl).origin
  return items.find(item=>{
    if(!item)return false
    if(item.danger&&!['safe','accepted','allowlistedByPolicy','deepScannedSafe'].includes(item.danger))return false
    if([item.url,item.finalUrl].some(value=>{try{const id=/\/(?:image|video)\/([0-9a-f-]{36})$/i.exec(new URL(value).pathname)?.[1];return id&&id!==mediaId}catch{return false}}))return false
    const referrer=item.referrer?.split('#')[0]
    return item.state==='complete'&&item.exists!==false&&matchesOriginalName(item.filename,title,mediaId)&&safeMediaUrl(item.finalUrl||item.url,origin)&&
      (!referrer||referrer===origin||referrer===`${origin}/`||referrer===projectUrl.split('#')[0])
  })
}
export async function captureOriginal(api, { projectUrl, mediaId, nonce, title }, trigger) {
  const origin = new URL(projectUrl).origin
  let captured, duplicate = false, resolveItem, rejectItem
  const found = new Promise((resolve, reject) => { resolveItem = resolve; rejectItem = reject })
  // A rejection may precede trigger completion; attach a handler immediately.
  found.catch(() => {})
  const started = Date.now()
  const listener = (item, suggest) => {
    const referrer = item.referrer?.split('#')[0]
    const sameProject = referrer === projectUrl.split('#')[0]
    const identifiesMedia = [item.url, item.finalUrl].some(value => value?.includes(mediaId))
    const otherMedia = [item.url, item.finalUrl].some(value => {
      try { const id = /\/(?:image|video)\/([0-9a-f-]{36})$/i.exec(new URL(value).pathname)?.[1]; return id && id !== mediaId } catch { return false }
    })
    // Native blob downloads can omit the referrer and asset ID. In that case
    // require the exact result title/timestamp filename, approved media origin,
    // and this command's narrow time window. Never accept another project URL.
    const originOnly = !referrer || referrer === origin || referrer === `${origin}/`
    const namedOriginal = originOnly && matchesOriginalName(item.filename, title, mediaId)
    const recent = Date.parse(item.startTime) >= started - 1000
    if (!recent || otherMedia || (!sameProject && !identifiesMedia && !namedOriginal) || !safeMediaUrl(item.finalUrl || item.url, origin)) { suggest(); return }
    const extension = /\.(png|jpe?g|webp|mp4|mov|webm)$/i.exec(item.filename)?.[1]?.toLowerCase()
    if (!extension) { suggest(); rejectItem(new Error('Flow original download has an unsupported file format.')); return }
    if (captured) { duplicate = true; suggest(); rejectItem(new Error('Multiple Flow downloads were detected. Wait for them to finish, then resume collection.')); return }
    captured = item.id
    suggest({ filename: `Frame Studio/${nonce}.${extension}`, conflictAction: 'uniquify' })
    resolveItem(item.id)
  }
  api.onDeterminingFilename.addListener(listener)
  const timeout = setTimeout(() => rejectItem(new Error('Flow original download could not be associated with this result. Resume collection; no new generation is needed.')), 60000)
  return {
    // Start listening before any page click. Keep the listener through completion
    // to detect ambiguous concurrent downloads from the same project.
    run: async () => {
      try { await trigger(); const id = await found; if (duplicate) throw new Error('Ambiguous Flow download. Resume collection.'); return id }
      catch (error) { api.onDeterminingFilename.removeListener(listener); throw error }
      finally { clearTimeout(timeout) }
    },
    assertUnique: () => { if (duplicate) throw new Error('Multiple Flow downloads were detected. Resume collection after they finish.') },
    dispose: () => { clearTimeout(timeout); api.onDeterminingFilename.removeListener(listener) },
  }
}
