// Real scheduler + companion WebSocket transport. One Flow acknowledgement is
// stalled deliberately; unrelated projects must still reach native activation.
// No real browser, user workspace, Google request or credits are touched.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {readFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {WebSocket} from 'ws'
import {FlowCompanion} from '../dist-electron/flow-companion.cjs'
import {FlowScheduler} from '../dist-electron/flow-scheduler.cjs'
import {nativeFlowSubmit} from '../dist-electron/flow-native-submit.cjs'
import {FlowNotSubmittedError} from '../dist-electron/storage/errors.cjs'
const ids=Array.from({length:6},()=>randomUUID()),urls=new Map(ids.map(id=>[id,`https://flow.google.com/project/${id}`]))
const version=JSON.parse(await readFile('extension/manifest.json','utf8'))
const chromeMode=process.argv.includes('--chrome'),pages=new Map()
const title=chromeMode?`Frame Studio parallel test ${randomUUID()}`:'Shared project name'
let browser
if(chromeMode){
 const {chromium}=await import('playwright')
 browser=await chromium.launch({channel:'chrome',headless:false,chromiumSandbox:true,ignoreDefaultArgs:['--unsafely-disable-devtools-self-xss-warnings']})
 const context=await browser.newContext()
 await context.route('**/*',route=>[...urls.values()].includes(route.request().url())?route.fulfill({contentType:'text/html',body:`<!doctype html><title>${title}</title><button aria-label="Start generation">Start generation</button><script>window.clicks=0;document.querySelector('button').onclick=e=>{window.clicks++;window.trusted=e.isTrusted}</script>`}):route.abort())
 for(const id of ids){const page=await context.newPage();await page.goto(urls.get(id));pages.set(id,page)}
}
let client,heldReply,active=0,maxActive=0,scopeErrors=0
const clicked=[],acknowledged=[],commands=[],errors=[]
const bridge=new FlowCompanion(os.tmpdir(),async(url,title)=>{
 assert.ok([...urls.values()].includes(url))
 active++;maxActive=Math.max(maxActive,active)
 try{
  if(chromeMode){await nativeFlowSubmit(path.resolve('electron/flow-native-submit.ps1'))(url,title);const page=pages.get([...urls].find(([,value])=>value===url)[0]);assert.deepEqual(await page.evaluate(()=>({clicks:window.clicks,trusted:window.trusted})),{clicks:1,trusted:true})}
  else await delay(5)
  clicked.push(url)
 }finally{active--}
})
const ws={projects:{isDeleted:()=>false}}
const scheduler=new FlowScheduler(async()=>ws,(id,dispatch)=>bridge.forProject(id,dispatch))
const until=async(predicate,label,ms=chromeMode?15000:2000)=>{const end=Date.now()+ms;while(!predicate()&&Date.now()<end)await delay(2);assert.ok(predicate(),label)}
const pending=[]
try{
 const {code}=await bridge.pair(),[port,token]=code.split('.')
 client=new WebSocket(`ws://127.0.0.1:${port}/companion`,{origin:`chrome-extension://${'a'.repeat(32)}`})
 client.on('open',()=>client.send(JSON.stringify({type:'pair',token,url:urls.get(ids[0])})))
 client.on('message',async raw=>{
  const command=JSON.parse(raw)
  if(command.type==='ping'){client.send(JSON.stringify({type:'pong'}));return}
  if(command.type!=='command')return
  commands.push(command)
  const reply=value=>client.send(JSON.stringify({type:'reply',id:command.id,projectId:command.projectId,ok:true,value}))
  if(command.action==='inspect'){reply({url:urls.get(ids[0]),title:'Fixture',ready:true,companionVersion:'0.1.6',adapterVersion:version.version_name});return}
  if(command.payload.url!==urls.get(command.projectId))scopeErrors++
  if(command.action==='armSubmit'){if(chromeMode)await pages.get(command.projectId).bringToFront();reply({nonce:randomUUID(),title});return}
  if(command.action==='confirmSubmit'){
   const acknowledge=()=>{acknowledged.push(command.projectId);reply({accepted:true,evidence:'prompt-cleared'})}
   if(command.projectId===ids[0])heldReply=acknowledge
   else acknowledge()
  }
 })
 await until(()=>bridge.status().state==='connected','Companion paired')
 const submit=id=>scheduler.runner(id).browser.submit(urls.get(id))
 pending.push(submit(ids[0]));pending[0].catch(error=>errors.push(error.message))
 await until(()=>!!heldReply||errors.length,'First project reached delayed acknowledgement')
 assert.ok(heldReply,errors.join('; '))
 for(const id of ids.slice(1)){const request=submit(id);request.catch(error=>errors.push(error.message));pending.push(request)}
 await until(()=>clicked.length===ids.length&&acknowledged.length===5,'Other projects must submit while first acknowledgement remains pending',chromeMode?45000:1000)
 assert.equal(maxActive,1,'Only the native ticket/click turn needs a foreground lock')
 assert.equal(scopeErrors,0);assert.equal(acknowledged.includes(ids[0]),false)
 assert.equal(acknowledged.length,5,'Unrelated project acknowledgements continue independently')
 heldReply();heldReply=undefined;await Promise.all(pending)
 assert.equal(new Set(clicked).size,6);assert.equal(clicked.length,6,'No duplicate native click')
 console.log('PASS six production companion submissions: one stalled acknowledgement does not block five other projects; native activation stays serial, project URLs stay scoped and every request clicks exactly once.')
 if(chromeMode){
  const first=pages.get(ids[0]),native=nativeFlowSubmit(path.resolve('electron/flow-native-submit.ps1'))
  await first.bringToFront();await first.locator('button').evaluate(button=>button.disabled=true)
  await assert.rejects(()=>native(urls.get(ids[0]),title),error=>error instanceof FlowNotSubmittedError&&/not uniquely visible/.test(error.message),'Other tabs enabled buttons must not replace this project disabled button')
  await assert.rejects(()=>native(urls.get(ids[1]),title),error=>error instanceof FlowNotSubmittedError&&/not displaying the paired/.test(error.message))
  for(const page of pages.values())assert.equal(await page.evaluate(()=>window.clicks),1)
  console.log('PASS six actual Chrome tabs and Windows native trusted clicks; disabled/wrong-project requests cannot use another tab\'s button. Fresh routed fixture profile: no live Google network requests or credits.')
 }
}finally{
 heldReply?.();await Promise.allSettled(pending);await scheduler.close();client?.terminate();await bridge.close();await browser?.close()
 if(errors.length)console.log('Submission failures:',errors)
}
