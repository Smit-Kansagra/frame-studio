// Exercise the actual service-worker command loop with isolated Chrome mocks.
// A delayed/interrupted download must not cause another Original-size click.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ProjectTabs } from '../extension/project-tabs.js'
import { captureOriginal, safeMediaUrl } from '../extension/result-download.js'
let listener,ws,captures=0,started=0,native=false
const filenameListeners=new Set(), mediaId='981ed90b-1ef1-4f17-9230-13158641ff87'
const items=new Map(),responses=new Map()
class Socket {
  static OPEN=1
  readyState=1
  constructor(){ws=this;queueMicrotask(()=>this.onopen())}
  send(text){const value=JSON.parse(text);if(value.type==='pair')this.onmessage({data:JSON.stringify({type:'paired'})});else responses.set(value.id,value)}
  close(){this.readyState=3}
}
const chrome={
  runtime:{id:'fixture',getURL:file=>`chrome-extension://fixture/${file}`,onMessage:{addListener:fn=>listener=fn}},
  action:{setBadgeText(){}},windows:{async update(){}},
  tabs:{async get(){return{id:1,url:'https://flow.google.com/project/one',status:'complete'}},async update(){},onRemoved:{addListener(){}},async sendMessage(tab,message){
    if(message.action==='downloadOriginal'){
      const item={id:++started,state:'interrupted',url:'blob:https://flow.google.com/22222222-2222-4222-8222-222222222222',referrer:'',filename:'Result_981ed90b.jpg',startTime:new Date().toISOString()}
      for(const callback of filenameListeners)callback(item,suggestion=>{if(suggestion)item.filename=`C:/Downloads/${suggestion.filename}`})
      items.set(item.id,item)
      assert.match(item.filename,/Frame Studio\//,'The current Flow filename must be captured and redirected immediately')
      return{ok:true,value:null}
    }
    return{ok:true,value:native?{mode:'native-menu',title:'Result'}:{url:'https://flow-content.google/image/result',extension:'png'}}
  }},
  scripting:{async executeScript(){}},
  downloads:{onDeterminingFilename:{addListener:fn=>filenameListeners.add(fn),removeListener:fn=>filenameListeners.delete(fn)},async download(){started++;items.set(started,{id:started,state:'interrupted',byExtensionId:'fixture',filename:`C:/Downloads/Frame Studio/test-${started}.png`});return started},async search({id}){return[items.get(id)]}},
}
const code=(await readFile('extension/background.js','utf8')).replace(/^import .*$/gm,'')
new Function('chrome','WebSocket','ProjectTabs','captureOriginal','safeMediaUrl',code)(chrome,Socket,ProjectTabs,async(...args)=>{
  captures++;return captureOriginal(...args)
},safeMediaUrl)
await new Promise(resolve=>listener({type:'connect',code:`12345.${'a'.repeat(64)}`,tabId:1},{id:'fixture',url:chrome.runtime.getURL('popup.html')},reply=>{assert.equal(reply.ok,true,reply.message);resolve()}))
let sequence=0
async function command(nonce){const id=`request-${++sequence}`;await ws.onmessage({data:JSON.stringify({type:'command',id,action:'download',payload:{url:'https://flow.google.com/project/one',nonce,result:{id:native?mediaId:'direct'}}})});return responses.get(id)}
for(const isNative of [false,true]){
  native=isNative
  const nonce=isNative?'22222222-2222-4222-8222-222222222222':'11111111-1111-4111-8111-111111111111'
  const first=await command(nonce);assert.equal(first.ok,false);assert.match(first.error,/interrupted/)
  const count=started;items.get(count).state='complete'
  const retry=await command(nonce);assert.equal(retry.ok,true,retry.error)
  assert.equal(started,count,'Collection retry must observe the original download ID without a second click')
}
assert.equal(captures,1,'Only one native Original-size action was started')
assert.equal(filenameListeners.size,0,'Native download listeners are cleaned up')
console.log('PASS actual extension command loop reuses direct/native download IDs after interrupted waits; no duplicate Original-size click or new download.')
