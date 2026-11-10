document.querySelector('#version').textContent = `Frame Studio · ${chrome.runtime.getManifest().version}`
const productOrigins = { myntra: 'https://www.myntra.com/*', meesho: 'https://www.meesho.com/*', flipkart: 'https://www.flipkart.com/*', amazon: 'https://www.amazon.in/*', ajio: 'https://www.ajio.com/*' }

document.querySelector('#product-connect').addEventListener('click', async () => {
  const button = document.querySelector('#product-connect'), status = document.querySelector('#product-status')
  const stores = [...document.querySelectorAll('#product-stores input:checked')].map(input => input.value)
  if (!stores.length) { status.textContent = 'Select at least one shopping site.'; return }
  const code = document.querySelector('#product-code').value.trim()
  if (!/^\d{1,5}\.[0-9a-f]{64}$/.test(code)) { status.textContent = 'Paste a fresh Product Find pairing code from the app.'; return }
  button.disabled = true
  try {
    // Request only the selected sites, directly inside this explicit user gesture.
    const allowed = await chrome.permissions.request({ origins: stores.map(id => productOrigins[id]) })
    if (!allowed) throw new Error('Chrome site access was not allowed. No retailer collection started.')
    const result = await chrome.runtime.sendMessage({ type: 'products:connect', code, stores })
    status.textContent = result?.message ?? 'Product Find could not connect.'
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
