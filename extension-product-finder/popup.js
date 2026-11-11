document.querySelector('#version').textContent = `Frame Studio · ${chrome.runtime.getManifest().version}`
const productOrigins = { myntra: 'https://www.myntra.com/*', meesho: 'https://www.meesho.com/*', flipkart: 'https://www.flipkart.com/*', amazon: 'https://www.amazon.in/*', ajio: 'https://www.ajio.com/*' }
const siteNames = { myntra: 'Myntra', meesho: 'Meesho', flipkart: 'Flipkart', amazon: 'Amazon', ajio: 'AJIO' }
let missingOrigins = []
async function refreshPermissions() {
  const access = document.querySelector('#site-access'), allow = document.querySelector('#allow-sites')
  allow.disabled = true
  document.querySelector('#product-connect').disabled = true
  try {
    const entries = await Promise.all(Object.entries(productOrigins).map(async ([id, origin]) => ({ id, origin, granted: await chrome.permissions.contains({ origins: [origin] }) })))
    missingOrigins = entries.filter(entry => !entry.granted).map(entry => entry.origin)
    const granted = entries.filter(entry => entry.granted).map(entry => siteNames[entry.id])
    access.textContent = granted.length ? `Saved Chrome access: ${granted.join(', ')}. Store selection stays in Frame Studio.` : 'One-time setup: allow shopping-site access below, then connect with your pairing code.'
    allow.hidden = !missingOrigins.length
    allow.textContent = granted.length ? 'Allow remaining shopping sites' : 'Allow shopping sites once'
    allow.disabled = !missingOrigins.length
    document.querySelector('#product-connect').disabled = !granted.length
  } catch (error) { access.textContent = 'Could not check Chrome site access: ' + error.message }
}
document.querySelector('#allow-sites').addEventListener('click', async () => {
  const button = document.querySelector('#allow-sites'), status = document.querySelector('#product-status')
  if (!missingOrigins.length) return
  button.disabled = true
  try {
    // Only missing declared origins are requested, directly from this user click.
    const allowed = await chrome.permissions.request({ origins: [...missingOrigins] })
    status.textContent = allowed ? 'Chrome site access saved. Paste your code and connect; no store selection is needed here.' : 'New site access was not approved. Previously approved sites remain available.'
  } catch (error) { status.textContent = error.message }
  finally { await refreshPermissions() }
})
chrome.permissions.onAdded.addListener(() => { void refreshPermissions() })
chrome.permissions.onRemoved.addListener(() => { void refreshPermissions() })
void refreshPermissions()
let checkingConnection = false
async function refreshConnection() {
  if(checkingConnection) return
  checkingConnection = true
  try {
    const current = await chrome.runtime.sendMessage({ type: 'products:status' })
    document.querySelector('#connection-status').textContent = current?.connected ? (current.running ? 'Connected to Frame Studio. Collection is running; cancel it in the app before editing settings.' : 'Connected to Frame Studio now. Click Find my next post in the app.') : 'Not connected to Frame Studio now. Saved site permissions remain; create a fresh pairing code in the app and connect.'
    document.querySelector('#product-status').hidden = !current?.connected && document.querySelector('#product-status').textContent.startsWith('Chrome access paired.')
  } catch { document.querySelector('#connection-status').textContent = 'Connection status unavailable. Refresh this extension and pair again.' }
  finally { checkingConnection = false }
}
void refreshConnection()
const connectionTimer = setInterval(() => void refreshConnection(), 2000)
window.addEventListener('pagehide', () => clearInterval(connectionTimer), {once:true})

document.querySelector('#product-connect').addEventListener('click', async () => {
  const button = document.querySelector('#product-connect'), status = document.querySelector('#product-status')
  const code = document.querySelector('#product-code').value.trim()
  if (!/^\d{1,5}\.[0-9a-f]{64}$/.test(code)) { status.textContent = 'Paste a fresh Product Find pairing code from the app.'; return }
  button.disabled = true
  try {
    // Pairing never requests site permissions again. Chrome is the source of
    // truth; the worker reads existing grants, and the app selects stores.
    const result = await chrome.runtime.sendMessage({ type: 'products:connect', code })
    status.textContent = result?.ok ? '' : result?.message ?? 'Product Find could not connect.'
    await refreshConnection()
    if (result?.ok) document.querySelector('#product-code').value = ''
  } catch (error) { status.textContent = error.message } finally { button.disabled = false }
})

document.querySelector('#product-disconnect').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'products:disconnect' })
  document.querySelector('#product-status').textContent = result?.message ?? 'Product Find disconnected.'
})

document.querySelector('#refresh').addEventListener('click', async () => {
  const button = document.querySelector('#refresh'), status = document.querySelector('#product-status')
  button.disabled = true
  try {
    const result = await chrome.runtime.sendMessage({ type: 'products:refresh' })
    status.textContent = result?.message ?? 'Could not refresh. Try Reload in chrome://extensions.'
  } catch (error) { status.textContent = error.message }
  finally { button.disabled = false }
})
