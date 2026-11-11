import { readProductPage } from './product-page.js'

const origins = {
  myntra: 'https://www.myntra.com', meesho: 'https://www.meesho.com',
  flipkart: 'https://www.flipkart.com', amazon: 'https://www.amazon.in', ajio: 'https://www.ajio.com'
}
let socket, anchorWindow, permitted = [], paired = false
const jobs = new Map(), ownedTabs = new Map()
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function scope(url, store) {
  try { const u = new URL(url); return u.origin === origins[store] && !u.username && !u.password && !/\/(?:login|signin|ap\/signin|checkout|cart|my\/|account)/i.test(u.pathname) } catch { return false }
}
function detail(url, store) {
  if (!scope(url, store)) return false
  const path = new URL(url).pathname
  return store === 'myntra' ? /\/\d+\/buy\/?$/.test(path) : store === 'amazon' ? /\/(?:dp|gp\/product)\/[A-Z0-9]{10}(?:\/|$)/i.test(path) : /\/p\/[a-zA-Z0-9_-]+\/?$/.test(path)
}
function searchUrl(store, query) {
  const q = encodeURIComponent('women ' + query)
  // These are normal public search pages, not private catalogue/API endpoints.
  return ({ myntra: origins.myntra + '/' + encodeURIComponent(('women ' + query).replace(/\s+/g, '-')) + '?rawQuery=' + q,
    meesho: origins.meesho + '/search?q=' + q, flipkart: origins.flipkart + '/search?q=' + q,
    amazon: origins.amazon + '/s?k=' + q, ajio: origins.ajio + '/search/?text=' + q })[store]
}
async function read(tabId, store, signal, mode) {
  signal.throwIfAborted()
  const tab = await chrome.tabs.get(tabId)
  if (!scope(tab.url, store)) throw new Error('Retailer redirected outside the approved listing site or requested sign-in. Nothing was collected.')
  const result = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: readProductPage, args: [mode] })
  signal.throwIfAborted()
  if (result.length !== 1 || !scope(result[0].result?.url, store)) throw new Error('Retailer page identity could not be verified.')
  if (result[0].result.blocked) throw new Error(result[0].result.blocked)
  return result[0].result
}
async function collect(command, signal) {
  const { store, mode, query, url } = command
  if (!permitted.includes(store) || !origins[store] || !['search', 'details'].includes(mode)) throw new Error('Store access is not enabled in this Chrome connection.')
  if (!await chrome.permissions.contains({ origins: [origins[store] + '/*'] })) throw new Error('Chrome site permission was removed. Reconnect Product Find.')
  const target = mode === 'search' ? searchUrl(store, query) : url
  if (!scope(target, store) || mode === 'details' && !detail(target, store) || mode === 'search' && (typeof query !== 'string' || query.length > 300)) throw new Error('Invalid retailer request.')
  signal.throwIfAborted()
  const tab = await chrome.tabs.create({ windowId: anchorWindow, url: target, active: false })
  ownedTabs.set(tab.id, store)
  let succeeded = false
  try {
    const deadline = Date.now() + 48000
    let loaded = false
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      const current = await chrome.tabs.get(tab.id)
      // Read a committed retailer document without waiting for ads/analytics to
      // finish every network request. The reader below still waits for facts.
      if (!current.pendingUrl && scope(current.url, store)) { loaded = true; break }
      if (current.status === 'complete' && !current.pendingUrl && current.url && current.url !== 'about:blank' && !scope(current.url, store)) throw new Error('Chrome loaded a page outside the approved retailer listing site. No page facts were read.')
      await pause(250)
    }
    if (!loaded) throw new Error('Chrome navigation did not finish within 48 seconds. No retailer document was available to read.')
    let snapshot
    for (let attempt = 0; attempt < 24; attempt++) {
      snapshot = await read(tab.id, store, signal, mode)
      const pdp = snapshot.myntra
      const ready = pdp ? pdp.name && pdp.price && pdp.code && pdp.images.length : /"@type"\s*:\s*(?:"Product"|\[[^\]]*"Product")/.test(JSON.stringify(snapshot.schemas))
      if (mode === 'search' ? snapshot.links.length : ready) break
      await pause(500)
    }
    signal.throwIfAborted()
    succeeded = true
    return snapshot
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(`${store} ${mode} page failed: ${target}. ${error.message}. The failed collection tab was left open for manual inspection; no automatic retry or access bypass.`)
  } finally {
    // Never close a pre-existing tab, or a collection tab the owner navigated elsewhere.
    try { const current = await chrome.tabs.get(tab.id); if ((succeeded || signal.aborted) && scope(current.url, store)) await chrome.tabs.remove(tab.id) } catch { /* Tab may have been closed by its owner. */ }
    ownedTabs.delete(tab.id)
  }
}
function detach() {
  for (const job of jobs.values()) job.abort()
  socket?.close(); socket = undefined; permitted = []; paired = false
}
chrome.permissions.onRemoved.addListener(removed => { if (removed.origins?.some(origin => Object.values(origins).some(value => origin === value + '/*'))) detach() })
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || typeof message.type !== 'string' || !message.type.startsWith('products:')) return false
  if (message.type === 'products:status') {
    if (sender.url !== chrome.runtime.getURL('popup.html')) return false
    reply({ connected: paired && socket?.readyState === WebSocket.OPEN, running: jobs.size > 0 })
    return false
  }
  if (message.type === 'products:refresh') {
    if (sender.url !== chrome.runtime.getURL('popup.html')) return false
    if (jobs.size) { reply({ ok: false, message: 'Finish or cancel the active collection in Frame Studio before refreshing.' }); return false }
    detach()
    reply({ ok: true, message: 'Refreshing Product Finder. Pair a fresh Product Find code afterward.' })
    setTimeout(() => chrome.runtime.reload(), 150)
    return false
  }
  if (message.type === 'products:disconnect') { detach(); reply({ ok: true, message: 'Product Find disconnected. Flow and your shopping accounts were not changed.' }); return false }
  if (message.type !== 'products:connect') return false
  ;(async () => {
    if (jobs.size) throw new Error('Product collection is still stopping. Wait before reconnecting.')
    const match = /^(\d{1,5})\.([0-9a-f]{64})$/.exec(message.code ?? '')
    if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535) throw new Error('Create and paste a fresh Product Find pairing code.')
    const grants = await Promise.all(Object.entries(origins).map(async ([store, origin]) => await chrome.permissions.contains({ origins: [origin + '/*'] }) ? store : null))
    const stores = grants.filter(store => store !== null)
    if (!stores.length) throw new Error('Allow shopping sites once in Product Finder. Pairing uses those saved Chrome permissions; stores are selected only in Frame Studio.')
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab || !Number.isInteger(tab.windowId)) throw new Error('Open a normal Chrome window first.')
    detach(); permitted = stores; anchorWindow = tab.windowId
    const ws = socket = new WebSocket(`ws://127.0.0.1:${match[1]}/product-browser`)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('App did not accept the Product Find pairing code.')) }, 10000)
      ws.onopen = () => ws.send(JSON.stringify({ type: 'pair', token: match[2], stores, version: 'products-2' }))
      ws.onerror = () => { clearTimeout(timer); reject(new Error('Frame Studio is not listening. Create a new Product Find code.')) }
      ws.onmessage = event => {
        let command
        try { command = JSON.parse(event.data) } catch { ws.close(); return }
        if (command.type === 'paired') { clearTimeout(timer); if(socket === ws)paired = true; resolve(); return }
        if (command.type === 'pair-error') { clearTimeout(timer); reject(new Error(command.error || 'Reload Product Finder from the current app folder.')); ws.close(); return }
        if (command.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return }
        if (command.type === 'cancel') { jobs.get(command.id)?.abort(); return }
        if (command.type !== 'collect' || typeof command.id !== 'string' || command.id.length > 64 || jobs.has(command.id) || jobs.size >= 3) return
        const controller = new AbortController(); jobs.set(command.id, controller)
        void (async () => {
          let response
          try { response = { type: 'reply', id: command.id, ok: true, value: await collect(command, controller.signal) } }
          catch (error) { response = { type: 'reply', id: command.id, ok: false, error: controller.signal.aborted ? 'Chrome collection cancelled; its worker and tab have settled.' : error.message } }
          finally { jobs.delete(command.id) }
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response))
        })()
      }
      ws.onclose = () => { clearTimeout(timer); if (socket === ws) { socket = undefined; permitted = []; paired = false; for (const job of jobs.values()) job.abort() }; reject(new Error('Product Find connection closed. Pair again in Settings.')) }
    })
    return { ok: true, message: 'Connected. Click Find my next post in Frame Studio.' }
  })().then(reply).catch(error => reply({ ok: false, message: error.message }))
  return true
})
