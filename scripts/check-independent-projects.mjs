// Runs the actual scheduler and extension background with isolated browser APIs.
// No live account, downloads, user database or Flow allowance is touched.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {FlowScheduler} from '../dist-electron/flow-scheduler.cjs'
const until=async(predicate,label)=>{const end=Date.now()+4000;while(!predicate()&&Date.now()<end)await delay(2);assert.ok(predicate(),label)}

// Eight long uploads must all enter before any is released. More than three
// submitted jobs must not prevent a ninth project from starting its upload.
const ids=Array.from({length:9},()=>randomUUID()),uploads=new Set(),released=new Map(),contexts=new Map()
let submitted=0,nativeActive=0,maxNative=0
const workspace={projects:{isDeleted:()=>false},generations:{submittedCount:()=>99}}
const scheduler=new FlowScheduler(async()=>workspace,(id,dispatch)=>{
  contexts.set(id,dispatch)
  return {granularQueue:true,close:async()=>{}}
})
// Exercise the production lane construction, independently of generation data.
for(const id of ids){const runner=scheduler.runner(id);assert.equal(await runner.browser.capacityAvailable(),true);await runner.browser.submission(async()=>{},randomUUID())}
const work=ids.map(id=>contexts.get(id)('attach',async()=>{uploads.add(id);await new Promise(resolve=>released.set(id,resolve))}))
await until(()=>uploads.size===9,'All nine uploads enter together despite existing submitted jobs')
const native=ids.map(id=>contexts.get(id)('submit',async()=>{nativeActive++;maxNative=Math.max(maxNative,nativeActive);await delay(2);submitted++;nativeActive--}))
for(const release of released.values())release()
await Promise.all([...work,...native]);assert.equal(maxNative,1);assert.equal(submitted,9)
await scheduler.close()

// Execute the shipped background, including project/tab lanes, in-flight ID
// coalescing and MAIN-world callback routing from simultaneous content scripts.
const records={},tabs=new Map(),storage={},starts=new Set(),gates=new Map(),calls=[],listeners=[]
const origin='https://flow.google.com'
ids.forEach((id,index)=>{const tabId=index+1,url=`${origin}/project/${id}`;tabs.set(tabId,{id:tabId,url,windowId:1,status:'complete'});records[id]={tabId,url,origin,creationStarted:true}})
storage.frameProjectTabs=records
const mainMessage=(type,tabId,extra)=>new Promise(resolve=>{
  assert.equal(listeners[0]({type,...extra},{id:'fixture',tab:{id:tabId}},resolve),true)
})
globalThis.chrome={
 runtime:{id:'fixture',getURL:name=>`chrome-extension://fixture/${name}`,onMessage:{addListener:fn=>listeners.push(fn)}},
 action:{setBadgeText:()=>{}},storage:{session:{get:async()=>storage,set:async value=>{Object.assign(storage,structuredClone(value))}}},
 windows:{update:async()=>{}},
 tabs:{get:async id=>({...tabs.get(id)}),onRemoved:{addListener:()=>{}},update:async(id,patch)=>Object.assign(tabs.get(id),patch),sendMessage:async(tabId,message)=>{
   calls.push({tabId,action:message.action,id:message.id})
   if(message.action==='attach'){
     assert.equal(message.payload.url,tabs.get(tabId).url)
     starts.add(tabId)
     const uploaded=await mainMessage('frame-flow-main-upload',tabId,{file:{name:`product-${tabId}.png`},nonce:randomUUID()})
     assert.equal(uploaded.ok,true)
     await new Promise(resolve=>gates.set(tabId,resolve))
   }
   if(message.action==='prepare'){
     const edited=await mainMessage('frame-flow-edit-prompt',tabId,{prompt:`prompt-${tabId}`,nonce:randomUUID()})
     assert.equal(edited.ok,true)
   }
   return {ok:true,value:message.action==='inspect'?{ready:true}:null}
 }},
 scripting:{executeScript:async request=>{
   if(request.world==='MAIN'){
     const value=request.args[0],id=request.target.tabId
     if(typeof value==='string'){assert.equal(value,`prompt-${id}`);return [{result:{retained:true}}]}
     assert.equal(value.name,`product-${id}.png`);return [{result:{assigned:true}}]
   }
   return []
 }},downloads:{},
}
class Socket{
 static OPEN=1
 readyState=1
 replies=[]
 constructor(){Socket.instance=this;setTimeout(()=>this.onopen(),0)}
 send(raw){const message=JSON.parse(raw);if(message.type==='pair')queueMicrotask(()=>this.onmessage({data:JSON.stringify({type:'paired'})}));else this.replies.push(message)}
 close(){this.readyState=3}
 command(command){void this.onmessage({data:JSON.stringify({type:'command',...command})})}
}
globalThis.WebSocket=Socket
await import('../extension/background.js')
const paired=await new Promise(resolve=>listeners[0]({type:'connect',tabId:1,code:`12000.${'a'.repeat(64)}`},{id:'fixture',url:chrome.runtime.getURL('popup.html')},resolve))
assert.equal(paired.ok,true)
const socket=Socket.instance
const commands=ids.map(id=>({id:randomUUID(),projectId:id,action:'attach',payload:{url:records[id].url}}))
commands.forEach(command=>socket.command(command))
socket.command(commands[0]) // a duplicate received while the upload is pending
const next={id:randomUUID(),projectId:ids[0],action:'prepare',payload:{url:records[ids[0]].url}}
socket.command(next)
await until(()=>starts.size===9&&gates.size===9,'All extension tabs upload concurrently with correct MAIN callbacks')
assert.equal(calls.filter(c=>c.action==='attach').length,9,'A replayed command cannot upload twice')
assert.equal(calls.some(c=>c.id===next.id),false,'Own next command waits for its upload')
// Release eight tabs first; one stalled tab cannot hold the others.
for(const [tabId,release] of gates)if(tabId!==1)release()
await until(()=>socket.replies.filter(r=>r.ok).length===8,'Other tabs finish while one upload remains pending')
gates.get(1)()
await until(()=>socket.replies.some(r=>r.id===next.id),'Own lane resumes after upload')
assert.ok(socket.replies.every(r=>r.ok))
tabs.get(2).url=records[ids[2]].url
const wrong={id:randomUUID(),projectId:ids[1],action:'attach',payload:{url:records[ids[1]].url}}
socket.command(wrong)
await until(()=>socket.replies.some(r=>r.id===wrong.id),'Mismatched tab rejected')
assert.equal(socket.replies.find(r=>r.id===wrong.id).ok,false)
assert.equal(calls.some(c=>c.id===wrong.id),false,'No content action reaches another project')
listeners[0]({type:'disconnect'},{id:'fixture',url:chrome.runtime.getURL('popup.html')},()=>{})
console.log('PASS nine concurrent app/extension uploads, no global project cap, serial native submit, per-tab prompt/file routing, stalled-tab isolation, duplicate command coalescing and URL ownership rejection.')
