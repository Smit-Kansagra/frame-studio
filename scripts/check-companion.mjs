import assert from 'node:assert/strict'
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { FlowCompanion, allowedFlowPage } from '../dist-electron/flow-companion.cjs'
import { FlowCommandQueue } from '../dist-electron/flow-command-queue.cjs'

const root = await mkdtemp(path.join(os.tmpdir(), 'frame-companion-check-'))
const downloads = path.join(root, 'Downloads')
await mkdir(path.join(downloads, 'Frame Studio'), { recursive: true })
const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#6a8655' } }).png().toBuffer()
const photo = path.join(root, 'product.png'); await writeFile(photo, png)
const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'))
assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'downloads', 'storage'])
assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*', 'https://flow.google.com/*', 'https://labs.google/fx/tools/flow*', 'https://labs.google/fx/*/tools/flow*'])
assert.equal(manifest.externally_connectable, undefined)
assert.equal(manifest.content_scripts, undefined, 'No automatic all-tab injection')
assert.equal(allowedFlowPage('https://accounts.google.com/'), false)
assert.equal(allowedFlowPage('https://evil.example/?flow.google.com'), false)
assert.equal(allowedFlowPage('https://labs.google/not-flow'), false)
assert.equal(allowedFlowPage('https://flow.google.com/'), true)
assert.equal(allowedFlowPage('https://labs.google/fx/tools/flow'), true)
const bridge = new FlowCompanion(downloads, async url => { assert.equal(url, flowUrl); submitCount++ })
const origin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const flowUrl = 'https://flow.google.com/project/test-project'
const until = async test => { const deadline = Date.now() + 5000; while (!test() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(test(), 'Expected state within 5 seconds') }
function rejectedSocket(code, givenOrigin, token) {
  const [port] = code.split('.')
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/companion`, { origin: givenOrigin })
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('Unauthorized client was not rejected')) }, 6000)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'pair', token, url: flowUrl })))
    ws.on('message', () => { clearTimeout(timer); reject(new Error('Unauthorized client received a reply')) })
    ws.on('error', () => {})
    ws.on('close', () => { clearTimeout(timer); resolve() })
  })
}
let client, submitCount = 0, badDownload = false, loseDownloadReply = false, downloadCount = 0, wrongScope = false, onAttach, observed,recoveredDownload=false,prepareErrors=0,prepareCalls=0
try {
  assert.throws(() => bridge.pairingCode(), /expired or was already used/)
  const [pairing, concurrentPairing] = await Promise.all([bridge.pair(), bridge.pair()])
  assert.deepEqual(concurrentPairing, pairing, 'Concurrent connect clicks share one listener and code')
  assert.equal(bridge.pairingCode(), pairing.code)
  const [port, token] = pairing.code.split('.')
  assert.ok(new Date(pairing.expiresAt).getTime() > Date.now())
  await rejectedSocket(pairing.code, 'https://flow.google.com', token)
  await rejectedSocket(pairing.code, origin, '0'.repeat(64))
  client = new WebSocket(`ws://127.0.0.1:${port}/companion`, { origin })
  client.on('open', () => client.send(JSON.stringify({ type: 'pair', token, url: flowUrl })))
  client.on('message', async raw => {
    const command = JSON.parse(raw)
    if (command.type === 'ping') { client.send(JSON.stringify({ type: 'pong' })); return }
    if (command.type !== 'command') return
    observed?.push(command.action)
    if(command.action==='prepare'){prepareCalls++;if(prepareErrors-->0){client.send(JSON.stringify({type:'reply',id:command.id,projectId:command.projectId,ok:false,error:'Flow did not confirm the scoped editor action.'}));return}}
    let value = null
    if (command.action === 'inspect') value = { url: flowUrl, title: 'Fixture workspace', ready: true, companionVersion:'0.1.6', adapterVersion:'0.1.6-fast.24' }
    if (command.action === 'createProject') value = { url: flowUrl }
    if (command.action === 'nameProject') value = { name: command.payload.name }
    if (command.action === 'attach') { assert.equal(command.payload.file.base64, png.toString('base64')); if(onAttach){const callback=onAttach;onAttach=undefined;callback();await new Promise(resolve=>setTimeout(resolve,10))} }
    if (command.action === 'baseline') value = ['old-asset']
    if (command.action === 'results') value = [{ id: 'new-asset', selector: '[data-asset-id="new-asset"]' }]
    if (command.action === 'armSubmit') value = {nonce:'11111111-1111-4111-8111-111111111111',title:'Fixture workspace'}
    if (command.action === 'confirmSubmit') value = {accepted:true,evidence:'prompt-cleared'}
    if (command.action === 'download') {
      downloadCount++
      const filename = badDownload ? photo : recoveredDownload?path.join(downloads,`Fashion_post_flat_lay_and_${command.payload.result.id.slice(0,8)} (5).png`):path.join(downloads, 'Frame Studio', `${command.payload.nonce}.png`)
      if (!badDownload) await writeFile(filename, png)
      value = { filename }
      if(recoveredDownload)value={filename,originalMediaId:command.payload.result.id,originalTitle:'Fashion post flat lay and outfit'}
      if (loseDownloadReply) { loseDownloadReply=false;client.send(JSON.stringify({type:'reply',id:command.id,ok:false,error:'Download acknowledgement was lost.'}));return }
    }
    const projectId=wrongScope?'22222222-2222-4222-8222-222222222222':command.projectId;wrongScope=false
    client.send(JSON.stringify({ type: 'reply', id: command.id, projectId, ok: true, value }))
  })
  await until(() => bridge.status().state === 'connected')
  assert.throws(() => bridge.pairingCode(), /expired or was already used/, 'Consumed pairing code cannot be copied again')
  await rejectedSocket(pairing.code, origin, token)
  let committed = ''
  await bridge.createProject(async url => { committed = url }); assert.equal(committed, flowUrl)
  await bridge.nameProject(flowUrl, 'Matching software project')
  const scoped=bridge.forProject('11111111-1111-4111-8111-111111111111')
  await scoped.nameProject(flowUrl,'Scoped project')
  wrongScope=true
  await assert.rejects(()=>scoped.submit(flowUrl),/ownership is ambiguous/)
  assert.equal(submitCount,0,'Wrong-project submit ticket cannot reach the native click')
  await scoped.close()
  await assert.rejects(()=>scoped.results(flowUrl,'Scoped project','post',[]),/Project deleted/)
  const other=bridge.forProject('33333333-3333-4333-8333-333333333333')
  await other.nameProject(flowUrl,'Other project still connected')
  const commandQueue=new FlowCommandQueue(),queued=bridge.forProject('44444444-4444-4444-8444-444444444444',commandQueue.dispatch)
  let collecting
  observed=[]
  onAttach=()=>{collecting=queued.results(flowUrl,'Existing request','post',[])}
  await queued.prepare(flowUrl,{prompt:'Next product',outputType:'post',preset:'post-square',outputs:1,files:[photo,photo,photo]})
  await collecting
  assert.deepEqual(observed,['prepare','attach','results','attach','attach','baseline'],'Actual companion transport lets ready-result collection run before the next reference upload')
  observed=undefined
  prepareErrors=2;const callsBefore=prepareCalls
  await bridge.prepare(flowUrl,{prompt:'Background editor retry',outputType:'post',preset:'post-square',outputs:1,files:[]})
  assert.equal(prepareCalls,callsBefore+3,'Transient preparation errors retry before any native click')
  prepareErrors=5;const boundedBefore=prepareCalls
  await assert.rejects(()=>bridge.prepare(flowUrl,{prompt:'Still unavailable',outputType:'post',preset:'post-square',outputs:1,files:[]}),/scoped editor/)
  assert.equal(prepareCalls,boundedBefore+3,'Preparation retries remain bounded');prepareErrors=0
  await assert.rejects(() => bridge.nameProject(flowUrl, ''), /Invalid Flow project name/)
  assert.deepEqual(await bridge.prepare(flowUrl, { prompt: 'Product fixture', outputType: 'post', preset: 'post-square', sourceDuration: null, outputs: 1, files: [photo] }), ['old-asset'])
  await bridge.submit(flowUrl); assert.equal(submitCount, 1)
  const results = await bridge.results(flowUrl, 'Product fixture', 'post', ['old-asset'])
  const downloaded = await bridge.download(flowUrl, results[0], root)
  assert.equal((await sharp(downloaded).metadata()).format, 'png')
  assert.equal(await bridge.download(flowUrl,results[0],root),downloaded,'Retry reuses the project copy without another browser download')
  loseDownloadReply=true
  const recovering={...results[0],id:'lost-reply-result'}
  const beforeLost=downloadCount
  await assert.rejects(()=>bridge.download(flowUrl,recovering,root),/acknowledgement was lost/)
  assert.ok(await bridge.download(flowUrl,recovering,root))
  assert.equal(downloadCount,beforeLost+1,'A lost reply reuses its completed Chrome staging file, with no duplicate download')
  recoveredDownload=true
  const recoveredResult={id:'9345c2df-aaf3-4689-bc87-1aeea46ea144',selector:'#existing'}
  const original=await bridge.download(flowUrl,recoveredResult,root)
  assert.ok(original.includes('flow-original-'));assert.equal((await sharp(original).metadata()).format,'png');recoveredDownload=false
  badDownload = true
  await assert.rejects(() => bridge.download(flowUrl, {...results[0],id:'different-result'}, root), /outside the expected/)
  await assert.rejects(() => bridge.prepare('https://evil.example/project/id', { files: [] }), /Invalid Flow project/)
  client.close(); await until(() => bridge.status().state === 'not-connected')
  await assert.rejects(() => bridge.submit(flowUrl), /Pair the companion/)
  assert.equal(submitCount, 1)
  console.log('PASS local bridge: origin/token checks, one-time pairing, selected origins, attachment transport, submit once, result download, arbitrary-path rejection, disconnect')
} finally { client?.terminate(); await bridge.close() }

const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true })
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  const html = `<!doctype html><title>Offline companion UI contract fixture</title>
  <button>Nano Banana Pro</button><button>Image</button><button>Video</button><button>Ingredients</button><button>Frames</button>
  <label>Aspect ratio<select><option>1:1</option><option>9:16</option></select></label>
  <label>Outputs<select><option>1</option><option>2</option></select></label>
  <label>Duration<select><option>8s</option></select></label>
  <form><label>Prompt<textarea></textarea></label><input type="file" accept="image/png"><div id="references"></div><button type="button" id="generate">Generate</button></form>
  <div id="results"><article data-asset-id="old" data-prompt="Test product"><img alt="old" src="data:image/png;base64,${png.toString('base64')}"><a href="https://storage.googleapis.com/fixture/old.png" download="old.png">Download</a></article></div>
  <script>
  document.querySelector('input').onchange=e=>{const img=document.createElement('img');img.alt=e.target.files[0].name;img.src='data:image/png;base64,${png.toString('base64')}';document.querySelector('#references').append(img)};
  document.querySelector('#generate').onclick=()=>{window.count=(window.count||0)+1; const a=document.createElement('article');a.dataset.assetId='new';a.dataset.prompt=document.querySelector('textarea').value;a.innerHTML='<img alt="generated" src="data:image/png;base64,${png.toString('base64')}"><a download="result.png" href="https://storage.googleapis.com/fixture/result.png">Download</a>';document.querySelector('#results').append(a)};
  window.chrome={runtime:{id:'fixture',onMessage:{addListener(callback){window.handler=callback}},sendMessage:async message=>{try{let value;if(message.type==='frame-flow-edit-prompt')value=await window.editPromptInPage(message.prompt,message.nonce);else value=window.uploadInPage(message.file,message.nonce);return {ok:true,value}}catch(error){return {ok:false,error:error.message}}}}};
  </script>`
  await context.route('**/*', route => route.request().url() === flowUrl ? route.fulfill({ body: html, contentType: 'text/html' }) : route.abort())
  await page.goto(flowUrl)
  await page.addScriptTag({content:(await readFile('extension/editor-main.js','utf8')).replaceAll('export ','')+';window.editPromptInPage=editPromptInPage'})
  await page.addScriptTag({content:(await readFile('extension/upload-main.js','utf8')).replace('export function uploadInPage','function uploadInPage')+';window.uploadInPage=uploadInPage'})
  await page.addScriptTag({ content: await readFile('extension/content.js', 'utf8') })
  let sequence = 0
  const call = async (action, payload, id = `fixture-${++sequence}`) => page.evaluate(({ action, payload, id }) => new Promise(resolve => window.handler({ type: 'frame-flow-command', id, action, payload }, { id: 'fixture' }, resolve)), { action, payload, id })
  assert.equal((await call('inspect', {})).value.ready, true)
  const request = { url: flowUrl, prompt: 'Test product', outputType: 'post', preset: 'post-square', outputs: 1 }
  assert.equal((await call('prepare', request)).ok, true)
  assert.equal((await call('attach', { url: flowUrl, kind: 'reference', file: { name: 'product.png', type: 'image/png', base64: png.toString('base64') } })).ok, true)
  assert.deepEqual((await call('baseline', { url: flowUrl, references: 1, startFrame: false })).value, ['old'])
  const ticket=await call('armSubmit',{url:flowUrl},'once')
  assert.equal(ticket.ok,true)
  assert.deepEqual(await call('armSubmit',{url:flowUrl},'once'),ticket)
  await page.locator('#generate').click()
  assert.equal((await call('confirmSubmit',{url:flowUrl,nonce:ticket.value.nonce},'confirm')).ok,true)
  assert.equal((await call('confirmSubmit',{url:flowUrl,nonce:ticket.value.nonce},'confirm')).ok,true)
  assert.equal(await page.evaluate(() => window.count), 1, 'Duplicate command must not click Generate twice')
  const result = await call('results', { url: flowUrl, outputType: 'post', prompt: 'Test product', baseline: ['old'] })
  assert.deepEqual(result.value.map(item => item.id), ['new'])
  const link = await call('downloadLink', { url: flowUrl, result: result.value[0] })
  assert.equal(link.value.url, 'https://storage.googleapis.com/fixture/result.png')
  assert.equal((await call('armSubmit', { url: flowUrl })).ok, false, 'Prepared submission is consumed')
  assert.equal((await call('inspect', { url: 'https://evil.example/' })).ok, false)
  assert.equal((await call('arbitraryJavascript', {})).ok, false)
  console.log('PASS isolated content script: prompt/settings, real File attachment, stable result baseline, exact prompt matching, duplicate-submit guard, supported download link, wrong-project rejection')
} finally { await browser.close() }
console.log('PASS companion preview checks. These fixtures do not verify live Google Flow compatibility.')
