const status = document.querySelector('#status')
document.querySelector('#version').textContent = `Flow Companion ${chrome.runtime.getManifest().version_name || chrome.runtime.getManifest().version}`
document.querySelector('#connect').addEventListener('click', async () => {
  const button = document.querySelector('#connect'); button.disabled = true
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const result = await chrome.runtime.sendMessage({ type: 'connect', tabId: tab?.id, code: document.querySelector('#code').value.trim() })
    status.textContent = result?.message || 'Could not connect.'
    if (result?.ok) { document.querySelector('#code').value = ''; window.close() }
  } catch (error) { status.textContent = error.message } finally { button.disabled = false }
})
document.querySelector('#disconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'disconnect' }); status.textContent = 'Disconnected. Google login and tabs were not changed.'
})

document.querySelector('#diagnostic').addEventListener('click', async () => {
  const button = document.querySelector('#diagnostic'); button.disabled = true
  try {
    const result = await chrome.runtime.sendMessage({ type: 'upload-diagnostic' })
    status.textContent = result?.message || 'Could not save diagnostic.'
  } catch (error) { status.textContent = error.message } finally { button.disabled = false }
})
