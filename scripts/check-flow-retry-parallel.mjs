// Isolated parallel/retry regression. No Chrome account, app data or Flow credits.
import assert from 'node:assert/strict'
import {mkdtemp} from 'node:fs/promises'
import {setTimeout as delay} from 'node:timers/promises'
import {randomUUID} from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import {Workspace} from '../dist-electron/storage/workspace.cjs'
import {FlowScheduler} from '../dist-electron/flow-scheduler.cjs'
import {StorageError,FlowNotSubmittedError} from '../dist-electron/storage/errors.cjs'
import {postPhotos} from '../dist-electron/storage/post-plan.mjs'
const root=await mkdtemp(path.join(os.tmpdir(),'frame-retry-parallel-'))
let ws=await Workspace.open(path.join(root,'workspace')),scheduler,pump
const projects=[],sources=new Map()
for(let p=0;p<6;p++){
 const assets=[]
 for(let n=0;n<3;n++){const file=path.join(root,`${p}-${n}.png`);await sharp({create:{width:40,height:50,channels:3,background:{r:20+p*25,g:40+n*35,b:100}}}).png().toFile(file);const asset=await ws.importImage(file);assets.push(asset);sources.set(asset.id,file)}
 const product=await ws.products.save({name:`Products ${p}`,description:'',notes:'',assetIds:assets.map(a=>a.id),primaryAssetId:assets[0].id}),theme=await ws.themes.save({name:`Theme ${p}`,description:'',coverAssetId:null,referenceAssetIds:[],masterPrompt:`Project ${p}: preserve the product.`,outputType:'post',aspectRatio:'1:1',defaultDuration:0,compositionPrompt:'',scenes:[]})
 projects.push(await ws.projects.save({name:`Parallel ${p}`,productId:product.id,themeId:theme.id,characterId:null,outputType:'post',preset:'post-square',duration:0}))
}
const remote=new Map(),prepared=new Map(),admissions=[],submissions=[],downloads=new Map(),preparations=[]
let failUpload=true,holdEntered=false,unblock,downloadFail=true,rejectProject='',uncertainProject='',notSubmittedProject=''
const browserActive=new Set()
const hold=new Promise(resolve=>{unblock=resolve})
const key=(p,s)=>p+':'+s
const factory=projectId=>{
 const project=projects.find(p=>p.id===projectId),url=`https://flow.google.com/project/${projectId}`
 const operation=async fn=>{assert.equal(browserActive.has(projectId),false,'One command per owned project tab');browserActive.add(projectId);try{return await fn()}finally{browserActive.delete(projectId)}}
 return {
  async createProject(commit){return operation(async()=>{await commit(url);return url})},async nameProject(actual){assert.equal(actual,url)},
  async prepare(actual,request){return operation(async()=>{
   assert.equal(actual,url);assert.equal(request.projectId,projectId);const photo=postPhotos(project).find(p=>p.id===request.sceneId);assert.deepEqual(request.references,[photo.product.id]);assert.deepEqual(request.files,[await ws.mediaFile(photo.product.id,'original')])
   admissions.push(projectId);preparations.push({projectId,sceneId:request.sceneId,prompt:request.prompt,references:request.references});prepared.set(projectId,request)
   if(projectId===projects[0].id&&request.sceneId===postPhotos(project)[1].id&&failUpload){failUpload=false;throw new StorageError('INVALID_REQUEST','Fixture upload failed before Generate')}
   if(projectId===projects[0].id&&request.sceneId===postPhotos(project)[2].id&&!holdEntered){holdEntered=true;await hold}
   return [...remote.keys()]
  })},
  async submit(actual){return operation(async()=>{
   assert.equal(actual,url)
   const request=prepared.get(projectId)
   if(projectId===notSubmittedProject){notSubmittedProject='';throw new FlowNotSubmittedError('Fixture Generate control was not ready. Nothing was clicked.')}
   if(projectId===rejectProject){rejectProject='';throw new StorageError('INVALID_REQUEST','Flow rejected submission: too many requests. No automatic retry was made.')}
   const id=randomUUID();remote.set(id,{projectId,sceneId:request.sceneId,prompt:request.prompt,readyAt:Date.now()+15});submissions.push({projectId,sceneId:request.sceneId})
   if(projectId===uncertainProject){uncertainProject='';throw new StorageError('INVALID_REQUEST','Fixture lost submit acknowledgement')}
  })},
  async results(actual,prompt,_type,baseline){return operation(async()=>{assert.equal(actual,url);return [...remote].filter(([id,r])=>r.projectId===projectId&&r.prompt===prompt&&!baseline.includes(id)&&r.readyAt<=Date.now()).map(([id])=>({id,selector:'#'+id}))})},
  async download(actual,result){return operation(async()=>{assert.equal(actual,url);const row=remote.get(result.id);assert.equal(row.projectId,projectId);if(projectId===projects[1].id&&downloadFail){downloadFail=false;throw new StorageError('INVALID_REQUEST','Fixture interrupted result download')};downloads.set(result.id,(downloads.get(result.id)??0)+1);const photo=postPhotos(project).find(p=>p.id===row.sceneId);return sources.get(photo.product.id)})},
  async close(){},
 }
}
async function until(predicate,label,timeout=12000){const end=Date.now()+timeout;while(!await predicate()&&Date.now()<end)await delay(5);assert.ok(await predicate(),label)}
async function settle(){await until(()=>!scheduler.busy,'Queues finish without a stuck shared slot');await scheduler.collectPending()}
try{
 scheduler=new FlowScheduler(async()=>ws,factory,5,5000);pump=setInterval(()=>void scheduler.collectPending().catch(()=>{}),10)
 await Promise.all(projects.map(p=>scheduler.startPosts(p.id)))
 await until(()=>holdEntered,'A failed upload must not stop the next product')
 const failed=ws.flow.jobs(projects[0].id).find(j=>ws.generations.get(j.attemptId).state==='failed');assert.ok(failed)
 const snapshot=ws.generations.get(failed.attemptId),before=preparations.filter(p=>p.sceneId===snapshot.sceneId&&p.projectId===projects[0].id).length
 // A failed single-product request can join a currently running batch too.
 ws.flow.saveJob({...failed,postBatch:undefined})
 const queued=await scheduler.retry(failed.attemptId);await scheduler.retry(failed.attemptId);assert.equal(queued.retryQueued,true,'Retry can join an already-running product queue')
 unblock();await settle()
 assert.equal(new Set(admissions).size,6,'Every project has an independent lane')
 assert.equal(submissions.length,18);assert.equal(downloads.size,18);assert.ok([...downloads.values()].every(n=>n===1))
 for(const project of projects){assert.equal((await ws.generations.list(project.id)).length,3);assert.equal((await ws.generations.list(project.id)).filter(a=>a.state==='ready-for-review').length,3)}
 assert.equal(preparations.filter(p=>p.sceneId===snapshot.sceneId&&p.projectId===projects[0].id).length,before+1,'Repeated retry clicks queue one upload only')
 assert.equal(submissions.filter(p=>key(p.projectId,p.sceneId)===key(snapshot.projectId,snapshot.sceneId)).length,1)
 assert.equal(ws.generations.get(snapshot.id).prompt,snapshot.prompt);assert.deepEqual(ws.generations.get(snapshot.id).references,snapshot.references)
 const submitBefore=submissions.length;await scheduler.retry(snapshot.id);assert.equal(submissions.length,submitBefore,'Ready results cannot be generated by retry')

 // An explicit Flow rejection is safe to restart. A lost acknowledgement is not.
 const base=projects[1],make=async name=>{const p=await ws.projects.save({name,productId:base.productId,themeId:base.themeId,characterId:null,outputType:'post',preset:'post-square',duration:0});projects.push(p);return p}
 const rejected=await make('Explicit rejection');rejectProject=rejected.id;await scheduler.startPosts(rejected.id);await settle()
 const rejectedJob=ws.flow.jobs(rejected.id).find(j=>j.submissionRejected);assert.ok(rejectedJob);assert.equal(ws.generations.get(rejectedJob.attemptId).state,'failed');assert.equal((await ws.generations.list(rejected.id)).filter(a=>a.state==='ready-for-review').length,2,'A rejected product does not stop its siblings')
 const rejectionBefore=submissions.length;await scheduler.retry(rejectedJob.attemptId);await settle();assert.equal(submissions.length,rejectionBefore+1)
  const noClick=await make('Generate control not ready');notSubmittedProject=noClick.id;await scheduler.startPosts(noClick.id);await settle();const notSent=ws.flow.jobs(noClick.id).find(j=>ws.generations.get(j.attemptId).state==='failed');assert.ok(notSent);assert.equal(notSent.submittedAt,undefined);const beforeNoClickRetry=submissions.length;await scheduler.retry(notSent.attemptId);await settle();assert.equal(submissions.length,beforeNoClickRetry+1)
 const uncertain=await make('Uncertain submission');uncertainProject=uncertain.id;await scheduler.startPosts(uncertain.id);await settle();const uncertainJob=ws.flow.jobs(uncertain.id).find(j=>!j.submissionAcknowledged);assert.ok(uncertainJob)
 const uncertainBefore=submissions.length,preparedBefore=preparations.length;await scheduler.retry(uncertainJob.attemptId);await settle();assert.equal(submissions.length,uncertainBefore);assert.equal(preparations.length,preparedBefore,'Uncertain retry collects existing results and never uploads twice')
 assert.equal(ws.generations.get(uncertainJob.attemptId).state,'ready-for-review')
  // Restart drops a queued-retry marker, preserving the original failed snapshot.
  const interrupted=await make('Interrupted retry'),attempt=await ws.generations.prepareAutomatic(interrupted.id,'post');await ws.generations.setState(attempt.id,'failed')
  ws.flow.saveJob({attemptId:attempt.id,projectId:interrupted.id,stage:'needs-attention',message:'Retry queued',projectUrl:'',baseline:[],resultIds:[],imported:{},outputs:1,updatedAt:'',retryQueued:true})
  await ws.generations.retryPreparation(attempt.id,undefined,true)
  clearInterval(pump);await scheduler.close();await ws.close();ws=await Workspace.open(path.join(root,'workspace'));assert.equal(ws.flow.job(attempt.id).retryQueued,false);assert.equal(ws.generations.get(attempt.id).state,'failed','A crash during retry startup must not leave an orphaned active request')
  scheduler=new FlowScheduler(async()=>ws,factory,5,5000);await scheduler.retry(attempt.id);await settle();assert.equal(ws.generations.get(attempt.id).state,'ready-for-review');assert.equal(ws.generations.get(attempt.id).prompt,attempt.prompt)
 console.log('PASS six independent project lanes without a global cap, isolated references/results, failed upload and explicit rejection do not stop siblings, targeted queued retry with exact snapshot, duplicate retry coalescing, transient download recovery, ready-result skip and uncertain-submit collection without resubmission.')
}finally{unblock();clearInterval(pump);await scheduler?.close();await ws.close()}
