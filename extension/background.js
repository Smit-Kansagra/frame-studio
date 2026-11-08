import { uploadInPage } from './upload-main.js'
import { editPromptInPage } from './editor-main.js'
import { captureOriginal, safeMediaUrl, existingOriginal } from './result-download.js'
import { ProjectTabs, retryTabEdit } from './project-tabs.js'
// No credentials, private service endpoints, arbitrary script execution, or
// external messages. Each connection is explicitly paired from the action popup.
let socket, tabId, selectedOrigin, anchorWindowId, running = false
const completed = new Map()
const inFlight = new Map()
const projectLanes = new Map()
const tabLanes = new Map()
const nativeDownloads = new Map()
const activeContexts = new Map()
// Project creation and every tab command retain their own immutable context.
// Slow uploads never hold another project's lane. Replayed IDs share one action.
function inLane(lanes, key, action) {
  const previous = lanes.get(key) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(action)
  lanes.set(key, current)
  void current.finally(() => { if (lanes.get(key) === current) lanes.delete(key) }).catch(() => {})
  return current
}
const hasWork = () => running || inFlight.size > 0
// Retain IDs through reconnects. Retrying collection observes the same download
// rather than clicking Original size again while the first one is still running.
const resultDownloads = new Map()
function allowed(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && (u.hostname === 'flow.google.com' || (u.hostname === 'labs.google' && /^\/fx\/(?:[a-z-]+\/)?tools\/flow(?:\/|$)/i.test(u.pathname))) } catch { return false }
}
const projectTabs = new ProjectTabs(chrome, allowed)
const activeTabId = context => context?.tabId ?? tabId
function detach() { socket?.close(); socket = undefined; tabId = undefined; selectedOrigin = undefined; completed.clear(); chrome.action.setBadgeText({ text: '' }) }
async function selectedTab(context) {
  if (context) return projectTabs.verify(context, context.url)
  if (!Number.isInteger(tabId)) { await projectTabs.load(); for(const record of projectTabs.records.values()) { if(record.origin!==selectedOrigin || !Number.isInteger(record.tabId)) continue;try{const candidate=await chrome.tabs.get(record.tabId);if(allowed(candidate.url)&&new URL(candidate.url).origin===selectedOrigin){tabId=record.tabId;break}}catch{} } }
  if (!Number.isInteger(tabId)) throw new Error('No Flow tab has been explicitly connected.')
  const tab = await chrome.tabs.get(tabId)
  if (!allowed(tab.url) || new URL(tab.url).origin !== selectedOrigin) { detach(); throw new Error('Selected tab left the approved Flow origin. Reconnect from the extension action; no login page is controlled.') }
  return tab
}
async function pageAction(action, payload, id, context) {
  await selectedTab(context)
  await chrome.scripting.executeScript({ target: { tabId: activeTabId(context) }, files: ['content.js'], world: 'ISOLATED' })
  const result = await chrome.tabs.sendMessage(activeTabId(context), { type: 'frame-flow-command', id, action, payload })
  if (!result?.ok) throw new Error(result?.error || 'The Flow page did not confirm the action.')
  return result.value
}
async function navigate(url) {
  const current = await selectedTab()
  if (!allowed(url) || new URL(url).origin !== selectedOrigin) throw new Error('Cross-origin navigation requires reconnecting the extension on that Flow page.')
  if (current.url === url) return
  await retryTabEdit(()=>chrome.tabs.update(activeTabId(), { url }))
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const tab = await selectedTab()
    if (tab.status === 'complete' && tab.url === url) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('Flow navigation did not finish. Nothing was submitted.')
}
async function download(payload, id, context, originalLink) {
  if (!/^[0-9a-f-]{36}$/.test(payload.nonce)) throw new Error('Invalid local download request.')
  const key = `${payload.url}:${payload.result.id}:${payload.nonce}`
  let capture, downloadId = resultDownloads.get(key)?.id
  const native = resultDownloads.get(key)?.native
  if (!downloadId) {
  const link = originalLink ?? await pageAction('downloadLink', payload, id, context)
  if (link.mode === 'native-menu') {
    // Some native downloads omit media IDs. Keep their filename capture windows
    // separate without blocking uploads, result checks or direct URL downloads.
    if(!originalLink)return inLane(nativeDownloads,'original',()=>download(payload,id,context,link))
    const existing=await existingOriginal(chrome.downloads,{projectUrl:payload.url,mediaId:payload.result.id,title:link.title})
    if(existing)return {filename:existing.filename,originalMediaId:payload.result.id,originalTitle:link.title}
    capture = await captureOriginal(chrome.downloads, {projectUrl:payload.url, mediaId:payload.result.id, nonce:payload.nonce, title:link.title},
      () => pageAction('downloadOriginal', payload, `${id}:original`, context))
    downloadId = await capture.run()
  } else {
    if (!safeMediaUrl(link.url, context?.origin ?? selectedOrigin)) throw new Error('The visible result download is not a supported Google media URL.')
    if (!/^(?:png|jpe?g|webp|mp4|mov|webm)$/.test(link.extension)) throw new Error('The visible download has an unsupported format.')
    downloadId = await chrome.downloads.download({ url: link.url, filename: `Frame Studio/${payload.nonce}.${link.extension}`, saveAs: false, conflictAction: 'uniquify' })
  }
  resultDownloads.set(key, { id: downloadId, native: link.mode === 'native-menu' })
  }
  try {
  const deadline = Date.now() + 150000
  while (Date.now() < deadline) {
    // Query ONLY the download created above, never global download history.
    const [item] = await chrome.downloads.search({ id: downloadId })
    capture?.assertUnique()
    if (!item || (!capture && !native && !resultDownloads.get(key)?.native && item.byExtensionId !== chrome.runtime.id)) throw new Error('Download association was lost; use manual import.')
    if (item.danger && !['safe', 'accepted', 'allowlistedByPolicy', 'deepScannedSafe'].includes(item.danger)) throw new Error('Chrome is checking or blocking this download. Review the browser warning yourself; no safety warning is bypassed.')
    if (item.state === 'complete') { await selectedTab(context);return { filename: item.filename } }
    if (item.state === 'interrupted') throw new Error('Chrome interrupted the result download. The generation is preserved.')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('Result download is still pending in Chrome. Resume collection after it finishes.')
  } finally { capture?.dispose() }
}
async function execute(command) {
  const { action, payload = {}, id } = command
  const context=command.projectId ? await projectTabs.select(command.projectId,action,payload.url,selectedOrigin,anchorWindowId) : undefined
  const tab=await selectedTab(context)
  return inLane(tabLanes, tab.id, async () => {
  activeContexts.set(tab.id, context ?? {tabId:tab.id, origin:new URL(tab.url).origin})
  try {
  await selectedTab(context)
  if (action === 'show') { const tab = await selectedTab(context); await chrome.windows.update(tab.windowId, { focused: true }); await retryTabEdit(()=>chrome.tabs.update(activeTabId(context), { active: true })); return null }
  if (action === 'createProject') {
    const origin=context?.origin ?? selectedOrigin
    const home = origin === 'https://flow.google.com' ? `${origin}/` : 'https://labs.google/fx/tools/flow'
    if(context) {const tab=await selectedTab(context);if(tab.url!==home)throw new Error('New project tab is not on the Flow homepage. No project was created.')}
    else await navigate(home)
    await pageAction('createProject', {}, id, context)
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) { const tab = await selectedTab(context); if (/\/project\/[a-zA-Z0-9_-]+/.test(new URL(tab.url).pathname)) { if(context)await projectTabs.created(context,tab.url);return { url: tab.url } }; await new Promise(resolve => setTimeout(resolve, 250)) }
    throw new Error('Project creation may have completed but its link was not confirmed. Do not create another automatically.')
  }
  if (!context && ['prepare', 'results', 'download', 'armSubmit', 'nameProject'].includes(action)) await navigate(payload.url)
  if (['armSubmit','nameProject'].includes(action)) { const tab = await selectedTab(context); await retryTabEdit(async()=>{await selectedTab(context);return chrome.tabs.update(activeTabId(context),{active:true})}); await chrome.windows.update(tab.windowId,{focused:true}) }
  if (action === 'download') return await download(payload, id, context)
  if (!['inspect', 'nameProject', 'prepare', 'attach', 'checkReference', 'baseline', 'armSubmit', 'confirmSubmit', 'results'].includes(action)) throw new Error('Unsupported companion command.')
  const value = await pageAction(action, payload, id, context)
  await selectedTab(context)
  return value
  } finally { activeContexts.delete(tab.id) }
  })
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const context=sender.id===chrome.runtime.id ? activeContexts.get(sender.tab?.id) : undefined
  if (message.type==='frame-flow-edit-prompt' && context) {
    ;(async()=>{
      await selectedTab(context)
      const results=await chrome.scripting.executeScript({target:{tabId:context.tabId},world:'MAIN',func:editPromptInPage,args:[message.prompt,message.nonce]})
      if(results.length!==1 || results[0].result?.retained!==true) throw new Error('Flow did not confirm the scoped editor action.')
      return {ok:true,value:results[0].result}
    })().then(reply).catch(error=>reply({ok:false,error:error.message}))
    return true
  }
  if(message.type==='frame-flow-main-upload' && context){
    ;(async()=>{
      await selectedTab(context)
      const results=await chrome.scripting.executeScript({target:{tabId:context.tabId},world:'MAIN',func:uploadInPage,args:[message.file,message.nonce]})
      if(results.length!==1 || results[0].result?.assigned!==true) throw new Error('Flow page-context upload was not confirmed.')
      return {ok:true,value:results[0].result}
    })().then(reply).catch(error=>reply({ok:false,error:error.message}))
    return true
  }
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false
  if (message.type === 'disconnect') { detach(); reply({ ok: true }); return false }
  if (message.type === 'upload-diagnostic') {
    ;(async () => {
      if (hasWork()) throw new Error('Wait until the current Flow action has stopped before saving its diagnostic.')
      running = true
      try {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
        const selected = await selectedTab()
        if (active?.id !== selected.id) throw new Error('Open the connected Flow tab first. No other tab is inspected.')
        const report = await pageAction('uploadDiagnostic', {}, crypto.randomUUID())
        await chrome.downloads.download({ url: `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(report, null, 2))}`, filename: 'Frame Studio/flow-upload-diagnostic.json', saveAs: true, conflictAction: 'uniquify' })
        return { ok: true, message: 'Save this diagnostic JSON in the software test screenshot folder. It contains only toolbar control structure; no generation was submitted.' }
      } finally { running = false }
    })().then(reply).catch(error => reply({ ok: false, message: error.message }))
    return true
  }
  if (message.type !== 'connect') return false
  ;(async () => {
    if (hasWork()) throw new Error('A Flow action is active. Wait for completion before changing tabs.')
    const match = /^(\d{1,5})\.([0-9a-f]{64})$/.exec(message.code || '')
    if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535) throw new Error('Paste a fresh pairing code from Frame Studio Settings.')
    const tab = await chrome.tabs.get(message.tabId)
    if (!allowed(tab.url)) throw new Error('Open your signed-in Google Flow workspace, then click the extension there.')
    detach(); tabId = tab.id; selectedOrigin = new URL(tab.url).origin; anchorWindowId = tab.windowId
    const ws = socket = new WebSocket(`ws://127.0.0.1:${match[1]}/companion`)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('Local app did not accept this code. Generate a fresh code.')) }, 10000)
      ws.onopen = () => ws.send(JSON.stringify({ type: 'pair', token: match[2], url: tab.url }))
      ws.onerror = () => { clearTimeout(timer); reject(new Error('Frame Studio is not listening. Open the app and generate a new pairing code.')) }
      ws.onmessage = async event => {
        try {
          const command = JSON.parse(event.data)
          if (command.type === 'paired') { clearTimeout(timer); chrome.action.setBadgeText({ text: 'ON' }); resolve(); return }
          if (command.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return }
          if (command.type !== 'command' || typeof command.id !== 'string' || command.id.length > 64) return
          if (completed.has(command.id)) { ws.send(JSON.stringify(completed.get(command.id))); return }
          if (running) { ws.send(JSON.stringify({ type: 'reply', id: command.id, projectId:command.projectId, ok: false, error: 'A companion diagnostic is running.' })); return }
          let pending=inFlight.get(command.id)
          if(!pending){
            pending=inLane(projectLanes, command.projectId ?? 'connected-tab', async () => {
              try { return { type:'reply',id:command.id,projectId:command.projectId,ok:true,value:await execute(command) } }
              catch(error){ return { type:'reply',id:command.id,projectId:command.projectId,ok:false,error:error.message } }
            })
            inFlight.set(command.id,pending)
            void pending.then(response=>{completed.set(command.id,response);if(completed.size>200)completed.delete(completed.keys().next().value);inFlight.delete(command.id)})
          }
          const response=await pending
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response))
        } catch { ws.close() }
      }
      ws.onclose = () => { clearTimeout(timer); if (socket === ws) detach(); reject(new Error('Connection closed. Pair again from the selected Flow tab.')) }
    })
    return { ok: true, message: 'Paired. Generate in Frame Studio opens each project in its own Flow tab. Keep Chrome open. Disconnect here any time.' }
  })().then(reply).catch(error => reply({ ok: false, message: error.message }))
  return true
})
chrome.tabs.onRemoved.addListener(id => { if (id === tabId) tabId=undefined;void projectTabs.removed(id).catch(()=>{}) })
