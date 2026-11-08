// Ready results must reach review during another product's long upload sequence.
// Uses real scheduler/storage/priority queue with isolated staged image files.
import assert from 'node:assert/strict'
import { mkdtemp,writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { Workspace } from '../dist-electron/storage/workspace.cjs'
import { FlowScheduler } from '../dist-electron/flow-scheduler.cjs'
import { FlowCommandQueue } from '../dist-electron/flow-command-queue.cjs'
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
// A result queued behind a current upload must beat the next queued upload;
// submit is one indivisible turn even if a result arrives during its click.
const queue=new FlowCommandQueue(),order=[]
let unlock
const current=queue.dispatch('attach',()=>new Promise(resolve=>{unlock=()=>{order.push('upload-1');resolve()}}))
await delay(0)
const later=queue.dispatch('attach',async()=>{order.push('upload-2')})
const result=queue.dispatch('results',async()=>{order.push('result')})
unlock();await Promise.all([current,later,result]);assert.deepEqual(order,['upload-1','result','upload-2'])
const urgent=new FlowCommandQueue(),urgentOrder=[]
let finishUpload
const held=urgent.dispatch('attach',()=>new Promise(resolve=>{finishUpload=resolve}))
await delay(0)
const collections=Array.from({length:6},()=>urgent.dispatch('results',async()=>{urgentOrder.push('result')}))
const confirmation=urgent.dispatch('confirmSubmit',async()=>{urgentOrder.push('confirm')})
finishUpload();await Promise.all([held,...collections,confirmation]);assert.equal(urgentOrder[0],'confirm','Confirmation must not wait behind result collection after its foreground turn ends')
const fairness=new FlowCommandQueue(),fairOrder=[]
let releaseFair
const blocker=fairness.dispatch('attach',()=>new Promise(resolve=>{releaseFair=resolve}))
await delay(0)
const work=[...Array(8)].map((_,i)=>fairness.dispatch('results',async()=>{fairOrder.push(`result-${i}`)}))
work.push(fairness.dispatch('attach',async()=>{fairOrder.push('upload')}))
releaseFair();await Promise.all([blocker,...work]);assert.equal(fairOrder.indexOf('upload'),4,'Repeated result checks cannot starve uploads')
const root=await mkdtemp(path.join(os.tmpdir(),'frame-fast-collection-')),ws=await Workspace.open(path.join(root,'workspace'))
const assets=[]
for(let i=0;i<4;i++){const file=path.join(root,`${i}.png`);await writeFile(file,await sharp({create:{width:24,height:32,channels:3,background:'#26736a'}}).png().toBuffer());assets.push(await ws.importImage(file))}
const product=await ws.products.save({name:'Four products',description:'',notes:'',assetIds:assets.map(a=>a.id),primaryAssetId:assets[0].id})
const theme=await ws.themes.save({name:'Direction',description:'',coverAssetId:null,referenceAssetIds:[],masterPrompt:'Style this product',outputType:'post',aspectRatio:'1:1',defaultDuration:0,compositionPrompt:'One photo',scenes:[]})
const makeProject=name=>ws.projects.save({name,productId:product.id,themeId:theme.id,characterId:null,outputType:'post',preset:'post-square',duration:0})
const projects=[await makeProject('A'),await makeProject('B')],remote=new Map(),prepared=new Map(),events=[],downloaded=new Map()
const browserBusy=new Set()
let submitted=0,firstJob,firstReadyAt=0,savedAt=0,scheduler
const op=async(id,kind,action)=>{assert.equal(browserBusy.has(id),false,'Only one command per project tab');browserBusy.add(id);events.push({id,kind,time:Date.now()});try{return await action()}finally{browserBusy.delete(id)}}
const factory=(id,dispatch)=>({
  granularQueue:true,
  createProject:commit=>dispatch('createProject',()=>op(id,'create',async()=>{const url=`https://flow.google.com/project/${id}`;await commit(url);return url})),
  nameProject:()=>dispatch('nameProject',()=>op(id,'name',async()=>{})),
  prepare:async(_url,request)=>{
    prepared.set(id,request)
    for(let photo=0;photo<3;photo++) await dispatch('attach',()=>op(id,`upload-${request.sceneId}-${photo}`,()=>delay(70)))
    return [...remote.keys()]
  },
  submit:()=>dispatch('submit',()=>op(id,'submit',async()=>{
    events.push({id,kind:'native-start'});await delay(5);events.push({id,kind:'native-end'})
    const request=prepared.get(id),resultId=randomUUID(),readyAt=Date.now()+30
    remote.set(resultId,{projectId:id,prompt:request.prompt,readyAt});submitted++
    if(!firstJob){firstJob=ws.flow.latest(id);firstReadyAt=readyAt}
  })),
  results:(_url,prompt,_kind,baseline)=>dispatch('results',()=>op(id,'results',async()=>[...remote].filter(([key,r])=>r.projectId===id&&r.prompt===prompt&&r.readyAt<=Date.now()&&!baseline.includes(key)).map(([key])=>({id:key,selector:`#${key}`})))),
  download:(_url,result)=>dispatch('download',()=>op(id,'download',async()=>{
    assert.equal(remote.get(result.id).projectId,id)
    downloaded.set(result.id,(downloaded.get(result.id)||0)+1)
    return path.join(root,'0.png')
  })),
  close:async()=>{},
})
let pump
try{
  scheduler=new FlowScheduler(async()=>ws,factory,10,5000)
  pump=setInterval(()=>void scheduler.collectPending().then(()=>{if(firstJob&&!savedAt&&ws.generations.get(firstJob.attemptId).state==='ready-for-review'){savedAt=Date.now();events.push({kind:'first-review'})}}),10)
  await Promise.all(projects.map(p=>scheduler.startPosts(p.id)))
  const limit=Date.now()+10000
  while(scheduler.busy&&Date.now()<limit)await delay(10)
  assert.equal(scheduler.busy,false)
  await scheduler.collectPending()
  if(!savedAt&&ws.generations.get(firstJob.attemptId).state==='ready-for-review')savedAt=Date.now()
  assert.equal(submitted,8);assert.equal(downloaded.size,8)
  assert.ok([...downloaded.values()].every(count=>count===1),'Background sweep and foreground queue never download the same result twice')
  assert.ok(savedAt-firstReadyAt<1000,`Review latency ${savedAt-firstReadyAt}ms must not wait for the full upload batch`)
  assert.ok(events.some(e=>e.kind.startsWith('upload-')&&e.time>savedAt),'First result is saved while more uploads are still ahead')
  let nativeActive=false;for(const event of events){if(event.kind==='native-start'){assert.equal(nativeActive,false,'Native submit/click/ack cannot overlap another native turn');nativeActive=true}if(event.kind==='native-end')nativeActive=false};assert.equal(nativeActive,false)
  for(const p of projects)assert.equal((await ws.generations.list(p.id)).filter(a=>a.state==='ready-for-review').length,4)
  console.log(`PASS completed results preempt queued photo uploads; first review latency ${savedAt-firstReadyAt}ms during long uploads; two projects / eight results remain isolated; no duplicate download; native submit uninterrupted.`)
}finally{clearInterval(pump);await scheduler?.close();await ws.close()}
