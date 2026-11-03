// Actual background command loop + content adapter in separate isolated Chrome
// tabs. All Flow URLs are fulfilled locally; no Google traffic/account/credits.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { ProjectTabs } from '../extension/project-tabs.js'
const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true,ignoreDefaultArgs:['--unsafely-disable-devtools-self-xss-warnings']})
const context=await browser.newContext(),pages=new Map(),responses=new Map(),store={}
const content=await readFile('extension/content.js','utf8')
const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
await context.route('**/*',route=>{
  if(!route.request().url().startsWith('https://flow.google.com/'))return route.abort()
  const name=new URL(route.request().url()).pathname.split('/').pop()||'home'
  return route.fulfill({contentType:'text/html',body:`<!doctype html><title>Same name</title><button onclick="location.href='/project/'+crypto.randomUUID()">New project</button><textarea></textarea><article data-asset-id="result-${name}" data-prompt="Product ${name}"><img src="data:image/png;base64,${image}" width="16" height="16"><a download="result.png" href="https://storage.googleapis.com/fixture/result.png">Download</a></article><script>window.chrome={runtime:{id:'fixture',onMessage:{addListener:fn=>window.handler=fn}}}</script>`})
})
let sequence=0,tabSequence=0,listener,ws
async function makePage(url){const page=await context.newPage();await page.goto(url);const id=++tabSequence;pages.set(id,page);return{id,url,status:'complete',windowId:1}}
class Socket {
  static OPEN=1
  readyState=1
  constructor(){ws=this;queueMicrotask(()=>this.onopen())}
  send(text){const value=JSON.parse(text);if(value.type==='pair')this.onmessage({data:JSON.stringify({type:'paired'})});else responses.set(value.id,value)}
  close(){this.readyState=3}
}
const chrome={
  runtime:{id:'fixture',getURL:file=>`chrome-extension://fixture/${file}`,onMessage:{addListener:fn=>listener=fn}},
  storage:{session:{async get(){return structuredClone(store)},async set(data){Object.assign(store,structuredClone(data))}}},action:{setBadgeText(){}},windows:{async update(){}},
  tabs:{async get(id){const p=pages.get(id);if(!p||p.isClosed())throw Error('No tab');return{id,url:p.url(),status:'complete',windowId:1}},create:options=>makePage(options.url),async update(id,options){if(options.url)await pages.get(id).goto(options.url);return this.get(id)},onRemoved:{addListener(){}},async sendMessage(id,message){return pages.get(id).evaluate(message=>new Promise(resolve=>window.handler(message,{id:'fixture'},resolve)),message)}},
  scripting:{async executeScript({target}){await pages.get(target.tabId).addScriptTag({content})}},
}
const code=(await readFile('extension/background.js','utf8')).replace(/^import .*$/gm,'')
new Function('chrome','WebSocket','ProjectTabs',code)(chrome,Socket,ProjectTabs)
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222'
async function command(projectId,action,payload={}){const id=`cmd-${++sequence}`;await ws.onmessage({data:JSON.stringify({type:'command',id,projectId,action,payload})});const response=responses.get(id);assert.equal(response.projectId,projectId);return response}
try{
  const seed=await makePage('https://flow.google.com/')
  await new Promise(resolve=>listener({type:'connect',code:`12345.${'a'.repeat(64)}`,tabId:seed.id},{id:'fixture',url:chrome.runtime.getURL('popup.html')},reply=>{assert.equal(reply.ok,true,reply.message);resolve()}))
  const urlA='https://flow.google.com/project/A',urlB='https://flow.google.com/project/B'
  for(const [id,url,name] of [[a,urlA,'A'],[b,urlB,'B']]){
    const result=await command(id,'results',{url,prompt:`Product ${name}`,outputType:'post',baseline:[]})
    assert.equal(result.ok,true,result.error);assert.deepEqual(result.value.map(x=>x.id),[`result-${name}`])
  }
  const mapping=store.frameProjectTabs
  assert.notEqual(mapping[a].tabId,mapping[b].tabId)
  assert.equal(pages.get(seed.id).url(),'https://flow.google.com/','Pairing tab is never repurposed')
  let result=await command(a,'results',{url:urlB,prompt:'Product B',outputType:'post',baseline:[]})
  assert.equal(result.ok,false);assert.match(result.error,/mismatch/)
  await pages.get(mapping[a].tabId).goto(urlB)
  result=await command(a,'results',{url:urlA,prompt:'Product A',outputType:'post',baseline:[]})
  assert.equal(result.ok,false);assert.match(result.error,/URL changed/)
  result=await command(b,'results',{url:urlB,prompt:'Product B',outputType:'post',baseline:[]})
  assert.equal(result.ok,true);assert.deepEqual(result.value.map(x=>x.id),['result-B'])
  await pages.get(mapping[a].tabId).close()
  result=await command(a,'results',{url:urlA,prompt:'Product A',outputType:'post',baseline:[]})
  assert.equal(result.ok,true,result.error);assert.deepEqual(result.value.map(x=>x.id),['result-A'])
  const c='33333333-3333-4333-8333-333333333333'
  result=await command(c,'createProject')
  assert.equal(result.ok,true,result.error);assert.match(result.value.url,/\/project\/[0-9a-f-]{36}$/)
  const again=await command(c,'createProject');assert.equal(again.ok,false);assert.match(again.error,/already requested/)
  assert.equal(pages.get(mapping[b].tabId).url(),urlB)
  console.log('PASS isolated Chrome tabs: actual adapter returns only each project’s result, seed tab preserved, wrong scope/URL refused, A navigation/closure does not affect B, closed A reopens saved URL, new project created in its own tab once only.')
}finally{await context.close();await browser.close()}
